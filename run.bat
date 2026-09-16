@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=C:\Users\MI\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not exist "%NODE%" set "NODE=node"

echo ============================================
echo   TikTok 视频链接自动补全
echo ============================================
echo.

"%NODE%" src\sync.cjs %*

echo.
echo 完成。结果见 data\output.csv
pause
