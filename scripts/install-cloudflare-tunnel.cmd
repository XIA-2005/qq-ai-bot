@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title QQ AI Bot - 安全配置 Cloudflare Named Tunnel
if not "%~1"=="" (
  echo [拒绝] 请勿把 Tunnel Token 作为命令行参数传入；命令历史和进程列表可能泄露。
  echo        请无参数运行根目录“配置iPhone固定远程.cmd”，在本机安全提示中输入 Token。
  exit /b 2
)
echo 旧安装入口已转至唯一的安全配置脚本；只接受交互式 Token 输入。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-remote-tunnel.ps1"
exit /b %ERRORLEVEL%
