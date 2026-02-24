# 构建阶段
FROM golang:1.22-alpine AS builder

# 安装构建依赖
RUN apk add --no-cache git

WORKDIR /build

# 设置 Go 代理（使用国内镜像）
ENV GOPROXY=https://goproxy.cn,direct

# 复制Go模块文件
COPY go.mod go.sum ./
RUN go mod download

# 复制源代码
COPY . .

# 构建二进制文件
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o file-rocket server.go disk_space_unix.go

# 运行阶段
FROM alpine:latest

# 安装必要的运行时依赖
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

# 从构建阶段复制二进制文件
COPY --from=builder /build/file-rocket .

# 复制静态文件目录（Web 界面必需）
COPY --from=builder /build/public ./public

# 创建上传目录
RUN mkdir -p /app/files && chmod 755 /app

# 声明数据卷（用于持久化上传文件和配置）
VOLUME ["/app/files"]

# 暴露端口
EXPOSE 3000

# 启动应用程序
CMD ["./file-rocket"]
