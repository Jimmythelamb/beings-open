@echo off
setlocal EnableExtensions
cd /d "%~dp0"
wscript.exe //B "%~dp0Launch-BEINGS-Helper.vbs"
exit /b 0
