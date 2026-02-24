// WebSocket 连接 (原生)
let socket = null;
let wsConnected = false;

// 全局变量
let currentPickupCode = null;
let expectedFileInfo = null;
let expectedFileHash = '';
let downloadStartTime = null;
let totalBytesReceived = 0;
let isConnecting = false;
let transferMode = null;
let memoryChunkBuffers = [];
let expectedMemoryChunks = 0;
let receivedMemoryChunks = 0;
let pendingChunkMetaQueue = [];
let pendingBinaryQueue = [];
let receivedChunkIndexSet = new Set();
let activeReceiveSink = null;
let outOfOrderChunkBuffer = new Map();
let nextChunkToPersist = 0;
let persistedBytes = 0;
let speedSampleWindow = [];
const SPEED_WINDOW_MS = 1800;
const MOBILE_MEMORY_LIMIT = 150 * 1024 * 1024;

// 移动设备检测
function isMobileDevice() {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
        return navigator.userAgentData.mobile;
    }
    if (navigator.maxTouchPoints > 2 && /Macintosh/.test(navigator.userAgent)) {
        return true;
    }
    return /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
}

let p2pPeerConnection = null;
let p2pDataChannel = null;
let pendingIceCandidates = []; // ICE candidate 缓存队列
let p2pIceRestartCount = 0; // ICE restart 已尝试次数
const P2P_MAX_ICE_RESTARTS = 2; // 最多尝试 ICE restart 次数
let p2pIceRestartTime = 0; // 上次 ICE restart 的时间戳
const P2P_ICE_RESTART_COOLDOWN = 8000; // ICE restart 后的冷却期（毫秒）
let signalProcessing = false; // 信令消息串行锁
let signalQueue = []; // 信令消息等待队列
let pendingJoinCode = '';
let p2pJoinTried = false;
let joinFallbackTimer = null;
let sinkReadyResendTimer = null;
let sinkReadyResendAttempts = 0;
const SINK_READY_RESEND_INTERVAL_MS = 900;
const SINK_READY_RESEND_MAX_ATTEMPTS = 10;
let dataTimeoutTimer = null;
const DATA_TIMEOUT_MS = 5000;
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

// NAT 信息
let senderNATInfo = null;
let receiverNATInfo = null;

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

// 检测浏览器能力
function detectCapabilities() {
    // 检查是否在安全上下文中（HTTPS 或 localhost）
    const isSecureContext = window.isSecureContext ||
                           location.protocol === 'https:' ||
                           location.hostname === 'localhost' ||
                           location.hostname === '127.0.0.1';

    // File System Access API 只在安全上下文中可用
    const supportsFileSystemAccess = isSecureContext &&
                                     typeof window.showSaveFilePicker === 'function';

    return {
        fileSystemAccess: supportsFileSystemAccess,
        preferredChunkSize: 512 * 1024,
        windowConfig: { initial: 4, min: 2, max: 8 },
        // P2P 传输参数（不再使用，发送端硬编码 256KB/2/4/2）
        p2pChunkSize: 256 * 1024,
        p2pWindowConfig: { initial: 2, min: 2, max: 4 }
    };
}

// DOM 元素
const pickupCodeInput = document.getElementById('pickupCodeInput');
const connectBtn = document.getElementById('connectBtn');
const previewFileName = document.getElementById('previewFileName');
const previewFileSize = document.getElementById('previewFileSize');
const previewFileType = document.getElementById('previewFileType');
const downloadProgressFill = document.getElementById('downloadProgressFill');
const downloadProgressPercent = document.getElementById('downloadProgressPercent');
const downloadSpeed = document.getElementById('downloadSpeed');
const downloadFileName = document.getElementById('downloadFileName');
const errorText = document.getElementById('errorText');
const errorTitle = document.getElementById('errorTitle');
const verifyResultText = document.getElementById('verifyResultText');
const downloadCompleteText = document.getElementById('downloadCompleteText');

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    setupInputHandlers();
    setupWebSocket();

    // 从服务端同步主题
    fetch('/api/features').then(r => r.json()).then(data => {
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
    }).catch(() => {});

    // 检查 URL 参数，自动填入取件码
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    if (token && token.length === 4) {
        // 填入输入框
        pickupCodeInput.value = token.toUpperCase();
        // 更新显示的 code-box
        const codeBoxes = document.querySelectorAll('.code-box');
        for (let i = 0; i < 4; i++) {
            if (i < token.length) {
                codeBoxes[i].textContent = token[i].toUpperCase();
                codeBoxes[i].classList.add('filled');
                codeBoxes[i].classList.remove('active');
            }
        }
        // 等 WebSocket 连接建立后自动触发连接
        const waitAndConnect = setInterval(() => {
            if (wsConnected) {
                clearInterval(waitAndConnect);
                connectToSender();
            }
        }, 200);
        // 超时保护：5秒后停止等待
        setTimeout(() => clearInterval(waitAndConnect), 5000);
    }
});

// 连接 WebSocket
function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    socket = new WebSocket(wsUrl);

    socket.onopen = function() {
        console.log('[WS] 连接成功');
        wsConnected = true;
    };

    socket.onmessage = async function(event) {
        if (typeof event.data !== 'string') {
            await handleBinaryChunk(event.data);
            return;
        }

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
        setTimeout(setupWebSocket, 3000);
    };

    socket.onerror = function(error) {
        console.error('[WS] 错误:', error);
    };
}

function wsSend(type, payload) {
    if (socket && wsConnected) {
        socket.send(JSON.stringify({ type, payload }));
    }
}

function cleanupP2PResources() {
    pendingIceCandidates = [];
    signalQueue = [];
    signalProcessing = false;
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
            p2pPeerConnection.ondatachannel = null;
            p2pPeerConnection.close();
        } catch (_) {}
    }
    p2pPeerConnection = null;
}

function sendSignal(payload) {
    wsSend('signal', {
        pickupCode: currentPickupCode,
        ...payload
    });
}

async function setupP2PReceiverConnection() {
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

    p2pPeerConnection.onconnectionstatechange = () => {
        const state = p2pPeerConnection?.connectionState;
        console.log('[P2P 接收端] 连接状态:', state);
        if (state === 'failed') {
            if (p2pTransferCompleted) return;
            if (simpleP2PTotalReceived > 0) {
                const text = '发送端已断开连接';
                errorText.textContent = text;
                errorText.style.display = 'block';
                const dlSpeed = document.getElementById('downloadSpeed');
                const dlPercent = document.getElementById('downloadProgressPercent');
                if (dlSpeed) dlSpeed.textContent = text;
                if (dlPercent) dlPercent.textContent = '已中断';
                return;
            }
            // ICE restart 冷却期内忽略 failed 事件（restart 还在生效中）
            if (p2pIceRestartTime > 0 && (Date.now() - p2pIceRestartTime) < P2P_ICE_RESTART_COOLDOWN) {
                console.log('[P2P 接收端] ICE restart 冷却期内，忽略 failed 事件');
                return;
            }
            // ICE restart: 通知发送端重新协商
            if (p2pIceRestartCount < P2P_MAX_ICE_RESTARTS && p2pPeerConnection) {
                p2pIceRestartCount++;
                p2pIceRestartTime = Date.now();
                console.log(`[P2P 接收端] ICE 连接失败，请求发送端 ICE restart (${p2pIceRestartCount}/${P2P_MAX_ICE_RESTARTS})...`);
                sendSignal({ signalType: 'ice-restart-request' });
                return;
            }
            // 真正失败，提示用户
            console.error('[P2P 接收端] P2P 连接失败');
            errorText.textContent = 'P2P 连接失败，请返回重试或换用其他传输模式';
            errorText.style.display = 'block';
            const acceptBtn = document.getElementById('acceptBtn');
            if (acceptBtn) {
                acceptBtn.disabled = true;
                acceptBtn.textContent = '连接失败';
            }
        } else if (state === 'disconnected') {
            if (p2pTransferCompleted) return;
            if (simpleP2PTotalReceived > 0) {
                const text = '发送端连接中断，等待恢复...';
                const dlSpeed = document.getElementById('downloadSpeed');
                if (dlSpeed) dlSpeed.textContent = text;
            }
            // disconnected 不做处理，等待自动恢复或变为 failed
        } else if (state === 'connected') {
            p2pIceRestartCount = 0; // 连接成功，重置 restart 计数
            p2pIceRestartTime = 0;
        }
    };

    p2pPeerConnection.ondatachannel = (event) => {
        p2pDataChannel = event.channel;
        p2pDataChannel.binaryType = 'arraybuffer';

        // DataChannel 打开时启用接收按钮
        const enableAcceptBtn = () => {
            console.log('[P2P 接收端] DataChannel 已打开');
            const acceptBtn = document.getElementById('acceptBtn');
            if (acceptBtn) {
                acceptBtn.disabled = false;
                acceptBtn.textContent = '接收文件';
            }
        };

        if (p2pDataChannel.readyState === 'open') {
            enableAcceptBtn();
        } else {
            p2pDataChannel.onopen = enableAcceptBtn;
        }

        p2pDataChannel.onmessage = async (evt) => {
            if (typeof evt.data === 'string') {
                handleSimpleP2PData(evt.data);
            } else if (evt.data instanceof ArrayBuffer || evt.data instanceof Blob) {
                if (transferMode === 'p2p') {
                    handleSimpleP2PData(evt.data);
                } else {
                    await handleBinaryChunk(evt.data);
                }
            }
        };
        p2pDataChannel.onerror = (err) => {
            if (p2pTransferCompleted) return;
            console.warn('[P2P 接收端] DataChannel 错误:', err);
            if (simpleP2PTotalReceived > 0) {
                const text = '数据通道错误';
                errorText.textContent = text;
                errorText.style.display = 'block';
                const dlSpeed = document.getElementById('downloadSpeed');
                const dlPercent = document.getElementById('downloadProgressPercent');
                if (dlSpeed) dlSpeed.textContent = text;
                if (dlPercent) dlPercent.textContent = '已中断';
            }
        };
        p2pDataChannel.onclose = () => {
            if (p2pTransferCompleted) return;
            console.log('[P2P 接收端] DataChannel 已关闭');
            if (simpleP2PTotalReceived > 0) {
                const text = '发送端已断开连接';
                errorText.textContent = text;
                errorText.style.display = 'block';
                const dlSpeed = document.getElementById('downloadSpeed');
                const dlPercent = document.getElementById('downloadProgressPercent');
                if (dlSpeed) dlSpeed.textContent = text;
                if (dlPercent) dlPercent.textContent = '已中断';
            }
        };
    };
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
    if (!p2pPeerConnection || transferMode !== 'p2p') {
        // P2P 连接未建立时缓存 ICE candidate
        if (payload.signalType === 'ice-candidate' && payload.candidate) {
            pendingIceCandidates.push(payload.candidate);
        }
        return;
    }

    try {
        if (payload.signalType === 'offer' && payload.sdp) {
            await p2pPeerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            const answer = await p2pPeerConnection.createAnswer();
            await p2pPeerConnection.setLocalDescription(answer);
            sendSignal({ signalType: 'answer', sdp: answer });
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
        }
    } catch (error) {
        console.warn('[P2P] 信令处理异常（不放弃连接）:', error);
    }
}

function scheduleMemoryJoinFallback(code) {
    if (joinFallbackTimer) {
        clearTimeout(joinFallbackTimer);
    }

    joinFallbackTimer = setTimeout(() => {
        if (!isConnecting || !pendingJoinCode || pendingJoinCode !== code || !p2pJoinTried) {
            return;
        }

        wsSend('join-session', {
            pickupCode: code,
            mode: 'memory',
            capabilities: detectCapabilities()
        });
    }, 1800);
}

function clearJoinState() {
    if (joinFallbackTimer) {
        clearTimeout(joinFallbackTimer);
        joinFallbackTimer = null;
    }
    pendingJoinCode = '';
    p2pJoinTried = false;
    stopSinkReadyResend();
}

function stopSinkReadyResend() {
    if (sinkReadyResendTimer) {
        clearInterval(sinkReadyResendTimer);
        sinkReadyResendTimer = null;
    }
    sinkReadyResendAttempts = 0;
}

function startSinkReadyResend(mode) {
    stopSinkReadyResend();
    sinkReadyResendAttempts = 0;

    sinkReadyResendTimer = setInterval(() => {
        if (!currentPickupCode || !expectedFileInfo) {
            stopSinkReadyResend();
            return;
        }

        sinkReadyResendAttempts++;
        wsSend('receiver-sink-ready', {
            pickupCode: currentPickupCode,
            mode
        });

        if (sinkReadyResendAttempts >= SINK_READY_RESEND_MAX_ATTEMPTS) {
            stopSinkReadyResend();
        }
    }, SINK_READY_RESEND_INTERVAL_MS);
}

function getBinaryTransport() {
    if (transferMode === 'p2p' && p2pDataChannel && p2pDataChannel.readyState === 'open') {
        return p2pDataChannel;
    }
    return null;
}

function handleWSMessage(msg) {
    switch (msg.type) {
        case 'session-joined':
            handleSessionJoined(msg);
            break;
        case 'storage-mode':
            handleStorageMode(msg);
            break;
        case 'signal':
            handleSignalMessage(msg);
            break;
        case 'transfer-start':
            handleTransferStart(msg);
            break;
        case 'chunk-meta':
            handleChunkMeta(msg);
            break;
        case 'transfer-chunk':
            handleTransferChunk(msg);
            break;
        case 'transfer-end':
            handleTransferEnd();
            break;
        case 'connection-lost':
            handleConnectionLost(msg);
            break;
        case 'p2p-nat-info':
            handleP2PNATInfo(msg);
            break;
        case 'error':
            handleError(msg);
            break;
    }
}

function handleSessionJoined(msg) {
    stopSinkReadyResend();
    const { pickupCode, fileName, size, mode } = msg.payload;
    currentPickupCode = pickupCode;
    expectedFileInfo = { fileName, size };
    expectedFileHash = '';
    transferMode = mode === 'p2p' ? 'p2p' : 'memory';

    clearJoinState();

    if (transferMode === 'p2p') {
        setupP2PReceiverConnection().catch((err) => {
            console.error('[P2P 接收端] P2P 连接初始化失败:', err);
            errorText.textContent = 'P2P 连接初始化失败，请返回重试或换用其他传输模式';
            errorText.style.display = 'block';
        });

        // 并行检测接收端 NAT 类型
        detectNATType().then(natInfo => {
            receiverNATInfo = natInfo;
            wsSend('p2p-nat-info', {
                pickupCode: currentPickupCode,
                natType: natInfo,
                role: 'receiver'
            });
            updateP2PNATDisplay(senderNATInfo, receiverNATInfo);
        });
    } else {
        cleanupP2PResources();
    }

    previewFileName.textContent = fileName;
    previewFileSize.textContent = formatFileSize(size);
    previewFileType.textContent = getFileType(fileName);

    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
    isConnecting = false;

    // 设置接收按钮状态
    const acceptBtn = document.getElementById('acceptBtn');
    if (acceptBtn) {
        if (transferMode === 'p2p') {
            acceptBtn.disabled = true;
            acceptBtn.textContent = 'P2P 连接中...';
        } else {
            acceptBtn.disabled = false;
            acceptBtn.textContent = '接收文件';
        }
    }

    showStage('file-confirm-stage');
}

function handleStorageMode(msg) {
    stopSinkReadyResend();
    const { pickupCode, fileName, size, fileHash } = msg.payload;
    currentPickupCode = pickupCode;
    expectedFileInfo = { fileName, size };
    expectedFileHash = fileHash || '';
    transferMode = 'storage';

    clearJoinState();
    cleanupP2PResources();

    previewFileName.textContent = fileName;
    previewFileSize.textContent = formatFileSize(size);
    previewFileType.textContent = getFileType(fileName);

    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
    isConnecting = false;

    // storage 模式不需要 P2P 连接，按钮直接可用
    const acceptBtn = document.getElementById('acceptBtn');
    if (acceptBtn) {
        acceptBtn.disabled = false;
        acceptBtn.textContent = '接收文件';
    }

    showStage('file-confirm-stage');
}

function handleTransferStart(msg) {
    stopSinkReadyResend();
    const payload = msg.payload || {};
    const { fileName, fileSize, totalChunks, fileHash, dataPlane } = payload;

    transferMode = dataPlane === 'p2p' ? 'p2p' : 'memory';
    expectedFileInfo = { fileName, size: fileSize };
    expectedFileHash = (fileHash || '').toLowerCase();
    expectedMemoryChunks = totalChunks || 0;
    receivedMemoryChunks = 0;
    memoryChunkBuffers = [];
    pendingChunkMetaQueue = [];
    pendingBinaryQueue = [];
    receivedChunkIndexSet = new Set();
    outOfOrderChunkBuffer = new Map();
    nextChunkToPersist = 0;
    persistedBytes = 0;
    speedSampleWindow = [];

    showStage('download-stage');
    downloadFileName.textContent = fileName || '下载中...';
    downloadStartTime = Date.now();
    totalBytesReceived = 0;
    updateProgress(0);
    downloadSpeed.textContent = transferMode === 'p2p' ? '正在通过 P2P 接收数据...' : '正在接收数据...';

    // 内存流式传输启动数据超时检测
    if (transferMode === 'memory') {
        startDataTimeoutCheck();
    }
}

function handleChunkMeta(msg) {
    if (transferMode !== 'memory' && transferMode !== 'p2p') {
        return;
    }

    const payload = msg.payload || {};
    const chunkIndex = Number(payload.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return;
    }

    pendingChunkMetaQueue.push({
        chunkIndex,
        pickupCode: payload.pickupCode || currentPickupCode || '',
        chunkHash: (payload.chunkHash || '').toLowerCase()
    });
    flushPendingMemoryChunks().catch(() => {});
}

function handleTransferChunk(msg) {
    const payload = msg.payload || {};
    const chunk = payload.chunk || [];
    const uint8 = Uint8Array.from(chunk);
    const chunkIndex = Number(payload.chunkIndex);

    if (Number.isInteger(chunkIndex) && chunkIndex >= 0) {
        processIncomingMemoryChunk(uint8, chunkIndex).catch(() => {});
        return;
    }

    memoryChunkBuffers.push(uint8);
    receivedMemoryChunks++;
    totalBytesReceived += uint8.byteLength;

    const progress = expectedMemoryChunks > 0 ? (receivedMemoryChunks / expectedMemoryChunks) * 100 : 0;
    updateProgress(progress);

    const elapsedSec = Math.max((Date.now() - downloadStartTime) / 1000, 0.001);
    downloadSpeed.textContent = `${formatFileSize(totalBytesReceived / elapsedSec)}/s`;
}

// 简单 P2P 数据接收（滑动窗口并行，带单块验证）
let simpleP2PMetadata = null;
let simpleP2PReceivedData = [];
let simpleP2PTotalReceived = 0;
let simpleP2PLastProgressUpdate = 0;
let simpleP2PStreamWriter = null;
let simpleP2PStreamingMode = false;
let simpleP2PFAPIWritable = null; // File System Access API writable stream
let simpleP2PReadyToReceive = false;
let simpleP2PChunkMetaQueue = []; // 块元数据队列（滑动窗口下可能同时有多个）
let simpleP2PVerifiedBuffer = new Map(); // 已验证但未按序写入的块: index -> Uint8Array
let simpleP2PNextWriteIndex = 0; // 下一个要写入的块索引
let simpleP2PWrittenBytes = 0; // 已按序写入的字节数
let p2pTransferCompleted = false; // P2P 传输完成标志，防止降级到内存流式传输


async function handleSimpleP2PData(data) {
    // 处理 JSON 消息（元数据或控制信号）
    if (typeof data === 'string') {
        try {
            const message = JSON.parse(data);

            if (message.type === 'metadata') {
                simpleP2PMetadata = message;
                console.log('📦 收到 P2P 文件元数据:', simpleP2PMetadata);

                // 设置传输模式为 P2P
                transferMode = 'p2p';

                // 重置接收统计
                simpleP2PReceivedData = [];
                simpleP2PTotalReceived = 0;
                simpleP2PLastProgressUpdate = Date.now();
                simpleP2PReadyToReceive = false;
                simpleP2PChunkMetaQueue = [];
                simpleP2PVerifiedBuffer = new Map();
                simpleP2PNextWriteIndex = 0;
                simpleP2PWrittenBytes = 0;

                // 初始化 StreamSaver.js
                initSimpleP2PStreamDownload();

                return;
            } else if (message.type === 'start-transfer') {
                console.log('📡 发送端已准备好，开始接收数据');
                simpleP2PReadyToReceive = true;

                showStage('download-stage');
                downloadFileName.textContent = simpleP2PMetadata.name;
                downloadStartTime = Date.now();

                console.log(`🚀 开始接收文件，大小: ${formatFileSize(simpleP2PMetadata.size)}`);

                return;
            } else if (message.type === 'chunk-meta') {
                // 收到块元数据（索引和哈希），加入队列
                simpleP2PChunkMetaQueue.push({
                    index: message.index,
                    hash: message.hash
                });
                return;
            } else if (message.type === 'complete') {
                console.log('✅ P2P 文件接收完成信号，已写入:', formatFileSize(simpleP2PWrittenBytes));
                // 刷新剩余的已验证缓冲区
                await flushP2PVerifiedBuffer();
                completeSimpleP2PDownload();
                return;
            }
        } catch (e) {
            // 不是 JSON，继续处理为二进制数据
        }
    }

    // 接收文件数据块
    if (data instanceof ArrayBuffer) {
        if (!simpleP2PReadyToReceive) {
            console.warn('⚠️ 尚未准备好接收数据，忽略数据块');
            return;
        }

        // 从队列中取出对应的元数据
        if (simpleP2PChunkMetaQueue.length === 0) {
            console.warn('⚠️ 收到数据块但没有对应的元数据，忽略');
            return;
        }

        const meta = simpleP2PChunkMetaQueue.shift();
        const uint8Array = new Uint8Array(data);
        const chunkIndex = meta.index;
        const expectedHash = meta.hash;

        // 验证哈希
        const actualHash = sha256(uint8Array);

        if (actualHash !== expectedHash) {
            console.error(`❌ 块 ${chunkIndex} 哈希不匹配！期望: ${expectedHash.substring(0, 8)}..., 实际: ${actualHash.substring(0, 8)}...`);

            // 发送 NACK
            if (p2pDataChannel && p2pDataChannel.readyState === 'open') {
                p2pDataChannel.send(JSON.stringify({
                    type: 'nack',
                    index: chunkIndex
                }));
            }
            return;
        }

        // 哈希匹配，立即发送 ACK（让发送端尽快滑动窗口）
        if (p2pDataChannel && p2pDataChannel.readyState === 'open') {
            p2pDataChannel.send(JSON.stringify({
                type: 'ack',
                index: chunkIndex
            }));
        }

        simpleP2PTotalReceived += data.byteLength;

        // 如果是下一个要写入的块，直接写入并刷新缓冲区
        if (chunkIndex === simpleP2PNextWriteIndex) {
            await writeP2PChunkToDisk(uint8Array);
            simpleP2PNextWriteIndex++;
            // 刷新后续连续的已验证块
            await flushP2PVerifiedBuffer();
        } else {
            // 乱序到达，缓存起来等待按序写入
            simpleP2PVerifiedBuffer.set(chunkIndex, uint8Array);
        }

        // 更新进度
        updateP2PReceiveProgress();
    }
}

// 将单个块写入磁盘/流
async function writeP2PChunkToDisk(uint8Array) {
    // 优先使用 File System Access API 写入
    if (simpleP2PFAPIWritable) {
        try {
            await simpleP2PFAPIWritable.write(uint8Array);
            simpleP2PWrittenBytes += uint8Array.byteLength;
            return;
        } catch (error) {
            console.error('❌ File System Access API 写入失败，降级到缓存模式:', error);
            simpleP2PFAPIWritable = null;
        }
    }
    // 其次使用 StreamSaver.js 写入
    if (simpleP2PStreamingMode && simpleP2PStreamWriter) {
        try {
            simpleP2PStreamWriter.write(uint8Array);
            simpleP2PWrittenBytes += uint8Array.byteLength;
            return;
        } catch (error) {
            console.error('❌ StreamSaver 写入失败，降级到缓存模式:', error);
            simpleP2PStreamingMode = false;
        }
    }
    // 缓存模式
    simpleP2PReceivedData.push(uint8Array.buffer);
    simpleP2PWrittenBytes += uint8Array.byteLength;
}

// 刷新已验证缓冲区中连续的块
async function flushP2PVerifiedBuffer() {
    while (simpleP2PVerifiedBuffer.has(simpleP2PNextWriteIndex)) {
        const chunk = simpleP2PVerifiedBuffer.get(simpleP2PNextWriteIndex);
        simpleP2PVerifiedBuffer.delete(simpleP2PNextWriteIndex);
        await writeP2PChunkToDisk(chunk);
        simpleP2PNextWriteIndex++;
    }
}

// 更新 P2P 接收进度
function updateP2PReceiveProgress() {
    const now = Date.now();
    if (simpleP2PMetadata && simpleP2PMetadata.size &&
        (now - simpleP2PLastProgressUpdate >= 100 || simpleP2PTotalReceived >= simpleP2PMetadata.size)) {

        const progress = (simpleP2PTotalReceived / simpleP2PMetadata.size) * 100;
        updateProgress(Math.min(progress, 100));

        const elapsedSec = (now - downloadStartTime) / 1000;
        const speed = simpleP2PTotalReceived / elapsedSec;
        downloadSpeed.textContent = `${formatFileSize(speed)}/s`;

        simpleP2PLastProgressUpdate = now;
    }
}

// 初始化简单 P2P 流式下载
async function initSimpleP2PStreamDownload() {
    if (!simpleP2PMetadata) return;

    // 如果 File System Access API 已初始化，跳过 StreamSaver.js
    if (simpleP2PFAPIWritable) {
        console.log('ℹ️ File System Access API 已就绪，跳过 StreamSaver.js 初始化');
        return;
    }

    // 移动端：跳过 StreamSaver.js，直接使用缓存模式
    if (isMobileDevice()) {
        console.log('ℹ️ 移动设备：跳过 StreamSaver.js，使用缓存模式');
        simpleP2PStreamingMode = false;
        simpleP2PStreamWriter = null;
        return;
    }

    // 桌面端：尝试 StreamSaver.js
    console.log('🔧 尝试使用 StreamSaver.js 初始化流式下载...');

    if (typeof window.streamSaver !== 'undefined') {
        try {
            const fileStream = window.streamSaver.createWriteStream(simpleP2PMetadata.name, {
                size: simpleP2PMetadata.size
            });

            simpleP2PStreamWriter = fileStream.getWriter();
            simpleP2PStreamingMode = true;

            console.log('✅ StreamSaver 流式下载已初始化');
        } catch (error) {
            console.warn('⚠️ StreamSaver 初始化失败，使用缓存模式:', error);
            simpleP2PStreamingMode = false;
            simpleP2PStreamWriter = null;
        }
    } else {
        console.log('ℹ️ StreamSaver 不可用，使用缓存模式');
        simpleP2PStreamingMode = false;
    }
}

// 完成简单 P2P 下载
async function completeSimpleP2PDownload() {
    // 标记 P2P 传输已完成，防止降级到内存流式传输
    p2pTransferCompleted = true;
    stopSinkReadyResend();

    // 验证接收的数据大小
    if (simpleP2PTotalReceived !== simpleP2PMetadata.size) {
        console.warn(`⚠️ 数据大小不匹配！期望: ${simpleP2PMetadata.size}, 实际: ${simpleP2PTotalReceived}`);
    }

    updateProgress(100);

    // File System Access API 模式：关闭 writable
    if (simpleP2PFAPIWritable) {
        try {
            await simpleP2PFAPIWritable.close();
            console.log('✅ File System Access API 流式下载完成，文件已保存');
        } catch (error) {
            console.error('❌ 关闭 File System Access API 写入流失败:', error);
            showError('文件保存失败: ' + error.message, '传输失败');
            return;
        }
    }
    // StreamSaver.js 模式：关闭写入流
    else if (simpleP2PStreamingMode && simpleP2PStreamWriter) {
        try {
            await simpleP2PStreamWriter.close();
            console.log('✅ StreamSaver 流式下载完成，文件已保存');
        } catch (error) {
            console.error('❌ 关闭 StreamSaver 写入流失败:', error);
            showError('文件保存失败', '传输失败');
            return;
        }
    }
    // 缓存模式：创建 Blob 并下载
    else {
        if (!simpleP2PMetadata || simpleP2PReceivedData.length === 0) {
            showError('P2P 接收失败：数据不完整', '传输失败');
            return;
        }

        console.log(`📦 创建 Blob，共 ${simpleP2PReceivedData.length} 个数据块`);

        const blob = new Blob(simpleP2PReceivedData, {
            type: simpleP2PMetadata.mimeType || 'application/octet-stream'
        });

        console.log(`✅ Blob 创建成功，大小: ${formatFileSize(blob.size)}`);

        if (blob.size !== simpleP2PMetadata.size) {
            console.error(`❌ 文件大小验证失败！Blob: ${blob.size}, 期望: ${simpleP2PMetadata.size}`);
            showError(`文件接收不完整：${formatFileSize(blob.size)} / ${formatFileSize(simpleP2PMetadata.size)}`, '传输失败');
            return;
        }

        // 触发下载
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = simpleP2PMetadata.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // 显示完成状态
    showStage('download-complete-stage');

    // 通知发送端传输已完成
    if (p2pDataChannel && p2pDataChannel.readyState === 'open') {
        try {
            p2pDataChannel.send(JSON.stringify({ type: 'transfer-complete' }));
            console.log('📤 已通知发送端传输完成');
        } catch (e) {
            console.warn('⚠️ 通知发送端失败:', e);
        }
    }

    // 清理变量
    simpleP2PReceivedData = [];
    simpleP2PMetadata = null;
    simpleP2PTotalReceived = 0;
    simpleP2PStreamWriter = null;
    simpleP2PStreamingMode = false;
    simpleP2PFAPIWritable = null;
    simpleP2PReadyToReceive = false;
    simpleP2PChunkMetaQueue = [];
    simpleP2PVerifiedBuffer = new Map();
    simpleP2PNextWriteIndex = 0;
    simpleP2PWrittenBytes = 0;

    // 延迟关闭 P2P 连接，确保 transfer-complete 消息发送出去
    setTimeout(() => {
        if (p2pPeerConnection) {
            p2pPeerConnection.close();
        }
    }, 500);
}

async function handleBinaryChunk(binaryData) {
    // P2P 模式：使用简单处理器（旧版本实现，无验证）
    if (transferMode === 'p2p') {
        handleSimpleP2PData(binaryData);
        return;
    }

    // 内存流式模式：使用复杂处理器（带验证）
    if (transferMode !== 'memory') {
        return;
    }

    const buffer = binaryData instanceof Blob ? await binaryData.arrayBuffer() : binaryData;
    pendingBinaryQueue.push(buffer);
    await flushPendingMemoryChunks();
}

async function flushPendingMemoryChunks() {
    while (pendingChunkMetaQueue.length > 0 && pendingBinaryQueue.length > 0) {
        const meta = pendingChunkMetaQueue.shift();
        const buffer = pendingBinaryQueue.shift();
        const uint8 = new Uint8Array(buffer);
        await processIncomingMemoryChunk(uint8, meta.chunkIndex, meta.pickupCode, meta.chunkHash);
    }
}

async function processIncomingMemoryChunk(uint8, chunkIndex, pickupCodeForAck = '', expectedChunkHash = '') {
    if (receivedChunkIndexSet.has(chunkIndex)) {
        wsSend('chunk-ack', {
            pickupCode: pickupCodeForAck || currentPickupCode,
            chunkIndex
        });
        return;
    }

    if (expectedChunkHash) {
        const actualChunkHash = await sha256OfUint8(uint8);
        if (actualChunkHash !== expectedChunkHash) {
            wsSend('chunk-nack', {
                pickupCode: pickupCodeForAck || currentPickupCode,
                missingChunks: [chunkIndex]
            });
            return;
        }
    }

    outOfOrderChunkBuffer.set(chunkIndex, {
        chunk: uint8,
        pickupCodeForAck: pickupCodeForAck || currentPickupCode
    });

    await flushPersistableChunks();
}

async function flushPersistableChunks() {
    while (outOfOrderChunkBuffer.has(nextChunkToPersist)) {
        const record = outOfOrderChunkBuffer.get(nextChunkToPersist);
        outOfOrderChunkBuffer.delete(nextChunkToPersist);

        const writeResult = await appendChunkToSink(record.chunk);
        if (!writeResult.ok) {
            const reason = writeResult.reason || '写入本地失败';
            if (errorTitle) errorTitle.textContent = '传输失败';
            errorText.textContent = reason;
            showStage('error-stage');
            if (currentPickupCode) {
                wsSend('verify-fail', { pickupCode: currentPickupCode, reason });
            }
            return;
        }

        receivedChunkIndexSet.add(nextChunkToPersist);
        receivedMemoryChunks = receivedChunkIndexSet.size;
        totalBytesReceived += record.chunk.byteLength;
        resetDataTimeout();

        wsSend('chunk-ack', {
            pickupCode: record.pickupCodeForAck,
            chunkIndex: nextChunkToPersist
        });

        nextChunkToPersist++;
        updateReceiveProgressAndSpeed();
    }
}

async function handleTransferEnd() {
    stopSinkReadyResend();
    stopDataTimeoutCheck();
    if (transferMode !== 'memory' && transferMode !== 'p2p') {
        return;
    }

    const missingChunks = [];
    if (expectedMemoryChunks > 0) {
        for (let i = 0; i < expectedMemoryChunks; i++) {
            if (!receivedChunkIndexSet.has(i)) {
                missingChunks.push(i);
            }
        }
    }

    if (missingChunks.length > 0) {
        downloadSpeed.textContent = `检测到缺块，正在请求补发（${missingChunks.length}）...`;
        if (currentPickupCode) {
            wsSend('chunk-nack', {
                pickupCode: currentPickupCode,
                missingChunks
            });
        }
        return;
    }

    const finalizeResult = await finalizeReceiveSink();
    if (!finalizeResult.ok) {
        const reason = finalizeResult.reason || '写入完成失败';
        if (errorTitle) errorTitle.textContent = '传输失败';
        errorText.textContent = reason;
        showStage('error-stage');
        if (currentPickupCode) {
            wsSend('verify-fail', { pickupCode: currentPickupCode, reason });
        }
        return;
    }

    if (expectedFileHash && finalizeResult.actualHash && finalizeResult.actualHash !== expectedFileHash) {
        const reason = `SHA-256 校验失败：期望 ${expectedFileHash}，实际 ${finalizeResult.actualHash}`;
        setVerifyResult(false, reason);
        if (downloadCompleteText) downloadCompleteText.textContent = '下载完成';
        showStage('download-complete-stage');
        if (currentPickupCode) {
            wsSend('verify-fail', { pickupCode: currentPickupCode, reason, actualHash: finalizeResult.actualHash, expectedHash: expectedFileHash });
        }
        return;
    }

    let successText = '';
    if (finalizeResult.actualHash && expectedFileHash) {
        successText = `SHA-256 校验通过：${finalizeResult.actualHash}`;
    } else if (finalizeResult.mode === 'disk') {
        successText = '分块 SHA-256 校验通过，文件已流式写入本地';
    } else if (finalizeResult.mode === 'streamsaver') {
        successText = '分块 SHA-256 校验通过，文件已通过 StreamSaver.js 流式下载';
    } else {
        successText = `内存流传输完成：共 ${receivedMemoryChunks} 块`;
    }

    setVerifyResult(true, successText);
    if (downloadCompleteText) {
        downloadCompleteText.textContent = '下载完成';
    }
    showStage('download-complete-stage');

    if (currentPickupCode) {
        wsSend('verify-ok', {
            pickupCode: currentPickupCode,
            actualHash: finalizeResult.actualHash || '',
            integrityMode: finalizeResult.actualHash ? 'file-sha256' : 'chunk-sha256'
        });
    }
}

// 数据超时检测：每秒检查一次，连续5秒无新数据判定发送端断开
let lastDataAt = 0;

function startDataTimeoutCheck() {
    stopDataTimeoutCheck();
    lastDataAt = Date.now();
    dataTimeoutTimer = setInterval(() => {
        if (lastDataAt && Date.now() - lastDataAt > DATA_TIMEOUT_MS) {
            stopDataTimeoutCheck();
            const text = '发送端已断开连接';
            errorText.textContent = text;
            errorText.style.display = 'block';
            const statusEl = document.getElementById('statusText');
            if (statusEl) statusEl.textContent = text;
            const dlSpeed = document.getElementById('downloadSpeed');
            const dlPercent = document.getElementById('downloadProgressPercent');
            if (dlSpeed) dlSpeed.textContent = text;
            if (dlPercent) dlPercent.textContent = '已中断';
        }
    }, 1000);
}

function resetDataTimeout() {
    lastDataAt = Date.now();
}

function stopDataTimeoutCheck() {
    if (dataTimeoutTimer) {
        clearInterval(dataTimeoutTimer);
        dataTimeoutTimer = null;
    }
}

function handleConnectionLost(msg) {
    stopDataTimeoutCheck();
    const role = msg.payload && msg.payload.role;
    const displayText = role === 'sender' ? '发送端已断开连接' : '对方已断开连接';

    // 清理 P2P 资源
    if (p2pDataChannel) {
        try {
            p2pDataChannel.close();
        } catch (_) {}
    }
    if (p2pPeerConnection) {
        try {
            p2pPeerConnection.close();
        } catch (_) {}
    }

    // 更新所有可能可见的状态元素
    errorText.textContent = displayText;
    errorText.style.display = 'block';
    const statusEl = document.getElementById('statusText');
    if (statusEl) statusEl.textContent = displayText;
    // 传输阶段的可见元素
    const dlSpeed = document.getElementById('downloadSpeed');
    const dlPercent = document.getElementById('downloadProgressPercent');
    if (dlSpeed) dlSpeed.textContent = displayText;
    if (dlPercent) dlPercent.textContent = '已中断';
}

function handleError(msg) {
    stopSinkReadyResend();
    clearJoinState();
    isConnecting = false;
    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
    showError(msg.payload || '发生错误');
}

function showError(message, title) {
    if (errorTitle) errorTitle.textContent = title || '连接失败';
    errorText.textContent = message;
    showStage('error-stage');

    // 重置状态
    isConnecting = false;
    currentPickupCode = null;
    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
}

// 设置输入处理
function setupInputHandlers() {
    const boxes = document.querySelectorAll('.code-box');

    function updateDisplay(value) {
        boxes.forEach((box, index) => {
            const char = value[index] || '';
            box.textContent = char;

            if (char) {
                box.classList.add('filled');
            } else {
                box.classList.remove('filled');
            }
        });

        const upperValue = value.toUpperCase();
        pickupCodeInput.value = upperValue;
        connectBtn.disabled = upperValue.length !== 4;
    }

    boxes.forEach((box) => {
        box.addEventListener('click', () => {
            pickupCodeInput.focus();
        });
    });

    pickupCodeInput.addEventListener('input', (e) => {
        let value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (value.length > 4) {
            value = value.slice(0, 4);
        }
        updateDisplay(value);
    });

    pickupCodeInput.focus();

    connectBtn.addEventListener('click', () => {
        const code = pickupCodeInput.value.toUpperCase();
        if (code.length === 4) {
            joinSession(code);
        }
    });
}

// 保留兼容旧内联调用
function connectToSender() {
    const code = pickupCodeInput.value.toUpperCase();
    if (code.length === 4) {
        joinSession(code);
    }
}

// 加入会话
async function joinSession(code) {
    if (isConnecting) return;

    clearJoinState();
    pendingJoinCode = code;

    isConnecting = true;
    connectBtn.disabled = true;
    connectBtn.textContent = '连接中...';
    errorText.style.display = 'none';

    try {
        const response = await fetch(`/api/pickup-code/${code}`);
        const data = await response.json();

        if (data.success && data.exists && data.mode === 'storage') {
            handleStorageMode({
                payload: {
                    pickupCode: code,
                    fileName: data.fileName,
                    size: data.size,
                    fileHash: data.fileHash || ''
                }
            });
            return;
        }

        // HTTP API 明确返回取件码不存在
        if (data.success && !data.exists) {
            showError('无效的取件码');
            return;
        }

        p2pJoinTried = true;
        wsSend('join-session', {
            pickupCode: code,
            mode: 'p2p',
            capabilities: detectCapabilities()
        });
    } catch (error) {
        p2pJoinTried = false;
        wsSend('join-session', {
            pickupCode: code,
            mode: 'p2p',
            capabilities: detectCapabilities()
        });
    }
}

function acceptTransfer() {
    confirmDownload();
}

function declineTransfer() {
    stopSinkReadyResend();
    clearJoinState();
    currentPickupCode = null;
    expectedFileInfo = null;
    expectedFileHash = '';
    transferMode = null;
    senderNATInfo = null;
    receiverNATInfo = null;
    cleanupP2PResources();
    resetReceiveSink().catch(() => {});
    showStage('input-stage');
}

// P2P NAT 信息处理
function handleP2PNATInfo(msg) {
    const payload = msg.payload || {};
    if (payload.pickupCode !== currentPickupCode) return;

    if (payload.role === 'sender') {
        senderNATInfo = payload.natType;
        console.log('[P2P] 收到发送端NAT信息:', senderNATInfo);
        if (receiverNATInfo) {
            updateP2PNATDisplay(senderNATInfo, receiverNATInfo);
        }
    }
}

function updateP2PNATDisplay(senderNAT, receiverNAT) {
    if (!receiverNAT) return;

    const confirmStage = document.getElementById('file-confirm-stage');
    let natDisplay = confirmStage.querySelector('.nat-detection');

    if (!natDisplay) {
        natDisplay = document.createElement('div');
        natDisplay.className = 'nat-detection';
        natDisplay.style.marginTop = '20px';
        const fileDetails = confirmStage.querySelector('.file-details');
        if (fileDetails) {
            fileDetails.after(natDisplay);
        } else {
            confirmStage.appendChild(natDisplay);
        }
    }

    let totalSuccess = receiverNAT.success;
    if (senderNAT) {
        totalSuccess = Math.min(senderNAT.success, receiverNAT.success);
        if (senderNAT.success >= 90 && receiverNAT.success >= 90) {
            totalSuccess = Math.min(95, (senderNAT.success + receiverNAT.success) / 2);
        }
    }

    natDisplay.innerHTML = `
        <h4 style="margin-bottom: 15px; color: var(--text-main);">P2P 连接状态</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
            <div class="nat-box" style="background: rgba(255,255,255,0.5); padding: 12px; border-radius: 10px;">
                <div style="font-weight: 600; margin-bottom: 8px; color: var(--primary-color);">发送端</div>
                <div style="font-size: 0.9rem; color: var(--text-main);">
                    ${senderNAT ?
                        `<span class="nat-type" style="font-size: 0.85rem;">${senderNAT.type} - ${senderNAT.name}</span>` :
                        `<span style="color: var(--text-sub);">检测中...</span>`}
                </div>
            </div>
            <div class="nat-box" style="background: rgba(255,255,255,0.5); padding: 12px; border-radius: 10px;">
                <div style="font-weight: 600; margin-bottom: 8px; color: var(--secondary-color, var(--primary-color));">接收端</div>
                <div style="font-size: 0.9rem; color: var(--text-main);">
                    <span class="nat-type" style="font-size: 0.85rem;">${receiverNAT.type} - ${receiverNAT.name}</span>
                </div>
            </div>
        </div>
        <div class="nat-info" style="background: rgba(99, 102, 241, 0.1); padding: 15px; border-radius: 10px; display: block; text-align: center;">
            <strong style="color: var(--text-main); font-size: 1.1rem;">预计连接成功率</strong>
            <div class="nat-success-rate" style="font-size: 2.5rem; margin: 10px 0;">${Math.round(totalSuccess)}%</div>
            <p style="font-size: 0.85rem; color: var(--text-sub); margin: 0;">
                ${senderNAT ? getP2PTips(senderNAT, receiverNAT) : '等待发送端信息后显示详细建议'}
            </p>
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

// 确认下载
async function confirmDownload() {
    stopSinkReadyResend();
    if (!expectedFileInfo) return;

    // P2P 模式安全检查：DataChannel 必须已打开
    if (transferMode === 'p2p' && (!p2pDataChannel || p2pDataChannel.readyState !== 'open')) {
        console.warn('[P2P 接收端] DataChannel 未就绪，拒绝开始传输');
        return;
    }

    showStage('download-stage');
    downloadFileName.textContent = expectedFileInfo.fileName;
    downloadStartTime = Date.now();
    totalBytesReceived = 0;
    persistedBytes = 0;
    speedSampleWindow = [];

    if (transferMode === 'storage') {
        downloadSpeed.textContent = '正在下载并校验...';
        await downloadStoredFileInChunks();
        return;
    }

    // P2P 模式：优先使用 File System Access API，降级使用 StreamSaver.js
    if (transferMode === 'p2p') {
        const mobile = isMobileDevice();

        // 移动端：检查文件大小限制
        if (mobile && expectedFileInfo.size > MOBILE_MEMORY_LIMIT) {
            if (errorTitle) errorTitle.textContent = '传输失败';
            errorText.textContent = '该文件超过 150MB，移动设备内存不足以缓存。请使用电脑浏览器接收此文件。';
            showStage('error-stage');
            return;
        }

        // 尝试使用 File System Access API（仅 HTTPS/localhost 下可用）
        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: expectedFileInfo.fileName || 'download.bin'
                });
                simpleP2PFAPIWritable = await fileHandle.createWritable();
                console.log('✅ P2P: File System Access API 已初始化，流式落盘就绪');
                downloadSpeed.textContent = 'P2P 模式已准备（磁盘直写），等待发送方...';
            } catch (err) {
                console.warn('⚠️ P2P: File System Access API 初始化失败:', err.message);
                simpleP2PFAPIWritable = null;
                downloadSpeed.textContent = mobile ? 'P2P 模式已准备（内存缓冲），等待发送方...' : 'P2P 模式已准备，等待发送方...';
            }
        } else {
            console.log('ℹ️ P2P: File System Access API 不可用');
            simpleP2PFAPIWritable = null;
            downloadSpeed.textContent = mobile ? 'P2P 模式已准备（内存缓冲），等待发送方...' : 'P2P 模式已准备，等待发送方...';
        }

        // 发送就绪消息给发送方
        wsSend('receiver-sink-ready', {
            pickupCode: currentPickupCode,
            mode: 'p2p'
        });
        startSinkReadyResend('p2p');
        wsSend('receiver-ready', { pickupCode: currentPickupCode });
        return;
    }

    const sinkResult = await initReceiveSink(expectedFileInfo.fileName, expectedFileInfo.size || 0);
    if (!sinkResult.ok) {
        stopSinkReadyResend();
        const reason = sinkResult.reason || '无法初始化接收落盘器';
        if (currentPickupCode) {
            wsSend('receiver-fatal', { pickupCode: currentPickupCode, reason });
            wsSend('verify-fail', { pickupCode: currentPickupCode, reason });
        }
        if (errorTitle) errorTitle.textContent = '传输失败';
        errorText.textContent = reason;
        showStage('error-stage');
        return;
    }

    if (sinkResult.mode === 'disk') {
        downloadSpeed.textContent = '已准备流式写入本地磁盘，等待发送方...';
    } else if (sinkResult.mode === 'streamsaver') {
        downloadSpeed.textContent = '已准备流式下载（StreamSaver.js），等待发送方...';
    } else if (sinkResult.mode === 'http-stream') {
        downloadSpeed.textContent = 'HTTP 流下载模式，浏览器将自动下载文件...';
    } else {
        downloadSpeed.textContent = '浏览器内存回退模式，等待发送方...';
    }

    wsSend('receiver-sink-ready', {
        pickupCode: currentPickupCode,
        mode: sinkResult.mode
    });
    startSinkReadyResend(sinkResult.mode);
    wsSend('receiver-ready', { pickupCode: currentPickupCode });
}

async function initReceiveSink(fileName, fileSize) {
    await resetReceiveSink();

    const canUseDiskStream = typeof window.showSaveFilePicker === 'function';
    if (canUseDiskStream) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName || 'download.bin'
            });
            const writable = await handle.createWritable();
            activeReceiveSink = {
                mode: 'disk',
                fileName: fileName || 'download.bin',
                fileSize: fileSize || 0,
                writable,
                writtenBytes: 0
            };
            return { ok: true, mode: 'disk' };
        } catch (error) {
            console.warn('[接收] File System Access API 失败，尝试降级:', error.message);
        }
    }

    // 桌面端：尝试 StreamSaver.js 降级
    if (!isMobileDevice() && typeof window.streamSaver !== 'undefined') {
        try {
            const stream = window.streamSaver.createWriteStream(fileName || 'download.bin', { size: fileSize });
            const writer = stream.getWriter();
            activeReceiveSink = {
                mode: 'streamsaver',
                fileName: fileName || 'download.bin',
                fileSize: fileSize || 0,
                writer: writer,
                writtenBytes: 0,
                pendingWrites: []
            };
            return { ok: true, mode: 'streamsaver' };
        } catch (error) {
            console.warn('[接收] StreamSaver.js 初始化失败:', error);
        }
    }

    // 移动端：内存缓冲降级
    if (isMobileDevice()) {
        if (fileSize > MOBILE_MEMORY_LIMIT) {
            return { ok: false, reason: '该文件超过 150MB，移动设备内存不足以缓存。请使用电脑浏览器接收此文件。' };
        }
        activeReceiveSink = {
            mode: 'memory',
            fileName: fileName || 'download.bin',
            fileSize: fileSize || 0,
            chunks: [],
            writtenBytes: 0
        };
        console.log('[接收] 移动设备：使用内存缓冲模式');
        return { ok: true, mode: 'memory' };
    }

    // 桌面端都不可用
    return { ok: false, reason: '当前浏览器不支持流式落盘。请使用 HTTPS 访问并授权文件保存，或改用服务器存储模式。' };
}

// 启动 HTTP 流下载
function startHTTPDownload() {
    console.log(`[${currentPickupCode}] 启动 HTTP 流下载`);

    // 使用 iframe 发起 HTTP 流下载请求
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = `/api/download/${currentPickupCode}`;
    document.body.appendChild(iframe);

    // 几分钟后清理 iframe
    setTimeout(() => {
        if (iframe.parentNode) {
            document.body.removeChild(iframe);
        }
    }, 600000); // 10分钟

    activeReceiveSink = {
        mode: 'http-stream',
        fileName: expectedFileInfo?.name || 'download.bin',
        fileSize: expectedFileInfo?.size || 0
    };

    return { ok: true, mode: 'http-stream' };
}

async function appendChunkToSink(chunk) {
    if (!activeReceiveSink) {
        return { ok: false, reason: '接收落盘器未初始化' };
    }

    try {
        if (activeReceiveSink.mode === 'disk') {
            await activeReceiveSink.writable.write(chunk);
            activeReceiveSink.writtenBytes += chunk.byteLength;
        } else if (activeReceiveSink.mode === 'streamsaver') {
            // 非阻塞写入：不等待写入完成，立即返回（提升 P2P 传输速度）
            const writePromise = activeReceiveSink.writer.write(new Uint8Array(chunk));

            // 跟踪写入 Promise，用于最终检查和错误处理
            if (!activeReceiveSink.pendingWrites) {
                activeReceiveSink.pendingWrites = [];
            }
            activeReceiveSink.pendingWrites.push(writePromise);

            // 异步处理写入错误
            writePromise.catch(error => {
                console.error('[StreamSaver] 写入失败:', error);
                activeReceiveSink.writeError = error;
            });

            activeReceiveSink.writtenBytes += chunk.byteLength;
        } else {
            activeReceiveSink.chunks.push(chunk);
        }
        persistedBytes += chunk.byteLength;
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error?.message || '写入本地失败' };
    }
}

async function finalizeReceiveSink() {
    if (!activeReceiveSink) {
        return { ok: false, reason: '接收落盘器未初始化' };
    }

    try {
        if (activeReceiveSink.mode === 'disk') {
            await activeReceiveSink.writable.close();
            const result = { ok: true, mode: 'disk', actualHash: '' };
            activeReceiveSink = null;
            return result;
        }

        if (activeReceiveSink.mode === 'streamsaver') {
            // 等待所有待完成的写入
            if (activeReceiveSink.pendingWrites && activeReceiveSink.pendingWrites.length > 0) {
                console.log(`[StreamSaver] 等待 ${activeReceiveSink.pendingWrites.length} 个写入完成...`);
                await Promise.all(activeReceiveSink.pendingWrites);
                console.log('[StreamSaver] 所有写入已完成');
            }

            // 检查是否有写入错误
            if (activeReceiveSink.writeError) {
                return { ok: false, reason: `StreamSaver 写入失败: ${activeReceiveSink.writeError.message}` };
            }

            await activeReceiveSink.writer.close();
            const result = { ok: true, mode: 'streamsaver', actualHash: '' };
            activeReceiveSink = null;
            return result;
        }

        const blob = new Blob(activeReceiveSink.chunks, { type: 'application/octet-stream' });
        const actualHash = await sha256OfBlob(blob);
        triggerBrowserDownload(blob, activeReceiveSink.fileName);
        const result = { ok: true, mode: 'memory', actualHash };
        activeReceiveSink = null;
        return result;
    } catch (error) {
        return { ok: false, reason: error?.message || '完成落盘失败' };
    }
}

async function resetReceiveSink() {
    if (!activeReceiveSink) {
        return;
    }

    if (activeReceiveSink.mode === 'disk' && activeReceiveSink.writable) {
        try {
            await activeReceiveSink.writable.close();
        } catch (_) {}
    }

    if (activeReceiveSink.mode === 'streamsaver' && activeReceiveSink.writer) {
        try {
            await activeReceiveSink.writer.close();
        } catch (_) {}
    }

    if (activeReceiveSink.mode === 'memory' && activeReceiveSink.chunks) {
        activeReceiveSink.chunks = [];
    }

    activeReceiveSink = null;
}

function updateReceiveProgressAndSpeed() {
    const totalSize = expectedFileInfo?.size || 0;
    const progress = totalSize > 0
        ? (persistedBytes / totalSize) * 100
        : (expectedMemoryChunks > 0 ? (receivedMemoryChunks / expectedMemoryChunks) * 100 : 0);
    updateProgress(progress);

    const now = Date.now();
    speedSampleWindow.push({ t: now, bytes: persistedBytes });
    while (speedSampleWindow.length > 1 && now - speedSampleWindow[0].t > SPEED_WINDOW_MS) {
        speedSampleWindow.shift();
    }

    if (speedSampleWindow.length > 1) {
        const first = speedSampleWindow[0];
        const last = speedSampleWindow[speedSampleWindow.length - 1];
        const elapsed = Math.max((last.t - first.t) / 1000, 0.001);
        const delta = Math.max(last.bytes - first.bytes, 0);
        downloadSpeed.textContent = `${formatFileSize(delta / elapsed)}/s`;
    }
}

async function downloadStoredWithVerify() {
    try {
        const response = await fetch(`/api/download-stored/${currentPickupCode}`);
        if (!response.ok) {
            throw new Error('下载失败');
        }

        const headerHash = (response.headers.get('X-File-SHA256') || '').toLowerCase();
        const serverHash = (expectedFileHash || headerHash || '').toLowerCase();

        const blob = await response.blob();
        totalBytesReceived = blob.size;
        updateProgress(100);

        const actualHash = await sha256OfBlob(blob);

        const elapsedSec = Math.max((Date.now() - downloadStartTime) / 1000, 0.001);
        downloadSpeed.textContent = `${formatFileSize(totalBytesReceived / elapsedSec)}/s`;

        triggerBrowserDownload(blob, expectedFileInfo.fileName);

        if (serverHash && actualHash === serverHash) {
            setVerifyResult(true, `SHA-256 校验通过：${actualHash}`);
        } else if (serverHash) {
            setVerifyResult(false, `SHA-256 校验失败：期望 ${serverHash}，实际 ${actualHash}`);
        } else {
            setVerifyResult(false, `无法校验：服务端未提供 SHA-256，实际 ${actualHash}`);
        }

        showStage('download-complete-stage');
    } catch (err) {
        if (errorTitle) errorTitle.textContent = '传输失败';
        errorText.textContent = err.message || '下载失败';
        showStage('error-stage');
    }
}

// 下载单个块
async function downloadChunk(pickupCode, chunkIndex, chunkSize, fileSize, downloadState) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, fileSize) - 1;

    const startTime = Date.now();
    downloadState.chunksInFlight.set(chunkIndex, { startTime });

    try {
        const response = await fetch(`/api/download-stored/${pickupCode}`, {
            headers: {
                'Range': `bytes=${start}-${end}`
            }
        });

        if (response.ok || response.status === 206) {
            const chunkData = await response.arrayBuffer();
            downloadState.completedChunks.set(chunkIndex, chunkData);
            downloadState.chunksInFlight.delete(chunkIndex);
        } else {
            throw new Error('Download failed: ' + response.status);
        }
    } catch (error) {
        console.error(`[下载] 块 ${chunkIndex} 失败:`, error);
        downloadState.failedChunks.set(chunkIndex, error);
        downloadState.chunksInFlight.delete(chunkIndex);
        // 重传逻辑
        downloadState.nextChunkToDownload = Math.min(downloadState.nextChunkToDownload, chunkIndex);
    }
}

// 分块下载存储的文件
async function downloadStoredFileInChunks() {
    try {
        const CHUNK_SIZE = 512 * 1024; // 固定 512KB
        const fileSize = expectedFileInfo.size || 0;
        const fileName = expectedFileInfo.fileName;
        const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

        // 检测能力
        const capabilities = detectCapabilities();
        const useFileSystemAccess = capabilities.fileSystemAccess;

        console.log('[下载] 使用下载方式:', useFileSystemAccess ? 'File System Access API' : 'StreamSaver.js');

        // 获取写入句柄
        const mobile = isMobileDevice();
        let writable;
        let useMemoryBuffer = false;
        let memoryBufferChunks = [];

        if (useFileSystemAccess) {
            try {
                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: fileName
                });
                writable = await fileHandle.createWritable();
            } catch (err) {
                if (err.name === 'AbortError') {
                    throw new Error('用户取消了文件保存');
                }
                console.warn('[下载] File System Access API 失败，降级:', err);

                if (mobile) {
                    if (fileSize > MOBILE_MEMORY_LIMIT) {
                        throw new Error('该文件超过 150MB，移动设备内存不足以缓存。请使用电脑浏览器接收此文件。');
                    }
                    useMemoryBuffer = true;
                    writable = {
                        write: (data) => { memoryBufferChunks.push(data instanceof Uint8Array ? data : new Uint8Array(data)); },
                        close: () => {}
                    };
                } else {
                    if (!window.streamSaver) {
                        throw new Error('StreamSaver.js 未加载');
                    }
                    const stream = window.streamSaver.createWriteStream(fileName, { size: fileSize });
                    const writer = stream.getWriter();
                    writable = {
                        write: (data) => writer.write(new Uint8Array(data)),
                        close: () => writer.close()
                    };
                }
            }
        } else {
            if (mobile) {
                if (fileSize > MOBILE_MEMORY_LIMIT) {
                    throw new Error('该文件超过 150MB，移动设备内存不足以缓存。请使用电脑浏览器接收此文件。');
                }
                useMemoryBuffer = true;
                writable = {
                    write: (data) => { memoryBufferChunks.push(data instanceof Uint8Array ? data : new Uint8Array(data)); },
                    close: () => {}
                };
            } else {
                if (!window.streamSaver) {
                    throw new Error('StreamSaver.js 未加载，且不支持 File System Access API');
                }
                const stream = window.streamSaver.createWriteStream(fileName, { size: fileSize });
                const writer = stream.getWriter();
                writable = {
                    write: (data) => writer.write(new Uint8Array(data)),
                    close: () => writer.close()
                };
            }
        }

        // 滑动窗口配置
        const windowConfig = { initial: 4, min: 2, max: 8 };
        let currentWindow = windowConfig.initial;

        // 下载状态
        const downloadState = {
            nextChunkToDownload: 0,
            chunksInFlight: new Map(),
            completedChunks: new Map(), // chunkIndex -> data
            failedChunks: new Map(),
            nextChunkToWrite: 0,
            downloadedBytes: 0
        };

        // 并行下载逻辑
        while (downloadState.nextChunkToWrite < totalChunks) {
            // 发送窗口内的块
            const promises = [];
            while (downloadState.chunksInFlight.size < currentWindow &&
                   downloadState.nextChunkToDownload < totalChunks) {
                const chunkIndex = downloadState.nextChunkToDownload++;
                promises.push(downloadChunk(currentPickupCode, chunkIndex, CHUNK_SIZE, fileSize, downloadState));
            }

            // 等待至少一个块完成
            if (promises.length > 0) {
                await Promise.race(promises);
            }

            // 写入已完成的连续块
            while (downloadState.completedChunks.has(downloadState.nextChunkToWrite)) {
                const chunkData = downloadState.completedChunks.get(downloadState.nextChunkToWrite);
                await writable.write(chunkData);
                downloadState.completedChunks.delete(downloadState.nextChunkToWrite);
                downloadState.nextChunkToWrite++;
                downloadState.downloadedBytes += chunkData.byteLength;

                // 更新进度
                const percent = (downloadState.nextChunkToWrite / totalChunks) * 100;
                updateProgress(percent);

                const elapsed = (Date.now() - downloadStartTime) / 1000;
                const speed = downloadState.downloadedBytes / elapsed;
                downloadSpeed.textContent = `${formatFileSize(speed)}/s`;
            }

            // 调整窗口大小（AIMD）
            if (downloadState.failedChunks.size > 0) {
                currentWindow = Math.max(Math.floor(currentWindow / 2), windowConfig.min);
                downloadState.failedChunks.clear();
            } else if (downloadState.completedChunks.size > 0) {
                currentWindow = Math.min(currentWindow + 1, windowConfig.max);
            }

            // 等待一小段时间，避免忙等待
            if (downloadState.nextChunkToWrite < totalChunks &&
                !downloadState.completedChunks.has(downloadState.nextChunkToWrite)) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        // 关闭写入流
        await writable.close();

        // 内存缓冲模式：组装 Blob 并触发浏览器下载
        if (useMemoryBuffer) {
            const blob = new Blob(memoryBufferChunks, { type: 'application/octet-stream' });
            memoryBufferChunks = [];
            triggerBrowserDownload(blob, fileName);
        }

        totalBytesReceived = fileSize;
        updateProgress(100);

        const elapsedSec = Math.max((Date.now() - downloadStartTime) / 1000, 0.001);
        downloadSpeed.textContent = `${formatFileSize(totalBytesReceived / elapsedSec)}/s`;

        // 获取文件哈希（从响应头）
        const response = await fetch(`/api/stored-file/${currentPickupCode}`);
        if (response.ok) {
            const data = await response.json();
            const serverHash = (data.fileHash || '').toLowerCase();
            if (serverHash) {
                setVerifyResult(true, `SHA-256: ${serverHash}（服务器端校验）`);
            } else {
                setVerifyResult(false, '无法校验：服务端未提供 SHA-256');
            }
        }

        showStage('download-complete-stage');
    } catch (err) {
        console.error('[下载] 错误:', err);
        if (errorTitle) errorTitle.textContent = '传输失败';
        errorText.textContent = err.message || '下载失败';
        showStage('error-stage');
    }
}

function setVerifyResult(ok, text) {
    // 验证结果文本（如果元素存在才设置）
    if (verifyResultText) {
        verifyResultText.textContent = text || '';
        verifyResultText.style.color = ok ? '#16a34a' : '#dc2626';
    }
    // 完成标题（如果元素存在才设置）
    if (downloadCompleteText) {
        downloadCompleteText.textContent = ok ? '下载完成' : '下载完成（校验失败）';
    }
}

async function sha256OfUint8(uint8) {
    // 检测 crypto.subtle 是否可用（HTTPS 或 localhost）
    if (window.crypto && window.crypto.subtle) {
        try {
            const digest = await crypto.subtle.digest('SHA-256', uint8);
            const bytes = new Uint8Array(digest);
            return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn('[SHA256] Web Crypto API 失败，降级到纯 JS 实现:', e);
        }
    }

    // 降级到纯 JS 实现（HTTP 协议下）
    if (typeof sha256 !== 'undefined') {
        return sha256(uint8);
    }

    // 如果都不可用，返回空字符串（跳过哈希校验）
    console.warn('[SHA256] 无法计算哈希，跳过校验');
    return '';
}

async function sha256OfBlob(blob) {
    const arrayBuffer = await blob.arrayBuffer();

    // 检测 crypto.subtle 是否可用（HTTPS 或 localhost）
    if (window.crypto && window.crypto.subtle) {
        try {
            const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const bytes = new Uint8Array(digest);
            return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn('[SHA256] Web Crypto API 失败，降级到纯 JS 实现:', e);
        }
    }

    // 降级到纯 JS 实现（HTTP 协议下）
    if (typeof sha256 !== 'undefined') {
        const bytes = new Uint8Array(arrayBuffer);
        return sha256(bytes);
    }

    // 如果都不可用，返回空字符串（跳过哈希校验）
    console.warn('[SHA256] 无法计算哈希，跳过校验');
    return '';
}

function triggerBrowserDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function updateProgress(percent) {
    const safe = Math.min(Math.max(percent, 0), 100);
    downloadProgressFill.style.transition = 'none';
    downloadProgressFill.style.width = `${safe}%`;
    downloadProgressPercent.textContent = `${Math.round(safe)}%`;
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 获取文件类型
function getFileType(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    const types = {
        'pdf': 'PDF 文档',
        'doc': 'Word 文档',
        'docx': 'Word 文档',
        'xls': 'Excel 文件',
        'xlsx': 'Excel 文件',
        'ppt': 'PPT 演示文稿',
        'pptx': 'PPT 演示文稿',
        'txt': '文本文件',
        'md': 'Markdown 文件',
        'jpg': 'JPEG 图片',
        'jpeg': 'JPEG 图片',
        'png': 'PNG 图片',
        'gif': 'GIF 图片',
        'svg': 'SVG 图片',
        'mp4': 'MP4 视频',
        'mov': 'MOV 视频',
        'avi': 'AVI 视频',
        'mp3': 'MP3 音频',
        'wav': 'WAV 音频',
        'zip': 'ZIP 压缩包',
        'rar': 'RAR 压缩包',
        '7z': '7-Zip 压缩包',
        'apk': 'Android 安装包',
        'ipa': 'iOS 安装包',
        'dmg': 'macOS 安装包',
        'exe': 'Windows 执行文件'
    };
    return types[ext] || `${ext.toUpperCase()} 文件`;
}

// 显示指定阶段
function showStage(stageId) {
    document.querySelectorAll('.stage').forEach(stage => {
        stage.classList.remove('active');
    });
    const el = document.getElementById(stageId);
    if (el) {
        el.classList.add('active');
    }
}
