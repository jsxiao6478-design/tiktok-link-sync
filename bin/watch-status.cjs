/**
 * watch-status.cjs —— 一键自检：全自动链路现在到底通不通
 *
 * 用法: npm run watch:status
 *
 * 检查项：
 *   1) 守护进程是否在跑（心跳文件 + PID 存活 双重判断）
 *   2) 上一轮同步是什么时候、成功没有
 *   3) 有没有残留的僵尸锁
 *   4) 是否被主动停用（data/watch.disabled）
 *   5) 播放量/点赞数上次刷新时间与命中数
 *   6) 开机自启脚本是否已装进「启动」文件夹
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const HEARTBEAT = path.join(DATA, 'watch.heartbeat');
const PIDFILE = path.join(DATA, 'watch.pid');
const EPOCH = path.join(DATA, 'watch.epoch');
const LOCK = path.join(DATA, 'sync.lock');
const LOG = path.join(DATA, 'watch.log');
const DISABLED = path.join(DATA, 'watch.disabled');

const HEARTBEAT_STALE_SEC = 180;
const AUTOSTART = path.join(
  os.homedir(),
  'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/tiktok-sync-autostart.bat'
);

const OK = '[OK]  ';
const WARN = '[注意]';
const BAD = '[异常]';

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

let problems = 0;
function line(flag, text) {
  if (flag === BAD) problems += 1;
  console.log(`${flag} ${text}`);
}

console.log('=== TikTok 链接同步 · 自动运行自检 ===');
console.log(`项目目录: ${ROOT}`);
console.log('');

// 1) 是否被主动停用
if (fs.existsSync(DISABLED)) {
  line(WARN, `存在 data/watch.disabled —— 你手动停用过自动运行。恢复请跑: npm run watch:start`);
} else {
  line(OK, '未处于「主动停用」状态');
}

// 2) 守护进程心跳
const hb = readJson(HEARTBEAT);
if (!hb) {
  line(BAD, '找不到心跳文件（data/watch.heartbeat）—— 守护进程没在跑。启动: npm run watch:start');
} else {
  const ageSec = Math.round((Date.now() - hb.at) / 1000);
  if (ageSec <= HEARTBEAT_STALE_SEC) {
    line(OK, `守护进程心跳正常：PID=${hb.pid}，${ageSec}s 前刚报活（已完成第 ${hb.round} 轮）`);
  } else {
    line(BAD, `心跳已 ${ageSec}s 未更新（阈值 ${HEARTBEAT_STALE_SEC}s）—— 守护进程疑似已死。启动: npm run watch:start`);
  }
}

// 3) PID 文件
if (!fs.existsSync(PIDFILE)) {
  line(WARN, '没有 data/watch.pid');
} else {
  const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
  if (isPidAlive(pid)) line(OK, `watch.pid=${pid} 进程存活`);
  else line(WARN, `watch.pid=${pid} 是失效残留（重启守护进程会自动清理）`);
}

// 4) 僵尸锁
if (fs.existsSync(LOCK)) {
  const lock = readJson(LOCK);
  const ageSec = Math.round((Date.now() - fs.statSync(LOCK).mtimeMs) / 1000);
  if (lock && lock.pid && !isPidAlive(lock.pid)) {
    line(WARN, `有僵尸锁（持有者 PID ${lock.pid} 已死，已存在 ${ageSec}s）—— 下一轮同步会自动接管，无需人工处理`);
  } else {
    line(OK, `当前有一轮同步正在跑（PID ${(lock && lock.pid) || '?'}，已 ${ageSec}s）`);
  }
} else {
  line(OK, '没有残留的 sync.lock');
}

// 5) 最近一轮同步时间
if (fs.existsSync(LOG)) {
  const lines = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/);
  const last = lines[lines.length - 1] || '';
  const m = last.match(/^\[([0-9:]+)\]/);
  if (m) line(OK, `日志最后一行时间 ${m[1]}：${last.replace(/^\[[^\]]*\]\s*/, '').slice(0, 80)}`);
  const takeover = lines.filter((l) => l.includes('接管锁')).length;
  if (takeover > 0) line(OK, `历史上一共自愈接管僵尸锁 ${takeover} 次（说明锁机制在工作）`);
} else {
  line(WARN, '还没有 data/watch.log');
}

// 6) 播放量/点赞数刷新状态
const STATS_STATE = path.join(DATA, 'stats-refresh.json');
const st = readJson(STATS_STATE);
if (!st || !st.at) {
  line(WARN, '还没跑过 stats 刷新（data/stats-refresh.json 不存在）—— 守护进程跑到第 30 轮时会自动刷，也可手动: node src/sync.cjs --source feishu --refresh-stats');
} else {
  const min = Math.round((Date.now() - st.at) / 60000);
  const flag = min <= 45 ? OK : WARN;
  line(
    flag,
    `播放量/点赞数上次刷新：${fmtTime(st.at)}（${min} 分钟前，命中 ${st.hit}/${st.total} 条）`
  );
}

// 7) 开机自启
if (fs.existsSync(AUTOSTART)) {
  line(OK, '开机自启脚本已安装（启动文件夹）');
} else {
  line(WARN, `开机自启未安装。安装方法：把 bin/autostart.bat 复制到 ${path.dirname(AUTOSTART)}`);
}

console.log('');
console.log(problems === 0 ? '结论：自动运行链路正常。' : `结论：发现 ${problems} 处异常，按上面的提示处理。`);
process.exit(0);
