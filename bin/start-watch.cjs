/**
 * start-watch.cjs —— 在后台启动 watch-trigger.cjs 守护进程
 *
 * Windows 上没有 nohup，用 detached spawn 让父进程退出但子进程继续。
 * 关闭终端不会影响它；要看日志请用 `npm run watch:log`。
 *
 * 相关文件：
 *   data/watch.pid         守护进程 PID
 *   data/watch.heartbeat   守护进程心跳（每轮 sync 前后刷新，看门狗据此判断存活）
 *   data/watch.disabled    主动停用标记（本脚本会清除它）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'watch-trigger.cjs');
const DATA = path.join(ROOT, 'data');
const PID = path.join(DATA, 'watch.pid');
const LOG = path.join(DATA, 'watch.log');
const HEARTBEAT = path.join(DATA, 'watch.heartbeat');
const DISABLED = path.join(DATA, 'watch.disabled');

function log(...m) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[start-watch ${t}]`, ...m);
}

/** 进程是否存活；EPERM 表示进程存在但当前用户无权限访问（仍算活着） */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

fs.mkdirSync(DATA, { recursive: true });

// 恢复自动运行：清掉「主动停用」标记
if (fs.existsSync(DISABLED)) {
  try { fs.unlinkSync(DISABLED); log('已清除 data/watch.disabled（恢复自动运行）'); } catch (_) { /* ignore */ }
}

// 已经在跑就别再启
if (fs.existsSync(PID)) {
  const old = Number(fs.readFileSync(PID, 'utf8').trim());
  if (isAlive(old)) {
    log(`守护进程已在运行 PID=${old}，跳过启动。如需重启先 npm run watch:stop`);
    process.exit(0);
  }
  log(`残留 PID=${old} 已失效，继续启动`);
  try { fs.unlinkSync(PID); } catch (_) { /* ignore */ }
}

// 旧心跳会让看门狗以为还有活的实例，先清掉
try { fs.unlinkSync(HEARTBEAT); } catch (_) { /* ignore */ }

const out = fs.openSync(LOG, 'a');
const err = fs.openSync(LOG, 'a');

const child = spawn(process.execPath, [ENTRY], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, err],
  windowsHide: true,
  env: process.env,
});
child.unref();

fs.writeFileSync(PID, String(child.pid));
log(`守护进程已后台启动 PID=${child.pid}`);
log(`日志: ${LOG}`);
log(`停止: npm run watch:stop`);
