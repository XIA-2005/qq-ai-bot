@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
if not "%~1"=="" (
  echo [拒绝] 本卸载入口不接受任何 Token 或额外参数。
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-cloudflare-tunnel.ps1"
exit /b %ERRORLEVEL%
