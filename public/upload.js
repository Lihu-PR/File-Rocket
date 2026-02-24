// WebSocket 连接 (原生)
let socket = null;
let wsConnected = false;

// 全局变量
let selectedFile = null;
let pickupCode = null;
let transferStartTime = null;
let isTransferring = false;
let transferMode = 'memory'; // 默认内存流式传输
let originalTransferMode = 'memory';
let transferCompleted = false; // 传输完成标志，防止重复传输
let storageFallbackTriggered = false;
let availableFeatures = {
    memoryStreaming: true,
    serverStorage: false,
    p2pDirect: false
};
let storageConfig = {
    fileRetentionHours: 24,
    deleteOnDownload: false
};
let receiverCapabilities = null; // 接收端能力信息

let memoryTransferState = null;
let p2pPeerConnection = null;
let p2pDataChannel = null;
let p2pConnectTimer = null;
let pendingIceCandidates = []; // ICE candidate 缓存队列
let p2pIceRestartCount = 0; // ICE restart 已尝试次数
const P2P_MAX_ICE_RESTARTS = 2; // 最多尝试 ICE restart 次数
let p2pIceRestartTime = 0; // 上次 ICE restart 的时间戳
const P2P_ICE_RESTART_COOLDOWN = 8000; // ICE restart 后的冷却期（毫秒）
let signalProcessing = false; // 信令消息串行锁
let signalQueue = []; // 信令消息等待队列
let receiverReady = false;
let receiverSinkReady = false;
let transferStartRequested = false;
let sinkReadyWaitTimer = null;
let heartbeatTimer = null;
const P2P_CONNECT_TIMEOUT_MS = 60000;
const P2P_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.nextcloud.com:443' },
    { urls: 'stun:stun.sipgate.net:3478' },
    { urls: 'stun:stun.voip.blackberry.com:3478' },
    { urls: 'stun:stun.easyvoip.com:3478' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    { urls: 'stun:stun.qq.com:3478' }
];
const INITIAL_WINDOW_SIZE = 4;
const MAX_WINDOW_SIZE = 8;
const MIN_WINDOW_SIZE = 2;
const ACK_TIMEOUT_MS = 2500;
const MAX_RETRY_PER_CHUNK = 8;
const MAX_NACK_REPAIR_BATCH = 256;
const SPEED_WINDOW_MS = 1800;
const CACHE_SLACK_CHUNKS = 12;
const SINK_READY_WAIT_TIMEOUT_MS = 3500;

// NAT 类型检测（独立函数）
async function detectNATType() {
    try {
        const pc = new RTCPeerConnection({ iceServers: P2P_ICE_SERVERS });
        const candidates = [];
        let hasHost = false, hasSrflx = false, hasRelay = false;

        await new Promise((resolve) => {
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    candidates.push(event.candidate);
                    const s = event.candidate.candidate;
                    if (s.includes('typ host')) hasHost = true;
                    if (s.includes('typ srflx')) hasSrflx = true;
                    if (s.includes('typ relay')) hasRelay = true;
                    if (hasSrflx || hasRelay || (hasHost && candidates.length >= 2)) {
                        setTimeout(resolve, 500);
                    }
                } else {
                    resolve();
                }
            };
            pc.createDataChannel('nat-test');
            pc.createOffer().then(offer => pc.setLocalDescription(offer));
            setTimeout(resolve, 2000);
        });
        pc.close();

        if (hasHost && !hasSrflx && !hasRelay) {
            return { type: 'NAT0', name: '公网IP', success: 95 };
        } else if (hasSrflx) {
            const cnt = candidates.filter(c => c.candidate.includes('typ srflx')).length;
            if (cnt === 1) return { type: 'NAT1', name: '全锥型NAT', success: 90 };
            if (cnt === 2) return { type: 'NAT2', name: '限制型NAT', success: 75 };
            return { type: 'NAT3', name: '端口限制型NAT', success: 50 };
        } else if (hasRelay) {
            return { type: 'NAT4', name: '对称型NAT', success: 20 };
        }
        return { type: 'NAT4', name: '对称型NAT', success: 20 };
    } catch (e) {
        console.error('NAT检测失败:', e);
        return { type: 'UNKNOWN', name: '未知', success: 50 };
    }
}

// NAT 信息（发送端）
let senderNATInfo = null;
let receiverNATInfoOnSender = null;

// DOM 元素
const fileInput = document.getElementById('fileInput');
const fileDropZone = document.getElementById('fileDropZone');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const pickupCodeDisplay = document.getElementById('pickupCode');
let statusText = document.getElementById('statusText');
const statusBadge = document.getElementById('statusBadge');
const progressFill = document.getElementById('progressFill');
const progressPercent = document.getElementById('progressPercent');
const transferSpeed = document.getElementById('transferSpeed');
const connectedFileName = document.getElementById('connectedFileName');
const connectedFileSize = document.getElementById('connectedFileSize');
const connectedFileType = document.getElementById('connectedFileType');
const connectedStatusText = document.getElementById('connectedStatusText');

function setStatusBadge(type) {
    if (!statusBadge) return;
    statusBadge.classList.remove('neutral', 'success', 'error', 'warning');
    statusBadge.classList.add(type);
}

function clearSinkReadyWaitTimer() {
    if (sinkReadyWaitTimer) {
        clearTimeout(sinkReadyWaitTimer);
        sinkReadyWaitTimer = null;
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    setupWebSocket();
    setupFileDropZone();
    loadAvailableFeatures();
});

// 连接 WebSocket
function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    socket = new WebSocket(wsUrl);

    socket.onopen = function() {
        console.log('[WS] 连接成功');
        wsConnected = true;
        statusText.textContent = '已连接到服务器';
        setStatusBadge('success');
    };

    socket.onmessage = function(event) {
        try {
            const msg = JSON.parse(event.data);
            handleWSMessage(msg);
        } catch (e) {
            console.error('[WS] 消息解析错误:', e);
        }
    };

    socket.onclose = function() {
        console.log('[WS] 连接关闭');
        wsConnected = false;
        statusText.textContent = '与服务器断开连接';
        setStatusBadge('error');
        // 尝试重连
        setTimeout(setupWebSocket, 3000);
    };

    socket.onerror = function(error) {
        console.error('[WS] 错误:', error);
        statusText.textContent = '连接服务器失败';
        setStatusBadge('error');
    };
}

// WebSocket 消息处理
function handleWSMessage(msg) {
    switch (msg.type) {
        case 'session-created':
            handleSessionCreated(msg);
            break;
        case 'receiver-connected':
            handleReceiverConnected(msg);
            break;
        case 'receiver-ready':
            handleReceiverReady(msg);
            break;
        case 'receiver-sink-ready':
            handleReceiverSinkReady(msg);
            break;
        case 'receiver-fatal':
            handleReceiverFatal(msg);
            break;
        case 'signal':
            handleSignalMessage(msg);
            break;
        case 'transfer-complete':
            handleTransferComplete(msg);
            break;
        case 'chunk-ack':
            handleChunkAck(msg);
            break;
        case 'verify-ok':
            handleVerifyOk(msg);
            break;
        case 'verify-fail':
            handleVerifyFail(msg);
            break;
        case 'chunk-nack':
            handleChunkNack(msg);
            break;
        case 'connection-lost':
            handleConnectionLost(msg);
            break;
        case 'p2p-nat-info':
            handleP2PNATInfoOnSender(msg);
            break;
        case 'error':
            console.error('[WS] 服务器错误:', msg.payload);
            break;
    }
}

function handleSessionCreated(msg) {
    pickupCode = msg.payload.pickupCode;
    pickupCodeDisplay.textContent = pickupCode;
    receiverReady = false;
    receiverSinkReady = false;
    transferStartRequested = false;
    clearSinkReadyWaitTimer();

    // 更新取件码提示
    updateCodeHint();

    // 启动心跳保活（接收端未连接时保持会话）
    startHeartbeat();

    // 显示分享区域（二维码 + 复制链接）
    showShareSection(pickupCode);

    // 切换到等待连接阶段
    showStage('waiting-stage');
    statusText.textContent = '等待接收方连接...';
}

function handleP2PFailed(reason = '') {
    const text = reason || 'P2P 连接失败';
    console.error('[P2P 发送端]', text);
    statusText.textContent = `${text}，请返回重试或换用其他传输模式`;
    setStatusBadge('error');
}

function triggerStorageFallback(reason = '') {
    if (!selectedFile || storageFallbackTriggered) {
        return;
    }

    cleanupP2PResources();
    storageFallbackTriggered = true;
    transferMode = 'storage';
    const detail = reason ? `（${reason}）` : '';
    statusText.textContent = `正在自动回退到服务器存储模式${detail}`;
    setStatusBadge('warning');

    uploadFileToServerChunked().catch((error) => {
        statusText.textContent = `自动回退失败：${error?.message || '未知错误'}`;
        setStatusBadge('error');
    });
}

function cleanupP2PResources() {
    pendingIceCandidates = [];
    signalQueue = [];
    signalProcessing = false;
    if (p2pConnectTimer) {
        clearTimeout(p2pConnectTimer);
        p2pConnectTimer = null;
    }

    if (p2pDataChannel) {
        try {
            p2pDataChannel.onopen = null;
            p2pDataChannel.onmessage = null;
            p2pDataChannel.onerror = null;
            p2pDataChannel.onclose = null;
            if (p2pDataChannel.readyState !== 'closed') {
                p2pDataChannel.close();
            }
        } catch (_) {}
    }
    p2pDataChannel = null;

    if (p2pPeerConnection) {
        try {
            p2pPeerConnection.onicecandidate = null;
            p2pPeerConnection.onconnectionstatechange = null;
            p2pPeerConnection.close();
        } catch (_) {}
    }
    p2pPeerConnection = null;
}

function sendSignal(payload) {
    wsSend('signal', {
        pickupCode,
        ...payload
    });
}

async function setupP2PSenderConnection() {
    cleanupP2PResources();
    pendingIceCandidates = [];
    p2pIceRestartCount = 0;
    p2pIceRestartTime = 0;

    p2pPeerConnection = new RTCPeerConnection({
        iceServers: P2P_ICE_SERVERS,
        iceCandidatePoolSize: 5
    });

    p2pPeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal({ signalType: 'ice-candidate', candidate: event.candidate });
        }
    };

    p2pPeerConnection.onconnectionstatechange = async () => {
        const state = p2pPeerConnection?.connectionState;
        console.log('[P2P 发送端] 连接状态:', state);
        if (state === 'failed') {
            if (isTransferring) {
                isTransferring = false;
                const reason = '接收端已断开连接';
                statusText.textContent = reason;
                setStatusBadge('error');
                const tsEl = document.getElementById('transferSpeed');
                const ppEl = document.getElementById('progressPercent');
                if (tsEl) tsEl.textContent = reason;
                if (ppEl) ppEl.textContent = '已中断';
                return;
            }
            // ICE restart 冷却期内忽略 failed 事件（restart 还在生效中）
            if (p2pIceRestartTime > 0 && (Date.now() - p2pIceRestartTime) < P2P_ICE_RESTART_COOLDOWN) {
                console.log('[P2P 发送端] ICE restart 冷却期内，忽略 failed 事件');
                return;
            }
            // 还有 restart 次数，尝试 restart
            if (p2pIceRestartCount < P2P_MAX_ICE_RESTARTS && p2pPeerConnection) {
                p2pIceRestartCount++;
                p2pIceRestartTime = Date.now();
                console.log(`[P2P 发送端] ICE 连接失败，尝试 ICE restart (${p2pIceRestartCount}/${P2P_MAX_ICE_RESTARTS})...`);
                statusText.textContent = `P2P 连接重试中 (${p2pIceRestartCount}/${P2P_MAX_ICE_RESTARTS})...`;
                try {
                    const offer = await p2pPeerConnection.createOffer({ iceRestart: true });
                    await p2pPeerConnection.setLocalDescription(offer);
                    sendSignal({ signalType: 'offer', sdp: offer });
                } catch (e) {
                    console.warn('[P2P 发送端] ICE restart 失败:', e);
                    handleP2PFailed('P2P ICE restart 失败');
                }
                return;
            }
            handleP2PFailed('P2P 连接失败');
        } else if (state === 'disconnected') {
            if (isTransferring) {
                const tsEl = document.getElementById('transferSpeed');
                if (tsEl) tsEl.textContent = '连接中断，等待恢复...';
            }
            // disconnected 不做处理，等待自动恢复或变为 failed
        } else if (state === 'connected') {
            p2pIceRestartCount = 0; // 连接成功，重置 restart 计数
            p2pIceRestartTime = 0;
        }
    };

    p2pDataChannel = p2pPeerConnection.createDataChannel('file-rocket', {
        ordered: true
    });

    p2pDataChannel.onopen = () => {
        // 连接成功，清除超时计时器
        if (p2pConnectTimer) {
            clearTimeout(p2pConnectTimer);
            p2pConnectTimer = null;
        }
        statusText.textContent = 'P2P 数据通道已建立，等待接收方落盘器就绪...';
        setStatusBadge('success');
        requestTransferStartIfReady('p2p');
    };

    p2pDataChannel.onerror = (err) => {
        if (isTransferring) {
            isTransferring = false;
            const reason = '数据通道错误';
            statusText.textContent = reason;
            setStatusBadge('error');
            const tsEl = document.getElementById('transferSpeed');
            const ppEl = document.getElementById('progressPercent');
            if (tsEl) tsEl.textContent = reason;
            if (ppEl) ppEl.textContent = '已中断';
            return;
        }
        console.warn('[P2P 发送端] DataChannel 错误:', err);
    };

    p2pDataChannel.onclose = () => {
        if (isTransferring) {
            isTransferring = false;
            const reason = '接收端已断开连接';
            statusText.textContent = reason;
            setStatusBadge('error');
            const tsEl = document.getElementById('transferSpeed');
            const ppEl = document.getElementById('progressPercent');
            if (tsEl) tsEl.textContent = reason;
            if (ppEl) ppEl.textContent = '已中断';
            return;
        }
        console.log('[P2P 发送端] DataChannel 已关闭');
    };

    const offer = await p2pPeerConnection.createOffer();
    await p2pPeerConnection.setLocalDescription(offer);
    sendSignal({ signalType: 'offer', sdp: offer });

    p2pConnectTimer = setTimeout(() => {
        if (p2pDataChannel && p2pDataChannel.readyState === 'open') {
            return;
        }
        handleP2PFailed('P2P 握手超时（60秒）');
    }, P2P_CONNECT_TIMEOUT_MS);
}

function handleSignalMessage(msg) {
    signalQueue.push(msg);
    processSignalQueue();
}

async function processSignalQueue() {
    if (signalProcessing) return;
    signalProcessing = true;
    while (signalQueue.length > 0) {
        const msg = signalQueue.shift();
        await processSignal(msg);
    }
    signalProcessing = false;
}

async function processSignal(msg) {
    const payload = msg.payload || {};
    if (originalTransferMode !== 'p2p') {
        return;
    }
    if (!p2pPeerConnection) {
        // P2P 连接未建立时缓存 ICE candidate
        if (payload.signalType === 'ice-candidate' && payload.candidate) {
            pendingIceCandidates.push(payload.candidate);
        }
        return;
    }

    try {
        if (payload.signalType === 'answer' && payload.sdp) {
            // 只在 have-local-offer 状态下接受 answer
            if (p2pPeerConnection.signalingState !== 'have-local-offer') {
                console.warn('[P2P 发送端] 忽略 answer：当前状态', p2pPeerConnection.signalingState);
                return;
            }
            await p2pPeerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            // flush 缓存的 ICE candidate
            for (const candidate of pendingIceCandidates) {
                try {
                    await p2pPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    console.warn('[P2P] flush 缓存 ICE candidate 失败:', e);
                }
            }
            pendingIceCandidates = [];
        } else if (payload.signalType === 'ice-candidate' && payload.candidate) {
            if (!p2pPeerConnection.remoteDescription) {
                pendingIceCandidates.push(payload.candidate);
            } else {
                await p2pPeerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
            }
        } else if (payload.signalType === 'ice-restart-request') {
            // 冷却期内忽略（发送端可能刚自己做过 restart）
            if (p2pIceRestartTime > 0 && (Date.now() - p2pIceRestartTime) < P2P_ICE_RESTART_COOLDOWN) {
                console.log('[P2P 发送端] 冷却期内，忽略接收端 ICE restart 请求');
                return;
            }
            if (p2pIceRestartCount < P2P_MAX_ICE_RESTARTS && p2pPeerConnection) {
                p2pIceRestartCount++;
                p2pIceRestartTime = Date.now();
                console.log(`[P2P 发送端] 收到接收端 ICE restart 请求，重新协商 (${p2pIceRestartCount}/${P2P_MAX_ICE_RESTARTS})...`);
                statusText.textContent = `P2P 连接重试中 (${p2pIceRestartCount}/${P2P_MAX_ICE_RESTARTS})...`;
                const offer = await p2pPeerConnection.createOffer({ iceRestart: true });
                await p2pPeerConnection.setLocalDescription(offer);
                sendSignal({ signalType: 'offer', sdp: offer });
            } else {
                console.warn('[P2P 发送端] ICE restart 次数已用完，忽略接收端请求');
            }
        }
    } catch (error) {
        console.warn('[P2P] 信令处理异常（不放弃连接）:', error);
    }
}

function requestTransferStartIfReady(channel = 'memory') {
    if (transferStartRequested || isTransferring || !selectedFile || !pickupCode) {
        return;
    }

    if (!receiverReady) {
        clearSinkReadyWaitTimer();
        statusText.textContent = '等待接收端接收文件...';
        setStatusBadge('neutral');
        return;
    }

    if (!receiverSinkReady) {
        if (!sinkReadyWaitTimer) {
            sinkReadyWaitTimer = setTimeout(() => {
                sinkReadyWaitTimer = null;
                if (isTransferring || transferStartRequested || receiverSinkReady || !receiverReady) {
                    return;
                }
                statusText.textContent = '未收到落盘器就绪信号，已兼容启动传输...';
                setStatusBadge('warning');
                receiverSinkReady = true;
                requestTransferStartIfReady(channel);
            }, SINK_READY_WAIT_TIMEOUT_MS);
        }

        statusText.textContent = '接收方已确认，等待落盘器就绪...';
        setStatusBadge('neutral');
        return;
    }

    clearSinkReadyWaitTimer();

    if (channel === 'p2p') {
        if (!p2pDataChannel || p2pDataChannel.readyState !== 'open') {
            statusText.textContent = '接收方就绪，正在等待 P2P 数据通道建立...';
            setStatusBadge('neutral');
            return;
        }
    }

    transferStartRequested = true;
    startFileTransfer(channel).finally(() => {
        if (!isTransferring) {
            transferStartRequested = false;
        }
    });
}

function handleReceiverReady(msg) {
    receiverReady = true;
    if (originalTransferMode === 'p2p') {
        requestTransferStartIfReady('p2p');
        return;
    }

    requestTransferStartIfReady('memory');
}

function handleReceiverSinkReady(msg) {
    receiverSinkReady = true;
    clearSinkReadyWaitTimer();
    if (originalTransferMode === 'p2p') {
        requestTransferStartIfReady('p2p');
        return;
    }

    requestTransferStartIfReady('memory');
}

function handleReceiverFatal(msg) {
    const payload = msg.payload || {};
    const reason = payload.reason || '接收端初始化失败';
    clearSinkReadyWaitTimer();

    if (memoryTransferState) {
        memoryTransferState.aborted = true;
        memoryTransferState.abortReason = reason;
    }

    isTransferring = false;
    transferStartRequested = false;
    statusText.textContent = `接收端失败：${reason}`;
    setStatusBadge('error');
}

function handleReceiverConnected(msg) {
    // 接收端已连接，停止心跳（会话由 WebSocket 连接保活）
    stopHeartbeat();

    // 提取接收端能力信息
    const payload = msg.payload || {};
    receiverCapabilities = payload.capabilities || null;

    console.log('[调试] 接收端能力:', receiverCapabilities);

    receiverReady = false;
    receiverSinkReady = false;
    transferStartRequested = false;
    clearSinkReadyWaitTimer();

    // 切换到已连接页面，显示文件信息
    showStage('connected-stage');
    statusText = connectedStatusText;
    if (selectedFile) {
        connectedFileName.textContent = selectedFile.name;
        connectedFileSize.textContent = formatFileSize(selectedFile.size);
        connectedFileType.textContent = getFileType(selectedFile.name);
    }

    if (originalTransferMode === 'p2p') {
        statusText.textContent = '正在协商P2P直连...';
        transferMode = 'p2p';

        // 并行：NAT 检测 + P2P 建连
        detectNATType().then(natInfo => {
            senderNATInfo = natInfo;
            wsSend('p2p-nat-info', {
                pickupCode: pickupCode,
                natType: natInfo,
                role: 'sender'
            });
            updateSenderNATDisplay(senderNATInfo, receiverNATInfoOnSender);
        });

        setupP2PSenderConnection().catch((err) => {
            console.error('[P2P 发送端] P2P 建连失败:', err);
            handleP2PFailed('P2P 建连失败');
        });
        return;
    }

    statusText.textContent = '等待接收端接收文件...';
    requestTransferStartIfReady('memory');
}

function handleTransferComplete(msg) {
    if (memoryTransferState) {
        memoryTransferState.done = true;
    }
    setTimeout(() => {
        showStage('complete-stage');
    }, 500);
}

function handleVerifyOk(msg) {
    if (!memoryTransferState) {
        return;
    }
    clearSinkReadyWaitTimer();
    memoryTransferState.done = true;
    isTransferring = false;
    statusText.textContent = '接收端完整性校验通过，传输完成';
    setStatusBadge('success');

    setTimeout(() => {
        showStage('complete-stage');
    }, 500);
}

function handleVerifyFail(msg) {
    const payload = msg.payload || {};
    const reason = payload.reason || '接收端完整性校验失败';
    clearSinkReadyWaitTimer();

    if (memoryTransferState) {
        memoryTransferState.aborted = true;
        memoryTransferState.abortReason = reason;
    }

    isTransferring = false;
    statusText.textContent = `传输失败：${reason}`;
    setStatusBadge('error');
}

function handleConnectionLost(msg) {
    stopHeartbeat();
    isTransferring = false;
    clearSinkReadyWaitTimer();
    cleanupP2PResources();
    if (memoryTransferState) {
        memoryTransferState.aborted = true;
        memoryTransferState.abortReason = '接收端已断开连接';
    }
    // 在传输阶段直接更新可见元素
    const transferSpeed = document.getElementById('transferSpeed');
    const progressPercent = document.getElementById('progressPercent');
    if (transferSpeed) transferSpeed.textContent = '接收端已断开连接';
    if (progressPercent) progressPercent.textContent = '已中断';
    statusText.textContent = '接收端已断开连接';
    setStatusBadge('error');
}

function handleChunkAck(msg) {
    if (!memoryTransferState) {
        return;
    }

    const payload = msg.payload || {};
    const ackChunkIndex = Number(payload.chunkIndex);
    if (!Number.isInteger(ackChunkIndex) || ackChunkIndex < 0) {
        return;
    }
    if (ackChunkIndex >= memoryTransferState.totalChunks) {
        return;
    }

    if (!memoryTransferState.acked.has(ackChunkIndex)) {
        memoryTransferState.ackedBytes += memoryTransferState.chunkSizes[ackChunkIndex] || 0;
    }

    memoryTransferState.acked.add(ackChunkIndex);
    memoryTransferState.pending.delete(ackChunkIndex);
    memoryTransferState.chunkCache.delete(ackChunkIndex);
    memoryTransferState.chunkHashes.delete(ackChunkIndex);
    memoryTransferState.lastAckAt = Date.now();

    const currentWindow = memoryTransferState.windowSize;
    const maxWindow = memoryTransferState.maxWindowSize || MAX_WINDOW_SIZE;
    if (currentWindow < maxWindow) {
        memoryTransferState.windowSize = Math.min(currentWindow + 1, maxWindow);
    }
}

function handleChunkNack(msg) {
    if (!memoryTransferState) {
        return;
    }

    const payload = msg.payload || {};
    const missing = Array.isArray(payload.missingChunks) ? payload.missingChunks : [];
    const repaired = [];
    let rollbackBytes = 0;

    for (const item of missing) {
        const chunkIndex = Number(item);
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= memoryTransferState.totalChunks) {
            continue;
        }

        const wasAcked = memoryTransferState.acked.has(chunkIndex);
        memoryTransferState.acked.delete(chunkIndex);
        memoryTransferState.pending.delete(chunkIndex);

        if (!memoryTransferState.repairQueue.includes(chunkIndex)) {
            memoryTransferState.repairQueue.push(chunkIndex);
            repaired.push(chunkIndex);
            if (wasAcked) {
                rollbackBytes += memoryTransferState.chunkSizes[chunkIndex] || 0;
            }
        }
    }

    if (repaired.length > 0) {
        memoryTransferState.ackedBytes = Math.max(0, memoryTransferState.ackedBytes - rollbackBytes);
        const minWindow = memoryTransferState.minWindowSize || MIN_WINDOW_SIZE;
        memoryTransferState.windowSize = Math.max(minWindow, Math.floor(memoryTransferState.windowSize / 2));
        memoryTransferState.transferEndSent = false;
        statusText.textContent = `接收端请求补发 ${repaired.length} 个分块，正在修复...`;
    }
}

// 点击取件码复制到剪贴板
document.getElementById('pickupCode').addEventListener('click', function() {
    if (pickupCode && pickupCode !== '----') {
        navigator.clipboard.writeText(pickupCode).then(function() {
            // 显示复制成功效果
            pickupCodeDisplay.classList.add('copied');
            statusText.textContent = '已复制到剪贴板';
            setTimeout(function() {
                pickupCodeDisplay.classList.remove('copied');
                statusText.textContent = '等待接收方连接...';
            }, 1500);
        }).catch(function(err) {
            console.error('复制失败:', err);
        });
    }
});

// 发送 WebSocket 消息
function wsSend(type, payload) {
    if (socket && wsConnected) {
        socket.send(JSON.stringify({ type, payload }));
    }
}

// 设置拖拽上传
function setupFileDropZone() {
    fileDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileDropZone.classList.add('drag-over');
    });

    fileDropZone.addEventListener('dragleave', () => {
        fileDropZone.classList.remove('drag-over');
    });

    fileDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        fileDropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFileSelect(files[0]);
        }
    });

    fileDropZone.addEventListener('click', selectFile);

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileSelect(e.target.files[0]);
        }
    });
}

// 选择文件
function selectFile() {
    fileInput.click();
}

// 加载可用功能
async function loadAvailableFeatures() {
    try {
        const response = await fetch('/api/features');
        const data = await response.json();

        console.log('[调试] API响应:', JSON.stringify(data));

        if (data.success && data.features) {
            availableFeatures = data.features;
            console.log('[调试] 加载的功能配置:', JSON.stringify(availableFeatures));
            // 保存存储配置
            if (data.storageConfig) {
                storageConfig = data.storageConfig;
            }
            // 同步服务端主题
            if (data.theme && data.theme !== localStorage.getItem('file-rocket-theme')) {
                localStorage.setItem('file-rocket-theme', data.theme);
                if (data.theme === 'classic') {
                    document.documentElement.removeAttribute('data-theme');
                } else {
                    document.documentElement.setAttribute('data-theme', data.theme);
                }
                var fav = document.getElementById('favicon');
                if (fav) fav.href = data.theme === 'minimal' ? 'favicon-minimal.svg' : 'favicon-classic.svg';
            }
            updateTransferModeOptions();
            updateStorageDescription();
        }
    } catch (error) {
        console.error('加载功能配置失败:', error);
    }
}

// 更新传输模式选项显示
function updateTransferModeOptions() {
    console.log('[调试] updateTransferModeOptions, availableFeatures:', JSON.stringify(availableFeatures));

    const memoryOption = document.getElementById('memoryModeOption');
    const storageOption = document.getElementById('storageModeOption');
    const p2pOption = document.getElementById('p2pModeOption');

    if (memoryOption) {
        const show = availableFeatures.memoryStreaming ? 'block' : 'none';
        console.log('[调试] 内存流式:', show);
        memoryOption.style.display = show;
    }
    if (storageOption) {
        const show = availableFeatures.serverStorage ? 'block' : 'none';
        console.log('[调试] 服务器存储:', show);
        storageOption.style.display = show;
    }
    if (p2pOption) {
        const show = availableFeatures.p2pDirect ? 'block' : 'none';
        console.log('[调试] P2P直连:', show);
        p2pOption.style.display = show;
    }

    // 检查是否所有模式都被禁用
    const allDisabled = !availableFeatures.memoryStreaming &&
                       !availableFeatures.serverStorage &&
                       !availableFeatures.p2pDirect;

    if (allDisabled) {
        const modeSelection = document.querySelector('.transfer-mode-selector');
        if (modeSelection) {
            modeSelection.innerHTML = `
                <div style="text-align: center; padding: 30px; color: var(--text-sub);">
                    <p style="font-size: 1.2rem; margin-bottom: 10px;">暂时无法使用</p>
                    <p>管理员已关闭所有传输模式</p>
                </div>
            `;
        }
        const generateBtn = document.getElementById('generateCodeBtn');
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.textContent = '暂时无法使用';
        }
        return;
    }

    // 设置默认选中项
    if (availableFeatures.memoryStreaming) {
        document.getElementById('memoryMode').checked = true;
        transferMode = 'memory';
        console.log('[调试] 默认选中: 内存流式传输');
    } else if (availableFeatures.serverStorage) {
        document.getElementById('storageMode').checked = true;
        transferMode = 'storage';
        console.log('[调试] 默认选中: 服务器存储');
    } else if (availableFeatures.p2pDirect) {
        document.getElementById('p2pMode').checked = true;
        transferMode = 'p2p';
        console.log('[调试] 默认选中: P2P直连');
    }
    console.log('[调试] 当前 transferMode:', transferMode);
}

// 更新服务器存储模式描述
function updateStorageDescription() {
    const storageModeDesc = document.getElementById('storageModeDesc');
    if (!storageModeDesc) return;

    if (storageConfig.neverDelete) {
        storageModeDesc.textContent = '文件永久保存在服务器，支持异步下载';
    } else if (storageConfig.deleteOnDownload) {
        storageModeDesc.textContent = '文件暂存服务器，接收方下载后立即删除';
    } else {
        const hours = storageConfig.fileRetentionHours || 24;
        storageModeDesc.textContent = `文件暂存${hours}小时，支持异步下载`;
    }
}

// 心跳机制：保持会话活跃
function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (socket && wsConnected) {
            socket.send(JSON.stringify({ type: 'heartbeat' }));
        }
    }, 60 * 1000); // 每60秒发送一次心跳
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// 更新取件码提示文本
function updateCodeHint() {
    const codeHint = document.getElementById('codeHint');
    if (!codeHint) return;

    if (transferMode === 'storage') {
        if (storageConfig.neverDelete) {
            codeHint.textContent = '请将此码分享给接收方 (文件永久有效)';
        } else if (storageConfig.deleteOnDownload) {
            codeHint.textContent = '请将此码分享给接收方 (下载后文件自动删除)';
        } else {
            const hours = storageConfig.fileRetentionHours || 24;
            codeHint.textContent = `请将此码分享给接收方 (${hours}小时内有效)`;
        }
    } else {
        codeHint.textContent = '请将此码分享给接收方 (发送端需保持在线)';
    }
}

// 处理文件选择
function handleFileSelect(file) {
    selectedFile = file;
    transferCompleted = false; // 重置传输完成标志

    // 显示文件信息
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    // 切换到生成取件码阶段
    showStage('code-generate-stage');

    // 更新传输模式选项显示
    updateTransferModeOptions();
    updateStorageDescription();

    // 绑定传输模式选择事件
    document.querySelectorAll('input[name="transferMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            transferMode = e.target.value;
            console.log('切换传输模式:', transferMode);
        });
    });
}

// 生成取件码
async function generateCode() {
    if (!selectedFile) return;

    const generateBtn = document.getElementById('generateCodeBtn');

    // 获取选中的传输模式
    const selectedMode = document.querySelector('input[name="transferMode"]:checked');

    // 检查是否选择了传输模式
    if (!selectedMode) {
        alert('请先选择传输方式！');
        return;
    }

    transferMode = selectedMode.value;
    originalTransferMode = transferMode;
    storageFallbackTriggered = false;

    // 验证所选模式是否可用
    if (!availableFeatures[transferMode === 'memory' ? 'memoryStreaming' :
                          transferMode === 'storage' ? 'serverStorage' :
                          'p2pDirect']) {
        alert('所选传输方式已被管理员禁用，请选择其他方式！');
        return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = '处理中...';

    if (transferMode === 'storage') {
        // 服务器存储模式：分块上传文件
        await uploadFileToServerChunked();
    } else if (transferMode === 'p2p') {
        // P2P 模式：先创建 p2p 会话，连接阶段协商 DataChannel
        createMemoryStreamSession('p2p');
    } else {
        // 内存流式传输模式
        createMemoryStreamSession();
    }
}

// 创建内存流式传输会话
function createMemoryStreamSession(requestedMode = 'memory') {
    wsSend('create-session', {
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        mode: requestedMode
    });
}

// 上传文件到服务器
async function uploadFileToServer() {
    showStage('transfer-stage');
    statusText.textContent = '正在上传文件到服务器...';
    transferStartTime = Date.now();

    const xhr = new XMLHttpRequest();

    return new Promise((resolve, reject) => {
        // 上传进度监听
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percent = (e.loaded / e.total) * 100;
                updateProgress(percent);

                const elapsed = (Date.now() - transferStartTime) / 1000;
                const speed = e.loaded / elapsed;
                transferSpeed.textContent = `${formatFileSize(speed)}/s`;

                statusText.textContent = `正在上传文件到服务器... ${percent.toFixed(1)}%`;
            }
        });

        // 上传完成
        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                try {
                    const data = JSON.parse(xhr.responseText);

                    if (data.success) {
                        pickupCode = data.pickupCode;
                        pickupCodeDisplay.textContent = pickupCode;

                        let statusMessage = '文件已上传到服务器';
                        if (data.neverDelete) {
                            statusMessage += '，文件永久保存';
                        } else if (data.deleteOnDownload) {
                            statusMessage += '，接收方下载后自动删除';
                        } else {
                            const retentionHours = data.retentionHours || 24;
                            statusMessage += `，${retentionHours}小时内有效`;
                        }
                        statusText.textContent = statusMessage;
                        setStatusBadge('success');

                        updateCodeHint();
                        showStage('waiting-stage');

                        resolve(data);
                    } else {
                        alert(data.message || '文件上传失败');
                        const generateBtn = document.getElementById('generateCodeBtn');
                        generateBtn.disabled = false;
                        generateBtn.textContent = '生成取件码';
                        reject(new Error(data.message || '上传失败'));
                    }
                } catch (error) {
                    alert('解析服务器响应失败');
                    const generateBtn = document.getElementById('generateCodeBtn');
                    generateBtn.disabled = false;
                    generateBtn.textContent = '生成取件码';
                    reject(error);
                }
            } else {
                alert('上传失败，HTTP状态码：' + xhr.status);
                const generateBtn = document.getElementById('generateCodeBtn');
                generateBtn.disabled = false;
                generateBtn.textContent = '生成取件码';
                reject(new Error('HTTP Error: ' + xhr.status));
            }
        });

        // 上传错误
        xhr.addEventListener('error', () => {
            alert('网络错误，文件上传失败');
            const generateBtn = document.getElementById('generateCodeBtn');
            generateBtn.disabled = false;
            generateBtn.textContent = '生成取件码';
            reject(new Error('Network Error'));
        });

        // 准备并发送请求
        const formData = new FormData();
        formData.append('file', selectedFile);

        xhr.open('POST', '/api/upload-file');
        xhr.send(formData);
    });
}

// 生成唯一取件码
function generatePickupCode() {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// 上传单个块
async function uploadChunk(file, fileID, chunkIndex, totalChunks, chunkSize, uploadState) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);

    const formData = new FormData();
    formData.append('fileID', fileID);
    formData.append('chunkIndex', chunkIndex.toString());
    formData.append('totalChunks', totalChunks.toString());
    formData.append('chunk', chunk);

    const startTime = Date.now();
    uploadState.chunksInFlight.set(chunkIndex, { startTime });

    try {
        const response = await fetch('/api/upload-chunk', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                uploadState.completedChunks.add(chunkIndex);
                uploadState.chunksInFlight.delete(chunkIndex);
                uploadState.uploadedBytes += (end - start);
            } else {
                throw new Error(data.message || 'Upload failed');
            }
        } else {
            throw new Error('HTTP Error: ' + response.status);
        }
    } catch (error) {
        console.error(`[上传] 块 ${chunkIndex} 失败:`, error);
        uploadState.failedChunks.set(chunkIndex, error);
        uploadState.chunksInFlight.delete(chunkIndex);
        // 重传逻辑：将失败的块重新加入队列
        uploadState.nextChunkToSend = Math.min(uploadState.nextChunkToSend, chunkIndex);
    }
}

// 等待块完成
function waitForChunkCompletion(uploadState) {
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            if (uploadState.chunksInFlight.size === 0 ||
                uploadState.completedChunks.size + uploadState.failedChunks.size > 0) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);
    });
}

// 合并所有块
async function mergeChunks(fileID, totalChunks, fileName, fileSize) {
    const response = await fetch('/api/merge-chunks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            fileID,
            totalChunks,
            fileName,
            fileSize
        })
    });

    if (response.ok) {
        return await response.json();
    } else {
        const errorText = await response.text();
        throw new Error('Merge failed: ' + errorText);
    }
}

// 分块上传到服务器
async function uploadFileToServerChunked() {
    showStage('transfer-stage');
    statusText.textContent = '正在上传文件到服务器...';
    transferStartTime = Date.now();

    const CHUNK_SIZE = 512 * 1024; // 固定 512KB
    const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE);
    const fileID = generatePickupCode(); // 生成唯一 ID 作为取件码

    // 注册分块上传会话（用于断开时清理）
    if (socket && wsConnected) {
        wsSend('register-chunk-upload', { fileID });
    }

    // 滑动窗口配置
    const windowConfig = { initial: 4, min: 2, max: 8 };
    let currentWindow = windowConfig.initial;

    // 上传状态
    const uploadState = {
        nextChunkToSend: 0,
        chunksInFlight: new Map(),
        completedChunks: new Set(),
        failedChunks: new Map(),
        uploadedBytes: 0
    };

    // 并行上传逻辑
    try {
        while (uploadState.completedChunks.size < totalChunks) {
            // 发送窗口内的块
            const promises = [];
            while (uploadState.chunksInFlight.size < currentWindow &&
                   uploadState.nextChunkToSend < totalChunks) {
                const chunkIndex = uploadState.nextChunkToSend++;
                promises.push(uploadChunk(selectedFile, fileID, chunkIndex, totalChunks, CHUNK_SIZE, uploadState));
            }

            // 等待至少一个块完成
            if (promises.length > 0) {
                await Promise.race(promises);
            }
            await waitForChunkCompletion(uploadState);

            // 更新进度
            const percent = (uploadState.completedChunks.size / totalChunks) * 100;
            updateProgress(percent);

            const elapsed = (Date.now() - transferStartTime) / 1000;
            const speed = uploadState.uploadedBytes / elapsed;
            transferSpeed.textContent = `${formatFileSize(speed)}/s`;
            statusText.textContent = `正在上传文件到服务器... ${percent.toFixed(1)}%`;

            // 调整窗口大小（AIMD）
            if (uploadState.failedChunks.size > 0) {
                currentWindow = Math.max(Math.floor(currentWindow / 2), windowConfig.min);
                uploadState.failedChunks.clear();
            } else if (uploadState.completedChunks.size > 0) {
                currentWindow = Math.min(currentWindow + 1, windowConfig.max);
            }
        }

        // 所有块上传完成，通知服务器合并
        statusText.textContent = '正在合并文件...';
        const mergeResult = await mergeChunks(fileID, totalChunks, selectedFile.name, selectedFile.size);

        if (mergeResult.success) {
            // 通知服务器上传完成，清除跟踪
            if (socket && wsConnected) {
                wsSend('chunk-upload-complete', { fileID });
            }

            pickupCode = mergeResult.pickupCode;
            pickupCodeDisplay.textContent = pickupCode;

            let statusMessage = '文件已上传到服务器';
            if (mergeResult.neverDelete) {
                statusMessage += '，文件永久保存';
            } else if (mergeResult.deleteOnDownload) {
                statusMessage += '，接收方下载后自动删除';
            } else {
                const retentionHours = storageConfig.fileRetentionHours || 24;
                statusMessage += `，${retentionHours}小时内有效`;
            }
            statusText.textContent = statusMessage;
            setStatusBadge('success');

            updateCodeHint();
            showShareSection(pickupCode);
            showStage('waiting-stage');

            return mergeResult;
        } else {
            throw new Error(mergeResult.message || '合并失败');
        }
    } catch (error) {
        alert('文件上传失败: ' + error.message);
        const generateBtn = document.getElementById('generateCodeBtn');
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.textContent = '生成取件码';
        }
        throw error;
    }
}

function createMemoryTransferState(file, code, chunkSize = 256 * 1024, windowConfig = null) {
    const totalChunks = Math.ceil(file.size / chunkSize);
    const chunkSizes = new Array(totalChunks).fill(chunkSize);
    if (totalChunks > 0) {
        const lastSize = file.size - (totalChunks - 1) * chunkSize;
        chunkSizes[totalChunks - 1] = lastSize > 0 ? lastSize : chunkSize;
    }

    // 使用接收端提供的窗口配置，或使用默认值
    const wc = windowConfig || { initial: INITIAL_WINDOW_SIZE, min: MIN_WINDOW_SIZE, max: MAX_WINDOW_SIZE };

    return {
        pickupCode: code,
        file,
        chunkSize,
        totalChunks,
        chunkSizes,
        expectedFileHash: '',
        nextToSend: 0,
        windowSize: wc.initial,
        minWindowSize: wc.min,
        maxWindowSize: wc.max,
        pending: new Map(),
        acked: new Set(),
        chunkCache: new Map(),
        chunkHashes: new Map(),
        repairQueue: [],
        transferEndSent: false,
        ackedBytes: 0,
        done: false,
        aborted: false,
        abortReason: '',
        lastAckAt: Date.now(),
        speedSampleWindow: []
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sha256OfArrayBuffer(buffer) {
    // 检测 crypto.subtle 是否可用（HTTPS 或 localhost）
    if (window.crypto && window.crypto.subtle) {
        try {
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            const bytes = new Uint8Array(digest);
            return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn('[SHA256] Web Crypto API 失败，降级到纯 JS 实现:', e);
        }
    }

    // 降级到纯 JS 实现（HTTP 协议下）
    if (typeof sha256 !== 'undefined') {
        const bytes = new Uint8Array(buffer);
        return sha256(bytes);
    }

    // 如果都不可用，返回空字符串（跳过哈希校验）
    console.warn('[SHA256] 无法计算哈希，跳过校验');
    return '';
}

function pruneChunkCache(state) {
    const maxKeep = Math.max(state.windowSize + CACHE_SLACK_CHUNKS, MIN_WINDOW_SIZE + CACHE_SLACK_CHUNKS);
    if (state.chunkCache.size <= maxKeep) {
        return;
    }

    const removable = [];
    for (const chunkIndex of state.chunkCache.keys()) {
        if (!state.pending.has(chunkIndex) && !state.repairQueue.includes(chunkIndex)) {
            removable.push(chunkIndex);
        }
    }

    for (const chunkIndex of removable) {
        state.chunkCache.delete(chunkIndex);
        state.chunkHashes.delete(chunkIndex);
        if (state.chunkCache.size <= maxKeep) {
            break;
        }
    }
}

async function getChunkWithHash(state, chunkIndex) {
    if (state.chunkCache.has(chunkIndex) && state.chunkHashes.has(chunkIndex)) {
        return {
            buffer: state.chunkCache.get(chunkIndex),
            chunkHash: state.chunkHashes.get(chunkIndex)
        };
    }

    const start = chunkIndex * state.chunkSize;
    const end = Math.min(start + state.chunkSize, state.file.size);
    const buffer = await state.file.slice(start, end).arrayBuffer();
    const chunkHash = await sha256OfArrayBuffer(buffer);
    state.chunkCache.set(chunkIndex, buffer);
    state.chunkHashes.set(chunkIndex, chunkHash);
    pruneChunkCache(state);
    return { buffer, chunkHash };
}

async function waitForTransportDrain(maxBufferedAmount, dataChannel = null) {
    if (dataChannel) {
        while (dataChannel.readyState === 'open' && dataChannel.bufferedAmount > maxBufferedAmount) {
            if (memoryTransferState && memoryTransferState.aborted) return;
            await sleep(12);
        }
        return;
    }

    const drainStart = Date.now();
    while (socket && socket.bufferedAmount > maxBufferedAmount) {
        if (memoryTransferState && memoryTransferState.aborted) return;
        if (Date.now() - drainStart > 5000) {
            if (memoryTransferState) {
                memoryTransferState.aborted = true;
                memoryTransferState.abortReason = '接收端已断开连接';
            }
            return;
        }
        await sleep(12);
    }
}

async function sendChunkWithMeta(state, chunkIndex, isRetry, dataChannel = null) {
    if (dataChannel) {
        if (dataChannel.readyState !== 'open') {
            state.aborted = true;
            state.abortReason = 'P2P 数据通道已断开';
            return;
        }
    } else if (!socket || socket.readyState !== WebSocket.OPEN) {
        state.aborted = true;
        state.abortReason = '连接已断开';
        return;
    }

    await waitForTransportDrain(8 * 1024 * 1024, dataChannel);

    const { buffer, chunkHash } = await getChunkWithHash(state, chunkIndex);
    wsSend('chunk-meta', {
        pickupCode: state.pickupCode,
        chunkIndex,
        totalChunks: state.totalChunks,
        chunkSize: state.chunkSizes[chunkIndex],
        chunkHash,
        retry: !!isRetry
    });

    if (dataChannel) {
        dataChannel.send(buffer);
    } else {
        socket.send(buffer);
    }

    const prev = state.pending.get(chunkIndex);
    state.pending.set(chunkIndex, {
        lastSentAt: Date.now(),
        retries: prev ? prev.retries + (isRetry ? 1 : 0) : (isRetry ? 1 : 0)
    });
}

async function retransmitTimedOutChunks(state, dataChannel = null) {
    const now = Date.now();
    for (const [chunkIndex, p] of state.pending.entries()) {
        if (state.acked.has(chunkIndex)) {
            state.pending.delete(chunkIndex);
            continue;
        }
        if (now-p.lastSentAt < ACK_TIMEOUT_MS) {
            continue;
        }
        if (p.retries >= MAX_RETRY_PER_CHUNK) {
            state.aborted = true;
            state.abortReason = `分块 #${chunkIndex} 重试次数超限`;
            return;
        }
        const minWindow = state.minWindowSize || MIN_WINDOW_SIZE;
        state.windowSize = Math.max(minWindow, Math.floor(state.windowSize / 2));
        await sendChunkWithMeta(state, chunkIndex, true, dataChannel);
    }
}

async function sendRepairChunks(state, dataChannel = null) {
    if (!Array.isArray(state.repairQueue) || state.repairQueue.length === 0) {
        return;
    }

    const batch = state.repairQueue.splice(0, MAX_NACK_REPAIR_BATCH);
    for (const chunkIndex of batch) {
        if (state.aborted) {
            return;
        }
        await sendChunkWithMeta(state, chunkIndex, true, dataChannel);
    }
}

function updateAckDrivenProgress(state) {
    const progress = state.totalChunks > 0 ? (state.acked.size / state.totalChunks) * 100 : 100;
    updateProgress(progress);

    const now = Date.now();
    state.speedSampleWindow.push({ t: now, bytes: state.ackedBytes });
    while (state.speedSampleWindow.length > 1 && now - state.speedSampleWindow[0].t > SPEED_WINDOW_MS) {
        state.speedSampleWindow.shift();
    }

    if (state.speedSampleWindow.length > 1) {
        const first = state.speedSampleWindow[0];
        const last = state.speedSampleWindow[state.speedSampleWindow.length - 1];
        const elapsed = Math.max((last.t - first.t) / 1000, 0.001);
        const delta = Math.max(last.bytes - first.bytes, 0);
        transferSpeed.textContent = `${formatFileSize(delta / elapsed)}/s`;
    }
}

// P2P 滑动窗口传输
async function startSimpleP2PTransfer() {
    if (!selectedFile || !pickupCode || !p2pDataChannel) return;

    console.log('🚀 开始 P2P 滑动窗口传输（2/4/2）');

    showStage('transfer-stage');
    transferStartTime = Date.now();
    isTransferring = true;
    statusText.textContent = '正在通过 P2P 直连传输...';

    // 发送文件元数据
    p2pDataChannel.send(JSON.stringify({
        type: 'metadata',
        name: selectedFile.name,
        size: selectedFile.size,
        mimeType: selectedFile.type
    }));
    console.log('📦 已发送文件元数据');

    // 发送开始传输信号
    p2pDataChannel.send(JSON.stringify({ type: 'start-transfer' }));

    // 分块大小：256KB（WebRTC DataChannel SCTP 消息上限约 256KB）
    const chunkSize = 262144; // 256KB
    const fileSize = selectedFile.size;
    const totalChunks = Math.ceil(fileSize / chunkSize);

    // 滑动窗口配置
    const P2P_WINDOW_INITIAL = 2;
    const P2P_WINDOW_MAX = 4;
    const P2P_WINDOW_MIN = 2;
    const P2P_ACK_TIMEOUT = 5000;
    const P2P_MAX_RETRIES = 3;

    let windowSize = P2P_WINDOW_INITIAL;
    let nextToSend = 0;           // 下一个要发送的块索引
    let ackedCount = 0;           // 已确认的块数
    const ackedSet = new Set();   // 已确认的块索引集合
    const inFlight = new Map();   // 在途块: chunkIndex -> { sentAt, retries }
    const retryQueue = [];        // 需要重传的块索引
    let aborted = false;
    let abortReason = '';

    // 速度统计
    let ackedBytes = 0;
    const speedSamples = [];
    let lastProgressUpdate = Date.now();

    console.log(`📊 分块: ${chunkSize}B (${(chunkSize/1024)}KB), 总块数: ${totalChunks}, 窗口: ${P2P_WINDOW_INITIAL}/${P2P_WINDOW_MAX}/${P2P_WINDOW_MIN}`);

    // 保存原始的 onmessage 处理器
    const originalOnMessage = p2pDataChannel.onmessage;

    // 设置 ACK/NACK 处理器
    p2pDataChannel.onmessage = (evt) => {
        if (typeof evt.data !== 'string') return;
        try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'ack') {
                const idx = msg.index;
                if (!ackedSet.has(idx)) {
                    ackedSet.add(idx);
                    ackedCount++;
                    // 计算该块大小
                    const start = idx * chunkSize;
                    const end = Math.min(start + chunkSize, fileSize);
                    ackedBytes += (end - start);
                    // 窗口增长（加法增大）
                    if (windowSize < P2P_WINDOW_MAX) {
                        windowSize = Math.min(windowSize + 1, P2P_WINDOW_MAX);
                    }
                }
                inFlight.delete(idx);
            } else if (msg.type === 'nack') {
                const idx = msg.index;
                inFlight.delete(idx);
                ackedSet.delete(idx);
                // 窗口缩小（乘法减小）
                windowSize = Math.max(Math.floor(windowSize / 2), P2P_WINDOW_MIN);
                // 加入重传队列
                if (!retryQueue.includes(idx)) {
                    retryQueue.push(idx);
                }
                console.warn(`⚠️ 块 ${idx} NACK，窗口缩小到 ${windowSize}`);
            }
        } catch (e) {}
    };

    // 发送单个块（不等待 ACK）
    async function sendChunk(chunkIndex, isRetry = false) {
        if (aborted) return;
        if (!p2pDataChannel || p2pDataChannel.readyState !== 'open') {
            aborted = true;
            abortReason = 'P2P 数据通道已断开';
            return;
        }

        // 等待缓冲区
        const drainStart = Date.now();
        while (p2pDataChannel.readyState === 'open' && p2pDataChannel.bufferedAmount > 4 * 1024 * 1024) {
            if (Date.now() - drainStart > 5000) {
                aborted = true;
                abortReason = '接收端已断开连接';
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        if (aborted || !p2pDataChannel || p2pDataChannel.readyState !== 'open') return;

        // 读取块数据
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, fileSize);
        const chunkData = await selectedFile.slice(start, end).arrayBuffer();

        // 计算哈希
        const hashHex = sha256(new Uint8Array(chunkData));

        // 发送元数据
        p2pDataChannel.send(JSON.stringify({
            type: 'chunk-meta',
            index: chunkIndex,
            hash: hashHex
        }));

        // 发送二进制数据
        p2pDataChannel.send(chunkData);

        // 记录在途状态
        const prev = inFlight.get(chunkIndex);
        inFlight.set(chunkIndex, {
            sentAt: Date.now(),
            retries: prev ? prev.retries + (isRetry ? 1 : 0) : (isRetry ? 1 : 0)
        });
    }

    // 检查超时的在途块
    function checkTimeouts() {
        const now = Date.now();
        for (const [idx, info] of inFlight.entries()) {
            if (ackedSet.has(idx)) {
                inFlight.delete(idx);
                continue;
            }
            if (now - info.sentAt >= P2P_ACK_TIMEOUT) {
                if (info.retries >= P2P_MAX_RETRIES) {
                    aborted = true;
                    abortReason = `块 #${idx} 重试次数超限 (${P2P_MAX_RETRIES})`;
                    return;
                }
                inFlight.delete(idx);
                if (!retryQueue.includes(idx)) {
                    retryQueue.push(idx);
                }
                // 超时缩小窗口
                windowSize = Math.max(Math.floor(windowSize / 2), P2P_WINDOW_MIN);
                console.warn(`⚠️ 块 ${idx} ACK 超时，加入重传队列，窗口: ${windowSize}`);
            }
        }
    }

    // 更新进度
    function updateP2PProgress() {
        const now = Date.now();
        if (now - lastProgressUpdate < 100 && ackedCount < totalChunks) return;
        lastProgressUpdate = now;

        const progress = totalChunks > 0 ? (ackedCount / totalChunks) * 100 : 0;
        updateProgress(Math.min(progress, 100));

        speedSamples.push({ t: now, bytes: ackedBytes });
        while (speedSamples.length > 1 && now - speedSamples[0].t > 1800) {
            speedSamples.shift();
        }
        if (speedSamples.length > 1) {
            const first = speedSamples[0];
            const last = speedSamples[speedSamples.length - 1];
            const elapsed = Math.max((last.t - first.t) / 1000, 0.001);
            const delta = Math.max(last.bytes - first.bytes, 0);
            transferSpeed.textContent = `${formatFileSize(delta / elapsed)}/s`;
        }
    }

    // 主传输循环
    try {
        while (ackedCount < totalChunks && !aborted) {
            // 1. 优先处理重传队列
            while (retryQueue.length > 0 && inFlight.size < windowSize && !aborted) {
                const retryIdx = retryQueue.shift();
                if (!ackedSet.has(retryIdx)) {
                    await sendChunk(retryIdx, true);
                }
            }

            // 2. 发送新块，填满窗口
            while (nextToSend < totalChunks && inFlight.size < windowSize && !aborted) {
                await sendChunk(nextToSend, false);
                nextToSend++;
            }

            // 3. 检查超时
            checkTimeouts();

            // 4. 更新进度
            updateP2PProgress();

            // 5. 短暂等待，避免忙循环
            if (ackedCount < totalChunks && !aborted) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }

        if (aborted) {
            throw new Error(abortReason || '传输中止');
        }

        console.log('✅ P2P 滑动窗口传输完成');
        updateProgress(100);

        // 发送完成标记
        p2pDataChannel.send(JSON.stringify({ type: 'complete' }));

        statusText.textContent = '文件发送完成，等待接收方确认...';
        isTransferring = false;

        // 监听接收端的 transfer-complete 确认消息
        p2pDataChannel.onmessage = (evt) => {
            if (typeof evt.data === 'string') {
                try {
                    const msg = JSON.parse(evt.data);
                    if (msg.type === 'transfer-complete') {
                        console.log('✅ 接收端确认传输完成');
                        statusText.textContent = '传输完成！';
                        setStatusBadge('success');
                        showStage('complete-stage');
                        p2pDataChannel.onmessage = originalOnMessage;
                    }
                } catch (e) {}
            }
        };

        // 超时兜底：5 秒后如果没收到确认，也显示完成
        setTimeout(() => {
            if (statusText.textContent === '文件发送完成，等待接收方确认...') {
                console.log('⚠️ 未收到接收端确认，自动标记完成');
                statusText.textContent = '传输完成！';
                setStatusBadge('success');
                showStage('complete-stage');
                p2pDataChannel.onmessage = originalOnMessage;
            }
        }, 5000);

    } catch (error) {
        console.error('❌ 传输失败:', error);
        const reason = error.message || '传输失败';
        statusText.textContent = reason;
        setStatusBadge('error');
        // 更新传输阶段可见元素
        const tsEl = document.getElementById('transferSpeed');
        const ppEl = document.getElementById('progressPercent');
        if (tsEl) tsEl.textContent = reason;
        if (ppEl) ppEl.textContent = '已中断';
        isTransferring = false;
        p2pDataChannel.onmessage = originalOnMessage;
    }
}

// 开始文件传输
async function startFileTransfer(channel = 'memory') {
    if (!selectedFile || !pickupCode) return;

    // 防止重复传输
    if (transferCompleted) {
        console.log('⚠️ 传输已完成，忽略重复请求');
        return;
    }

    const useP2P = channel === 'p2p' && p2pDataChannel && p2pDataChannel.readyState === 'open';

    // P2P 模式：使用简单传输（旧版本实现）
    if (useP2P) {
        await startSimpleP2PTransfer();
        transferCompleted = true; // 标记传输完成
        return;
    }

    // 内存流式传输模式：使用原有复杂逻辑
    showStage('transfer-stage');
    transferStartTime = Date.now();
    isTransferring = true;

    const chunkSize = 512 * 1024; // 固定 512KB
    const windowConfig = { initial: 4, min: 2, max: 8 };

    console.log('[调试] 传输模式: 内存流式');
    console.log('[调试] 分块大小:', chunkSize, '窗口配置:', windowConfig);

    memoryTransferState = createMemoryTransferState(selectedFile, pickupCode, chunkSize, windowConfig);
    const state = memoryTransferState;

    statusText.textContent = '正在传输文件...';

    wsSend('transfer-start', {
        pickupCode,
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        totalChunks: state.totalChunks,
        chunkSize: state.chunkSize,
        fileHash: '',
        integrityMode: 'chunk-sha256',
        progressMode: 'ack-bytes',
        dataPlane: 'memory'
    });

    while (isTransferring && !state.aborted) {
        await sendRepairChunks(state, null);

        while (
            state.nextToSend < state.totalChunks &&
            state.pending.size < state.windowSize &&
            !state.aborted
        ) {
            await sendChunkWithMeta(state, state.nextToSend, false, null);
            state.nextToSend++;
        }

        await retransmitTimedOutChunks(state, null);
        updateAckDrivenProgress(state);

        const allChunksAcked = state.acked.size >= state.totalChunks;
        const noPending = state.pending.size === 0;
        const noRepairPending = !state.repairQueue || state.repairQueue.length === 0;

        if (allChunksAcked && noPending && noRepairPending) {
            if (!state.transferEndSent) {
                wsSend('transfer-end', {
                    pickupCode,
                    totalChunks: state.totalChunks,
                    dataPlane: 'memory'
                });
                state.transferEndSent = true;
                statusText.textContent = '数据发送完成，等待接收方校验确认...';
            }

            if (state.done || state.aborted || !isTransferring) {
                break;
            }
        }

        await sleep(4);
    }

    if (state.aborted) {
        isTransferring = false;
        const reason = state.abortReason || '传输失败';
        statusText.textContent = reason;
        setStatusBadge('error');
        // 更新传输阶段可见元素
        const transferSpeed = document.getElementById('transferSpeed');
        const progressPercent = document.getElementById('progressPercent');
        if (transferSpeed) transferSpeed.textContent = reason;
        if (progressPercent) progressPercent.textContent = '已中断';
        return;
    }

    if (!isTransferring) return;
}

// 更新传输进度
function updateProgress(progress) {
    const percent = Math.round(progress);
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
}

// 显示指定阶段
function showStage(stageId) {
    document.querySelectorAll('.stage').forEach(stage => {
        stage.classList.remove('active');
    });
    document.getElementById(stageId).classList.add('active');
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 生成分享链接
function getShareLink(code) {
    const origin = window.location.origin;
    return `${origin}/receive?token=${code}`;
}

// 显示分享区域（二维码 + 复制链接按钮）
function showShareSection(code) {
    const shareSection = document.getElementById('shareSection');
    const qrcodeContainer = document.getElementById('qrcodeContainer');
    if (!shareSection || !qrcodeContainer) return;

    // 清空旧二维码
    qrcodeContainer.innerHTML = '';

    const shareLink = getShareLink(code);

    // 生成二维码
    if (typeof QRCode !== 'undefined') {
        new QRCode(qrcodeContainer, {
            text: shareLink,
            width: 160,
            height: 160,
            colorDark: '#1f2937',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    }

    shareSection.style.display = 'flex';
}

// 复制分享链接（点击二维码触发）
function copyShareLink() {
    if (!pickupCode) return;
    const shareLink = getShareLink(pickupCode);
    const hint = document.getElementById('qrcodeHint');

    function showCopied() {
        if (hint) {
            hint.textContent = '链接已复制';
            hint.style.color = 'var(--primary-color)';
            setTimeout(() => {
                hint.textContent = '扫码或点击二维码复制链接';
                hint.style.color = 'var(--text-sub)';
            }, 1500);
        }
    }

    navigator.clipboard.writeText(shareLink).then(showCopied).catch(() => {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = shareLink;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showCopied();
    });
}

// P2P NAT 信息处理（发送端）
function handleP2PNATInfoOnSender(msg) {
    const payload = msg.payload || {};
    if (payload.pickupCode !== pickupCode) return;

    if (payload.role === 'receiver') {
        receiverNATInfoOnSender = payload.natType;
        console.log('[P2P] 收到接收端NAT信息:', receiverNATInfoOnSender);
        if (senderNATInfo) {
            updateSenderNATDisplay(senderNATInfo, receiverNATInfoOnSender);
        }
    }
}

function updateSenderNATDisplay(senderNAT, receiverNAT) {
    const container = document.getElementById('senderNatDisplay');
    if (!container) return;
    if (!senderNAT) return;

    let totalSuccess = senderNAT.success;
    if (receiverNAT) {
        totalSuccess = Math.min(senderNAT.success, receiverNAT.success);
        if (senderNAT.success >= 90 && receiverNAT.success >= 90) {
            totalSuccess = Math.min(95, (senderNAT.success + receiverNAT.success) / 2);
        }
    }

    container.innerHTML = `
        <div class="nat-detection" style="margin-top: 20px;">
            <h4 style="margin-bottom: 15px; color: var(--text-main);">P2P 连接状态</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                <div class="nat-box" style="background: rgba(255,255,255,0.5); padding: 12px; border-radius: 10px;">
                    <div style="font-weight: 600; margin-bottom: 8px; color: var(--primary-color);">发送端</div>
                    <div style="font-size: 0.9rem; color: var(--text-main);">
                        <span class="nat-type" style="font-size: 0.85rem;">${senderNAT.type} - ${senderNAT.name}</span>
                    </div>
                </div>
                <div class="nat-box" style="background: rgba(255,255,255,0.5); padding: 12px; border-radius: 10px;">
                    <div style="font-weight: 600; margin-bottom: 8px; color: var(--secondary-color, var(--primary-color));">接收端</div>
                    <div style="font-size: 0.9rem; color: var(--text-main);">
                        ${receiverNAT ?
                            `<span class="nat-type" style="font-size: 0.85rem;">${receiverNAT.type} - ${receiverNAT.name}</span>` :
                            `<span style="color: var(--text-sub);">检测中...</span>`}
                    </div>
                </div>
            </div>
            <div class="nat-info" style="background: rgba(99, 102, 241, 0.1); padding: 15px; border-radius: 10px; display: block; text-align: center;">
                <strong style="color: var(--text-main); font-size: 1.1rem;">预计连接成功率</strong>
                <div class="nat-success-rate" style="font-size: 2.5rem; margin: 10px 0;">${Math.round(totalSuccess)}%</div>
                <p style="font-size: 0.85rem; color: var(--text-sub); margin: 0;">
                    ${receiverNAT ? getP2PTips(senderNAT, receiverNAT) : '等待接收端信息后显示详细建议'}
                </p>
            </div>
        </div>
    `;
}

function getP2PTips(senderNAT, receiverNAT) {
    const minSuccess = Math.min(senderNAT.success, receiverNAT.success);
    if (minSuccess >= 90) return '双方网络环境极佳，P2P连接成功率很高';
    if (minSuccess >= 75) return '网络环境良好，P2P连接应该能建立';
    if (minSuccess >= 50) return '网络环境一般，P2P连接可能需要一些时间';
    return '网络环境较差，建议使用服务器中转模式';
}

function getFileType(name) {
    const ext = name.split('.').pop().toLowerCase();
    const types = {
        'pdf': 'PDF 文档', 'doc': 'Word 文档', 'docx': 'Word 文档',
        'xls': 'Excel 文件', 'xlsx': 'Excel 文件',
        'ppt': 'PPT 演示文稿', 'pptx': 'PPT 演示文稿',
        'txt': '文本文件', 'md': 'Markdown 文件',
        'jpg': 'JPEG 图片', 'jpeg': 'JPEG 图片', 'png': 'PNG 图片',
        'gif': 'GIF 图片', 'svg': 'SVG 图片',
        'mp4': 'MP4 视频', 'mov': 'MOV 视频', 'avi': 'AVI 视频',
        'mp3': 'MP3 音频', 'wav': 'WAV 音频',
        'zip': 'ZIP 压缩包', 'rar': 'RAR 压缩包', '7z': '7-Zip 压缩包',
        'apk': 'Android 安装包', 'exe': 'Windows 执行文件'
    };
    return types[ext] || `${ext.toUpperCase()} 文件`;
}
