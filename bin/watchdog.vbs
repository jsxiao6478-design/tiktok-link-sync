' 看门狗：监督 watch-trigger.cjs 守护进程，发现它不在跑/卡死就拉起来。
'
' 设计要点（和旧版的区别）：
'   1) 用「心跳文件」判断存活，不依赖 PowerShell / Get-Process
'      —— 守护进程每轮 sync 前后都会刷新 data\watch.heartbeat；
'      心跳超过 STALE_SEC 秒没动就认定它死了（进程崩了、被关了、或卡住了都能发现）。
'   2) 只用 WScript 内置对象（WScript.Shell / Scripting.FileSystemObject），
'      不调用 powershell，避免被安全策略拦、也不会有双重重定向到同一日志文件的坑。
'   3) 重启交给 bin\start-watch.cjs —— 它自己会写 watch.pid、重定向日志、并做去重。
'   4) 尊重 data\watch.disabled：用户主动 `npm run watch:stop` 后不会再被强拉起来。
'   5) 单实例锁 data\watchdog.lock，避免开机脚本重复拉起多个看门狗。
'
' 手动测一次（不常驻）：wscript bin\watchdog.vbs --once

Option Explicit

Dim shell, fso, exe, cwd, hbFile, pidFile, logFile, disFile, lockFile, lockObj
Dim STALE_SEC
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

exe = "C:\Users\MI\.workbuddy\binaries\node\versions\22.22.2\node.exe"
cwd = "C:\Users\MI\WorkBuddy\2026-09-15-11-35-00\tiktok-link-sync"
hbFile = cwd & "\data\watch.heartbeat"
pidFile = cwd & "\data\watch.pid"
logFile = cwd & "\data\watchdog.log"
disFile = cwd & "\data\watch.disabled"
lockFile = cwd & "\data\watchdog.lock"

STALE_SEC = 180   ' 心跳超过 3 分钟没更新 → 认为守护进程已死

Dim once
once = False
Dim i
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "--once" Then once = True
Next

Sub WriteLog(msg)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine "[" & FormatDateTime(Now, 2) & " " & FormatDateTime(Now, 3) & "] " & msg
  f.Close
  On Error GoTo 0
End Sub

Function HeartbeatAgeSec()
  HeartbeatAgeSec = -1
  On Error Resume Next
  If fso.FileExists(hbFile) Then
    HeartbeatAgeSec = DateDiff("s", fso.GetFile(hbFile).DateLastModified, Now)
  End If
  On Error GoTo 0
End Function

Sub EnsureRunning()
  Dim age, pid, cmd
  age = HeartbeatAgeSec()

  If age >= 0 And age < STALE_SEC Then
    Exit Sub        ' 心跳新鲜，守护进程活着
  End If

  If age < 0 Then
    WriteLog "看门狗：没有心跳文件，判定守护进程未运行"
  Else
    WriteLog "看门狗：心跳已 " & age & "s 未更新（阈值 " & STALE_SEC & "s），判定守护进程已死或卡死"
  End If

  ' 收尾：如果残留进程还在（卡死场景），强制结束它
  On Error Resume Next
  If fso.FileExists(pidFile) Then
    pid = Trim(fso.OpenTextFile(pidFile).ReadLine())
    If IsNumeric(pid) And pid <> "" Then
      shell.Run "taskkill /PID " & pid & " /F /T", 0, True
      WriteLog "看门狗：已请求结束残留进程 PID=" & pid
    End If
  End If
  On Error GoTo 0

  ' 拉起：交给 start-watch.cjs（负责写 watch.pid / 日志重定向 / 去重）
  cmd = """" & exe & """ """ & cwd & "\bin\start-watch.cjs"""
  shell.CurrentDirectory = cwd
  On Error Resume Next
  shell.Run cmd, 0, True
  If Err.Number <> 0 Then
    WriteLog "看门狗：拉起失败 " & Err.Description
    Err.Clear
  Else
    WriteLog "看门狗：已拉起守护进程"
  End If
  On Error GoTo 0
End Sub

' ── 用户主动停用时，什么都不做 ──
If fso.FileExists(disFile) Then
  If once Then WriteLog "看门狗：存在 watch.disabled，跳过（--once 结束）"
  WScript.Quit 0
End If

' ── 单实例锁 ──
Dim canStart, ageLock, lf
canStart = False
On Error Resume Next
Err.Clear
Set lf = fso.CreateTextFile(lockFile, False, True)   ' False = 不覆盖已存在的文件
If Err.Number = 0 Then
  lf.Close
  canStart = True
Else
  Err.Clear
  Set lf = Nothing
  If fso.FileExists(lockFile) Then
    ageLock = DateDiff("s", fso.GetFile(lockFile).DateLastModified, Now)
    If ageLock > 120 Then
      fso.DeleteFile lockFile, True
      Set lf = fso.CreateTextFile(lockFile, False, True)
      If Err.Number = 0 Then
        lf.Close
        canStart = True
        WriteLog "看门狗：接管过期的单实例锁（已 " & ageLock & "s 未刷新）"
      End If
    End If
  End If
End If
On Error GoTo 0

If Not canStart Then
  If once Then WriteLog "看门狗：已有实例在运行，本次退出"
  WScript.Quit 0
End If

If once Then
  EnsureRunning
  ' 一次性模式是「我来跑一次检查」，不该长期占着单实例锁
  On Error Resume Next
  fso.DeleteFile lockFile, True
  On Error GoTo 0
  WScript.Quit 0
End If

WriteLog "看门狗启动（检查间隔 30s，心跳阈值 " & STALE_SEC & "s）"

' ── 主循环 ──
Do
  ' 刷新单实例锁的 mtime，让别的实例知道我还活着
  On Error Resume Next
  If fso.FileExists(lockFile) Then
    Set lockObj = fso.GetFile(lockFile)
    lockObj.DateLastModified = Now
    Set lockObj = Nothing
  End If
  On Error GoTo 0

  If fso.FileExists(disFile) Then
    ' 用户主动停用 → 退出，下次开机自启会重新判断
    WriteLog "看门狗：检测到 watch.disabled，看门狗退出"
    On Error Resume Next
    fso.DeleteFile lockFile, True
    On Error GoTo 0
    WScript.Quit 0
  End If

  EnsureRunning
  WScript.Sleep 30000
Loop
