const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const adminMiddleware = require('./admin-middleware');
const RateLimiter = require('./rate-limiter');

const app = express();
const server = http.createServer(app);
server.setTimeout(0); // 禁用超时，确保大文件传输不断开

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8, // 100MB buffer
  pingTimeout: 60000, // 60秒超时
  pingInterval: 25000, // 25秒ping间隔
  transports: ['websocket', 'polling'] // 支持websocket和polling
});

const PORT = process.env.PORT || 3000;

// 存储活跃的传输会话
const activeSessions = new Map();

// 存储文件的会话（服务器存储模式）
const storedFileSessions = new Map();

// 统计数据
let stats = {
  todayTransfers: 0,
  totalTransfers: 0,
  lastResetDate: new Date().toDateString()
};

// 速率限制器
const loginLimiter = new RateLimiter(5, 300000); // 5次/5分钟
const codeGenerationLimiter = new RateLimiter(20, 60000); // 20次/分钟
const codeAttemptLimiter = new RateLimiter(10, 60000); // 10次/分钟

// 确保文件存储目录存在
const config = adminMiddleware.loadConfig();
if (config && config.storageConfig) {
  const uploadDir = path.resolve(config.storageConfig.uploadDir);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

// 配置静态文件服务
app.use(express.static('public'));
app.use(express.json());

// 配置 Multer 用于文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const config = adminMiddleware.loadConfig();
    const uploadDir = path.resolve(config.storageConfig.uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // 记录上传开始时间
    req.uploadStartTime = Date.now();
    cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024 // 10GB 限制
  }
});

// 生成4位随机取件码（数字+大写字母）
function generatePickupCode() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // 确保取件码唯一
  if (activeSessions.has(code)) {
    return generatePickupCode();
  }
  return code;
}

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log(`客户端连接: ${socket.id}`);

  // 创建文件传输会话
  socket.on('create-session', (callback) => {
    const clientIP = socket.handshake.address;
    
    // 速率限制
    if (!codeGenerationLimiter.check(clientIP)) {
      return callback({ 
        success: false, 
        message: '操作过于频繁，请稍后再试' 
      });
    }
    
    const pickupCode = generatePickupCode();
    activeSessions.set(pickupCode, {
      senderId: socket.id,
      receiverId: null,
      senderSocket: socket,
      receiverSocket: null,
      fileInfo: null,
      createdAt: Date.now()
    });
    
    socket.join(`session-${pickupCode}`);
    console.log(`[${pickupCode}] 创建传输会话 (发送端: ${socket.id}) - 当前活跃会话: ${activeSessions.size}`);
    
    callback({ success: true, pickupCode });
  });

  // 加入接收会话
  socket.on('join-session', (data, callback) => {
    const { pickupCode } = data;
    const clientIP = socket.handshake.address;
    
    // 速率限制（防止暴力破解取件码）
    if (!codeAttemptLimiter.check(clientIP)) {
      return callback({ 
        success: false, 
        message: '尝试次数过多，请稍后再试' 
      });
    }
    
    const session = activeSessions.get(pickupCode);
    
    if (!session) {
      callback({ success: false, message: '无效的取件码' });
      return;
    }
    
    // 如果是同一个socket的重复请求，直接返回成功
    if (session.receiverId === socket.id) {
      console.log(`重复的join-session请求: ${pickupCode} from ${socket.id}`);
      callback({ success: true });
      
      // 如果文件信息已存在，重新发送给接收方
      if (session.fileInfo) {
        socket.emit('file-info', session.fileInfo);
      }
      return;
    }
    
    if (session.receiverId) {
      callback({ success: false, message: '该取件码已被使用' });
      return;
    }
    
    // 更新会话信息
    session.receiverId = socket.id;
    session.receiverSocket = socket;
    
    socket.join(`session-${pickupCode}`);
    
    // 通知发送方有接收方连接
    if (session.senderSocket) {
      session.senderSocket.emit('receiver-connected', {
        pickupCode: pickupCode,
        receiverId: socket.id
      });
    }
    
    // 如果文件信息已存在，立即发送给接收方（附带pickupCode）
    if (session.fileInfo) {
      socket.emit('file-info', {
        pickupCode: pickupCode,
        ...session.fileInfo
      });
      console.log(`[${pickupCode}] 向新加入的接收端发送文件信息`);
    }
    
    console.log(`[${pickupCode}] 接收方加入会话 (接收端: ${socket.id}, 发送端: ${session.senderId}) - 当前活跃会话: ${activeSessions.size}`);
    callback({ success: true });
  });

  // 处理文件信息
  socket.on('file-info', (data) => {
    const { pickupCode, fileInfo } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.senderId === socket.id) {
      session.fileInfo = fileInfo;
      // 记录传输模式
      session.transferMode = fileInfo.mode || 'memory';
      console.log(`[${pickupCode}] 存储文件信息: ${fileInfo.name} (模式: ${session.transferMode})`);
      
      // 如果接收方已连接，发送文件信息（附带 pickupCode）
      if (session.receiverSocket) {
        session.receiverSocket.emit('file-info', {
          pickupCode: pickupCode,
          ...fileInfo
        });
        console.log(`[${pickupCode}] 向接收端发送文件信息`);
      }
    } else {
      console.log(`[${pickupCode}] file-info验证失败`);
    }
  });

  // 处理文件数据块传输
  socket.on('file-chunk', (data) => {
    const { pickupCode, chunk, chunkIndex, totalChunks, isLast } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.senderId === socket.id) {
      // P2P模式下不处理文件块（文件通过WebRTC直接传输）
      if (session.transferMode === 'p2p') {
        console.log(`[${pickupCode}] P2P模式，忽略file-chunk`);
        return;
      }
      
      // 检查是否有活跃的 HTTP 下载响应流
      if (session.downloadResponse && !session.downloadResponse.writableEnded) {
        
        // 关键修复：将 ArrayBuffer 正确转换为 Buffer
        const buffer = Buffer.from(chunk);
        
        // 初始化字节计数器（如果是第一个块）
        if (!session.totalBytesTransferred) {
            session.totalBytesTransferred = 0;
        }
        session.totalBytesTransferred += buffer.length;
        
        // 写入数据到 HTTP 响应流
        const canContinue = session.downloadResponse.write(buffer);
        
        // 流控/背压机制：只有当缓冲区未满或drain事件触发时才发送ACK
        if (canContinue) {
            socket.emit('chunk-ack', { pickupCode, chunkIndex });
        } else {
            session.downloadResponse.once('drain', () => {
                socket.emit('chunk-ack', { pickupCode, chunkIndex });
            });
        }
        
        // 计算并广播进度（包含实际字节数用于速度计算）
        const progress = ((chunkIndex + 1) / totalChunks) * 100;
        const bytesTransferred = session.totalBytesTransferred;
        
        // 每隔10个chunk或者是最后一块才广播，减少流量
        if (chunkIndex % 10 === 0 || isLast) {
             io.to(`session-${pickupCode}`).emit('transfer-progress', { 
                pickupCode,
                progress,
                chunkIndex,
                totalChunks,
                bytesTransferred  // 新增：实际传输的字节数
            });
        }

        if (isLast) {
            console.log(`[${pickupCode}] 所有数据传输完成 (${session.totalBytesTransferred} bytes)，结束HTTP流`);
            session.downloadResponse.end();
        }
      } else {
        // 接收端可能断开了
        console.log(`[${pickupCode}] 没有活跃的下载流，停止传输`);
        socket.emit('receiver-disconnected', { pickupCode });
      }
    } else {
      // 验证失败
    }
  });

  // 处理接收端下载完成确认
  socket.on('download-complete', (data) => {
    const { pickupCode } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.receiverId === socket.id && session.senderSocket) {
      // 通知发送方传输真正完成
      session.senderSocket.emit('transfer-complete', { pickupCode });
      console.log(`传输全部完成: ${pickupCode}`);
      
      // 更新统计
      stats.todayTransfers++;
      stats.totalTransfers++;
      
      // 清理会话
      setTimeout(() => {
        activeSessions.delete(pickupCode);
      }, 2000);
    }
  });

  // 处理接收方确认传输
  socket.on('accept-transfer', (data) => {
    const { pickupCode } = data;
    const session = activeSessions.get(pickupCode);
    
    console.log(`[服务器] 收到accept-transfer事件, pickupCode: ${pickupCode}`);
    
    if (session && session.receiverId === socket.id) {
        console.log(`[${pickupCode}] 接收方确认接收 (模式: ${session.transferMode})`);
        console.log(`[${pickupCode}] 会话信息 - 发送端: ${session.senderId}, 接收端: ${session.receiverId}`);
        
        // P2P模式下，通知发送端可以开始P2P传输了
        if (session.transferMode === 'p2p' && session.senderSocket) {
            console.log(`[${pickupCode}] P2P模式，准备通知发送端...`);
            session.senderSocket.emit('receiver-ready-p2p', { pickupCode });
            console.log(`[${pickupCode}] ✅ 已发送receiver-ready-p2p给发送端`);
        } else {
            console.log(`[${pickupCode}] 非P2P模式或发送端Socket不存在`);
        }
        // 其他模式由HTTP请求触发
    } else {
        console.log(`[${pickupCode}] accept-transfer验证失败 - session存在: ${!!session}, receiverId匹配: ${session?.receiverId === socket.id}`);
    }
  });

  // 处理传输状态更新（接收端发送进度，服务器转发给上传端）
  // 这个监听器现在主要用于接收端断开等状态，进度由服务器内部计算广播
  socket.on('transfer-progress', (data) => {
     // 忽略客户端发来的进度，使用服务器计算的进度
  });

  // 转发接收端下载速度给发送端
  socket.on('transfer-speed', (data) => {
    const { pickupCode, speed } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.receiverId === socket.id && session.senderSocket) {
      // 转发时附带 pickupCode，确保发送端能正确识别
      session.senderSocket.emit('transfer-speed', { 
        pickupCode: pickupCode,
        speed: speed 
      });
    } else {
      console.log(`[${pickupCode}] transfer-speed验证失败: session存在=${!!session}, receiverId匹配=${session?.receiverId === socket.id}`);
    }
  });

  // ========== P2P 信令中继 ==========
  
  // P2P NAT 信息交换
  // 请求NAT信息（接收端主动请求）
  socket.on('request-nat-info', (data) => {
    const { pickupCode } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.receiverId === socket.id) {
      // 如果发送端的NAT信息已经存在，立即发送给接收端
      if (session.senderNAT) {
        socket.emit('p2p-nat-info', { 
          pickupCode, 
          natType: session.senderNAT, 
          role: 'sender' 
        });
        console.log(`[${pickupCode}] 接收端请求NAT信息，发送已存储的发送端NAT`);
      }
    }
  });
  
  socket.on('p2p-nat-info', (data) => {
    const { pickupCode, natType, role } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session) {
      // 存储 NAT 信息
      if (role === 'sender') {
        session.senderNAT = natType;
        console.log(`[${pickupCode}] 存储发送端NAT信息:`, natType.type);
        // 转发给接收方
        if (session.receiverSocket) {
          session.receiverSocket.emit('p2p-nat-info', { pickupCode, natType, role: 'sender' });
          console.log(`[${pickupCode}] 转发发送端NAT信息到接收端`);
        }
      } else if (role === 'receiver') {
        session.receiverNAT = natType;
        console.log(`[${pickupCode}] 存储接收端NAT信息:`, natType.type);
        // 转发给发送方
        if (session.senderSocket) {
          session.senderSocket.emit('p2p-nat-info', { pickupCode, natType, role: 'receiver' });
        }
      }
      
      console.log(`[${pickupCode}] 收到${role}的NAT信息: ${natType.type}`);
    }
  });
  
  // P2P Offer
  socket.on('p2p-offer', (data) => {
    const { pickupCode, offer } = data;
    const session = activeSessions.get(pickupCode);
    
    console.log(`[服务器] 收到p2p-offer, pickupCode: ${pickupCode}`);
    
    if (session && session.senderId === socket.id && session.receiverSocket) {
      session.receiverSocket.emit('p2p-offer', { pickupCode, offer });
      console.log(`[${pickupCode}] ✅ P2P Offer已转发给接收端`);
    } else {
      console.log(`[${pickupCode}] ❌ Offer转发失败 - session存在: ${!!session}, senderId匹配: ${session?.senderId === socket.id}, receiverSocket存在: ${!!session?.receiverSocket}`);
    }
  });
  
  // P2P Answer
  socket.on('p2p-answer', (data) => {
    const { pickupCode, answer } = data;
    const session = activeSessions.get(pickupCode);
    
    console.log(`[服务器] 收到p2p-answer, pickupCode: ${pickupCode}`);
    
    if (session && session.receiverId === socket.id && session.senderSocket) {
      session.senderSocket.emit('p2p-answer', { pickupCode, answer });
      console.log(`[${pickupCode}] ✅ P2P Answer已转发给发送端`);
    } else {
      console.log(`[${pickupCode}] ❌ Answer转发失败`);
    }
  });
  
  // P2P ICE候选
  socket.on('p2p-ice-candidate', (data) => {
    const { pickupCode, candidate } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session) {
      // 转发给对方
      if (session.senderId === socket.id && session.receiverSocket) {
        session.receiverSocket.emit('p2p-ice-candidate', { pickupCode, candidate });
      } else if (session.receiverId === socket.id && session.senderSocket) {
        session.senderSocket.emit('p2p-ice-candidate', { pickupCode, candidate });
      }
    }
  });

  // 处理断开连接
  socket.on('disconnect', () => {
    console.log(`客户端断开连接: ${socket.id}`);
    
    // 查找并清理相关会话
    for (const [pickupCode, session] of activeSessions.entries()) {
      if (session.senderId === socket.id || session.receiverId === socket.id) {
        const role = session.senderId === socket.id ? '发送端' : '接收端';
        console.log(`[${pickupCode}] ${role}断开连接 - 活跃会话: ${activeSessions.size}`);
        
        // 通知其他参与者连接已断开
        io.to(`session-${pickupCode}`).emit('connection-lost', { pickupCode });
        
        // 如果是接收方断开，专门通知发送方（用于中断传输）
        if (session.receiverId === socket.id && session.senderSocket && session.senderSocket.connected) {
          console.log(`[${pickupCode}] 通知发送端接收方已断开`);
          session.senderSocket.emit('receiver-disconnected', { pickupCode });
          session.receiverId = null;
          session.receiverSocket = null;
        }
        
        // 如果是发送方断开，立即清理会话
        if (session.senderId === socket.id) {
          console.log(`[${pickupCode}] 清理会话（发送端断开）`);
          activeSessions.delete(pickupCode);
        }
        break;
      }
    }
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString()
  });
});

// ========== 管理员 API ==========

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (!password) {
    return res.status(400).json({ success: false, message: '请输入密码' });
  }
  
  // 速率限制
  if (!loginLimiter.check(clientIP)) {
    return res.status(429).json({ 
      success: false, 
      message: '登录尝试次数过多，请稍后再试' 
    });
  }
  
  if (adminMiddleware.verifyAdminPassword(password)) {
    const token = adminMiddleware.createAdminSession();
    loginLimiter.reset(clientIP); // 成功后重置限制
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

// 获取管理员配置
app.get('/api/admin/config', adminMiddleware.requireAdmin, (req, res) => {
  const config = adminMiddleware.loadConfig();
  
  // 重置每日统计
  const today = new Date().toDateString();
  if (stats.lastResetDate !== today) {
    stats.todayTransfers = 0;
    stats.lastResetDate = today;
  }
  
  // 计算存储文件数量
  let storedFiles = 0;
  if (config && config.features.serverStorage) {
    try {
      const uploadDir = path.resolve(config.storageConfig.uploadDir);
      if (fs.existsSync(uploadDir)) {
        storedFiles = fs.readdirSync(uploadDir).length;
      }
    } catch (error) {
      console.error('读取存储目录失败:', error);
    }
  }
  
  res.json({
    success: true,
    features: config.features,
    storageConfig: config.storageConfig,
    stats: {
      activeSessions: activeSessions.size,
      todayTransfers: stats.todayTransfers,
      storedFiles: storedFiles
    }
  });
});

// 更新存储配置
app.put('/api/admin/storage-config', adminMiddleware.requireAdmin, (req, res) => {
  const { fileRetentionHours, deleteOnDownload } = req.body;
  
  const config = adminMiddleware.loadConfig();
  if (!config) {
    return res.status(500).json({ success: false, message: '加载配置失败' });
  }
  
  if (fileRetentionHours !== undefined) {
    config.storageConfig.fileRetentionHours = fileRetentionHours;
  }
  
  if (deleteOnDownload !== undefined) {
    config.storageConfig.deleteOnDownload = deleteOnDownload;
  }
  
  if (adminMiddleware.saveConfig(config)) {
    res.json({ success: true, message: '存储配置已更新' });
  } else {
    res.status(500).json({ success: false, message: '配置保存失败' });
  }
});

// 获取磁盘空间和文件列表
app.get('/api/admin/files', adminMiddleware.requireAdmin, (req, res) => {
  const config = adminMiddleware.loadConfig();
  const uploadDir = path.resolve(config.storageConfig.uploadDir);
  
  try {
    // 获取磁盘空间信息（专为Linux优化：支持OpenWrt ARM64和Ubuntu AMD64）
    let diskSpace = { total: 0, free: 0, used: 0 };
    
    const { execSync } = require('child_process');
    
    try {
      // 确保上传目录存在
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      
      // Linux/Unix: 使用 df 命令获取磁盘空间
      // 支持所有架构：x86_64, amd64, aarch64, arm64, armv7l等
      // 支持所有发行版：Ubuntu, Debian, OpenWrt, Alpine等
      
      let dfOutput = '';
      let useBytesUnit = false;
      
      // 优先尝试 -B1 参数（字节单位，精确但不是所有系统都支持）
      try {
        dfOutput = execSync(`df -B1 "${uploadDir}"`, { 
          encoding: 'utf8',
          shell: '/bin/sh',
          timeout: 5000
        }).toString();
        useBytesUnit = true;
      } catch (dfError) {
        // 如果 -B1 不支持（如某些 BusyBox 版本），使用 -k（KB单位，通用性最好）
        try {
          dfOutput = execSync(`df -k "${uploadDir}"`, { 
            encoding: 'utf8',
            shell: '/bin/sh',
            timeout: 5000
          }).toString();
          useBytesUnit = false;
        } catch (dfkError) {
          // 最后尝试不带参数的 df（某些老旧系统）
          dfOutput = execSync(`df "${uploadDir}"`, { 
            encoding: 'utf8',
            shell: '/bin/sh',
            timeout: 5000
          }).toString();
          useBytesUnit = false;
        }
      }
      
      // 解析 df 输出
      const lines = dfOutput.trim().split('\n');
      
      if (lines.length >= 2) {
        // df 输出格式（可能会换行）：
        // Filesystem     1K-blocks    Used Available Use% Mounted on
        // /dev/sda1       10485760 5242880   5242880  50% /
        
        // 处理可能的换行情况
        let dataLine = lines[1].trim();
        
        // 如果第二行是以 /dev/ 开头但没有数字，说明数据在第三行
        if (lines.length >= 3 && dataLine.match(/^\/\w+/) && !dataLine.match(/\d/)) {
          dataLine = lines[2].trim();
        }
        
        // 分割数据（使用正则处理多个空格）
        const parts = dataLine.split(/\s+/);
        
        // 识别数据位置（有些系统 Filesystem 列可能很长）
        let sizeIndex = -1;
        for (let i = 0; i < parts.length; i++) {
          // 找到第一个纯数字列
          if (parts[i].match(/^\d+$/)) {
            sizeIndex = i;
            break;
          }
        }
        
        if (sizeIndex >= 0 && parts.length >= sizeIndex + 3) {
          const totalBlocks = parseInt(parts[sizeIndex]) || 0;
          const usedBlocks = parseInt(parts[sizeIndex + 1]) || 0;
          const availBlocks = parseInt(parts[sizeIndex + 2]) || 0;
          
          if (useBytesUnit) {
            // -B1 参数，直接是字节
            diskSpace.total = totalBlocks;
            diskSpace.used = usedBlocks;
            diskSpace.free = availBlocks;
          } else {
            // -k 或默认参数，是 1K blocks，需要转换为字节
            diskSpace.total = totalBlocks * 1024;
            diskSpace.used = usedBlocks * 1024;
            diskSpace.free = availBlocks * 1024;
          }
          
          console.log(`[磁盘空间] 总容量: ${(diskSpace.total / 1024 / 1024 / 1024).toFixed(2)} GB, ` +
                      `已用: ${(diskSpace.used / 1024 / 1024 / 1024).toFixed(2)} GB, ` +
                      `可用: ${(diskSpace.free / 1024 / 1024 / 1024).toFixed(2)} GB`);
        }
      }
      
    } catch (error) {
      console.error('获取磁盘空间失败:', error.message);
      console.error('请确保系统支持 df 命令（Linux标准工具）');
      // 失败时使用默认值
      diskSpace = { total: 0, free: 0, used: 0 };
    }
    
    // 获取文件列表
    const files = [];
    let totalSize = 0;
    
    // 确保上传目录存在
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    // 加载当前配置
    const currentConfig = adminMiddleware.loadConfig();
    const retentionHours = currentConfig.storageConfig.fileRetentionHours || 24;
    const deleteOnDownload = currentConfig.storageConfig.deleteOnDownload || false;
    
    // 遍历存储的会话信息
    for (const [pickupCode, fileInfo] of storedFileSessions.entries()) {
      const filePath = path.join(uploadDir, fileInfo.filename);
      
      try {
        // 检查文件是否真实存在
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          
          // 使用文件信息中的上传时间，如果没有则使用文件的修改时间
          const uploadTime = fileInfo.uploadTime || stats.mtimeMs;
          
          // 计算删除时间和剩余时间
          let deleteTime = null;
          let remainingMs = null;
          
          if (deleteOnDownload) {
            // 下载后删除模式
            deleteTime = null;
            remainingMs = null;
          } else {
            // 定时删除模式
            deleteTime = uploadTime + (retentionHours * 60 * 60 * 1000);
            remainingMs = Math.max(0, deleteTime - Date.now());
          }
          
          // 获取实际文件大小（以防万一与记录不符）
          const actualSize = stats.size;
          const recordedSize = fileInfo.size || actualSize;
          
          files.push({
            pickupCode: pickupCode,
            originalName: fileInfo.originalName || fileInfo.filename,
            filename: fileInfo.filename,
            size: actualSize, // 使用实际大小
            uploadTime: uploadTime,
            deleteTime: deleteTime,
            remainingMs: remainingMs,
            deleteMode: deleteOnDownload ? 'download' : 'timer',
            downloaded: fileInfo.downloaded || false,
            retentionHours: retentionHours
          });
          
          totalSize += actualSize;
        } else {
          // 文件不存在但会话记录存在，清理无效记录
          console.warn(`[文件管理] 文件不存在，清理会话记录: ${pickupCode} - ${fileInfo.filename}`);
          storedFileSessions.delete(pickupCode);
        }
      } catch (error) {
        console.error(`[文件管理] 处理文件失败: ${pickupCode}`, error.message);
      }
    }
    
    // 按上传时间降序排序（最新的在前）
    files.sort((a, b) => b.uploadTime - a.uploadTime);
    
    console.log(`[文件管理] 当前文件数: ${files.length}, 总大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    
    res.json({
      success: true,
      diskSpace: diskSpace,
      files: files,
      totalSize: totalSize,
      fileCount: files.length,
      uploadDir: uploadDir
    });
    
  } catch (error) {
    console.error('获取文件列表失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '获取文件列表失败: ' + error.message 
    });
  }
});

// 删除指定文件
app.delete('/api/admin/files/:pickupCode', adminMiddleware.requireAdmin, (req, res) => {
  const pickupCode = req.params.pickupCode;
  
  try {
    deleteStoredFile(pickupCode);
    res.json({ 
      success: true, 
      message: '文件已删除' 
    });
  } catch (error) {
    console.error('删除文件失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '删除文件失败: ' + error.message 
    });
  }
});

// 删除所有文件（包括孤立文件和损坏文件）
app.delete('/api/admin/files/all', adminMiddleware.requireAdmin, (req, res) => {
  try {
    let deletedCount = 0;
    let freedSpace = 0;
    let failedCount = 0;
    
    // 读取 files 目录下的所有文件
    if (fs.existsSync(uploadDir)) {
      const allFiles = fs.readdirSync(uploadDir);
      
      console.log(`[管理员] 开始清理，共发现 ${allFiles.length} 个文件`);
      
      for (const filename of allFiles) {
        const filePath = path.join(uploadDir, filename);
        
        try {
          // 检查是否为文件（排除目录）
          const stats = fs.statSync(filePath);
          if (stats.isFile()) {
            const fileSize = stats.size;
            
            // 尝试删除文件（包括损坏的文件）
            fs.unlinkSync(filePath);
            
            freedSpace += fileSize;
            deletedCount++;
            
            console.log(`[管理员] ✅ 删除文件: ${filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
          } else if (stats.isDirectory()) {
            console.log(`[管理员] ⏭️  跳过目录: ${filename}`);
          }
        } catch (error) {
          // 即使文件损坏或无法读取，也尝试强制删除
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
            console.log(`[管理员] ✅ 强制删除损坏文件: ${filename}`);
          } catch (forceError) {
            failedCount++;
            console.error(`[管理员] ❌ 无法删除文件: ${filename}`, forceError.message);
          }
        }
      }
      
      // 清空所有会话记录
      storedFileSessions.clear();
      
      console.log(`[管理员] 删除完成 - 成功: ${deletedCount}, 失败: ${failedCount}, 释放空间: ${(freedSpace / 1024 / 1024).toFixed(2)} MB`);
      
      res.json({ 
        success: true, 
        message: failedCount > 0 ? `删除完成，${failedCount} 个文件删除失败` : '所有文件已删除',
        deletedCount: deletedCount,
        failedCount: failedCount,
        freedSpace: freedSpace
      });
    } else {
      console.log('[管理员] 上传目录不存在');
      res.json({ 
        success: true, 
        message: '上传目录不存在或为空',
        deletedCount: 0,
        freedSpace: 0
      });
    }
  } catch (error) {
    console.error('[管理员] 删除所有文件失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '删除失败: ' + error.message 
    });
  }
});

// 更新管理员配置
app.put('/api/admin/config', adminMiddleware.requireAdmin, (req, res) => {
  const { features } = req.body;
  
  if (!features) {
    return res.status(400).json({ success: false, message: '缺少配置数据' });
  }
  
  if (adminMiddleware.updateFeatureConfig(features)) {
    res.json({ success: true, message: '配置已更新' });
  } else {
    res.status(500).json({ success: false, message: '配置更新失败' });
  }
});

// 修改管理员密码
app.post('/api/admin/change-password', adminMiddleware.requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: '请填写所有字段' });
  }
  
  if (!adminMiddleware.verifyAdminPassword(currentPassword)) {
    return res.status(401).json({ success: false, message: '当前密码错误' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: '新密码长度至少6位' });
  }
  
  const config = adminMiddleware.loadConfig();
  config.adminPassword = newPassword;
  
  if (adminMiddleware.saveConfig(config)) {
    res.json({ success: true, message: '密码修改成功' });
  } else {
    res.status(500).json({ success: false, message: '密码修改失败' });
  }
});

// 获取功能配置（公开接口）
app.get('/api/features', (req, res) => {
  const features = adminMiddleware.getFeatureConfig();
  const config = adminMiddleware.loadConfig();
  res.json({ 
    success: true, 
    features,
    storageConfig: config ? config.storageConfig : null
  });
});

// 主页面路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 文件存储模式 API ==========

// 文件上传接口（服务器存储模式）
app.post('/api/upload-file', upload.single('file'), (req, res) => {
  const config = adminMiddleware.getFeatureConfig();
  
  if (!config || !config.serverStorage) {
    // 如果功能未启用但文件已上传，删除该文件
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('[上传] 删除未授权上传文件失败:', err);
      });
    }
    return res.status(403).json({ 
      success: false, 
      message: '服务器存储模式未启用' 
    });
  }
  
  if (!req.file) {
    return res.status(400).json({ success: false, message: '未选择文件' });
  }
  
  const pickupCode = generatePickupCode();
  const fileInfo = {
    pickupCode: pickupCode,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadTime: Date.now(),
    downloaded: false
  };
  
  storedFileSessions.set(pickupCode, fileInfo);
  
  // 获取当前配置
  const currentConfig = adminMiddleware.loadConfig();
  const retentionHours = currentConfig.storageConfig.fileRetentionHours || 24;
  const deleteOnDownload = currentConfig.storageConfig.deleteOnDownload || false;
  
  // 设置文件过期清理（如果不是下载后删除模式）
  if (!deleteOnDownload) {
    setTimeout(() => {
      deleteStoredFile(pickupCode);
    }, retentionHours * 60 * 60 * 1000);
  }
  
  console.log(`[服务器存储] 文件已上传: ${pickupCode} - ${req.file.originalname} (保留${deleteOnDownload ? '下载后删除' : retentionHours + '小时'})`);
  
  res.json({
    success: true,
    pickupCode: pickupCode,
    retentionHours: deleteOnDownload ? '下载后删除' : retentionHours,
    deleteOnDownload: deleteOnDownload,
    fileInfo: {
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype
    }
  });
});

// 获取存储文件信息
app.get('/api/stored-file/:code', (req, res) => {
  const pickupCode = req.params.code;
  const fileInfo = storedFileSessions.get(pickupCode);
  
  if (!fileInfo) {
    return res.status(404).json({ 
      success: false, 
      message: '取件码无效或文件已过期' 
    });
  }
  
  res.json({
    success: true,
    fileInfo: {
      name: fileInfo.originalName,
      size: fileInfo.size,
      type: fileInfo.mimetype
    }
  });
});

// 下载存储文件
app.get('/api/download-stored/:code', (req, res) => {
  const pickupCode = req.params.code;
  const fileInfo = storedFileSessions.get(pickupCode);
  
  if (!fileInfo) {
    return res.status(404).send('取件码无效或文件已过期');
  }
  
  const config = adminMiddleware.loadConfig();
  const filePath = path.join(config.storageConfig.uploadDir, fileInfo.filename);
  
  if (!fs.existsSync(filePath)) {
    storedFileSessions.delete(pickupCode);
    return res.status(404).send('文件不存在');
  }
  
  // 设置下载头
  const fileName = encodeURIComponent(fileInfo.originalName);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
  res.setHeader('Content-Type', fileInfo.mimetype || 'application/octet-stream');
  res.setHeader('Content-Length', fileInfo.size);
  res.setHeader('Cache-Control', 'no-cache'); // 禁用缓存
  res.setHeader('X-Content-Type-Options', 'nosniff'); // 安全头
  res.setHeader('Accept-Ranges', 'bytes'); // 支持断点续传
  
  // 流式发送文件（优化缓冲区大小）
  const fileStream = fs.createReadStream(filePath, {
    highWaterMark: 512 * 1024 // 512KB缓冲区，提升读取速度
  });
  
  fileStream.on('end', () => {
    console.log(`[服务器存储] 文件已下载: ${pickupCode}`);
    fileInfo.downloaded = true;
    
    // 检查是否设置为下载后删除
    const currentConfig = adminMiddleware.loadConfig();
    const deleteOnDownload = currentConfig.storageConfig.deleteOnDownload || false;
    
    if (deleteOnDownload) {
      // 立即删除文件
      console.log(`[服务器存储] 配置为下载后删除，立即清理文件: ${pickupCode}`);
      setTimeout(() => {
        deleteStoredFile(pickupCode);
      }, 2000);
    } else {
      // 5秒后删除（保持原有逻辑）
      setTimeout(() => {
        deleteStoredFile(pickupCode);
      }, 5000);
    }
  });
  
  fileStream.on('error', (error) => {
    console.error(`[服务器存储] 文件读取错误:`, error);
    res.status(500).send('文件读取失败');
  });
  
  fileStream.pipe(res);
});

// 删除存储文件
function deleteStoredFile(pickupCode) {
  const fileInfo = storedFileSessions.get(pickupCode);
  
  if (!fileInfo) return;
  
  const config = adminMiddleware.loadConfig();
  const filePath = path.join(config.storageConfig.uploadDir, fileInfo.filename);
  
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[服务器存储] 文件已删除: ${pickupCode} - ${fileInfo.originalName}`);
    }
  } catch (error) {
    console.error(`[服务器存储] 删除文件失败:`, error);
  }
  
  storedFileSessions.delete(pickupCode);
}

// 新增：HTTP流式下载接口
app.get('/api/download/:code', (req, res) => {
    const pickupCode = req.params.code;
    const session = activeSessions.get(pickupCode);

    if (!session || !session.fileInfo) {
        return res.status(404).send('链接已失效或文件信息缺失');
    }

    // 设置下载头
    const fileName = encodeURIComponent(session.fileInfo.name);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.setHeader('Content-Type', session.fileInfo.type || 'application/octet-stream');
    if (session.fileInfo.size) {
        res.setHeader('Content-Length', session.fileInfo.size);
    }

    // 存储响应对象到会话中，以便Socket接收到数据时写入
    session.downloadResponse = res;
    console.log(`[${pickupCode}] HTTP下载请求已建立，准备流式传输`);

    // 通知发送端开始发送数据
    if (session.senderSocket) {
        session.senderSocket.emit('start-transfer', { pickupCode });
    }

    // 监听连接关闭
    req.on('close', () => {
        if (!res.writableEnded) {
            console.log(`[${pickupCode}] 接收端HTTP连接中断`);
            if (session.senderSocket) {
                session.senderSocket.emit('receiver-disconnected', { pickupCode });
            }
            session.downloadResponse = null;
        }
    });
});

// 清理过期会话（每5分钟执行一次）
setInterval(() => {
  const now = Date.now();
  const expiredTime = 30 * 60 * 1000; // 30分钟过期
  
  // 清理过期的活跃会话
  for (const [pickupCode, session] of activeSessions.entries()) {
    if (now - session.createdAt > expiredTime) {
      console.log(`[会话清理] 清理过期会话: ${pickupCode}`);
      activeSessions.delete(pickupCode);
    }
  }
  
  // 清理过期的存储文件
  const config = adminMiddleware.loadConfig();
  if (config && config.features.serverStorage) {
    const retentionHours = config.storageConfig.fileRetentionHours || 24;
    const deleteOnDownload = config.storageConfig.deleteOnDownload || false;
    
    // 如果不是"下载后删除"模式，才进行定时清理
    if (!deleteOnDownload) {
      for (const [pickupCode, fileInfo] of storedFileSessions.entries()) {
        const uploadTime = fileInfo.uploadTime || Date.now();
        const fileAge = now - uploadTime;
        const maxAge = retentionHours * 60 * 60 * 1000;
        
        if (fileAge > maxAge) {
          console.log(`[文件清理] 清理过期文件: ${pickupCode} - ${fileInfo.originalName} (已存储 ${(fileAge / 3600000).toFixed(1)} 小时)`);
          deleteStoredFile(pickupCode);
        }
      }
    }
  }
  
  // 清理孤儿文件（磁盘上存在但没有会话记录的文件）
  cleanOrphanFiles();
}, 5 * 60 * 1000); // 每5分钟执行一次

// 清理孤儿文件（上传中断或异常留下的文件）
function cleanOrphanFiles() {
  const config = adminMiddleware.loadConfig();
  if (!config || !config.features.serverStorage) return;
  
  const uploadDir = path.resolve(config.storageConfig.uploadDir);
  if (!fs.existsSync(uploadDir)) return;
  
  try {
    const files = fs.readdirSync(uploadDir);
    const now = Date.now();
    const orphanAgeThreshold = 10 * 60 * 1000; // 10分钟，给上传足够的时间
    
    // 获取所有有效文件名
    const validFilenames = new Set();
    for (const [, fileInfo] of storedFileSessions.entries()) {
      validFilenames.add(fileInfo.filename);
    }
    
    // 检查每个文件
    for (const filename of files) {
      if (!validFilenames.has(filename)) {
        const filePath = path.join(uploadDir, filename);
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtimeMs;
        
        // 如果文件超过10分钟且没有会话记录，视为孤儿文件
        if (fileAge > orphanAgeThreshold) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`[孤儿文件清理] 删除失败: ${filename}`, err);
            } else {
              console.log(`[孤儿文件清理] 已删除孤儿文件: ${filename} (年龄: ${(fileAge / 60000).toFixed(1)} 分钟)`);
            }
          });
        }
      }
    }
  } catch (error) {
    console.error('[孤儿文件清理] 清理过程出错:', error);
  }
}

// 启动前检查
require('./startup-check');

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 File-Rocket 4.0 服务器启动成功!`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`🔐 管理后台: 点击首页版权文字 4 次`);
  console.log('='.repeat(50));
  console.log(`\n当前配置:`);
  
  const config = adminMiddleware.loadConfig();
  if (config) {
    console.log(`  - 内存流式传输: ${config.features.memoryStreaming ? '✅' : '❌'}`);
    console.log(`  - 服务器存储: ${config.features.serverStorage ? '✅' : '❌'}`);
    console.log(`  - P2P 直连: ${config.features.p2pDirect ? '✅' : '❌'}`);
  }
  
  console.log(`\n活跃会话: ${activeSessions.size}`);
  console.log(`存储文件: ${storedFileSessions.size}\n`);
});
