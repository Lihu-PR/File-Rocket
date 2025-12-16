// P2P WebRTC 文件传输辅助类
class P2PFileTransfer {
    constructor(socket) {
        this.socket = socket;
        this.peerConnection = null;
        this.dataChannel = null;
        this.pickupCode = null;
        this.isSender = false;
        this.natType = null;
        
        // STUN/TURN 服务器列表（增加更多服务器提高成功率）
        this.iceServers = [
            // Google STUN服务器
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            // 其他公共STUN服务器
            { urls: 'stun:stun.stunprotocol.org:3478' },
            { urls: 'stun:stun.voip.blackberry.com:3478' }
            // 注意：如果需要支持对称型NAT，需要添加TURN服务器
            // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
        ];
        
        this.setupSocketListeners();
    }
    
    // 设置Socket监听器
    setupSocketListeners() {
        // 先移除旧的监听器，避免重复监听
        this.socket.off('p2p-offer');
        this.socket.off('p2p-answer');
        this.socket.off('p2p-ice-candidate');
        
        // 创建绑定到当前实例的处理函数
        this.offerHandler = async (data) => {
            console.log('[P2P] 收到Offer事件，pickupCode:', data.pickupCode, '当前pickupCode:', this.pickupCode, 'isSender:', this.isSender);
            if (data.pickupCode === this.pickupCode && !this.isSender) {
                console.log('[P2P] 条件匹配，处理Offer');
                try {
                    await this.handleOffer(data.offer);
                } catch (error) {
                    console.error('[P2P] 处理Offer失败:', error);
                }
            } else {
                console.log('[P2P] 条件不匹配，忽略Offer');
            }
        };
        
        this.answerHandler = async (data) => {
            console.log('[P2P] 收到Answer事件');
            if (data.pickupCode === this.pickupCode && this.isSender) {
                try {
                    await this.handleAnswer(data.answer);
                } catch (error) {
                    console.error('[P2P] 处理Answer失败:', error);
                }
            }
        };
        
        this.candidateHandler = async (data) => {
            console.log('[P2P] 收到ICE候选事件');
            if (data.pickupCode === this.pickupCode) {
                try {
                    await this.handleIceCandidate(data.candidate);
                } catch (error) {
                    console.error('[P2P] 处理ICE候选失败:', error);
                }
            }
        };
        
        this.socket.on('p2p-offer', this.offerHandler);
        this.socket.on('p2p-answer', this.answerHandler);
        this.socket.on('p2p-ice-candidate', this.candidateHandler);
    }
    
    // 初始化P2P连接（发送方）
    async initSender(pickupCode, file) {
        this.pickupCode = pickupCode;
        this.isSender = true;
        this.file = file;
        
        // 检测NAT类型
        await this.detectNATType();
        
        // 创建PeerConnection
        this.createPeerConnection();
        
        // 创建数据通道
        this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
            ordered: true,
            maxRetransmits: 3
        });
        
        this.setupDataChannel();
        
        // 创建Offer（使用更激进的ICE策略）
        const offer = await this.peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false,
            iceRestart: false
        });
        await this.peerConnection.setLocalDescription(offer);
        
        console.log('Offer已创建并设置为本地描述');
        
        // 发送Offer给接收方
        this.socket.emit('p2p-offer', {
            pickupCode: this.pickupCode,
            offer: offer
        });
        
        return this.natType;
    }
    
    // 初始化P2P连接（接收方）
    async initReceiver(pickupCode) {
        this.pickupCode = pickupCode;
        this.isSender = false;
        
        // 检测NAT类型
        await this.detectNATType();
        
        return this.natType;
    }
    
    // 创建PeerConnection
    createPeerConnection() {
        this.peerConnection = new RTCPeerConnection({
            iceServers: this.iceServers,
            // 优化ICE配置
            iceCandidatePoolSize: 10, // 预先收集候选
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        // 监听ICE候选（Trickle ICE：边收集边发送）
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('发送ICE候选:', event.candidate.type);
                this.socket.emit('p2p-ice-candidate', {
                    pickupCode: this.pickupCode,
                    candidate: event.candidate
                });
            } else {
                console.log('ICE候选收集完成');
            }
        };
        
        // 监听ICE连接状态
        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE连接状态:', this.peerConnection.iceConnectionState);
        };
        
        // 监听连接状态
        this.peerConnection.onconnectionstatechange = () => {
            console.log('P2P连接状态:', this.peerConnection.connectionState);
            
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(this.peerConnection.connectionState);
            }
            
            // 连接失败时的处理
            if (this.peerConnection.connectionState === 'failed' || 
                this.peerConnection.connectionState === 'disconnected') {
                console.error('P2P连接失败或断开');
                if (this.onError) {
                    this.onError(new Error('P2P连接失败'));
                }
            }
        };
        
        // 接收方监听数据通道
        if (!this.isSender) {
            this.peerConnection.ondatachannel = (event) => {
                console.log('接收到数据通道');
                this.dataChannel = event.channel;
                this.setupDataChannel();
            };
        }
    }
    
    // 设置数据通道
    setupDataChannel() {
        this.dataChannel.onopen = () => {
            console.log('P2P数据通道已打开');
            
            if (this.onChannelOpen) {
                this.onChannelOpen();
            }
            
            // 发送方开始发送文件
            if (this.isSender && this.file) {
                this.sendFile();
            }
        };
        
        this.dataChannel.onmessage = (event) => {
            // 接收方处理接收到的数据
            if (!this.isSender && this.onDataReceived) {
                this.onDataReceived(event.data);
            }
        };
        
        this.dataChannel.onerror = (error) => {
            console.error('P2P数据通道错误:', error);
            
            if (this.onError) {
                this.onError(error);
            }
        };
    }
    
    // 处理Offer
    async handleOffer(offer) {
        console.log('收到Offer，创建PeerConnection');
        this.createPeerConnection();
        
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        console.log('远程描述已设置');
        
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        console.log('Answer已创建并设置为本地描述');
        
        // 发送Answer
        this.socket.emit('p2p-answer', {
            pickupCode: this.pickupCode,
            answer: answer
        });
        console.log('Answer已发送');
    }
    
    // 处理Answer
    async handleAnswer(answer) {
        console.log('收到Answer，设置远程描述');
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('Answer已设置，等待ICE连接建立');
    }
    
    // 处理ICE候选
    async handleIceCandidate(candidate) {
        if (this.peerConnection && this.peerConnection.remoteDescription) {
            try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('ICE候选已添加:', candidate.type);
            } catch (error) {
                console.error('添加ICE候选失败:', error);
            }
        } else {
            console.warn('PeerConnection未就绪，无法添加ICE候选');
        }
    }
    
    // 发送文件
    async sendFile() {
        if (!this.file || !this.dataChannel) return;
        
        // 动态chunk大小：根据文件大小调整
        let chunkSize = 16384; // 默认16KB for WebRTC
        if (this.file.size > 100 * 1024 * 1024) { // >100MB
            chunkSize = 65536; // 64KB chunks
        } else if (this.file.size > 10 * 1024 * 1024) { // >10MB
            chunkSize = 32768; // 32KB chunks
        }
        const fileSize = this.file.size;
        const totalChunks = Math.ceil(fileSize / chunkSize);
        
        // 先发送文件元信息
        const metadata = JSON.stringify({
            type: 'metadata',
            name: this.file.name,
            size: this.file.size,
            mimeType: this.file.type
        });
        this.dataChannel.send(metadata);
        
        // 发送文件数据
        let offset = 0;
        let lastProgressUpdate = Date.now();
        const progressUpdateInterval = 100; // 每100ms更新一次进度
        const reader = new FileReader();
        
        const readSlice = () => {
            const slice = this.file.slice(offset, offset + chunkSize);
            reader.readAsArrayBuffer(slice);
        };
        
        reader.onload = (e) => {
            if (this.dataChannel.readyState === 'open') {
                // 控制发送速率，避免缓冲区溢出
                const bufferedAmount = this.dataChannel.bufferedAmount;
                const maxBuffered = 16 * 1024 * 1024; // 16MB缓冲上限
                
                if (bufferedAmount > maxBuffered) {
                    // 如果缓冲区太满，延迟发送
                    setTimeout(() => reader.onload(e), 10);
                    return;
                }
                
                this.dataChannel.send(e.target.result);
                offset += e.target.result.byteLength;
                
                // 限制进度更新频率，避免UI卡顿
                const now = Date.now();
                if (now - lastProgressUpdate >= progressUpdateInterval || offset >= fileSize) {
                    const progress = (offset / fileSize) * 100;
                    
                    if (this.onProgress) {
                        this.onProgress(progress, offset, fileSize);
                    }
                    lastProgressUpdate = now;
                }
                
                if (offset < fileSize) {
                    readSlice();
                } else {
                    console.log('P2P文件发送完成');
                    
                    // 发送完成标记
                    this.dataChannel.send(JSON.stringify({ type: 'complete' }));
                    
                    if (this.onComplete) {
                        this.onComplete();
                    }
                }
            }
        };
        
        readSlice();
    }
    
    // NAT类型检测（优化版：更快速）
    async detectNATType() {
        try {
            const pc = new RTCPeerConnection({ iceServers: this.iceServers });
            
            // 收集ICE候选
            const candidates = [];
            let hasHost = false;
            let hasSrflx = false;
            let hasRelay = false;
            
            await new Promise((resolve) => {
                pc.onicecandidate = (event) => {
                    if (event.candidate) {
                        candidates.push(event.candidate);
                        const candidateStr = event.candidate.candidate;
                        
                        // 快速检测候选类型
                        if (candidateStr.includes('typ host')) hasHost = true;
                        if (candidateStr.includes('typ srflx')) hasSrflx = true;
                        if (candidateStr.includes('typ relay')) hasRelay = true;
                        
                        // 如果已经收集到足够的信息，提前结束（优化速度）
                        if (hasSrflx || hasRelay || (hasHost && candidates.length >= 2)) {
                            setTimeout(resolve, 500); // 等待500ms看是否有更多候选
                        }
                    } else {
                        // ICE收集完成
                        resolve();
                    }
                };
                
                pc.createDataChannel('test');
                pc.createOffer().then(offer => pc.setLocalDescription(offer));
                
                // 缩短超时时间到2秒（更快）
                setTimeout(resolve, 2000);
            });
            
            pc.close();
            
            // NAT类型判断（支持NAT0/1/2/3/4）
            if (hasHost && !hasSrflx && !hasRelay) {
                this.natType = { type: 'NAT0', name: '公网IP', success: 95 };
            } else if (hasSrflx) {
                const srflxCount = candidates.filter(c => c.candidate.includes('typ srflx')).length;
                if (srflxCount === 1) {
                    this.natType = { type: 'NAT1', name: '全锥型NAT', success: 90 };
                } else if (srflxCount === 2) {
                    this.natType = { type: 'NAT2', name: '限制型NAT', success: 75 };
                } else {
                    this.natType = { type: 'NAT3', name: '端口限制型NAT', success: 50 };
                }
            } else if (hasRelay) {
                this.natType = { type: 'NAT4', name: '对称型NAT', success: 20 };
            } else {
                this.natType = { type: 'NAT4', name: '对称型NAT', success: 20 };
            }
            
            console.log('NAT类型检测结果:', this.natType, `(收集到${candidates.length}个候选)`);
            
        } catch (error) {
            console.error('NAT检测失败:', error);
            this.natType = { type: 'UNKNOWN', name: '未知', success: 50 };
        }
    }
    
    // 关闭连接
    close() {
        console.log('[P2P] 关闭P2P连接');
        
        // 移除Socket监听器
        if (this.offerHandler) {
            this.socket.off('p2p-offer', this.offerHandler);
        }
        if (this.answerHandler) {
            this.socket.off('p2p-answer', this.answerHandler);
        }
        if (this.candidateHandler) {
            this.socket.off('p2p-ice-candidate', this.candidateHandler);
        }
        
        // 关闭数据通道
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }
        
        // 关闭PeerConnection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
    }
}

