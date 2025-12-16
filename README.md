# 🚀 File-Rocket 4.0

<div align="center">

![File-Rocket Logo](https://img.shields.io/badge/File--Rocket-4.0-blueviolet?style=for-the-badge&logo=rocket)
[![Docker Image](https://img.shields.io/docker/v/lihupr/file-rocket?label=Docker%20Hub&style=for-the-badge&color=blue&logo=docker)](https://hub.docker.com/r/lihupr/file-rocket)
[![GitHub](https://img.shields.io/badge/GitHub-Lihu--PR-black?style=for-the-badge&logo=github)](https://github.com/Lihu-PR)

**新一代轻量级、高性能的异地大文件传输工具**  
专为 ARM64 嵌入式设备（如 OpenWrt 软路由、树莓派）优化，同时也完美支持 PC 和服务器。

### 🌐 在线体验
**[https://file-rocket.top/](https://file-rocket.top/)** - 立即体验，无需安装（仅作演示 推荐个人部署）  
**[https://file-rocket.tech/](https://file-rocket.tech/)** - 备用地址，速度更快（仅作演示 推荐个人部署）

<img width="2552" height="1314" alt="FR" src="https://github.com/user-attachments/assets/4144584b-ca15-4e6c-b810-7cd729ddd7a9" />

*© 2025 File-Rocket 4.0 • Designed for Speed*

</div>

---

## ✨ 核心特性

### 🎯 三种传输模式，灵活选择

#### ⚡ 内存流式传输
- 端到端直连，服务器仅做中继，**不存储任何文件**
- 双方需同时在线，速度快，仅受带宽限制
- 支持超大文件，内存占用极低

#### 💾 服务器存储中转
- 文件暂存服务器（1小时/24小时/下载后删除 可选）
- 支持异步下载，接收方可随时下载
- 完整的管理员文件管理功能

#### 🔗 P2P 直连传输
- 点对点 WebRTC 连接，无需服务器中转数据
- 自动 NAT 类型检测（NAT0/1/2/3/4）
- 显示连接成功率预测和等待时间，速度最快

### 🔐 强大的管理员系统

- **隐藏式入口**：首页版权文字点击 4 次触发
- **密码保护**：默认密码 `7428`（首次登录后请修改）
- **功能配置**：动态开启/关闭传输模式
- **文件管理**：查看存储文件、磁盘空间、一键清理
- **系统统计**：活跃会话、今日传输、文件数量
- **安全设置**：修改管理员密码、Token 会话管理

### 🌐 全平台支持

- 📱 **响应式设计**：Glassmorphism UI，完美适配手机、平板和电脑
- 🔄 **智能断连检测**：精准监测传输状态，异常断开秒级响应
- 🌍 **跨架构支持**：ARM64 (OpenWrt/树莓派) 和 AMD64 (PC/服务器)
- 🎯 **极低占用**：内存占用极低，适合路由器等低功耗设备全天候运行
- 🛡️ **安全可靠**：SHA-256 文件完整性校验、速率限制、自动清理

---

## 📦 部署指南 (Docker)

> 💡 **提示**：不想自己部署？直接访问 [在线体验地址](https://file-rocket.top/) 或 [备用地址（高速）](https://file-rocket.tech/) 试用！（仅作演示 推荐个人部署）

我们强烈推荐直接使用 Docker 部署，这是最快、最稳定的方式。  
Docker 安装及配置教程：[哩虎的技术博客 - Docker 安装及配置](https://lihu.site/archives/docker-install)

### 1️⃣ 快速启动（推荐）

根据您的设备类型选择命令：

#### 🏠 ARM64 设备（OpenWrt / 树莓派 / 电视盒子）
```bash
docker run -d \
  --name file-rocket \
  --restart unless-stopped \
  -p 3000:3000 \
  --memory=128m \
  --cpus=0.3 \
  -v ./files:/app/files \
  lihupr/file-rocket:arm64
```
视频教程制作中...

#### 💻 AMD64 设备（Windows / Linux PC / 云服务器）
```bash
docker run -d \
  --name file-rocket \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ./files:/app/files \
  lihupr/file-rocket:latest
```
视频教程：[AMD64 平台部署视频教程](https://b23.tv/nlUlzcT)

> **访问地址**：打开浏览器访问 `http://设备IP:3000`

---

### 2️⃣ 自行构建镜像（高级）

如果您需要修改源码或自行编译，请按以下步骤操作。

#### ⚠️ 编译前必读：网络问题解决
由于国内网络环境，构建时可能会拉取基础镜像失败。**请务必先手动拉取基础镜像到本地**：

**对于 ARM64（构建给 OpenWrt/树莓派用）：**
```bash
docker pull --platform linux/arm64 node:18-alpine
```

**对于 AMD64（构建给 PC/服务器用）：**
```bash
docker pull --platform linux/amd64 node:18-alpine
```

#### 🛠️ 构建步骤

**构建 ARM64 镜像：**
```bash
# 1. 确保已拉取基础镜像（见上一步）
# 2. 执行构建命令
docker build --platform linux/arm64 --no-cache -t file-rocket:arm64 .

# 3. 导出为文件（方便传输到路由器）
docker save -o file-rocket-arm64.tar file-rocket:arm64
```

**构建 AMD64 镜像：**
```bash
# 1. 确保已拉取基础镜像
# 2. 执行构建命令
docker build --platform linux/amd64 --no-cache -t file-rocket:amd64 .

# 3. 导出为文件（可选）
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
5. 将取件码发给接收方，等待连接

### 📥 接收文件
1. 打开首页，点击 **"接收文件"**
2. 输入对方提供的 4 位取件码
3. 确认文件信息无误后，点击 **"接收文件"** 开始下载

### 🔐 管理员配置
1. 点击页面底部版权文字 **4 次** 触发登录
2. 输入默认密码：`7428`（首次登录后请立即修改）
3. 进入管理后台：
   - **功能开关**：实时开启/关闭各传输模式
   - **文件管理**：查看磁盘空间、存储文件列表、一键清理
   - **文件保留时间**：1 小时/24 小时/下载后删除
   - **系统统计**：活跃会话、今日传输、存储文件数量
   - **安全设置**：修改管理员密码

---

## ❓ 常见问题（FAQ）

**Q: 文件会保存在服务器上吗？**  
A: 这取决于您选择的传输模式：
- **内存流式传输**：不保存，数据直接流向接收端
- **服务器存储**：暂存 1-24 小时后自动删除
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
例如：NAT0(95%) + NAT1(90%) = 92.5% 综合成功率  
例如：NAT1(90%) + NAT3(50%) = 50% 综合成功率

**Q: 如何选择传输模式？**  
A: 根据文件大小和使用场景：
- **小文件（<100MB）**：服务器存储（上传快，随时下载）
- **中等文件（100MB-1GB）**：内存流式或 P2P
- **大文件（>1GB）**：P2P（如果网络好）或服务器存储

**Q: OpenWrt 部署报错 "exec format error"？**  
A: 您可能部署了 AMD64 的镜像。请确保使用 `lihupr/file-rocket:arm64` 标签。

**Q: 构建时报错 "failed to do request: EOF"？**  
A: 这是网络问题导致无法拉取基础镜像。请参考上文的 **"编译前必读"**，先使用 `docker pull` 手动拉取镜像。

**Q: 如何清理损坏的文件？**  
A: 进入管理员面板 → 文件管理 → 点击 **"删除所有文件"** 按钮。

---

## 🔒 安全建议

1. ✅ 首次登录后立即修改默认密码
2. ✅ 使用强密码（至少 12 位，包含字母数字符号）
3. ✅ 生产环境必须使用 HTTPS
4. ✅ 定期检查管理后台统计数据
5. ✅ 定期清理存储文件
6. ✅ 不要将 `config.json` 提交到版本控制
7. ✅ 配置防火墙规则限制访问

---

## 🛠️ 技术栈

- **后端**：Node.js + Express + Socket.IO
- **前端**：原生 JavaScript + WebRTC
- **传输**：HTTP Stream + WebSocket + DataChannel
- **存储**：文件系统
- **认证**：Token-based
- **设计**：Glassmorphism UI

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

**File-Rocket 4.0** - 让文件传输更简单、更快速、更安全

</div>
