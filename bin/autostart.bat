@echo off
REM 开机 / 登录时自启 —— 只负责拉起「看门狗」，剩下的交给它
REM   * 看门狗每 30s 检查守护进程心跳，死了/卡死就重新拉起
REM   * 看门狗自己带单实例锁，重复运行本脚本不会启出多个看门狗
REM
REM 安装位置：C:\Users\MI\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\tiktok-sync-autostart.bat
REM 手动停用：cd tiktok-link-sync && npm run watch:stop   （会写 data\watch.disabled，看门狗不再自动拉起）

set "PROJ=C:\Users\MI\WorkBuddy\2026-09-15-11-35-00\tiktok-link-sync"

if not exist "%PROJ%\bin\watchdog.vbs" (
  echo [tiktok-sync] 找不到 %PROJ%\bin\watchdog.vbs，跳过自启
  exit /b 1
)

REM wscript //B = 无弹窗批处理模式，进程完全独立于本窗口
start "" /B wscript.exe //B //NOLOGO "%PROJ%\bin\watchdog.vbs"

exit /b 0
