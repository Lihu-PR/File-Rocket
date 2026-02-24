@echo off
chcp 65001 >nul
title File-Rocket Go 服务器

echo ================================================
echo   🚀 File-Rocket 4.0 (Go 版本)
echo ================================================
echo.

REM 检查 Go 是否安装
where go >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未检测到 Go 环境！
    echo.
    echo 请先安装 Go 1.21+: https://go.dev/dl/
    echo.
    pause
    exit /b 1
)

echo [1/2] 检查 Go 环境...
go version
echo.

REM 总是重新编译以确保使用最新代码
echo [2/2] 编译程序...
go build -ldflags="-s -w" -o file-rocket.exe server.go disk_space_windows.go
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 编译失败！
    pause
    exit /b 1
)
echo [成功] 编译完成
echo.

echo ================================================
echo   启动服务器...
echo   访问: http://localhost:3000
echo   管理: 点击首页版权文字 4 次 (密码 7428)
echo ================================================
echo.
echo [提示] 按 Ctrl+C 停止服务器
echo.

file-rocket.exe

pause
