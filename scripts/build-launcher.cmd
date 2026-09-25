@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo .NET Framework C# compiler not found. Install .NET Framework 4.x before rebuilding launcher.
  exit /b 1
)
"%CSC%" /nologo /codepage:65001 /optimize+ /target:winexe /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /out:"%~dp0launcher.exe" "%~dp0Launcher.cs"
if errorlevel 1 exit /b %errorlevel%
copy /y "%~dp0launcher.exe" "%~dp0..\启动机器人.exe" >nul
if errorlevel 1 exit /b %errorlevel%
echo Launcher rebuilt from scripts\Launcher.cs for both EXE entry points.
exit /b 0
