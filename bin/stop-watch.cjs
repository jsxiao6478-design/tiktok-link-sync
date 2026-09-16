/**
 * stop-watch.cjs —— 结束 start-watch 启动的 watch-trigger 守护进程
 *
 * 会写一个 data/watch.disabled 标记：看门狗（bin/watchdog.vbs）看到它就
 * 不再把守护进程拉起来。想恢复自动运行，跑 npm run watch:start 即可（会清掉标记）。
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const PID = path.join(DATA, 'watch.pid');
const HEARTBEAT = path.join(DATA, 'watch.heartbeat');
const DISABLED = path.join(DATA, 'watch.disabled');

fs.mkdirSync(DATA, { recursive: true });
// 先立标记再杀进程，避免看门狗在这中间把进程拉回来
fs.writeFileSync(DISABLED, new Date().toISOString());
console.log('已写入 data/watch.disabled（看门狗不会再自动拉起）');

if (fs.existsSync(PID)) {
  const pid = Number(fs.readFileSync(PID, 'utf8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`已发送 SIGTERM → PID=${pid}`);
  } catch (e) {
    console.log(`结束 PID=${pid} 失败: ${e.message}`);
  }
  try { fs.unlinkSync(PID); } catch (_) { /* ignore */ }
} else {
  console.log('未找到 watch.pid，守护进程可能未启动。');
}

// 抹掉心跳：否则看门狗在这 30 秒窗口里仍可能判定「存活」而漏掉停用态
try { fs.unlinkSync(HEARTBEAT); } catch (_) { /* ignore */ }
