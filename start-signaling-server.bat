@echo off
setlocal
cd /d "%~dp0"

echo Starting WebRTC signaling server...
echo.
echo If you pass a WebGL build folder, it will also serve the game:
echo   start-signaling-server.bat C:\Path\To\WebGLBuild
echo.

node server.js %*
echo.
echo Server stopped.
pause
