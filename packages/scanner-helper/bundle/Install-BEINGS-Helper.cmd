@echo off
setlocal
cd /d "%~dp0"
title Install BEINGS scanner helper
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-BEINGS-Helper.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Install did not finish. You can close this window.
  pause
  exit /b %RC%
)
echo.
echo Installed. You can close this window. The helper is running in the background.
timeout /t 4 /nobreak >nul
exit /b 0
