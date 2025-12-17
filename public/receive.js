// Socket.IO 连接
const socket = io();

// 全局变量
let currentPickupCode = null;
let receivedChunks = [];
let expectedFileInfo = null;
let downloadStartTime = null;
let totalBytesReceived = 0;
let isConnecting = false;
let isDownloading = false;
let totalChunks = 0;
let chunksReceived = 0;
let chunkMap = new Map(); // 用于存储接收到的chunk，按索引排序
let transferMode = null; // 传输模式：memory, storage, p2p
let senderNATInfo = null; // P2P发送端NAT信息
let receiverNATInfo = null; // P2P接收端NAT信息

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

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    setupInputHandlers();
    setupSocketListeners();
});

// 设置输入处理
function setupInputHandlers() {
    const boxes = document.querySelectorAll('.code-box');
    
    // 更新UI显示函数
    function updateDisplay(value) {
        boxes.forEach((box, index) => {
            const char = value[index] || '';
            box.textContent = char;
            
            // 处理填充状态
            if (char) {
                box.classList.add('filled');
                // 只有新输入的字符才加动画（简单判断：如果是当前输入的最后一位）
                if (index === value.length - 1) {
                    box.classList.add('pop');
                    setTimeout(() => box.classList.remove('pop'), 300);
                }
            } else {
                box.classList.remove('filled');
            }
            
            // 处理激活聚焦状态
            // 如果当前是待输入位，或者是已满时的最后一位，则激活
            if (index === value.length || (value.length === 4 && index === 3)) {
                box.classList.add('active');
            } else {
                box.classList.remove('active');
            }
        });
    }

    // 取件码输入格式化
    pickupCodeInput.addEventListener('input', function(e) {
        let value = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
        if (value.length > 4) {
            value = value.slice(0, 4);
        }
        e.target.value = value;
        
        // 更新视觉UI
        updateDisplay(value);
        
        // 自动连接当输入4位时
        if (value.length === 4) {
            setTimeout(() => {
                // 检查是否已经在连接或连接成功
                if (!isConnecting && !currentPickupCode) {
                    connectToSender();
                }
            }, 500);
        }
    });
    
    // 聚焦处理
    pickupCodeInput.addEventListener('focus', () => {
        updateDisplay(pickupCodeInput.value);
    });
    
    pickupCodeInput.addEventListener('blur', () => {
        boxes.forEach(box => box.classList.remove('active'));
    });
    
    // 回车键连接
    pickupCodeInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && e.target.value.length === 4) {
            connectToSender();
        }
    });
    
    // 焦点到输入框
    pickupCodeInput.focus();
}

// 连接到发送方
async function connectToSender() {
    const code = pickupCodeInput.value.trim();
    
    if (code.length !== 4) {
        alert('请输入4位取件码');
        return;
    }
    
    // 防止重复连接
    if (isConnecting) {
        console.log('正在连接中，忽略重复请求');
        return;
    }
    
    isConnecting = true;
    currentPickupCode = code;
    connectBtn.disabled = true;
    connectBtn.textContent = '连接中...';
    
    // 切换到连接中状态
    showStage('connecting-stage');
    
    // 首先检查是否是服务器存储模式
    try {
        const storageResponse = await fetch(`/api/stored-file/${code}`);
        
        if (storageResponse.ok) {
            // 服务器存储模式
            const data = await storageResponse.json();
            if (data.success) {
                transferMode = 'storage';
                expectedFileInfo = data.fileInfo;
                
                // 显示文件预览
                previewFileName.textContent = data.fileInfo.name;
                previewFileSize.textContent = formatFileSize(data.fileInfo.size);
                previewFileType.textContent = data.fileInfo.type || '未知类型';
                
                isConnecting = false;
                showStage('file-confirm-stage');
                return;
            }
        }
    } catch (error) {
        // 404是正常的（P2P或内存模式下文件不在服务器），静默处理
        // 只在非404错误时输出日志
        if (!error.message || !error.message.includes('404')) {
            console.log('检查存储文件时出错:', error);
        }
    }
    
    // 尝试加入Socket会话（内存流式或P2P）
    socket.emit('join-session', { pickupCode: code }, (response) => {
        isConnecting = false; // 重置连接状态
        
        if (response.success) {
            // 连接成功，等待文件信息
            // 不要在这里设置transferMode，等待file-info事件来设置
            console.log('✅ 连接成功，等待文件信息...');
        } else {
            // 连接失败
            showError(response.message || '连接失败');
            // 重置UI状态
            connectBtn.disabled = false;
            connectBtn.textContent = '连接';
        }
    });
}

// 设置Socket事件监听
function setupSocketListeners() {
    // 全局监听P2P NAT信息（发送端）
    socket.on('p2p-nat-info', (data) => {
        if (data.pickupCode === currentPickupCode && data.role === 'sender') {
            senderNATInfo = data.natType;
            console.log('[P2P] 接收到发送端NAT信息:', senderNATInfo);
            // 立即更新NAT显示
            if (receiverNATInfo) {
                updateP2PNATDisplay(senderNATInfo, receiverNATInfo);
            }
        }
    });
    
    // 接收文件信息
    socket.on('file-info', async (fileInfo) => {
        const { pickupCode: infoPickupCode, name, size, type, mode } = fileInfo;
        
        console.log('📥 [接收端] 收到file-info事件 #' + (window.fileInfoCount = (window.fileInfoCount || 0) + 1), ':', { pickupCode: infoPickupCode, mode, name, size });
        console.log('📥 [完整fileInfo]:', fileInfo);
        
        // 严格验证：只接收属于当前房间的文件信息
        if (infoPickupCode && infoPickupCode !== currentPickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的文件信息: ${infoPickupCode} (当前: ${currentPickupCode})`);
            return;
        }
        
        expectedFileInfo = { name, size, type };
        
        console.log('🔍 [调试] mode值:', mode, '当前transferMode:', transferMode);
        const oldMode = transferMode;
        transferMode = mode || transferMode || 'memory';
        
        console.log('🔄 [接收端] 传输模式从', oldMode, '变更为:', transferMode);
        
        // 如果是P2P模式，初始化P2P接收
        if (mode === 'p2p') {
            console.log('🚀 [P2P] 开始初始化P2P接收端，pickupCode:', currentPickupCode);
            p2p = new P2PFileTransfer(socket);
            window.currentP2P = p2p;
            
            console.log('⏳ [P2P] P2PFileTransfer实例已创建，开始NAT检测...');
            receiverNATInfo = await p2p.initReceiver(currentPickupCode);
            console.log('✅ [P2P] NAT检测完成，pickupCode已设置为:', p2p.pickupCode);
            console.log('📊 [P2P] 接收端NAT信息:', receiverNATInfo);
            
            // 发送接收端NAT信息到服务器
            socket.emit('p2p-nat-info', {
                pickupCode: currentPickupCode,
                natType: receiverNATInfo,
                role: 'receiver'
            });
            
            console.log('📤 [P2P] 接收端NAT信息已发送到服务器');
            
            // 请求服务器发送发送端的NAT信息（如果已经有的话）
            socket.emit('request-nat-info', { pickupCode: currentPickupCode });
            
            // 显示NAT信息（在确认阶段显示）
            setTimeout(() => {
                console.log('[P2P] 当前NAT信息 - 发送端:', senderNATInfo, '接收端:', receiverNATInfo);
                updateP2PNATDisplay(senderNATInfo, receiverNATInfo);
                
                // 显示传输模式提示（移动设备 vs 桌面设备）
                displayP2PTransferModeHint();
            }, 500); // 增加延迟，等待服务器响应
            
            // 设置P2P事件处理
            p2p.onDataReceived = handleP2PData;
            p2p.onChannelOpen = () => {
                console.log('P2P通道已打开，准备接收文件');
            };
        }
        
        // 显示文件预览
        previewFileName.textContent = name || fileInfo.name;
        previewFileSize.textContent = formatFileSize(size || fileInfo.size);
        previewFileType.textContent = type || fileInfo.type || '未知类型';
        
        // 切换到确认阶段
        showStage('file-confirm-stage');
    });
    
    // 接收文件数据块 (已废弃，改为HTTP下载)
    // socket.on('file-chunk', ...) 已移除

    
    // 连接丢失
    socket.on('connection-lost', (data) => {
        const { pickupCode: lostPickupCode } = data || {};
        
        // 验证是否属于当前房间
        if (lostPickupCode && lostPickupCode !== currentPickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的断连: ${lostPickupCode} (当前: ${currentPickupCode})`);
            return;
        }
        
        console.log(`[${currentPickupCode}] 检测到连接丢失`);
        isDownloading = false;
        showError('连接已断开');
    });
    
    // 传输进度更新（从服务器同步）
    socket.on('transfer-progress', (data) => {
        const { pickupCode: progressPickupCode, progress, chunkIndex, totalChunks: progressTotalChunks, bytesTransferred } = data;
        
        // 严格验证：只接收属于当前房间的进度更新
        if (progressPickupCode && progressPickupCode !== currentPickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的进度: ${progressPickupCode} (当前: ${currentPickupCode})`);
            return;
        }
        
        // 更新本地变量用于速度计算
        if (progressTotalChunks) {
             totalChunks = progressTotalChunks;
        }
        
        // 使用服务器报告的实际字节数（更准确）
        if (bytesTransferred !== undefined && bytesTransferred > totalBytesReceived) {
            totalBytesReceived = bytesTransferred;
        }
        
        // 使用服务器同步的进度（更准确）
        if (progress !== undefined) {
            updateDownloadProgress(progress);
            
            // 如果进度达到100%，且没有在下载完成阶段，则切换状态
            if (progress >= 100 && isDownloading) {
                setTimeout(() => {
                    showStage('download-complete-stage');
                    isDownloading = false;
                    // 通知服务器下载完成（虽然服务器可能已经知道了，但作为确认）
                    socket.emit('download-complete', { pickupCode: currentPickupCode });
                }, 1000);
            }
        }
    });
    
    // 连接错误
    socket.on('connect_error', () => {
        showError('无法连接到服务器');
    });
    
    // 断开连接
    socket.on('disconnect', () => {
        console.log('Socket断开连接');
        isDownloading = false;
        if (currentPickupCode) {
            showError('与服务器断开连接');
        }
    });
}

// 接受文件传输
function acceptTransfer() {
    if (!expectedFileInfo) return;
    
    console.log('👆 [接收端] 用户点击接收文件，传输模式:', transferMode);
    
    // 更新下载文件名显示
    downloadFileName.textContent = expectedFileInfo.name;
    
    // 切换到下载阶段
    showStage('download-stage');
    
    if (transferMode === 'storage') {
        // 服务器存储模式：直接下载
        console.log('💾 [存储模式] 开始下载服务器存储的文件');
        downloadStoredFile();
    } else if (transferMode === 'p2p') {
        // P2P模式：通知服务器接收端已准备好
        console.log('🔔 [P2P] P2P模式，发送accept-transfer通知服务器');
        socket.emit('accept-transfer', { pickupCode: currentPickupCode });
        console.log('✅ [P2P] accept-transfer已发送，等待P2P连接建立...');
        // P2P的下载逻辑已经在handleP2PData中处理
    } else {
        // 内存流式传输模式：使用HTTP流
        console.log('🌊 [内存模式] 开始HTTP流式下载');
        downloadMemoryStream();
    }
}

// 下载服务器存储的文件
function downloadStoredFile() {
    const downloadUrl = `/api/download-stored/${currentPickupCode}`;
    
    // 创建隐藏的下载链接
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = expectedFileInfo.name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    console.log(`[${currentPickupCode}] 服务器存储模式下载已触发`);
    
    // 模拟进度（因为浏览器下载无法获取实时进度）
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += 10;
        updateDownloadProgress(progress);
        
        if (progress >= 100) {
            clearInterval(progressInterval);
            setTimeout(() => {
                showStage('download-complete-stage');
            }, 500);
        }
    }, 500);
}

// 下载内存流式文件
function downloadMemoryStream() {
    const downloadUrl = `/api/download/${currentPickupCode}`;
    
    // 使用 iframe 触发下载
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = downloadUrl;
    document.body.appendChild(iframe);
    
    // 几分钟后清理 iframe
    setTimeout(() => {
        document.body.removeChild(iframe);
    }, 60000);
    
    console.log(`[${currentPickupCode}] 已发起HTTP流式下载请求`);
    
    // 重置进度条
    updateDownloadProgress(0);
    isDownloading = true;
    downloadStartTime = Date.now();
    totalBytesReceived = 0; 
}

// 拒绝文件传输
function declineTransfer() {
    socket.disconnect();
    location.reload();
}

// 完成下载
function completeDownload() {
    if (!expectedFileInfo) {
        showError('文件接收失败：缺少文件信息');
        return;
    }
    
    // 确定使用哪种存储方式
    const hasChunkMap = chunkMap.size > 0;
    const hasChunkArray = receivedChunks.length > 0;
    
    if (!hasChunkMap && !hasChunkArray) {
        showError('文件接收失败：没有接收到任何数据');
        return;
    }
    
    try {
        let mergedArray;
        let totalSize;
        
        if (hasChunkMap) {
            // 使用Map方式：按索引排序合并
            console.log(`[${currentPickupCode}] 使用Map方式合并 ${chunkMap.size} 个chunk`);
            totalSize = Array.from(chunkMap.values()).reduce((sum, chunk) => sum + chunk.length, 0);
            mergedArray = new Uint8Array(totalSize);
            let offset = 0;
            
            // 按索引顺序合并
            const sortedIndices = Array.from(chunkMap.keys()).sort((a, b) => a - b);
            for (const index of sortedIndices) {
                const chunk = chunkMap.get(index);
                mergedArray.set(chunk, offset);
                offset += chunk.length;
            }
        } else {
            // 使用数组方式：顺序合并
            console.log(`[${currentPickupCode}] 使用数组方式合并 ${receivedChunks.length} 个chunk`);
            totalSize = receivedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            mergedArray = new Uint8Array(totalSize);
            let offset = 0;
            
            for (const chunk of receivedChunks) {
                mergedArray.set(chunk, offset);
                offset += chunk.length;
            }
        }
        
        // 创建Blob并下载
        const blob = new Blob([mergedArray], { 
            type: expectedFileInfo.type || 'application/octet-stream' 
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = expectedFileInfo.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        // 显示完成状态
        showStage('download-complete-stage');
        
        // 通知服务器和发送端下载完成
        socket.emit('download-complete', { pickupCode: currentPickupCode });
        console.log('文件下载完成，已通知发送端');
        
        // 清理数据和状态
        receivedChunks = [];
        chunkMap.clear();
        totalBytesReceived = 0;
        chunksReceived = 0;
        totalChunks = 0;
        isDownloading = false;
        
    } catch (error) {
        console.error('文件下载失败:', error);
        showError('文件下载失败');
    }
}

// 更新下载进度
function updateDownloadProgress(progress) {
    if (!isDownloading) {
        console.log('未在下载状态，不更新进度');
        return;
    }
    
    const percent = Math.round(Math.min(progress, 100));
    downloadProgressFill.style.width = `${percent}%`;
    downloadProgressPercent.textContent = `${percent}%`;
    
    // 计算下载速度
    if (downloadStartTime && totalBytesReceived > 0) {
        const elapsed = (Date.now() - downloadStartTime) / 1000;
        const speed = totalBytesReceived / elapsed;
        downloadSpeed.textContent = `${formatFileSize(speed)}/s`;
        
        // 定期向发送端发送速度更新（每秒发送一次，避免过于频繁）
        if (!window.lastSpeedUpdate || Date.now() - window.lastSpeedUpdate > 1000) {
            window.lastSpeedUpdate = Date.now();
            if (currentPickupCode && socket.connected) {
                socket.emit('transfer-speed', { 
                    pickupCode: currentPickupCode,
                    speed: speed
                });
            }
        }
    }
}

// 显示错误
function showError(message) {
    errorText.textContent = message;
    showStage('error-stage');
    
    // 重置所有状态
    isConnecting = false;
    isDownloading = false;
    currentPickupCode = null;
    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
    
    // 清理数据
    receivedChunks = [];
    chunkMap.clear();
    totalBytesReceived = 0;
    chunksReceived = 0;
    totalChunks = 0;
}

// 显示指定阶段
function showStage(stageId) {
    // 隐藏所有阶段
    document.querySelectorAll('.stage').forEach(stage => {
        stage.classList.remove('active');
    });
    
    // 显示目标阶段
    document.getElementById(stageId).classList.add('active');
}

// P2P 数据接收处理
let p2pReceivedData = [];
let p2pMetadata = null;
let p2pTotalReceived = 0; // 累计接收字节数
let p2pLastProgressUpdate = 0; // 上次UI更新时间
let p2pLastSyncUpdate = 0; // 上次同步给发送端的时间
let p2pLastReceivedBytes = 0; // 上次更新时的接收字节数
const P2P_PROGRESS_UPDATE_INTERVAL = 100; // UI进度更新间隔(ms)
const P2P_SYNC_INTERVAL = 1000; // 同步给发送端的间隔(ms)

// 流式写入相关
let p2pWritableStream = null; // 文件写入流
let p2pStreamWriter = null; // StreamSaver writer
let p2pStreamingMode = false; // 是否使用流式模式
let p2pReadyToReceive = false; // 是否准备好接收数据
let p2p = null; // P2P传输实例（全局）

// 检测是否为移动设备
function isMobileDevice() {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    
    // 检测移动设备的用户代理
    const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
    const isMobile = mobileRegex.test(userAgent);
    
    // 额外检测：触摸屏 + 小屏幕
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isSmallScreen = window.innerWidth <= 768;
    
    const result = isMobile || (isTouchDevice && isSmallScreen);
    
    console.log('📱 设备检测:', {
        userAgent: userAgent.substring(0, 50) + '...',
        isMobile: isMobile,
        isTouchDevice: isTouchDevice,
        isSmallScreen: isSmallScreen,
        screenWidth: window.innerWidth,
        最终判定: result ? '移动设备' : '桌面设备'
    });
    
    return result;
}

function handleP2PData(data) {
    // 尝试解析为JSON（元数据或控制消息）
    if (typeof data === 'string') {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'metadata') {
                p2pMetadata = message;
                console.log('📦 收到P2P文件元数据:', p2pMetadata);
                
                // 重置接收统计
                p2pReceivedData = []; // 清空之前的数据
                p2pTotalReceived = 0;
                p2pLastProgressUpdate = Date.now();
                p2pLastSyncUpdate = Date.now();
                p2pLastReceivedBytes = 0;
                p2pReadyToReceive = false; // 等待用户确认
                
                // 尝试初始化流式写入
                initP2PStreamDownload();
                
                return;
            } else if (message.type === 'start-transfer') {
                // 发送端确认可以开始传输了
                console.log('📡 发送端已准备好，开始接收数据');
                p2pReadyToReceive = true;
                
                // 切换到下载阶段
                showStage('download-stage');
                downloadFileName.textContent = p2pMetadata.name;
                downloadStartTime = Date.now();
                isDownloading = true;
                
                console.log(`🚀 开始接收文件，大小: ${formatFileSize(p2pMetadata.size)}`);
                
                return;
            } else if (message.type === 'complete') {
                console.log('✅ P2P文件接收完成，总大小:', formatFileSize(p2pTotalReceived));
                completeP2PDownload();
                return;
            }
        } catch (e) {
            // 不是JSON，作为普通数据处理
        }
    }
    
    // 接收文件数据块
    if (data instanceof ArrayBuffer) {
        // 检查是否准备好接收
        if (!p2pReadyToReceive) {
            console.warn('⚠️ 尚未准备好接收数据，忽略数据块');
            return;
        }
        
        // 流式写入模式
        if (p2pStreamingMode && p2pStreamWriter) {
            try {
                // 使用StreamSaver的writer直接写入
                const uint8Array = new Uint8Array(data);
                p2pStreamWriter.write(uint8Array);
                p2pTotalReceived += data.byteLength;
            } catch (error) {
                console.error('❌ StreamSaver写入失败，降级到缓存模式:', error);
                // 降级到缓存模式
                p2pStreamingMode = false;
                
                // 尝试关闭StreamSaver writer
                try {
                    if (p2pStreamWriter) {
                        p2pStreamWriter.abort();
                        p2pStreamWriter = null;
                    }
                } catch (abortError) {
                    console.warn('⚠️ 关闭StreamSaver writer失败:', abortError);
                }
                
                // 将当前数据块保存到缓存
                p2pReceivedData.push(data);
                p2pTotalReceived += data.byteLength;
                
                console.log('⚠️ 已切换到内存缓存模式，后续数据将缓存在内存中');
            }
        } else {
            // 缓存模式（降级方案）
            p2pReceivedData.push(data);
            p2pTotalReceived += data.byteLength;
        }
        
        // 对于大文件，定期触发下载以释放内存
        if (p2pMetadata && p2pMetadata.size > 100 * 1024 * 1024) { // >100MB
            // 每接收50MB就触发一次部分下载（流式）
            if (p2pReceivedData.length > 0 && p2pTotalReceived % (50 * 1024 * 1024) < data.byteLength) {
                console.log(`💾 已接收 ${formatFileSize(p2pTotalReceived)}，缓存块数: ${p2pReceivedData.length}`);
            }
        }
        
        // 限制UI更新频率，避免卡顿
        const now = Date.now();
        if (p2pMetadata && p2pMetadata.size && 
            (now - p2pLastProgressUpdate >= P2P_PROGRESS_UPDATE_INTERVAL || 
             p2pTotalReceived >= p2pMetadata.size)) {
            
            const progress = (p2pTotalReceived / p2pMetadata.size) * 100;
            updateDownloadProgress(Math.min(progress, 100));
            
            // 计算实时速度（基于最近一段时间的接收量）
            const timeDelta = (now - p2pLastProgressUpdate) / 1000;
            const bytesDelta = p2pTotalReceived - p2pLastReceivedBytes;
            
            let instantSpeed = 0;
            if (timeDelta > 0) {
                instantSpeed = bytesDelta / timeDelta;
                downloadSpeed.textContent = `${formatFileSize(instantSpeed)}/s`;
            }
            
            // 更新统计
            p2pLastProgressUpdate = now;
            p2pLastReceivedBytes = p2pTotalReceived;
            
            // P2P模式下，每1秒向服务器同步一次进度给发送端
            if (now - p2pLastSyncUpdate >= P2P_SYNC_INTERVAL || p2pTotalReceived >= p2pMetadata.size) {
                const progressData = {
                    pickupCode: currentPickupCode,
                    progress: progress,
                    bytesReceived: p2pTotalReceived,
                    speed: instantSpeed
                };
                socket.emit('p2p-progress', progressData);
                p2pLastSyncUpdate = now;
                console.log(`📤 [接收端同步] 进度: ${progress.toFixed(1)}%, 速度: ${formatFileSize(instantSpeed)}/s, pickupCode: ${currentPickupCode}`);
            }
        }
    }
}

// 检测是否为移动设备
function isMobileDevice() {
    // 方法1：通过 userAgent 检测
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    
    // 检测常见移动设备标识
    const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
    if (mobileRegex.test(userAgent)) {
        return true;
    }
    
    // 方法2：通过触摸屏检测（辅助判断）
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    
    // 方法3：通过屏幕宽度检测（辅助判断）
    const isSmallScreen = window.innerWidth <= 768;
    
    // 综合判断：触摸屏 + 小屏幕 = 移动设备
    if (hasTouch && isSmallScreen) {
        return true;
    }
    
    // 方法4：检测平台信息（新API）
    if (navigator.userAgentData && navigator.userAgentData.mobile) {
        return true;
    }
    
    return false;
}

// 初始化P2P流式下载
async function initP2PStreamDownload() {
    if (!p2pMetadata) return;
    
    console.log('🔧 尝试使用StreamSaver.js初始化流式下载...');
    console.log('🔍 检查StreamSaver支持:', typeof streamSaver !== 'undefined');
    
    // 检测是否为移动设备
    const isMobile = isMobileDevice();
    
    // 移动设备强制使用缓存模式（因为需要用户确认下载）
    if (isMobile) {
        console.log('📱 检测到移动设备，使用缓存模式（传输完成后统一下载）');
        p2pStreamingMode = false;
        p2pStreamWriter = null;
        
        // 通知发送端可以开始传输了
        notifyReadyToReceive();
        return;
    }
    
    // 桌面设备：检查StreamSaver是否可用
    if (typeof streamSaver !== 'undefined') {
        try {
            // 配置StreamSaver (可选)
            // streamSaver.mitm = '/path/to/mitm.html'; // 如果需要自定义Service Worker路径
            
            // 创建流式写入流
            const fileStream = streamSaver.createWriteStream(p2pMetadata.name, {
                size: p2pMetadata.size // 提供文件大小可以显示更准确的进度
            });
            
            p2pStreamWriter = fileStream.getWriter();
            p2pStreamingMode = true;
            
            console.log('✅ StreamSaver流式下载已初始化，文件将边收边存');
            console.log(`📦 文件: ${p2pMetadata.name}, 大小: ${formatFileSize(p2pMetadata.size)}`);
            
            // 通知发送端可以开始传输了
            notifyReadyToReceive();
            
        } catch (error) {
            console.warn('⚠️ StreamSaver初始化失败，降级到缓存模式:', error);
            // 降级到缓存模式
            p2pStreamingMode = false;
            p2pStreamWriter = null;
            
            // 通知发送端可以开始传输了
            notifyReadyToReceive();
        }
    } else {
        // StreamSaver不可用，使用缓存模式
        console.log('ℹ️ StreamSaver不可用，使用缓存模式');
        p2pStreamingMode = false;
        
        // 通知发送端可以开始传输了
        notifyReadyToReceive();
    }
}

// 通知发送端准备好接收
function notifyReadyToReceive() {
    console.log('📤 通知发送端：接收端已准备好');
    
    // 通过 P2P DataChannel 发送准备好的信号
    if (p2p && p2p.dataChannel && p2p.dataChannel.readyState === 'open') {
        p2p.dataChannel.send(JSON.stringify({ type: 'receiver-ready' }));
    }
    
    // 同时通过服务器发送（双保险）
    socket.emit('receiver-ready-for-data', {
        pickupCode: currentPickupCode,
        streamingMode: p2pStreamingMode
    });
}

// 完成P2P下载
async function completeP2PDownload() {
    // 验证接收的数据大小是否匹配
    if (p2pTotalReceived !== p2pMetadata.size) {
        console.warn(`⚠️ 数据大小不匹配！期望: ${p2pMetadata.size}, 实际: ${p2pTotalReceived}`);
    }
    
    // 确保进度显示为100%
    updateDownloadProgress(100);
    
    let finalSize = p2pTotalReceived;
    
    // 流式模式：关闭写入流
    if (p2pStreamingMode && p2pStreamWriter) {
        try {
            await p2pStreamWriter.close();
            console.log(`✅ StreamSaver流式下载完成，文件已保存，大小: ${formatFileSize(p2pTotalReceived)}`);
            finalSize = p2pTotalReceived;
        } catch (error) {
            console.error('❌ 关闭StreamSaver写入流失败:', error);
            showError('文件保存失败');
            return;
        }
    } 
    // 缓存模式：创建 Blob 并下载
    else {
        if (!p2pMetadata || p2pReceivedData.length === 0) {
            showError('P2P接收失败：数据不完整');
            return;
        }
        
        console.log(`📦 开始创建Blob，共 ${p2pReceivedData.length} 个数据块，总大小: ${formatFileSize(p2pTotalReceived)}`);
        
        // 检测是否为移动设备
        const isMobile = isMobileDevice();
        
        // 直接使用 ArrayBuffer 数组创建 Blob
        const blob = new Blob(p2pReceivedData, { 
            type: p2pMetadata.mimeType || 'application/octet-stream' 
        });
        
        console.log(`✅ Blob创建成功，大小: ${formatFileSize(blob.size)} (期望: ${formatFileSize(p2pMetadata.size)})`);
        
        // 最终验证
        if (blob.size !== p2pMetadata.size) {
            console.error(`❌ 文件大小验证失败！Blob: ${blob.size}, 期望: ${p2pMetadata.size}`);
            showError(`文件接收不完整：${formatFileSize(blob.size)} / ${formatFileSize(p2pMetadata.size)}`);
            return;
        }
        
        // 触发下载
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = p2pMetadata.name;
        
        // 移动设备优化：添加额外的提示和处理
        if (isMobile) {
            console.log('📱 移动设备：准备触发下载（需要用户确认）');
            
            // 移动设备上，先显示一个提示，让用户知道即将下载
            // 某些移动浏览器需要用户交互才能触发下载
            document.body.appendChild(a);
            
            // 使用 setTimeout 确保 DOM 更新完成
            setTimeout(() => {
                a.click();
                
                // 延迟清理，确保下载已触发
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    console.log('📱 移动设备：下载已触发，资源已清理');
                }, 1000);
            }, 100);
        } else {
            // 桌面设备：直接触发下载
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('💻 桌面设备：下载已触发');
        }
        
        finalSize = blob.size;
    }
    
    // 通知服务器和发送端：接收完成
    socket.emit('p2p-complete', {
        pickupCode: currentPickupCode,
        totalBytes: finalSize
    });
    
    console.log('📤 已通知发送端：文件接收完成');
    
    // 显示完成状态
    showStage('download-complete-stage');
    
    // 清理P2P相关变量
    p2pReceivedData = [];
    p2pMetadata = null;
    p2pTotalReceived = 0;
    p2pLastProgressUpdate = 0;
    p2pLastSyncUpdate = 0;
    p2pLastReceivedBytes = 0;
    p2pWritableStream = null;
    p2pStreamWriter = null;
    p2pStreamingMode = false;
    p2pReadyToReceive = false;
    isDownloading = false;
    
    // 通知服务器
    socket.emit('download-complete', { pickupCode: currentPickupCode });
    
    // 关闭P2P连接
    if (window.currentP2P) {
        window.currentP2P.close();
        window.currentP2P = null;
    }
}

// 显示P2P传输模式提示
function displayP2PTransferModeHint() {
    const confirmStage = document.getElementById('file-confirm-stage');
    let modeHint = confirmStage.querySelector('.p2p-mode-hint');
    
    // 如果已存在，先移除
    if (modeHint) {
        modeHint.remove();
    }
    
    // 检测设备类型
    const isMobile = isMobileDevice();
    
    // 创建提示元素
    modeHint = document.createElement('div');
    modeHint.className = 'p2p-mode-hint';
    modeHint.style.cssText = `
        margin-top: 15px;
        margin-bottom: 25px;
        padding: 12px 15px;
        border-radius: 8px;
        font-size: 0.9rem;
        line-height: 1.5;
    `;
    
    if (isMobile) {
        // 移动设备提示
        modeHint.style.background = 'rgba(255, 193, 7, 0.15)';
        modeHint.style.border = '1px solid rgba(255, 193, 7, 0.3)';
        modeHint.style.color = 'var(--text-main)';
        modeHint.innerHTML = `
            <div style="text-align: center;">
                <div style="margin-bottom: 8px;">
                    <span style="font-size: 1.2rem;">📱</span>
                    <strong style="color: #f59e0b; margin-left: 5px;">移动设备模式</strong>
                </div>
                <div style="font-size: 0.85rem; color: var(--text-sub);">
                    文件将先接收到内存，传输完成后统一下载（需要您确认下载）
                </div>
            </div>
        `;
    } else {
        // 桌面设备提示
        modeHint.style.background = 'rgba(16, 185, 129, 0.15)';
        modeHint.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        modeHint.style.color = 'var(--text-main)';
        modeHint.innerHTML = `
            <div style="text-align: center;">
                <div style="margin-bottom: 8px;">
                    <span style="font-size: 1.2rem;">💻</span>
                    <strong style="color: #10b981; margin-left: 5px;">桌面设备模式</strong>
                </div>
                <div style="font-size: 0.85rem; color: var(--text-sub);">
                    文件将边接收边保存到磁盘，内存占用极低
                </div>
            </div>
        `;
    }
    
    // 插入到NAT信息之后
    const natDisplay = confirmStage.querySelector('.nat-detection');
    if (natDisplay) {
        natDisplay.after(modeHint);
    } else {
        // 如果没有NAT显示，插入到文件详情之后
        const fileDetails = confirmStage.querySelector('.file-details');
        if (fileDetails) {
            fileDetails.after(modeHint);
        }
    }
}

// 更新P2P NAT显示
function updateP2PNATDisplay(senderNAT, receiverNAT) {
    const confirmStage = document.getElementById('file-confirm-stage');
    let natDisplay = confirmStage.querySelector('.nat-detection');
    
    if (!natDisplay) {
        natDisplay = document.createElement('div');
        natDisplay.className = 'nat-detection';
        natDisplay.style.marginTop = '20px';
        
        const fileDetails = confirmStage.querySelector('.file-details');
        if (fileDetails) {
            fileDetails.after(natDisplay);
        }
    }
    
    // 计算综合成功率
    let totalSuccess = receiverNAT.success;
    if (senderNAT) {
        totalSuccess = Math.min(senderNAT.success, receiverNAT.success);
        if (senderNAT.success >= 90 && receiverNAT.success >= 90) {
            totalSuccess = Math.min(95, (senderNAT.success + receiverNAT.success) / 2);
        }
    }
    
    natDisplay.innerHTML = `
        <h4 style="margin-bottom: 15px; color: var(--text-main);">🌐 P2P 连接状态</h4>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
            <div style="background: rgba(255,255,255,0.5); padding: 12px; border-radius: 10px;">
                <div style="font-weight: 600; margin-bottom: 8px; color: var(--primary-color);">📤 发送端</div>
                <div style="font-size: 0.9rem; color: var(--text-main);">
                    ${senderNAT ? `
                        <span class="nat-type" style="font-size: 0.85rem;">${senderNAT.type} - ${senderNAT.name}</span>
                    ` : `
                        <span style="color: var(--text-sub);">等待发送端信息...</span>
                    `}
                </div>
            </div>
            
            <div style="background: rgba(255,255,255,0.5); padding: 12px; border-radius: 10px;">
                <div style="font-weight: 600; margin-bottom: 8px; color: var(--secondary-color);">📥 接收端</div>
                <div style="font-size: 0.9rem; color: var(--text-main);">
                    <span class="nat-type" style="font-size: 0.85rem;">${receiverNAT.type} - ${receiverNAT.name}</span>
                </div>
            </div>
        </div>
        
        <div class="nat-info" style="background: rgba(99, 102, 241, 0.1); padding: 15px; border-radius: 10px;">
            <div style="text-align: center; width: 100%;">
                <strong style="color: var(--text-main); font-size: 1.1rem;">预计连接成功率</strong>
                <div class="nat-success-rate" style="font-size: 2.5rem; margin: 10px 0; font-weight: 700; color: var(--primary-color);">${Math.round(totalSuccess)}%</div>
                <p style="font-size: 0.85rem; color: var(--text-sub); margin: 0;">
                    ${senderNAT ? getP2PTips(senderNAT, receiverNAT) : '等待发送端信息后显示详细建议'}
                </p>
            </div>
        </div>
    `;
}

// 获取P2P连接提示
function getP2PTips(senderNAT, receiverNAT) {
    const minSuccess = Math.min(senderNAT.success, receiverNAT.success);
    
    if (minSuccess >= 90) {
        return '✅ 双方网络环境极佳，P2P连接成功率很高';
    } else if (minSuccess >= 75) {
        return '✅ 网络环境良好，P2P连接应该能建立';
    } else if (minSuccess >= 50) {
        return '⚠️ 网络环境一般，P2P连接可能需要一些时间';
    } else {
        return '❌ 网络环境较差，建议使用服务器中转模式';
    }
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

