<div align="center">

# 🚀 File-Rocket 5.0

![File-Rocket Logo](https://img.shields.io/badge/File--Rocket-5.0-blueviolet?style=for-the-badge&logo=rocket)
[![Docker Image](https://img.shields.io/docker/v/lihupr/file-rocket?label=Docker%20Hub&style=for-the-badge&color=blue&logo=docker)](https://hub.docker.com/r/lihupr/file-rocket)
[![GitHub](https://img.shields.io/badge/GitHub-Lihu--PR-black?style=for-the-badge&logo=github)](https://github.com/Lihu-PR)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?style=for-the-badge&logo=go)](https://go.dev)

**新一代轻量级、高性能的异地大文件传输工具**
使用 Go 语言重写，单二进制部署，零依赖，极致性能。
专为 ARM64 嵌入式设备（如 OpenWrt 软路由、树莓派）优化，同时也完美支持 PC 和服务器。

### 🌐 在线体验
**[https://file-rocket.top/](https://file-rocket.top/)** - 立即体验，无需安装（仅作演示 推荐个人部署）  

**[https://file-rocket.tech/](https://file-rocket.tech/)** - 备用地址，速度更快（仅作演示 推荐个人部署）  


<img width="2552" height="1354" alt="ScreenShot_2026-02-24_154217_456" src="https://github.com/user-attachments/assets/266c6a1f-5708-40e7-ba29-fd8986108d64" />

*© 2025 File-Rocket 5.0 • Designed for Speed*

</div>

---

## ✨ 核心特性

### 🎯 三种传输模式，灵活选择
#### ⚡ 内存流式传输
- 端到端直连，服务器仅做中继，**不存储任何文件**
- 双方需同时在线，速度快，仅受带宽限制
- 512KB 分块 + 滑动窗口 + AIMD 拥塞控制
- 逐块 SHA-256 校验，支持 ACK/NACK 重传机制

#### 💾 服务器存储中转
- 文件暂存服务器（1小时/24小时/下载后删除/永久保存 可选）
- 支持异步下载，接收方可随时下载
- 分块上传（512KB），支持超大文件（最大 5GB）
- HTTP Range 断点续传，完整的管理员文件管理功能
- **动态空间限制**：自动限制上传文件大小为服务器可用空间的 90%

#### 🔗 P2P 直连传输
- 点对点 WebRTC 连接，无需服务器中转数据
- 15 个 STUN 服务器，自动 NAT 类型检测（NAT0/1/2/3/4）
- 显示连接成功率预测，ICE 重启机制（最多 2 次）
- P2P 失败自动回退到服务器存储模式
- **智能传输模式**：
  - 💻 **桌面设备**：StreamSaver 流式传输，边收边存，支持超大文件（>10GB）
  - 📱 **移动设备**：浏览器缓存模式，传输完成后统一下载（限制 150MB）

<img width="2552" height="1354" alt="ScreenShot_2026-02-24_154311_560" src="https://github.com/user-attachments/assets/52c9089e-d814-4d7c-84a3-6e4c63c5e502" />

### 🔐 强大的管理员系统

- **隐藏式入口**：首页版权文字点击 4 次触发
- **密码保护**：默认密码 `7428`（首次登录后请修改）
- **功能配置**：动态开启/关闭传输模式
- **文件管理**：查看存储文件、磁盘空间、一键清理
- **删除策略**：1小时/24小时/下载后删除/永久保存
- **系统统计**：活跃会话、今日传输、文件数量
- **主题切换**：经典（渐变毛玻璃）/ 极简（扁平简洁）全局切换
- **安全设置**：修改管理员密码、Token 会话管理

<img width="394" height="1354" alt="ScreenShot_2026-02-24_154455_616" src="https://github.com/user-attachments/assets/3da22b6f-77fa-4ec0-9ff6-7d5cce266d2e" />

### 🎨 双主题系统  

<img width="750" height="383" alt="ScreenShot_2026-02-24_154607_134" src="https://github.com/user-attachments/assets/a3851891-b3b2-4c98-86d3-33ac7e639517" />

| 特性 | 经典主题 | 极简主题（默认） |
|------|---------|----------------|
| **风格** | 动态渐变背景 + 毛玻璃效果 | 纯白扁平设计 |
| **图标** | Emoji 表情 | SVG 线条图标 |
| **加载动画** | 脉冲动画 | 3D 旋转方块 |
| **配色** | 紫蓝渐变 | 深灰单色 |
| **适合场景** | 展示演示 | 日常使用 |

### 🌐 全平台支持

- 📱 **响应式设计**：完美适配手机、平板和电脑
- 🔄 **智能断连检测**：精准监测传输状态，异常断开秒级响应
- 🌍 **跨架构支持**：ARM64 (OpenWrt/树莓派) 和 AMD64 (PC/服务器)
- 🎯 **极低占用**：Go 单二进制，内存占用极低，适合路由器等低功耗设备
- 🛡️ **安全可靠**：SHA-256 文件完整性校验（全文件 + 逐块）、防暴力破解、自动清理
- 📱 **移动优化**：智能识别移动设备，自动选择最佳传输方式
- 🌏 **中文支持**：完美支持中文文件名，无乱码问题
- ⚡ **高性能**：Go 原生并发，带宽利用率 95%+，跑满服务器带宽
- 📋 **QR 码分享**：生成取件码二维码，扫码即可接收文件

---
## 📦 部署指南 (Docker)

> 💡 **提示**：不想自己部署？直接访问 [在线体验地址](https://file-rocket.top/) 或 [备用地址（高速）](https://file-rocket.tech/) 试用！（仅作演示 推荐个人部署）

我们强烈推荐直接使用 Docker 部署，这是最快、最稳定的方式。
Docker 安装及配置教程：[哩虎的技术博客 - Docker 安装及配置](https://lihu.site/archives/docker-install)

### 1️⃣ 快速启动（推荐）

根据您的设备类型选择命令：

#### 🏠 ARM64 设备（OpenWrt / 树莓派 / 电视盒子）
<<<<<<< HEAD
```
docker run -d --name file-rocket --restart unless-stopped -p 3000:3000 --memory=128m --cpus=0.3 lihupr/file-rocket:arm64
```
视频教程：[ARM64 平台部署视频教程](https://b23.tv/mgSF3vi)

#### 💻 AMD64 设备（Windows / Linux PC / 云服务器）
```
docker run -d --name file-rocket --restart unless-stopped -p 3000:3000 lihupr/file-rocket:latest
=======
```bash
docker run -d --name file-rocket --restart unless-stopped \
  -p 3000:3000 --memory=128m --cpus=0.3 \
  -v /root/file-rocket-data:/app/files \
  lihupr/file-rocket:arm64
```
视频教程：[ARM64 平台部署视频教程](https://b23.tv/mgSF3vi)

#### 💻 AMD64 设备（Windows / Linux PC / 云服务器）
```bash
docker run -d --name file-rocket --restart unless-stopped \
  -p 3000:3000 \
  -v /root/file-rocket-data:/app/files \
  lihupr/file-rocket:latest
```
视频教程：[AMD64 平台部署视频教程](https://b23.tv/nlUlzcT)

> **访问地址**：打开浏览器访问 `http://设备IP:3000`

#### 🖥️ Windows 本地运行（无需 Docker）
```bat
start.bat
```
自动编译并启动，访问 `http://localhost:3000`

---

### 2️⃣ 自行构建镜像（高级）

如果您需要修改源码或自行编译，请按以下步骤操作。

#### ⚠️ 编译前必读：网络问题解决
由于国内网络环境，构建时可能会拉取基础镜像失败。**请务必先手动拉取基础镜像到本地**：

**对于 ARM64（构建给 OpenWrt/树莓派用）：**
```bash
docker pull --platform linux/arm64 golang:1.22-alpine
docker pull --platform linux/arm64 alpine:latest
```

**对于 AMD64（构建给 PC/服务器用）：**
```bash
docker pull --platform linux/amd64 golang:1.22-alpine
docker pull --platform linux/amd64 alpine:latest
```

#### 🛠️ 构建步骤

**构建 ARM64 镜像：**
```bash
docker buildx build --platform linux/arm64 --no-cache -t file-rocket:arm64 --load .

# 导出为文件（方便传输到路由器）
docker save -o file-rocket-arm64.tar file-rocket:arm64
```

**构建 AMD64 镜像：**
```bash
docker buildx build --platform linux/amd64 --no-cache -t file-rocket:amd64 --load .

# 导出为文件（可选）
docker save -o file-rocket-amd64.tar file-rocket:amd64
```

---
## 🔧 使用说明

### 📤 发送文件
1. 打开首页，点击 **"发送文件"**
2. 拖拽或选择文件
3. 选择传输方式：
   - **内存流式**：双方同时在线，速度快
   - **服务器存储**：异步传输，接收方可随时下载
   - **P2P 直连**：点对点传输，速度最快
4. 点击 **"生成取件码"**，获得 4 位取件码
5. 将取件码或二维码分享给接收方，等待连接

### 📥 接收文件
1. 打开首页，点击 **"接收文件"**（或扫描发送方的二维码）
2. 输入对方提供的 4 位取件码
3. 确认文件信息无误后，点击 **"接收文件"** 开始下载
4. **传输模式提示**（仅 P2P 模式）：
   - 💻 桌面设备：文件将边接收边保存到磁盘
   - 📱 移动设备：文件将先接收到内存，传输完成后统一下载

### 🔐 管理员配置
1. 点击页面底部版权文字 **4 次** 触发登录
2. 输入默认密码：`7428`（首次登录后请立即修改）
3. 进入管理后台：
   - **功能开关**：实时开启/关闭各传输模式
   - **文件管理**：查看磁盘空间、存储文件列表、一键清理
   - **文件保留时间**：1小时/24小时/下载后删除/永久保存
   - **主题切换**：经典 / 极简主题全局切换
   - **系统统计**：活跃会话、今日传输、存储文件数量
   - **安全设置**：修改管理员密码

---
## ⚙️ 配置说明

服务器首次启动时自动生成 `config.json`，所有配置均可通过管理面板在线修改。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `adminPassword` | `7428` | 管理员密码（首次登录后请修改） |
| `features.memoryStreaming` | `true` | 启用内存流式传输 |
| `features.serverStorage` | `true` | 启用服务器存储模式 |
| `features.p2pDirect` | `true` | 启用 P2P 直连模式 |
| `storageConfig.maxStorageSize` | 10 GB | 最大存储空间 |
| `storageConfig.fileRetentionHours` | 24 | 文件保留时间（小时） |
| `storageConfig.deleteOnDownload` | `false` | 下载后自动删除 |
| `storageConfig.neverDelete` | `false` | 永不自动删除 |
| `theme` | `minimal` | UI 主题（`classic` 或 `minimal`） |
| 环境变量 `PORT` | `3000` | 服务监听端口 |

命令行参数：
- `--reset` / `-r`：重置配置为默认值

---

## ❓ 常见问题（FAQ）

### 基础问题

**Q: 文件会保存在服务器上吗？**
A: 这取决于您选择的传输模式：
- **内存流式传输**：不保存，数据直接流向接收端
- **服务器存储**：暂存 1-24 小时后自动删除（或选择永久保存）
- **P2P 直连**：不保存，点对点传输

**Q: 传输速度有多快？**
A: 取决于发送端和接收端两边的**上传/下载带宽**以及服务器的中继带宽。
- **内存流式**：95%+ 带宽利用率
- **服务器存储**：99%+ 带宽利用率
- **P2P 直连**：理论上最快，无服务器瓶颈

**Q: P2P 连接失败怎么办？**
A: P2P 成功率由**双方 NAT 类型共同决定**，查看双端 NAT 类型和成功率：
- **NAT0**（公网 IP）：单端成功率 95%，最佳选择
- **NAT1**（全锥型 NAT）：单端成功率 90%，建议使用
- **NAT2**（限制型 NAT）：单端成功率 75%，可以尝试
- **NAT3**（端口限制型 NAT）：单端成功率 50%，谨慎尝试
- **NAT4**（对称型 NAT）：单端成功率 20%，建议使用其他模式

**实际连接成功率 = min(发送端成功率, 接收端成功率)**
*如果双方成功率都 ≥90%，则取平均值（上限 95%）*

**Q: 如何选择传输模式？**
A: 根据文件大小和使用场景：
- **小文件（<100MB）**：服务器存储（上传快，随时下载）
- **中等文件（100MB-1GB）**：内存流式或 P2P
- **大文件（>1GB）**：P2P（如果网络好）或服务器存储

**Q: 上传大文件时提示 413 错误怎么办？**
A: 系统会自动限制上传文件大小为服务器可用空间的 90%。如果仍然出现 413 错误，可能是：
1. Nginx 配置的 `client_max_body_size` 限制（参考下方 Nginx 配置）
2. 磁盘空间不足

### 📱 移动设备相关

**Q: 手机浏览器 P2P 传输有什么特殊处理？**
A: 系统会自动检测设备类型并选择最佳传输方式：
- **桌面设备（PC/Mac）**：使用 StreamSaver 流式传输，边接收边保存到磁盘，内存占用极低，支持超大文件
- **移动设备（手机/小平板）**：使用浏览器缓存模式，文件先接收到内存，传输完成后统一下载（限制 150MB）
- **建议**：移动设备传输大文件请使用"服务器存储"模式

**Q: 移动设备 P2P 传输大文件会有问题吗？**
A: 移动设备使用缓存模式，文件完全加载到内存中：
- 文件 > 150MB：超出限制，建议使用"服务器存储"模式
- 推荐大小：< 100MB（最佳）

**Q: 为什么移动设备不使用流式传输？**
A: 移动浏览器对下载有严格限制：
- StreamSaver 的 Service Worker 在某些移动浏览器上支持不佳
- 缓存模式可以确保一次确认即可完成下载，用户体验更好

### 部署相关

**Q: OpenWrt 部署报错 "exec format error"？**
A: 您可能部署了 AMD64 的镜像。请确保使用 `lihupr/file-rocket:arm64` 标签。

**Q: 构建时报错 "failed to do request: EOF"？**
A: 这是网络问题导致无法拉取基础镜像。请参考上文的 **"编译前必读"**，先使用 `docker pull` 手动拉取镜像。

**Q: 如何清理损坏的文件？**
A: 进入管理员面板 → 文件管理 → 点击 **"删除所有文件"** 按钮。

**Q: 如何配置 Nginx 以支持大文件上传？**
A: 在 Nginx 配置中添加以下内容：
```nginx
server {
    # 增加客户端请求体大小限制
    client_max_body_size 10G;
    client_body_buffer_size 128M;

    # 增加超时时间
    client_body_timeout 600s;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    # TCP 优化
    tcp_nodelay on;
    tcp_nopush on;

    # 禁用请求缓冲（流式传输）
    proxy_request_buffering off;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---
## 🚀 v5.0 更新亮点（相比 v4.0）

### 🔄 架构重写
- **Go 语言重写**：从 Node.js + Express + Socket.IO 迁移到 Go + gorilla/websocket
- **单二进制部署**：无需 Node.js 运行时，编译后仅一个可执行文件
- **零外部依赖**：仅依赖 gorilla/websocket，其余全部使用 Go 标准库
- **内存占用更低**：Go 原生并发模型，资源占用远低于 Node.js

### ✅ 新增功能
- **双主题系统**：经典（渐变毛玻璃）和极简（扁平简洁）主题，管理员可全局切换
- **逐块 SHA-256 校验**：不仅校验全文件哈希，每个传输块都独立校验
- **P2P 自动回退**：P2P 连接失败自动切换到服务器存储模式
- **ICE 重启机制**：P2P 连接中断时自动尝试重新建立（最多 2 次）
- **AIMD 拥塞控制**：所有传输模式均采用自适应滑动窗口
- **分块上传清理**：发送方断连时自动清理未完成的分块上传
- **健康检查端点**：`GET /health` 返回服务状态、活跃会话、存储文件数、运行时间
- **配置重置**：`--reset` 命令行参数一键恢复默认配置
- **QR 码分享**：发送页面生成二维码，接收方扫码直接连接

### 📊 P2P 传输模式对比

| 特性 | 桌面设备（流式） | 移动设备（缓存） |
|------|-----------------|-----------------|
| **内存占用** | 极低（~10MB） | 高（= 文件大小） |
| **大文件支持** | 优秀（>10GB） | 一般（<150MB） |
| **下载触发** | 自动边收边存 | 传输完成后手动确认 |
| **浏览器要求** | Chrome/Edge 85+ | 所有浏览器 |
| **HTTPS 要求** | 是（本地开发可用 HTTP） | 否 |

---

## 🔒 安全建议

1. ✅ 首次登录后立即修改默认密码
2. ✅ 使用强密码（至少 6 位，建议包含字母数字符号）
3. ✅ 生产环境必须使用 HTTPS
4. ✅ 定期检查管理后台统计数据
5. ✅ 定期清理存储文件
6. ✅ 不要将 `config.json` 提交到版本控制
7. ✅ 配置防火墙规则限制访问

---

## 🛠️ 技术栈

- **后端**：Go 1.22 + gorilla/websocket
- **前端**：原生 JavaScript + WebRTC + StreamSaver.js
- **传输**：HTTP Stream + WebSocket + WebRTC DataChannel
- **存储**：文件系统（原子写入 + SHA-256 校验）
- **认证**：SHA-256 Token
- **设计**：双主题（Glassmorphism / Flat Design）
- **设备检测**：多重策略（UserAgentData + 触摸屏 + 屏幕尺寸）
- **容器化**：多阶段 Docker 构建（golang:1.22-alpine → alpine:latest）

---

## 🤝 贡献与反馈

欢迎提交 Issue 或 PR 改进项目。

- **GitHub**：[Lihu-PR](https://github.com/Lihu-PR)
- **Docker Hub**：[lihupr](https://hub.docker.com/u/lihupr)
- **哩虎的技术博客**：[lihu.site](https://lihu.site/)

---

## 📄 许可证

MIT License

---

<div align="center">

Made with ❤️ by Lihu-PR

**File-Rocket 5.0** - 让文件传输更简单、更快速、更安全

</div>

