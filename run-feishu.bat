@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=C:\Users\MI\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not exist "%NODE%" set "NODE=node"

echo ============================================
echo   TikTok 视频链接自动补全  -  飞书表格模式
echo ============================================
echo.
echo   直接把链接回填到飞书多维表格
echo.

"%NODE%" src\sync.cjs --source feishu %*

echo.
echo 完成。本地快照见 data\feishu-run-*.csv
pause
