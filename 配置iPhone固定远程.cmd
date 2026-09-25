@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
if not "%~1"=="" (
  echo [拒绝] 请勿在命令行传 Tunnel Token。请无参数运行本脚本，并在交互提示中输入。
  exit /b 2
)
cd /d "%~dp0"
title QQ AI Bot - 配置 example.com 固定远程
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-remote-tunnel.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo 配置尚未完成，请按上方提示处理后重试。
pause
exit /b %RESULT%
