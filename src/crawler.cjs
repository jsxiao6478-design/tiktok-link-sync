/**
 * TikTok 抓取引擎
 *
 * 两条通道，按环境自动选择：
 *
 *   browser —— 打开主页，拦截 TikTok 自己发的 /api/post/item_list/ 响应。
 *              数据最全（能翻到几十条历史），但依赖出口 IP 不被降级。
 *              中国大陆需要代理；GitHub 机房 IP 会被稳定降级，云端不可用。
 *
 *   http    —— 纯 HTTP 走官方 SSR：嵌入页拿最近 10 条，再逐个视频页补
 *              发布时间与点赞数。不吃 IP 信誉，云端默认走这条。
 *              代价：只能覆盖每个账号最近 10 条作品。
 *
 * 选择规则（resolveCrawlMode）：
 *   config.crawlMode = 'http' | 'browser' | 'auto'
 *   或环境变量 TIKTOK_CRAWL_MODE
 *   'auto'（默认）：配了代理 → 浏览器优先、失败回落 HTTP；没配代理 → 只用 HTTP
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const { fetchAccountVideosHttp, localDate } = require('./tiktok-http.cjs');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

async function launchBrowser(config = {}) {
  const launchOpts = {
    headless: config.headless !== false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
    ],
  };
  // Chrome 可执行文件：优先 CHROME_PATH 环境变量，其次 config.chromePath。
  // 路径不存在时忽略（例如在 Linux runner 上仍残留 Windows 路径），
  // 交给 playwright 自行查找已安装的 chromium。
  const chromePath = process.env.CHROME_PATH || config.chromePath;
  if (chromePath && fs.existsSync(chromePath)) {
    launchOpts.executablePath = chromePath;
  }
  // 代理：优先 TIKTOK_PROXY 环境变量（CI 上从 Secrets 注入），其次 config.proxy
  const proxy = process.env.TIKTOK_PROXY || config.proxy;
  if (proxy) launchOpts.proxy = { server: proxy };
  return chromium.launch(launchOpts);
}

// localDate 由 tiktok-http.cjs 提供（两条通道共用同一个时区格式化）

function mapItems(rawList, fallbackUsername, timeZone) {
  return rawList.map((it) => {
    const uid = (it.author && it.author.uniqueId) || fallbackUsername;
    return {
      id: String(it.id),
      title: it.desc || '',
      createTime: it.createTime,
      createDate: localDate(it.createTime, timeZone),
      createIso: new Date(it.createTime * 1000).toISOString(),
      url: `https://www.tiktok.com/@${uid}/video/${it.id}`,
      plays: it.stats ? it.stats.playCount : null,
      likes: it.stats ? it.stats.diggCount : null,
      author: uid,
    };
  });
}

/**
 * 【浏览器通道】打开账号主页，拦截 /api/post/item_list/ 响应抓取
 * @returns {Promise<{username, videos, degraded, error}>}
 */
async function fetchAccountVideosBrowser(browser, username, config = {}) {
  const uname = String(username).replace(/^@/, '').replace(/\/$/, '');
  const timeZone = config.timezone || 'Asia/Shanghai';
  const maxScroll = config.maxScroll ?? 6;
  const scrollDelay = config.scrollDelayMs ?? 2500;

  const captured = [];
  const ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: config.locale || 'es-MX',
    timezoneId: timeZone,
  });
  const page = await ctx.newPage();

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/post/item_list/')) return;
    try {
      const json = await res.json();
      if (json && Array.isArray(json.itemList) && json.itemList.length) {
        captured.push(...json.itemList);
      }
    } catch {
      /* 忽略解析失败 */
    }
  });

  let degraded = false;
  let error = null;

  try {
    await page.goto(`https://www.tiktok.com/@${uname}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(config.firstWaitMs ?? 7000);

    for (let i = 0; i < maxScroll; i++) {
      await page.mouse.wheel(0, 2400);
      await page.waitForTimeout(scrollDelay);
    }
  } catch (e) {
    error = e.message;
    degraded = true;
  }

  // 去重
  let videos = mapItems(dedupeById(captured), uname, timeZone);

  // DOM 兜底：接口没拿到时, 用卡片上的 img alt + href
  if (!videos.length) {
    degraded = true;
    try {
      const dom = await page.$$eval('[data-e2e="user-post-item"]', (els) =>
        els.map((el) => {
          const a = el.querySelector('a[href*="/video/"]');
          const img = el.querySelector('img');
          return { href: a ? a.href : null, alt: img ? img.alt : null };
        })
      );
      videos = dom
        .filter((d) => d.href)
        .map((d) => {
          const m = d.href.match(/\/video\/(\d+)/);
          return {
            id: m ? m[1] : d.href,
            title: (d.alt || '').replace(/\s*creado por .*$/i, '').replace(/\s*created by .*$/i, '').trim(),
            createTime: null,
            createDate: null,
            createIso: null,
            url: d.href.split('?')[0],
            plays: null,
            likes: null,
            author: uname,
          };
        });
    } catch {
      /* 忽略 */
    }
  }

  await ctx.close().catch(() => {});
  return { username: uname, videos, degraded, error };
}

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = String(it.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

/**
 * 决定用哪条通道
 *   'http'    —— 只用纯 HTTP（云端默认）
 *   'browser' —— 只用浏览器
 *   'auto'    —— 配了代理：浏览器优先、失败回落 HTTP
 */
function resolveCrawlMode(config = {}) {
  const explicit = String(config.crawlMode || process.env.TIKTOK_CRAWL_MODE || '').toLowerCase();
  if (explicit === 'http' || explicit === 'browser') return explicit;
  const proxy = process.env.TIKTOK_PROXY || config.proxy;
  return proxy ? 'auto' : 'http';
}

/** 两条通道的结果按视频 ID 合并，浏览器数据优先（字段更全） */
function mergeVideoResults(primary, fallback) {
  const byId = new Map();
  for (const v of (fallback && fallback.videos) || []) byId.set(v.id, v);
  for (const v of (primary && primary.videos) || []) {
    const prev = byId.get(v.id) || {};
    byId.set(v.id, { ...prev, ...v });
  }
  const videos = [...byId.values()];
  const ok = (r) => (r && r.videos && r.videos.length ? r : null);
  const winner = ok(primary) || ok(fallback) || null;
  return {
    username: (primary && primary.username) || (fallback && fallback.username),
    videos,
    degraded: videos.length === 0,
    error: winner ? null : (primary && primary.error) || (fallback && fallback.error) || null,
    source: [fallback && fallback.source, primary && primary.source]
      .filter(Boolean)
      .concat(!(primary && primary.source) && !(fallback && fallback.source) ? ['browser'] : [])
      .join('+'),
  };
}

/**
 * 抓取单个账号的近期视频（对外统一入口，自动选通道）
 * @returns {Promise<{username, videos, degraded, error, source}>}
 */
async function fetchAccountVideos(browser, username, config = {}) {
  const mode = resolveCrawlMode(config);

  if (mode === 'http') {
    try {
      return await fetchAccountVideosHttp(username, config);
    } catch (e) {
      return { username, videos: [], degraded: true, error: e.message, source: 'http-embed' };
    }
  }

  if (mode === 'browser') {
    return fetchAccountVideosBrowser(browser, username, config);
  }

  // auto：浏览器优先（历史更全），拿不到再用 HTTP 兜底（至少给最近 10 条）
  const br = await fetchAccountVideosBrowser(browser, username, config);
  if (br.videos && br.videos.length) return { ...br, source: 'browser' };
  const httpRes = await fetchAccountVideosHttp(username, config).catch((e) => ({
    username,
    videos: [],
    degraded: true,
    error: e.message,
    source: 'http-embed',
  }));
  return mergeVideoResults(httpRes, br);
}

module.exports = {
  launchBrowser,
  fetchAccountVideos,
  fetchAccountVideosBrowser,
  fetchAccountVideosHttp,
  resolveCrawlMode,
  USER_AGENT,
};
