#!/usr/bin/env node
/**
 * 深度回填抓取缓存（bin/backfill-cache.cjs）
 *
 * 为什么需要它：
 *   嵌入页 / HTTP 通道每个账号只能拿到最新 ~10 条。云端每 30 分钟跑一次 +
 *   缓存回写（见 .github/workflows/tiktok-sync.yml）能保证「视频一发布就进
 *   缓存」，但部署之前的老视频不在任何缓存里，必须用浏览器通道一次性翻深，
 *   作为种子提交进仓库，云端 checkout 后才补得上老行。
 *
 * 用法：
 *   node bin/backfill-cache.cjs                    # 回填表格里出现的全部账号
 *   node bin/backfill-cache.cjs foo bar            # 只回填指定账号
 *   node bin/backfill-cache.cjs --scroll 40        # 翻得更深（默认 25 次）
 *
 * 缓存写入是并集合并（按视频 ID 去重、本轮优先），跑多少次都只会变多不会丢。
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('../src/config.cjs');
const { launchBrowser, fetchAccountVideosBrowser } = require('../src/crawler.cjs');
const feishu = require('../src/feishu.cjs');

const args = process.argv.slice(2);
const scrollIdx = args.indexOf('--scroll');
const MAX_SCROLL = scrollIdx > -1 ? Number(args[scrollIdx + 1]) || 25 : 25;
const rest = args.filter((a, i) => a !== '--scroll' && args[i - 1] !== '--scroll');

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).videos || []; } catch { return []; }
}

/** 并集合并：按视频 ID 去重，fresh 优先（stats 更新过的版本胜出） */
function unionById(fresh, old) {
  const seen = new Set();
  const out = [];
  for (const v of [...(fresh || []), ...(old || [])]) {
    const id = String((v && v.id) || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(v);
  }
  return out;
}

/** 从表格账号格里抽出纯用户名：@foo / https://tiktok.com/@foo / foo 都能出 foo */
function extractHandle(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/@([A-Za-z0-9._]{2,})/);
  if (m) return m[1].toLowerCase();
  if (/^[A-Za-z0-9._]{2,}$/.test(s)) return s.toLowerCase();
  return null;
}

(async () => {
  const cfg = loadConfig();
  const cacheDir = path.join(ROOT, 'data/cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  // 账号来源：命令行参数 > 表格里出现的全部账号 > 现有缓存文件名
  let accounts = rest.map((a) => String(a).replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (!accounts.length) {
    try {
      const rows = await feishu.readRecords(cfg, ROOT);
      const set = new Set();
      rows.forEach((r) => { const h = extractHandle(r.account); if (h) set.add(h); });
      accounts = [...set];
    } catch (e) {
      console.log('读表格失败，改用缓存目录里的账号：', e.message);
    }
  }
  if (!accounts.length) {
    accounts = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  }
  if (!accounts.length) { console.log('没有可回填的账号'); return; }

  console.log(`回填账号 ${accounts.length} 个: ${accounts.join(', ')}`);
  console.log(`滚动深度 ${MAX_SCROLL} 次（按每批 ~12 条、日更 ~10 条估，约覆盖 ${Math.round((MAX_SCROLL * 12) / 10)} 天）`);

  const crawlCfg = { ...cfg, maxScroll: MAX_SCROLL, scrollDelayMs: 2200, firstWaitMs: 9000 };
  const browser = await launchBrowser(cfg);
  try {
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const cacheFile = path.join(cacheDir, `${acc}.json`);
      const old = readCache(cacheFile);
      console.log(`\n(${i + 1}/${accounts.length}) @${acc} 现有缓存 ${old.length} 条，深抓中…`);

      let { videos, degraded, error } = await fetchAccountVideosBrowser(browser, acc, crawlCfg);
      if (!videos.length) {
        console.log('  ↻ 抓到 0 条，10s 后重试一次');
        await new Promise((r) => setTimeout(r, 10000));
        ({ videos, degraded, error } = await fetchAccountVideosBrowser(browser, acc, crawlCfg));
      }

      const merged = unionById(videos, old);
      const byDay = {};
      merged.forEach((v) => { const d = v.createDate || '?'; byDay[d] = (byDay[d] || 0) + 1; });
      const days = Object.keys(byDay).sort();
      if (merged.length) {
        fs.writeFileSync(
          cacheFile,
          JSON.stringify({ username: acc, fetchedAt: new Date().toISOString(), videos: merged }, null, 2),
          'utf8'
        );
      }
      console.log(`  → 本轮抓到 ${videos.length} 条${degraded ? ' ⚠降级' : ''}，合并后 ${merged.length} 条（原 ${old.length}）`);
      if (error) console.log(`  err=${error}`);
      if (days.length) {
        console.log(`  → 覆盖 ${days.length} 天: ${days[0]} ~ ${days[days.length - 1]}`);
        console.log('  → 每日分布: ' + days.map((d) => `${d.slice(5)}:${byDay[d]}`).join('  '));
      }
    }
  } finally {
    await browser.close();
  }
  console.log('\n✓ 回填完成');
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });