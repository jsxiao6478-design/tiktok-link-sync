/**
 * TikTok 视频链接自动补全 —— 主流程
 *
 * 两种数据源:
 *   1) 飞书多维表格 (默认推荐)  node src/sync.cjs --source feishu
 *   2) 本地 CSV                node src/sync.cjs --input data/input.csv
 *
 * 处理: 抓取各账号近期视频 -> 按「标题相似度 + 发布日期」匹配 -> 回填链接
 *
 * 常用参数:
 *   --source feishu      数据源用飞书多维表格(config.json 里配好 base/table)
 *   --source csv         数据源用本地 CSV(默认)
 *   --dry-run            只计算不写回(飞书模式也不改表)
 *   --use-cache          复用 data/cache 里的抓取结果, 秒级完成
 *   --force              连已有链接的记录也重新校验
 *   --retry              重新尝试上次「未找到」的记录(默认视为终态)
 *   --account xxx        只处理某个账号(调试)
 *   --config xxx.json    指定配置文件
 */
const fs = require('fs');
const path = require('path');
const { readCsv, writeCsv } = require('./csv.cjs');
const { launchBrowser, fetchAccountVideos, resolveCrawlMode } = require('./crawler.cjs');
const { fetchVideoStatsHttp } = require('./tiktok-http.cjs');
const { matchRecords, normalizeAccount, parseDate } = require('./matcher.cjs');
const feishu = require('./feishu.cjs');
const { loadConfig } = require('./config.cjs');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        a[key] = next;
        i++;
      } else {
        a[key] = true;
      }
    }
  }
  return a;
}

function log(...m) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}]`, ...m);
}

/**
 * 清理本程序自己产生的临时文件。
 * `data/tmp-write-*.json` 是写飞书时用的中转文件，正常路径下用完就删；
 * 但进程被 kill 时（定时任务的子进程常被中断）会残留，久了会堆一堆。
 * 只删超过 1 小时的，避免误删正在被另一个实例使用的文件。
 */
function sweepTemp(dir) {
  const MAX_AGE_MS = 60 * 60 * 1000;
  try {
    const names = fs.readdirSync(dir);
    let n = 0;
    for (const name of names) {
      if (!/^tmp-write-.*\.json$/.test(name)) continue;
      const p = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(p);
          n += 1;
        }
      } catch (_) { /* 单个失败不影响其它 */ }
    }
    if (n) log(`清理了 ${n} 个超过 1 小时的临时写文件（data/tmp-write-*.json）`);
  } catch (_) { /* ignore */ }
}

/* ─────────────────── 防并发锁（PID 探测版） ───────────────────
 * 旧实现只按「锁文件 mtime 超过 10 分钟」判僵尸锁，有两个坑：
 *   1) 上次 sync 崩溃/被 kill 留下锁，守护进程要空转最多 10 分钟；
 *   2) 单次 sync 抓 2 个账号要 60~90s，正常持锁也会被误判的边界很窄。
 * 新实现：锁文件里写持有者 PID，抢锁时用 signal 0 探测该进程是否还活着。
 *   - PID 存活            → 真的在跑，本轮退出（除非超过 HARD_MAX 判定为假死）
 *   - PID 已死 / 无法解析  → 立刻接管，不再等待
 */

/** 锁持有者假死上限：超过这个时长即使 PID 还在也强制接管（防句柄泄漏型卡死） */
const LOCK_HARD_MAX_MS = 15 * 60 * 1000;
/** 无法解析出 PID 的历史锁（旧版本留下的空文件）的兜底等待时长 */
const LOCK_LEGACY_MAX_MS = 3 * 60 * 1000;

/** 进程是否存活；EPERM 表示进程存在但当前用户无权限访问 */
function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 读取锁文件里的持有者信息；解析不出 PID 时退化为按 mtime 判断（pid=0） */
function readLock(lockFile) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(lockFile).mtimeMs;
  } catch (_) {
    return null; // 锁文件已经不在了
  }
  let raw = '';
  try {
    raw = fs.readFileSync(lockFile, 'utf8').trim();
  } catch (_) { /* 读不到就当空 */ }
  if (raw) {
    try {
      const info = JSON.parse(raw);
      const pid = Number(info.pid);
      if (Number.isInteger(pid) && pid > 0) {
        return {
          pid,
          at: Number(info.at) || mtimeMs,
          source: String(info.source || ''),
          ppid: Number(info.ppid) || 0,
        };
      }
    } catch (_) { /* 半截写入，走 mtime 兜底 */ }
  }
  return { pid: 0, at: mtimeMs, source: raw.slice(0, 120) };
}

/** 判断锁是否已成僵尸，返回 { stale: boolean, reason: string } */
function inspectLock(lockFile) {
  if (!fs.existsSync(lockFile)) return { stale: true, reason: '无锁' };
  const info = readLock(lockFile);
  const ageMs = Date.now() - (info ? info.at : Date.now());

  if (!info || !info.pid) {
    const stale = ageMs > LOCK_LEGACY_MAX_MS;
    return {
      stale,
      reason: stale
        ? `旧格式锁且已存在 ${Math.round(ageMs / 1000)}s`
        : `旧格式锁，存在 ${Math.round(ageMs / 1000)}s`,
    };
  }
  if (!isPidAlive(info.pid)) {
    const who = `${info.source ? `，命令: ${info.source}` : ''}${info.ppid ? `，父进程: ${info.ppid}` : ''}`;
    return { stale: true, reason: `持有者 PID ${info.pid} 已不存在${who}` };
  }
  if (ageMs > LOCK_HARD_MAX_MS) {
    return { stale: true, reason: `PID ${info.pid} 存活但持锁 ${Math.round(ageMs / 60000)} 分钟（疑似假死）` };
  }
  return {
    stale: false,
    reason:
      `PID ${info.pid} 正在运行（${Math.round(ageMs / 1000)}s）` +
      `${info.ppid ? `，父进程: ${info.ppid}` : ''}` +
      `${info.source ? `，命令: ${info.source}` : ''}`,
  };
}

/** 抢锁；成功返回 fd，失败返回 null */
function acquireLock(lockFile) {
  const payload = () =>
    JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      at: Date.now(),
      source: process.argv.slice(2).join(' '),
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = inspectLock(lockFile);
    if (process.env.TTSYNC_DEBUG_LOCK) {
      console.log('[lock-debug]', JSON.stringify(state), 'exists=', fs.existsSync(lockFile));
    }
    if (!state.stale && attempt === 0) {
      log(`上一轮仍在运行，本轮跳过：${state.reason}`);
      return null;
    }
    if (state.stale && fs.existsSync(lockFile)) {
      log(`接管锁：${state.reason}`);
      try {
        fs.unlinkSync(lockFile);
      } catch (e) {
        // Windows 上旧进程句柄未释放时会删不掉（EPERM/EBUSY，偶尔 code 为空），
        // 此时持有者已确认死亡，直接覆写内容即可
        log(`旧锁文件删除失败(${e.code || e.message})，改为原地覆写`);
        try {
          const fd = fs.openSync(lockFile, 'w');
          fs.writeSync(fd, payload());
          return fd;
        } catch (e2) {
          log(`原地覆写也失败(${e2.code})`);
        }
      }
    }
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, payload());
      return fd;
    } catch (e) {
      if (e && e.code === 'EEXIST') continue; // 竞态：别人抢先建了，再看一次
      throw e;
    }
  }
  return null;
}

/** 匹配状态 → 飞书「状态」单选项 */
function mapStatus(status) {
  if (status === '已匹配') return '已补全';
  if (status === '未找到') return '未找到';
  return '需人工确认'; // 待复核 / 低置信 / 日期兜底(请确认)
}

/** 该匹配结果是否足够可信, 可以直接把链接写进表里 */
function linkTrustworthy(status) {
  return status === '已匹配' || status === '待复核' || status === '日期兜底(请确认)';
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args.config);
  const source = String(args.source || (args.input ? 'csv' : 'feishu')).toLowerCase();

  // 防并发锁：守护进程和 automation 都会调 sync.cjs，加锁避免互相踩
  const lockFile = path.join(ROOT, 'data', 'sync.lock');
  let lockFd = null;
  const noLock = !!args['no-lock'];
  if (!noLock) {
    lockFd = acquireLock(lockFile);
    if (lockFd === null) return; // 已有活着的实例在跑
    sweepTemp(path.join(ROOT, 'data'));
  }
  /** 释放锁（幂等，可被 signal 处理器和 finally 重复调用） */
  const releaseLock = () => {
    if (lockFd === null) return;
    try { fs.closeSync(lockFd); } catch (_) { /* ignore */ }
    lockFd = null;
    try { fs.unlinkSync(lockFile); } catch (_) { /* ignore */ }
  };
  // 被 kill / Ctrl+C 时也要清锁，否则会留下僵尸锁拖住守护进程
  const onSignal = (sig) => {
    log(`收到 ${sig}，清理锁并退出`);
    releaseLock();
    process.exit(0);
  };
  if (!noLock) {
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }
  try {
    if (source === 'feishu') return await runFeishu(args, config);
    if (source === 'csv') return await runCsv(args, config);
    console.error(`✗ 未知数据源: ${source}（可选 csv / feishu）`);
    process.exit(1);
  } finally {
    releaseLock();
  }
}

/* ───────────────────────── 通用: 抓取 ───────────────────────── */

/**
 * 按账号抓取视频；命中缓存则直接读。
 * @returns {Promise<object>} { videosByAccount, cacheDir }
 */
async function crawlAccounts(accounts, config, args) {
  const cacheDir = path.resolve(ROOT, 'data/cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const videosByAccount = {};
  /** 本轮完全没抓到视频的账号（限流/降级）：这些账号的行不做任何写入，避免误改 */
  const degradedAccounts = new Set();
  const cacheFileOf = (acc) => path.join(cacheDir, `${acc}.json`);
  const useCache = !!args['use-cache'];
  const needFetch = accounts.some((acc) => !(useCache && fs.existsSync(cacheFileOf(acc))));

  let browser = null;
  const crawlMode = resolveCrawlMode(config);
  if (needFetch && crawlMode !== 'http') browser = await launchBrowser(config);
  else if (crawlMode === 'http') log('抓取通道：纯 HTTP（嵌入页 + 视频页），不启动浏览器');
  else log('全部账号命中本地缓存，跳过浏览器启动');

  try {
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const cacheFile = cacheFileOf(acc);

      if (useCache && fs.existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          videosByAccount[acc] = cached.videos || [];
          log(
            `(${i + 1}/${accounts.length}) @${acc} → 本地缓存 ${videosByAccount[acc].length} 条 (抓取于 ${cached.fetchedAt})`
          );
          continue;
        } catch {
          /* 缓存损坏则回退到实时抓取 */
        }
      }

      log(`(${i + 1}/${accounts.length}) 抓取 @${acc} ...`);
      try {
        let { videos, degraded, error } = await fetchAccountVideos(browser, acc, config);

        // TikTok 偶尔会返回空 itemList（限流/风控）。空结果会让这一轮完全刷不到
        // 这个账号的数据，所以隔一会儿重试一次 —— 实测能救回大部分情况。
        if (!videos.length && accounts.length <= 5) {
          log('    ↻ 抓到 0 条（疑似限流），10s 后重试一次');
          await new Promise((r) => setTimeout(r, 10000));
          const again = await fetchAccountVideos(browser, acc, config);
          if (again.videos.length) {
            ({ videos, degraded, error } = again);
            log('    ✓ 重试成功');
          } else {
            log('    ✗ 重试仍为 0 条');
          }
        }
        videosByAccount[acc] = videos;
        if (!videos.length) degradedAccounts.add(acc); // 抓不到 = 没有信息，别拿它去改表

        // 缓存只在「抓到了、且不比上一份少」时覆盖：
        // TikTok 限流/降级时可能返回 0~个位数条，若直接覆盖会把可用的旧缓存冲掉。
        let prevCount = 0;
        try {
          prevCount = (JSON.parse(fs.readFileSync(cacheFile, 'utf8')).videos || []).length;
        } catch (_) { /* ignore */ }
        if (videos.length > 0 && !degraded && videos.length >= prevCount) {
          fs.writeFileSync(
            cacheFile,
            JSON.stringify({ username: acc, fetchedAt: new Date().toISOString(), videos }, null, 2),
            'utf8'
          );
          log(`    → 获得 ${videos.length} 条视频（已更新缓存）`);
        } else {
          log(
            `    → 获得 ${videos.length} 条视频，保留旧缓存 ${prevCount} 条不覆盖` +
              (degraded ? ' ⚠降级(可能是风控/无公开视频)' : '')
          );
        }
        if (error) log(`    err=${error}`);
      } catch (e) {
        log(`    ✗ 失败: ${e.message}`);
        videosByAccount[acc] = [];
      }
      if (i < accounts.length - 1) await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { videosByAccount, cacheDir, degradedAccounts };
}

/** 调 matchRecords，返回与入参等长的结果数组 */
function runMatch(list, videosByAccount, config) {
  return matchRecords(
    list.map((r) => ({ account: r.account, title: r.title, date: r.date })),
    videosByAccount,
    { threshold: config.matchThreshold }
  );
}

function summarize(results) {
  let ok = 0;
  let review = 0;
  let fail = 0;
  for (const m of results) {
    if (m.status === '已匹配') ok++;
    else if (m.status === '未找到') fail++;
    else review++;
  }
  return { ok, review, fail };
}

/* ───────────────────────── 模式 A: CSV ───────────────────────── */

async function runCsv(args, config) {
  const COL = config.columns;
  const inputPath = path.resolve(ROOT, args.input || 'data/input.csv');
  const outputPath = path.resolve(ROOT, args.output || 'data/output.csv');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (!fs.existsSync(inputPath)) {
    console.error(`✗ 找不到输入文件: ${inputPath}`);
    process.exit(1);
  }

  const { headers, records } = readCsv(inputPath);
  log(`读取输入: ${path.basename(inputPath)}  共 ${records.length} 条记录`);

  if (!headers.includes(COL.title)) {
    console.error(`✗ 输入表缺少「${COL.title}」列。当前列: ${headers.join(' / ')}`);
    process.exit(1);
  }

  const force = !!args.force;
  const onlyAccount = args.account ? normalizeAccount(args.account) : null;

  const pending = records.filter((r) => {
    if (!COL.account || !headers.includes(COL.account)) return true;
    if (!String(r[COL.account] || '').trim()) return false;
    if (onlyAccount && normalizeAccount(r[COL.account]) !== onlyAccount) return false;
    if (force) return true;
    return !String(r[COL.link] || '').includes('/video/');
  });

  log(`待补链接: ${pending.length} 条  |  已有链接跳过: ${records.length - pending.length} 条`);

  if (!pending.length) {
    log('没有需要处理的记录，直接输出原表。');
    writeCsv(outputPath, headers, records);
    return;
  }

  const accounts = [...new Set(pending.map((r) => normalizeAccount(r[COL.account])))].filter(Boolean);
  log(`涉及账号 ${accounts.length} 个: ${accounts.join(', ')}`);

  const { videosByAccount, cacheDir, degradedAccounts } = await crawlAccounts(accounts, config, args);

  const results = runMatch(
    pending.map((r) => ({
      account: normalizeAccount(r[COL.account]),
      title: r[COL.title],
      date: parseDate(r[COL.date]) || r[COL.date],
    })),
    videosByAccount,
    config
  );

  const outHeaders = [...headers];
  for (const c of [COL.link, '匹配标题', '匹配日期', '置信度', '状态', '提示']) {
    if (!outHeaders.includes(c)) outHeaders.push(c);
  }

  const outRecords = records.map((r) => {
    const idx = pending.indexOf(r);
    if (idx < 0) {
      const copy = { ...r };
      if (String(r[COL.link] || '').includes('/video/')) copy['状态'] = copy['状态'] || '原有链接';
      return copy;
    }
    const m = results[idx];
    const copy = { ...r };
    copy[COL.link] = linkTrustworthy(m.status) ? m.link || '' : '';
    copy['匹配标题'] = m.matchedTitle || '';
    copy['匹配日期'] = m.matchedDate || '';
    copy['置信度'] = m.confidence ? Number(m.confidence).toFixed(2) : '';
    copy['状态'] = m.status;
    copy['提示'] = m.hint || (m.link && !linkTrustworthy(m.status) ? `低置信候选(未写入): ${m.link}` : '');
    return copy;
  });

  writeCsv(outputPath, outHeaders, outRecords);

  const { ok, review, fail } = summarize(results);
  log('──────────────────────────────');
  log(`✓ 成功匹配 ${ok} 条`);
  log(`⚠ 需人工复核 ${review} 条`);
  log(`✗ 未找到 ${fail} 条`);
  log(`输出文件: ${outputPath}`);
  log(`原始抓取缓存: ${cacheDir}`);
  if (fail) log('未找到的常见原因: 标题与视频描述差异过大 / 视频发布时间不在抓取范围内 / 账号名不匹配');
}

/* ───────────────────────── 模式 B: 飞书多维表格 ───────────────────────── */

async function runFeishu(args, config) {
  const F = feishu.feishuConfig(config);
  const FC = F.fields;
  const dryRun = !!args['dry-run'];
  /** 只刷 stats 模式：处理所有「已补全 / 需人工确认」的有链接行，**不重写 link/status/trigger** */
  const refreshStats = !!args['refresh-stats'];

  // ── stats 刷新的「最小间隔」闸门 ──
  // 本地守护进程（每 30 轮）和云端定时任务（每 30 分钟）都会调本模式，
  // 如果两边同时生效就会变成每 15 分钟抓一次，容易把 TikTok 抓出限流。
  // 所以这里用 data/stats-refresh.json 记录上次成功刷新的时间，间隔不够就跳过。
  const STATS_STATE = path.join(ROOT, 'data', 'stats-refresh.json');
  const statsMinMs =
    Math.max(0, Number(args['min-interval-min'] ?? config.statsMinIntervalMin ?? 25)) * 60 * 1000;
  if (refreshStats && !args.force && statsMinMs > 0) {
    let lastAt = 0;
    try {
      lastAt = Number(JSON.parse(fs.readFileSync(STATS_STATE, 'utf8')).at) || 0;
    } catch (_) { /* 首次运行没有状态文件 */ }
    const ageMs = Date.now() - lastAt;
    if (lastAt && ageMs < statsMinMs) {
      log(`距上次 stats 刷新仅 ${Math.round(ageMs / 60000)} 分钟（阈值 ${Math.round(statsMinMs / 60000)} 分钟），本轮跳过`);
      return;
    }
  }

  log(`读取飞书表格: ${F.url || F.baseToken}  [后端 ${feishu.backendName(config)}]`);
  const all = await feishu.readRecords(config, ROOT);
  log(`表中记录: ${all.length} 条${refreshStats ? '（仅刷 stats 模式）' : ''}`);

  const onlyAccount = args.account ? normalizeAccount(args.account) : null;
  const force = !!args.force;
  const retry = !!args.retry;

  // 「同步触发」字段以 TRIGGER 开头的行视为按钮触发：无论当前状态都强制重跑
  const triggerIds = new Set(
    all.filter((r) => /^TRIGGER/i.test(r.trigger || '')).map((r) => r.recordId)
  );

  if (triggerIds.size) log(`按钮触发: ${triggerIds.size} 条（来自「同步触发」字段）`);

  const pending = all.filter((r) => {
    if (!r.account || !r.title) return false;
    if (onlyAccount && normalizeAccount(r.account) !== onlyAccount) return false;

    if (refreshStats) {
      // stats 刷新模式：只处理「已有 video 链接」的行（已补全 / 需人工确认）。
      // 两点刻意的取舍：
      //   1) 没有 link 的行（待补全 / 未找到）留给普通 sync，本模式不代劳；
      //   2) 按钮触发的行（TRIGGER）跳过 —— 否则会被本模式「吃掉」却不写链接，
      //      导致按钮点下去还要再等一轮才生效。交给普通 sync 全量处理。
      if (triggerIds.has(r.recordId)) return false;
      return /\/video\//.test(r.link);
    }

    if (force) return true;
    if (triggerIds.has(r.recordId)) return true; // 按钮强制要求重试
    if (/\/video\//.test(r.link)) return false; // 已有链接
    // 终态：已补全 / 需人工确认（带链接）默认不重跑，避免半小时一次的死循环
    if (r.status === '已补全') return false;
    if (r.status === '需人工确认') return false;
    // 未找到 默认视为终态；加 --retry 才重新尝试（适合视频索引延迟的情况）
    if (r.status === '未找到' && !retry) return false;
    return true;
  });

  log(
    refreshStats
      ? `待刷 stats: ${pending.length} 条  |  跳过: ${all.length - pending.length} 条`
      : `待补链接: ${pending.length} 条  |  跳过: ${all.length - pending.length} 条`
  );

  if (!pending.length) {
    log(refreshStats ? '没有可刷新的记录（都没有视频链接）。' : '没有需要处理的记录，表格未做任何改动。');
    return;
  }

  const cacheDir = path.resolve(ROOT, 'data/cache');
  let videosByAccount = {};
  let degradedAccounts = new Set();

  if (refreshStats) {
    // stats 刷新不再抓账号列表：嵌入页只覆盖「最近 10 条」，
    // 表格覆盖 3 天（每账号最多 30+ 条），靠账号级抓取永远刷不满。
    // 改为按每行链接里的视频 ID 直连视频页 SSR（fetchVideoStatsHttp），
    // 逐行精确刷新，覆盖所有已有链接的行，包括最早的。
    const accounts = [...new Set(pending.map((r) => normalizeAccount(r.account)))].filter(Boolean);
    log(`涉及账号 ${accounts.length} 个（stats 模式：按视频 ID 逐行直连视频页，不抓账号列表）`);
  } else {
    const accounts = [...new Set(pending.map((r) => normalizeAccount(r.account)))].filter(Boolean);
    log(`涉及账号 ${accounts.length} 个: ${accounts.join(', ')}`);
    ({ videosByAccount, degradedAccounts } = await crawlAccounts(accounts, config, args));
  }

  // 组装写回内容
  const updates = [];
  const auditRows = [];
  let results = [];

  if (refreshStats) {
    // ── stats 刷新：按「行里已有链接的视频 ID」直接访问视频页 SSR ──
    // 刻意不用标题模糊匹配：文案相近 / 二次发布时标题匹配可能把 A 视频的
    // 播放量写到 B 行上；video ID 唯一，不存在歧义。
    // 也不依赖账号级抓取（嵌入页只有最近 10 条，更早的行永远刷不到）。
    const delay = Math.max(0, Number(config.httpDelayMs ?? 400));
    let hit = 0;
    const miss = [];
    for (let i = 0; i < pending.length; i++) {
      const rec = pending[i];
      const id = (String(rec.link || '').match(/\/video\/([0-9]{10,25})/) || [])[1];
      const uname = normalizeAccount(rec.account);
      let playsNum = NaN;
      let likesNum = NaN;

      if (id && uname) {
        try {
          const d = await fetchVideoStatsHttp(uname, id, config);
          if (typeof d.plays === 'number') playsNum = d.plays;
          if (typeof d.likes === 'number') likesNum = d.likes;
        } catch (e) {
          miss.push(`@${uname}/${id}: ${e.message}`);
        }
      }

      // 只刷 stats：不动 link / 状态 / 匹配标题 / 置信度 / TRIGGER
      const fields = {};
      if (Number.isFinite(playsNum) && playsNum >= 0) fields[FC.plays] = playsNum;
      if (Number.isFinite(likesNum) && likesNum >= 0) fields[FC.likes] = likesNum;
      if (Object.keys(fields).length) {
        hit++;
        updates.push({ recordId: rec.recordId, fields });
      }

      auditRows.push({
        [FC.account]: rec.account,
        [FC.title]: rec.title,
        [FC.date]: rec.date,
        [FC.link]: rec.link || '',
        视频ID: id || '',
        播放量: Number.isFinite(playsNum) ? playsNum : '',
        点赞数: Number.isFinite(likesNum) ? likesNum : '',
      });

      if ((i + 1) % 10 === 0) log(`  …已处理 ${i + 1}/${pending.length} 行（命中 ${hit}）`);
      if (i < pending.length - 1 && delay) await new Promise((r) => setTimeout(r, delay));
    }
    log(`直连命中 ${hit}/${pending.length} 条（未命中的行保持原值，不会被清空）`);
    if (miss.length) {
      log(`  ✗ ${miss.length} 条抓取失败（视频已删/链接错/风控）:`);
      for (const m of miss.slice(0, 5)) log(`    - ${m}`);
      if (miss.length > 5) log(`    …及其余 ${miss.length - 5} 条`);
    }
  } else {
    results = runMatch(
      pending.map((r) => ({
        account: normalizeAccount(r.account),
        title: r.title,
        date: parseDate(r.date) || r.date,
      })),
      videosByAccount,
      config
    );
  }

  pending.forEach((rec, i) => {
    if (refreshStats) return; // 已在上面按视频 ID 处理完毕
    const m = results[i];
    const fields = {};

    // 该账号本轮完全没抓到视频（限流/风控降级）——此时「未找到」不代表真的没有，
    // 所以这一行不做任何写入：既不会把已补全的行降级成「未找到」，
    // 也不会清掉「同步触发」标记（保留它，下一轮会自动重试）。
    if (degradedAccounts.has(normalizeAccount(rec.account))) {
      log(`  ⏭ 跳过（@${normalizeAccount(rec.account)} 本轮抓取降级）：${String(rec.title).slice(0, 30)}`);
      return;
    }

    const keep = linkTrustworthy(m.status);

    if (keep && m.link) fields[FC.link] = m.link;
    fields[FC.status] = [mapStatus(m.status)];
    if (m.matchedTitle) fields[FC.matchedTitle] = m.matchedTitle;

    // 播放量 / 点赞数：仅在拿到有效数字时写入（来源是 TikTok 主页嵌入的 stats）
    const playsNum = Number(m.plays);
    const likesNum = Number(m.likes);
    if (Number.isFinite(playsNum) && playsNum >= 0) fields[FC.plays] = playsNum;
    if (Number.isFinite(likesNum) && likesNum >= 0) fields[FC.likes] = likesNum;

    const notes = [];
    if (m.status === '已匹配') notes.push(`置信度 ${Number(m.confidence).toFixed(2)}`);
    else if (m.hint) notes.push(m.hint);
    if (m.confidence && m.status !== '已匹配') notes.push(`置信度 ${Number(m.confidence).toFixed(2)}`);
    if (m.link && !keep) notes.push(`低置信候选(未写入): ${m.link}`);
    if (notes.length) fields[FC.hint] = notes.join('；');

    // 按钮触发的行：处理完立即清掉 TRIGGER 标记，避免下次重复
    if (/^TRIGGER/i.test(rec.trigger || '')) {
      fields[FC.trigger] = '';
    }

    updates.push({ recordId: rec.recordId, fields });

    auditRows.push({
      [FC.account]: rec.account,
      [FC.title]: rec.title,
      [FC.date]: rec.date,
      [FC.link]: keep ? m.link || '' : '',
      匹配标题: m.matchedTitle || '',
      置信度: m.confidence ? Number(m.confidence).toFixed(2) : '',
      状态: mapStatus(m.status),
      提示: fields[FC.hint] || '',
    });
  });

  const { ok, review, fail } = refreshStats ? { ok: 0, review: 0, fail: 0 } : summarize(results);

  if (dryRun) {
    log('--dry-run 模式：不写回飞书表格。以下是预览：');
    for (const row of auditRows) {
      if (refreshStats) {
        log(`  ${row[FC.account]} | ${String(row[FC.title]).slice(0, 40)} | plays=${row.播放量} | likes=${row.点赞数}`);
      } else {
        log(`  ${row[FC.account]} | ${String(row[FC.title]).slice(0, 40)} | ${row.状态} | ${row[FC.link] || '(未写入链接)'}`);
      }
    }
  } else if (refreshStats && !updates.length) {
    log('没有可写入的 stats（抓取结果为 0 条或全部未命中），本次不调用飞书写接口。');
  } else {
    const n = await feishu.updateRecords(config, updates, ROOT, { verbose: true });
    log(`✓ 已回填飞书表格 ${n} 条记录${refreshStats ? '（仅播放量/点赞数）' : ''}`);
  }

  // 本地留一份审计快照
  const auditPath = path.resolve(ROOT, `data/feishu-run-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);
  const auditHeaders = refreshStats
    ? [FC.account, FC.title, FC.date, FC.link, '视频ID', '播放量', '点赞数']
    : [FC.account, FC.title, FC.date, FC.link, '匹配标题', '置信度', '状态', '提示'];
  writeCsv(auditPath, auditHeaders, auditRows);

  log('──────────────────────────────');
  if (refreshStats) {
    log(`✓ 已刷新播放量/点赞数 ${updates.length}/${pending.length} 条`);
    const missRate = pending.length ? 1 - updates.length / pending.length : 0;
    if (missRate > 0.5) {
      log(`⚠ 命中率偏低（${Math.round(missRate * 100)}% 未命中）：通常是 TikTok 限流/降级抓取。`);
      log('  未命中的行保持原值不变（不会被清零），等下一轮再刷即可。');
    }
    // 记录本次成功刷新时间，供「最小间隔」闸门使用（只在真写入了才记）
    if (!dryRun && updates.length) {
      try {
        fs.writeFileSync(
          STATS_STATE,
          JSON.stringify({ at: Date.now(), hit: updates.length, total: pending.length }),
          'utf8'
        );
      } catch (_) { /* ignore */ }
    }
  } else {
    log(`✓ 已补全 ${ok} 条`);
    log(`⚠ 需人工确认 ${review} 条`);
    log(`✗ 未找到 ${fail} 条`);
  }
  log(`本地审计快照: ${auditPath}`);
  log(`原始抓取缓存: ${cacheDir}`);
  log(`表格地址: ${F.url || `https://feishu.cn/base/${F.baseToken}`}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
