// Socket.IO 连接
const socket = io();

// 全局变量
let selectedFile = null;
let pickupCode = null;
let transferStartTime = null;
let isTransferring = false;
let transferMode = 'memory'; // 默认内存流式传输
let availableFeatures = {
    memoryStreaming: true,
    serverStorage: false,
    p2pDirect: false
};
let storageConfig = {
    fileRetentionHours: 24,
    deleteOnDownload: false
};

// DOM 元素
const fileInput = document.getElementById('fileInput');
const fileDropZone = document.getElementById('fileDropZone');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const pickupCodeDisplay = document.getElementById('pickupCode');
const statusText = document.getElementById('statusText');
const statusIndicator = document.getElementById('statusIndicator');
const progressFill = document.getElementById('progressFill');
const progressPercent = document.getElementById('progressPercent');
const transferSpeed = document.getElementById('transferSpeed');

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    setupFileDropZone();
    setupSocketListeners();
    loadAvailableFeatures();
});

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
        
        if (data.success && data.features) {
            availableFeatures = data.features;
            // 保存存储配置
            if (data.storageConfig) {
                storageConfig = data.storageConfig;
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
    const memoryOption = document.getElementById('memoryModeOption');
    const storageOption = document.getElementById('storageModeOption');
    const p2pOption = document.getElementById('p2pModeOption');
    
    if (memoryOption) memoryOption.style.display = availableFeatures.memoryStreaming ? 'block' : 'none';
    if (storageOption) storageOption.style.display = availableFeatures.serverStorage ? 'block' : 'none';
    if (p2pOption) p2pOption.style.display = availableFeatures.p2pDirect ? 'block' : 'none';
    
    // 检查是否所有模式都被禁用
    const allDisabled = !availableFeatures.memoryStreaming && 
                       !availableFeatures.serverStorage && 
                       !availableFeatures.p2pDirect;
    
    if (allDisabled) {
        // 所有模式都被禁用，显示提示并禁用生成按钮
        const modeSelection = document.querySelector('.mode-options');
        if (modeSelection) {
            modeSelection.innerHTML = `
                <div style="text-align: center; padding: 30px; color: var(--text-sub);">
                    <p style="font-size: 1.2rem; margin-bottom: 10px;">⚠️ 暂时无法使用</p>
                    <p>管理员已关闭所有传输模式</p>
                    <p style="font-size: 0.9rem; margin-top: 10px;">请联系管理员开启传输功能</p>
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
    } else if (availableFeatures.serverStorage) {
        document.getElementById('storageMode').checked = true;
        transferMode = 'storage';
    } else if (availableFeatures.p2pDirect) {
        document.getElementById('p2pMode').checked = true;
        transferMode = 'p2p';
    }
}

// 更新服务器存储模式描述
function updateStorageDescription() {
    const storageModeDesc = document.getElementById('storageModeDesc');
    if (!storageModeDesc) return;
    
    if (storageConfig.deleteOnDownload) {
        storageModeDesc.textContent = '文件暂存服务器，接收方下载后立即删除';
    } else {
        const hours = storageConfig.fileRetentionHours || 24;
        storageModeDesc.textContent = `文件暂存${hours}小时，支持异步下载`;
    }
}

// 更新取件码提示文本
function updateCodeHint() {
    const codeHint = document.getElementById('codeHint');
    if (!codeHint) return;
    
    if (transferMode === 'storage') {
        // 服务器存储模式：根据配置显示有效期
        if (storageConfig.deleteOnDownload) {
            codeHint.textContent = '请将此码分享给接收方 (下载后文件自动删除)';
        } else {
            const hours = storageConfig.fileRetentionHours || 24;
            codeHint.textContent = `请将此码分享给接收方 (${hours}小时内有效)`;
        }
    } else {
        // 内存流式传输和P2P模式：30分钟有效
        codeHint.textContent = '请将此码分享给接收方 (30分钟有效)';
    }
}

// 处理文件选择
function handleFileSelect(file) {
    selectedFile = file;
    
    // 显示文件信息
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    
    // 切换到生成取件码阶段
    showStage('code-generate-stage');
    
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
        // 服务器存储模式：直接上传文件
        await uploadFileToServer();
    } else if (transferMode === 'p2p') {
        // P2P 模式：创建P2P会话
        createP2PSession();
    } else {
        // 内存流式传输模式：创建Socket会话
        createMemoryStreamSession();
    }
}

// 创建内存流式传输会话
async function createMemoryStreamSession() {
    socket.emit('create-session', async (response) => {
        if (response.success) {
            pickupCode = response.pickupCode;
            pickupCodeDisplay.textContent = pickupCode;
            
            // 先计算文件哈希
            statusText.textContent = '正在计算文件校验值...';
            let sessionFileHash = '';
            try {
                sessionFileHash = await calculateFileHash(selectedFile);
                console.log(`[会话] 文件SHA-256: ${sessionFileHash.substring(0, 16)}...`);
            } catch (error) {
                console.warn('[会话] 文件哈希计算失败:', error);
            }
            
            // 发送文件信息
            socket.emit('file-info', {
                pickupCode: pickupCode,
                fileInfo: {
                    name: selectedFile.name,
                    size: selectedFile.size,
                    type: selectedFile.type,
                    mode: 'memory',
                    hash: sessionFileHash // 添加哈希值
                }
            });
            
            // 更新取件码提示
            updateCodeHint();
            
            // 切换到等待连接阶段
            showStage('waiting-stage');
        } else {
            alert('生成取件码失败，请重试');
            const generateBtn = document.getElementById('generateCodeBtn');
            generateBtn.disabled = false;
            generateBtn.textContent = '生成取件码';
        }
    });
}

// 上传文件到服务器
async function uploadFileToServer() {
    // 显示上传阶段
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
                
                // 计算上传速度
                const elapsed = (Date.now() - transferStartTime) / 1000;
                const speed = e.loaded / elapsed;
                transferSpeed.textContent = `${formatFileSize(speed)}/s`;
                
                // 更新状态文本
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
                        
                        // 更新状态文本 - 显示文件保留时间
                        let statusMessage = '文件已上传到服务器';
                        if (data.deleteOnDownload) {
                            statusMessage += '，接收方下载后自动删除';
                        } else {
                            const retentionHours = data.retentionHours || 24;
                            statusMessage += `，${retentionHours}小时内有效`;
                        }
                        statusText.textContent = statusMessage;
                        statusIndicator.style.background = '#28a745';
                        
                        // 更新取件码提示
                        updateCodeHint();
                        
                        // 显示等待阶段，保持取件码可见
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
        
        // 上传中止
        xhr.addEventListener('abort', () => {
            alert('上传已取消');
            const generateBtn = document.getElementById('generateCodeBtn');
            generateBtn.disabled = false;
            generateBtn.textContent = '生成取件码';
            reject(new Error('Upload Aborted'));
        });
        
        // 准备并发送请求
        const formData = new FormData();
        formData.append('file', selectedFile);
        
        xhr.open('POST', '/api/upload-file');
        xhr.send(formData);
    });
}

// 创建P2P会话
async function createP2PSession() {
    // 创建常规会话用于信令
    socket.emit('create-session', async (response) => {
        if (response.success) {
            pickupCode = response.pickupCode;
            pickupCodeDisplay.textContent = pickupCode;
            
            // 初始化P2P（但不立即发送Offer）
            const p2p = new P2PFileTransfer(socket);
            window.currentP2P = p2p;
            
            // 检测NAT类型
            statusText.textContent = '正在检测网络环境...';
            // 使用新的方法：只检测NAT，不创建Offer
            await p2p.initSenderNAT(pickupCode, selectedFile);
            const senderNAT = p2p.natType;
            
            // 发送NAT信息到服务器
            socket.emit('p2p-nat-info', {
                pickupCode: pickupCode,
                natType: senderNAT,
                role: 'sender'
            });
            
            // 显示发送端NAT信息
            displayNATInfo(senderNAT, 'sender', null);
            
            // 监听接收端NAT信息
            socket.on('p2p-nat-info', (data) => {
                if (data.pickupCode === pickupCode && data.role === 'receiver') {
                    // 更新显示，包含双端NAT信息
                    displayNATInfo(senderNAT, 'sender', data.natType);
                }
            });
            
            // 发送文件信息（包含P2P模式标记）
            socket.emit('file-info', {
                pickupCode: pickupCode,
                fileInfo: {
                    name: selectedFile.name,
                    size: selectedFile.size,
                    type: selectedFile.type,
                    mode: 'p2p'
                }
            });
            
            // P2P事件处理
            p2p.onChannelOpen = () => {
                statusText.textContent = 'P2P连接已建立，开始传输...';
                showStage('transfer-stage');
                transferStartTime = Date.now();
            };
            
            // P2P模式下，发送端不再自己计算进度，而是接收来自接收端的进度
            // 监听来自接收端的进度更新
            console.log(`🎧 [发送端] 注册p2p-progress监听器，当前pickupCode: ${pickupCode}`);
            socket.on('p2p-progress', (data) => {
                console.log(`📥 [发送端] 收到p2p-progress事件:`, data);
                
                // 严格验证：只接收属于当前房间的进度
                if (data.pickupCode !== pickupCode) {
                    console.log(`[房间隔离] 忽略不属于当前房间的P2P进度: ${data.pickupCode} (当前: ${pickupCode})`);
                    return;
                }
                
                // 更新进度和速度（来自接收端的真实数据）
                updateProgress(data.progress);
                transferSpeed.textContent = `${formatFileSize(data.speed)}/s`;
                
                console.log(`📊 [发送端同步] 进度: ${data.progress.toFixed(1)}%, 速度: ${formatFileSize(data.speed)}/s, 已接收: ${formatFileSize(data.bytesReceived)}`);
            });
            
            // 监听来自接收端的完成通知
            socket.on('p2p-complete', (data) => {
                // 严格验证：只接收属于当前房间的完成通知
                if (data.pickupCode !== pickupCode) {
                    console.log(`[房间隔离] 忽略不属于当前房间的P2P完成: ${data.pickupCode} (当前: ${pickupCode})`);
                    return;
                }
                
                console.log(`🎉 [P2P] 接收端确认完成，总大小: ${formatFileSize(data.totalBytes)}`);
                
                // 显示完成页面
                setTimeout(() => {
                    showStage('complete-stage');
                }, 500);
            });
            
            p2p.onComplete = () => {
                // 发送完成，等待接收端确认
                console.log('✅ [P2P] 文件发送完成，等待接收端确认...');
                statusText.textContent = '文件发送完成，等待接收端保存...';
            };
            
            p2p.onError = (error) => {
                console.error('❌ P2P错误:', error);
                statusText.textContent = 'P2P连接失败，请尝试其他传输方式';
            };
            
            // 更新取件码提示
            updateCodeHint();
            
            // 切换到等待连接阶段
            showStage('waiting-stage');
            statusText.textContent = '等待接收方连接...';
        } else {
            alert('生成取件码失败，请重试');
            const generateBtn = document.getElementById('generateCodeBtn');
            generateBtn.disabled = false;
            generateBtn.textContent = '生成取件码';
        }
    });
}

// 显示NAT信息（双端）
function displayNATInfo(senderNAT, role, receiverNAT) {
    const waitingStage = document.getElementById('waiting-stage');
    
    // 检查是否已经存在NAT信息显示
    let natDisplay = waitingStage.querySelector('.nat-detection');
    
    if (!natDisplay) {
        natDisplay = document.createElement('div');
        natDisplay.className = 'nat-detection';
        natDisplay.style.marginTop = '20px';
        
        // 插入到取件码显示后面
        const pickupCodeDisplay = waitingStage.querySelector('.pickup-code-display');
        pickupCodeDisplay.after(natDisplay);
    }
    
    // 计算综合成功率
    let totalSuccess = senderNAT.success;
    if (receiverNAT) {
        // 基于双方NAT类型计算综合成功率
        totalSuccess = Math.min(senderNAT.success, receiverNAT.success);
        // 如果双方都是好的NAT类型，成功率可以提升
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
                    <span class="nat-type" style="font-size: 0.85rem;">${senderNAT.type} - ${senderNAT.name}</span>
                </div>
            </div>
            
            <div style="background: rgba(255,255,255,0.5); padding: 12px; border-radius: 10px;">
                <div style="font-weight: 600; margin-bottom: 8px; color: var(--secondary-color);">📥 接收端</div>
                <div style="font-size: 0.9rem; color: var(--text-main);">
                    ${receiverNAT ? `
                        <span class="nat-type" style="font-size: 0.85rem;">${receiverNAT.type} - ${receiverNAT.name}</span>
                    ` : `
                        <span style="color: var(--text-sub);">等待连接中...</span>
                    `}
                </div>
            </div>
        </div>
        
        <div class="nat-info" style="background: rgba(99, 102, 241, 0.1); padding: 15px; border-radius: 10px;">
            <div style="text-align: center; width: 100%;">
                <strong style="color: var(--text-main); font-size: 1.1rem;">预计连接成功率</strong>
                <div class="nat-success-rate" style="font-size: 2.5rem; margin: 10px 0; font-weight: 700; color: var(--primary-color);">${Math.round(totalSuccess)}%</div>
                <p style="font-size: 0.85rem; color: var(--text-sub); margin: 0;">
                    ${receiverNAT ? getP2PTips(senderNAT, receiverNAT) : '等待接收端连接后显示详细信息'}
                </p>
            </div>
        </div>
    `;
}

// 获取P2P连接提示（基于双端NAT）
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

// 获取NAT提示信息
function getNATTips(natType) {
    const tips = {
        'NAT0': '✅ 公网IP，P2P连接成功率极高',
        'NAT1': '✅ 全锥型NAT，P2P连接成功率很高',
        'NAT2': '⚠️ 限制型NAT，P2P连接可能需要一些时间',
        'NAT3': '❌ 对称型NAT，P2P连接较困难，建议使用服务器中转',
        'UNKNOWN': '❓ 网络类型未知，将尝试建立连接'
    };
    
    return tips[natType] || tips['UNKNOWN'];
}

// 设置Socket事件监听
function setupSocketListeners() {
    // 接收方连接
    socket.on('receiver-connected', (data) => {
        const { pickupCode: connectedPickupCode } = data;
        
        // 严格验证：只处理属于当前房间的连接事件
        if (connectedPickupCode && connectedPickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的连接: ${connectedPickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        statusText.textContent = '接收方已连接，等待确认...';
        statusIndicator.style.background = '#28a745';
    });
    
    // 接收方确认开始传输
    socket.on('start-transfer', (data) => {
        const { pickupCode: transferPickupCode } = data;
        
        // 严格验证：只处理属于当前房间的开始传输指令
        if (transferPickupCode && transferPickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的开始传输: ${transferPickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        // P2P模式不需要通过服务器传输文件
        if (transferMode === 'p2p') {
            console.log('[P2P] P2P模式下不使用服务器中继传输');
            return;
        }
        
        statusText.textContent = '开始传输文件...';
        setTimeout(() => {
            startFileTransfer();
        }, 500);
    });
    
    // P2P模式：接收端准备好了
    socket.on('receiver-ready-p2p', async (data) => {
        const { pickupCode: readyPickupCode } = data;
        
        console.log('🔔 [发送端] 收到receiver-ready-p2p事件:', readyPickupCode);
        
        // 验证是否属于当前房间
        if (readyPickupCode && readyPickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的P2P就绪: ${readyPickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        console.log(`🚀 [${pickupCode}] 接收端P2P已准备好，开始创建Offer...`);
        statusText.textContent = '接收端已准备，正在建立P2P连接...';
        
        // 现在创建并发送Offer
        if (window.currentP2P) {
            try {
                console.log('⏳ [P2P] 调用createAndSendOffer()...');
                await window.currentP2P.createAndSendOffer();
                console.log('✅ [P2P] Offer创建并发送成功');
            } catch (error) {
                console.error('❌ [P2P] 创建Offer失败:', error);
                statusText.textContent = 'P2P连接建立失败';
            }
        } else {
            console.error('❌ [P2P] window.currentP2P不存在！');
        }
    });
    
    // 接收方下载完成确认
    socket.on('transfer-complete', (data) => {
        const { pickupCode: completePickupCode } = data;
        
        // 严格验证：只处理属于当前房间的完成事件
        if (completePickupCode && completePickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的完成事件: ${completePickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        // 传输真正完成，显示完成页面
        setTimeout(() => {
            showStage('complete-stage');
        }, 500);
    });
    
    // 连接丢失
    socket.on('connection-lost', (data) => {
        const { pickupCode: lostPickupCode } = data || {};
        
        // 验证是否属于当前房间
        if (lostPickupCode && lostPickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的断连: ${lostPickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        isTransferring = false;
        statusText.textContent = '连接已断开';
        statusIndicator.style.background = '#dc3545';
    });
    
    // 传输进度更新（从服务器同步）
    socket.on('transfer-progress', (data) => {
        const { pickupCode: progressPickupCode, progress, bytesTransferred } = data;
        
        // 严格验证：只接收属于当前房间的进度更新
        if (progressPickupCode && progressPickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的进度: ${progressPickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        if (progress !== undefined) {
            updateProgress(progress);
        }
        
        // 使用服务器报告的实际字节数计算准确的传输速度
        if (bytesTransferred !== undefined && transferStartTime) {
            const elapsed = (Date.now() - transferStartTime) / 1000;
            if (elapsed > 0) {
                const speed = bytesTransferred / elapsed;
                transferSpeed.textContent = `${formatFileSize(speed)}/s`;
            }
        }
    });
    
    // 接收端速度更新
    socket.on('transfer-speed', (data) => {
        const { pickupCode: speedPickupCode, speed } = data;
        
        // 严格验证：只接收属于当前房间的速度更新
        if (speedPickupCode && speedPickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的速度: ${speedPickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        if (speed !== undefined) {
            transferSpeed.textContent = `${formatFileSize(speed)}/s`;
        }
    });
    
    // 接收端断开连接
    socket.on('receiver-disconnected', (data) => {
        const { pickupCode: disconnectedPickupCode } = data || {};
        
        // 验证是否属于当前房间
        if (disconnectedPickupCode && disconnectedPickupCode !== pickupCode) {
            console.log(`[房间隔离] 忽略不属于当前房间的断连通知: ${disconnectedPickupCode} (当前: ${pickupCode})`);
            return;
        }
        
        console.log(`[${pickupCode}] 接收端已断开连接，停止传输`);
        isTransferring = false;
        statusText.textContent = '接收端已断开连接';
        statusIndicator.style.background = '#dc3545';
        transferSpeed.textContent = '0 B/s';
        
        // 显示错误或重新等待连接
        setTimeout(() => {
            statusText.textContent = '等待接收方连接...';
            statusIndicator.style.background = '#ffc107';
        }, 3000);
    });
}

// 计算文件哈希（SHA-256）
async function calculateFileHash(file) {
    return new Promise((resolve, reject) => {
        const chunkSize = 5 * 1024 * 1024; // 5MB chunks for hash calculation
        let offset = 0;
        const chunks = [];
        
        const reader = new FileReader();
        
        reader.onload = async (e) => {
            chunks.push(new Uint8Array(e.target.result));
            offset += e.target.result.byteLength;
            
            if (offset < file.size) {
                readNextChunk();
            } else {
                // 合并所有chunks并计算hash
                const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const merged = new Uint8Array(totalLength);
                let position = 0;
                for (const chunk of chunks) {
                    merged.set(chunk, position);
                    position += chunk.length;
                }
                
                try {
                    const hashBuffer = await crypto.subtle.digest('SHA-256', merged);
                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                    resolve(hashHex);
                } catch (error) {
                    reject(error);
                }
            }
        };
        
        reader.onerror = reject;
        
        function readNextChunk() {
            const slice = file.slice(offset, offset + chunkSize);
            reader.readAsArrayBuffer(slice);
        }
        
        readNextChunk();
    });
}

// 开始文件传输
async function startFileTransfer() {
    if (!selectedFile || !pickupCode) return;
    
    showStage('transfer-stage');
    transferStartTime = Date.now();
    isTransferring = true;
    
    // 先计算文件哈希用于完整性校验
    statusText.textContent = '正在计算文件校验值...';
    let fileHash = '';
    try {
        const hashStartTime = Date.now();
        fileHash = await calculateFileHash(selectedFile);
        const hashTime = ((Date.now() - hashStartTime) / 1000).toFixed(2);
        console.log(`[传输] 文件SHA-256: ${fileHash.substring(0, 16)}... (耗时${hashTime}秒)`);
    } catch (error) {
        console.warn('[传输] 文件哈希计算失败:', error);
        // 继续传输，但没有校验值
    }
    
    statusText.textContent = '正在传输文件...';
    
    // 增加分块大小到 1MB，提高大文件传输效率
    // 动态chunk大小：小文件用小chunk，大文件用大chunk
    let chunkSize = 256 * 1024; // 默认256KB
    if (selectedFile.size > 100 * 1024 * 1024) { // 大于100MB
        chunkSize = 2 * 1024 * 1024; // 2MB chunks
    } else if (selectedFile.size > 10 * 1024 * 1024) { // 大于10MB
        chunkSize = 1 * 1024 * 1024; // 1MB chunks
    }
    
    const totalChunks = Math.ceil(selectedFile.size / chunkSize);
    let currentChunk = 0;
    let lastAckedChunk = -1; // 最后确认的chunk索引
    
    const reader = new FileReader();
    
    // 监听块确认
    const ackHandler = (data) => {
        if (data.pickupCode === pickupCode) {
            lastAckedChunk = data.chunkIndex;
            console.log(`[${pickupCode}] ACK chunk ${data.chunkIndex}`);
            
            // 收到确认，如果还有下一块，继续发送
            if (currentChunk < totalChunks) {
                readNextChunk();
            }
        }
    };
    socket.on('chunk-ack', ackHandler);

    function readNextChunk() {
        if (!isTransferring) {
            console.log(`[${pickupCode}] 传输已停止`);
            socket.off('chunk-ack', ackHandler);
            return;
        }
        
        const start = currentChunk * chunkSize;
        const end = Math.min(start + chunkSize, selectedFile.size);
        const chunk = selectedFile.slice(start, end);
        
        reader.readAsArrayBuffer(chunk);
    }
    
    reader.onload = function(e) {
        if (!isTransferring) {
            console.log(`[${pickupCode}] 传输已停止，忽略读取结果`);
            socket.off('chunk-ack', ackHandler);
            return;
        }
        
        const chunkData = e.target.result;
        const isLast = currentChunk === totalChunks - 1;
        const chunkIndex = currentChunk;
        
        // 发送数据块
        socket.emit('file-chunk', {
            pickupCode: pickupCode,
            chunk: chunkData,
            chunkIndex: chunkIndex,
            totalChunks: totalChunks,
            isLast: isLast
        });
        
        console.log(`[${pickupCode}] 发送 chunk ${chunkIndex}/${totalChunks - 1}`);
        
        // 移动到下一个 chunk（等待 ACK）
        currentChunk++;
        
        // 如果是最后一块，也需要等待ACK确认数据被写入
        if (isLast) {
             console.log(`[${pickupCode}] 最后一块已发送，等待确认`);
        }
    };
    
    reader.onerror = function() {
        alert('文件读取失败');
        isTransferring = false;
        socket.off('chunk-ack', ackHandler);
    };

    // 监听开始传输信号（由接收端发起下载请求触发）
    const startHandler = (data) => {
        if (data.pickupCode === pickupCode) {
            console.log(`[${pickupCode}] 接收端已准备好，开始发送数据`);
            socket.off('start-transfer', startHandler); // 只触发一次
            readNextChunk();
        }
    };
    socket.on('start-transfer', startHandler);
    
    reader.onerror = function() {
        alert('文件读取失败');
        isTransferring = false;
    };
    
    // 开始读取第一个chunk
    readNextChunk();
}

// 更新传输进度
function updateProgress(progress) {
    const percent = Math.round(progress);
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    
    // 速度现在由接收端报告，本地不再计算
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

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 错误处理
socket.on('connect_error', () => {
    statusText.textContent = '连接服务器失败';
    statusIndicator.style.background = '#dc3545';
});

socket.on('disconnect', () => {
    statusText.textContent = '与服务器断开连接';
    statusIndicator.style.background = '#dc3545';
});
