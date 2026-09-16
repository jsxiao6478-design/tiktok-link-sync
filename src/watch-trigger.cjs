/**
 * watch-trigger.cjs —— 「立即同步」守护进程
 *
 * 飞书 RRULE 最密只能设到 5 分钟（DAILY + 12 个 BYMINUTE 拼出），
 * 为了让用户在表里点按钮后能在 ~60 秒内拿到结果，
 * 单独跑一个本地守护进程，每 60 秒调一次 sync.cjs。
 *
 * sync.cjs 现在已经能识别「同步触发」字段以 TRIGGER 开头的行并强制重跑，
 * 所以这里只需要保证它常驻运行。
 *
 * 用法:
 *   node src/watch-trigger.cjs                每 60 秒跑一次
 *   node src/watch-trigger.cjs --interval 30  自定义间隔（秒）
 *
 * 配套启停脚本:
 *   npm run watch:start   后台启动
 *   npm run watch:stop    结束后台进程
 *   npm run sync:once     跑一次 sync.cjs（不守护）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SYNC_CJS = path.join(__dirname, 'sync.cjs');
const DATA = path.join(ROOT, 'data');
const HEARTBEAT = path.join(DATA, 'watch.heartbeat');
const PIDFILE = path.join(DATA, 'watch.pid');
const EPOCH = path.join(DATA, 'watch.epoch');

/** 本进程的世代号；写进 data/watch.epoch，用来让旧一代守护进程自动退休 */
const MY_EPOCH = `${Date.now()}-${process.pid}`;

/**
 * 心跳文件：每轮 sync 前后各写一次。
 * 看门狗（bin/watchdog.vbs）靠它的 mtime 判断守护进程是否还活着 ——
 * 比「探测 PID」更可靠：进程卡死（PID 还在但不再干活）也能被发现。
 */
let round = 0;
function beat() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(HEARTBEAT, JSON.stringify({ pid: process.pid, round, at: Date.now() }));
  } catch (_) { /* 心跳失败不影响主流程 */ }
}

/** 心跳是不是本进程写的（避免退出时误删新一代守护进程的心跳） */
function heartbeatIsMine() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')).pid === process.pid;
  } catch (_) {
    return false;
  }
}

/**
 * 登记自己：写 PID + 抢占世代号。
 * 世代号机制解决的问题：旧守护进程可能因为 PID 丢失而无法被定位/结束，
 * 只要新一代起来并改写 watch.epoch，旧一代在下一轮就会读到不同的世代号并自行退出。
 */
function registerSelf() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(PIDFILE, String(process.pid));
    fs.writeFileSync(EPOCH, MY_EPOCH);
  } catch (_) { /* 写不了也不致命 */ }
}

/** 自己是否仍是当前世代（被新启动的守护进程取代则返回 false） */
function isCurrentEpoch() {
  try {
    return fs.readFileSync(EPOCH, 'utf8').trim() === MY_EPOCH;
  } catch (_) {
    return true; // 读不到就当自己还是有效的，避免误退
  }
}

/** 退出前的收尾：只清理属于自己的痕迹 */
function cleanupSelf() {
  if (heartbeatIsMine()) {
    try { fs.unlinkSync(HEARTBEAT); } catch (_) { /* ignore */ }
  }
  try {
    if (Number(fs.readFileSync(PIDFILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PIDFILE);
  } catch (_) { /* ignore */ }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        a[key] = next;
        i += 1;
      } else {
        a[key] = true;
      }
    }
  }
  return a;
}

function log(...m) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[watch ${t}]`, ...m);
}

/**
 * 每 N 轮额外跑一次「只刷 stats」（默认 30 轮 ≈ 30 分钟）。
 * 这是「无人值守」的本地兜底：即使不依赖任何云端定时任务，
 * 只要守护进程在跑，播放量/点赞数也会自动保持更新。
 */
let statsEvery = 30;

/**
 * 跑一轮 sync.cjs。
 * sync.cjs 自己有文件锁（sync.lock），所以多个 caller 并发也会被它自己互斥。
 * 这里只负责 spawn + 计时 + 日志。
 */
function tick() {
  return new Promise((resolve) => {
    const start = Date.now();
    round += 1;
    beat(); // 开跑前先报活，避免长轮次被误判为卡死
    const doStats = statsEvery > 0 && round % statsEvery === 0;
    const argv = [SYNC_CJS, '--source', 'feishu'];
    if (doStats) argv.push('--refresh-stats');
    log(`第 ${round} 轮${doStats ? '（stats 刷新轮）' : ''} 开始`);
    const child = spawn(process.execPath, argv, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
    child.on('exit', (code) => {
      log(`本轮结束 code=${code} 耗时 ${Math.round((Date.now() - start) / 1000)}s`);
      beat();
      resolve();
    });
    child.on('error', (e) => {
      log('子进程错误: ' + e.message);
      beat();
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const interval = Math.max(5, Number(args.interval || process.env.WATCH_INTERVAL_SEC || 60));
  statsEvery = Number(args['stats-every'] || process.env.STATS_EVERY_ROUNDS || 30);

  registerSelf();
  log(
    `守护进程已启动 PID=${process.pid}，每 ${interval}s 跑一次 sync.cjs` +
      `（每 ${statsEvery} 轮≈${Math.round((interval * statsEvery) / 60)} 分钟刷一次播放量/点赞数，Ctrl+C 退出）`
  );
  beat();

  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${sig}，退出…`);
    // 主动退出时抹掉自己的心跳，看门狗看到「无心跳」会按需拉起；
    // 但如果是用户主动 stop（data/watch.disabled 存在），看门狗会尊重该标记不再拉起。
    cleanupSelf();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    await tick();
    if (stopping) break;
    if (!isCurrentEpoch()) {
      log('检测到新一代守护进程已接管（watch.epoch 已变更），本进程自动退休');
      cleanupSelf();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});