/**
 * TikTok 抓取引擎
 *
 * 思路: 不解析 DOM, 而是拦截 TikTok 自己发出的 /api/post/item_list/ 响应,
 * 直接读取结构化字段 (id / desc / createTime), 由 id 拼出规范视频链接。
 * DOM 卡片仅作兜底。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');

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

function localDate(ts, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
}

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
 * 抓取单个账号的近期视频
 * @returns {Promise<{username, videos, degraded, error}>}
 */
async function fetchAccountVideos(browser, username, config = {}) {
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

module.exports = { launchBrowser, fetchAccountVideos, USER_AGENT };
