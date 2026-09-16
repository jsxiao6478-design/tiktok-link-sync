#!/usr/bin/env node
'use strict';

/**
 * 嵌入页深挖：搞清楚 https://www.tiktok.com/embed/@user 的数据结构、分页接口、总量上限。
 *
 * 已知：嵌入页在 GitHub runner 上返回 200 且有作品数据（普通主页接口被降级）。
 * 待答：
 *   1. 页面里的数据藏在哪个 JSON blob 里？字段名是什么？
 *   2. 一次能给多少条？能不能翻页/滚动加载更多？
 *   3. 加载更多走的是哪个接口（找到就能纯 HTTP 调，彻底不用浏览器）
 *
 *   node bin/diag-embed.cjs [账号]
 */

const path = require('path');
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config.cjs'));

const USER = process.argv[2] || 'carlosmendoz89';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const line = (s = '') => console.log(s);
const head = (s) => line('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 56 - s.length)));

const EMBED_URL = `https://www.tiktok.com/embed/@${USER}`;

async function getText(url, headers = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  line('嵌入页结构深挖');
  line(`账号：@${USER}`);

  // ── A. 纯 HTTP 拿嵌入页，分析结构 ────────────────────────
  head('A. 纯 HTTP 拿嵌入页');
  const r = await getText(EMBED_URL, { Referer: 'https://www.tiktok.com/' });
  line(`HTTP ${r.status}  长度 ${r.text.length}`);
  const html = r.text;

  const ids = [...new Set([...html.matchAll(/\/video\/(\d{17,20})/g)].map((m) => m[1]))];
  const idFields = [...new Set([...html.matchAll(/"id"\s*:\s*"(\d{17,20})"/g)].map((m) => m[1]))];
  line(`页面内 /video/<id> 去重数 = ${ids.length}`);
  line(`页面内 "id":"<19位>" 去重数 = ${idFields.length}`);

  // 找 JSON blob
  const blobs = [...html.matchAll(/<script[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  line(`带 id 的 script 标签：${blobs.length ? blobs.join(', ') : '(无)'}`);

  // 找可能的接口地址
  const apiPaths = [
    ...new Set([...html.matchAll(/["'`](\/[a-z0-9_\-/.]*api\/[a-zA-Z0-9_\-/.]+)["'`]/g)].map((m) => m[1])),
  ].slice(0, 20);
  line(`HTML 里出现的 api 路径（前 20 条）：`);
  apiPaths.forEach((p) => line('   ' + p));

  // 找一个视频卡片附近的 HTML，看标题字段
  const idx = html.indexOf('/video/');
  if (idx > 0) {
    line('\n视频链接附近 HTML（前后 400 字）：');
    line(html.slice(Math.max(0, idx - 200), idx + 200).replace(/\s+/g, ' '));
  }

  // 统计可能的标题字段名
  const fieldProbe = ['"desc"', '"title"', '"contentDesc"', '"playCount"', '"diggCount"', '"commentCount"', '"createTime"', '"itemList"', '"itemInfo"', '"videoData"', '"coverUrl"'];
  line('\n字段出现次数：');
  fieldProbe.forEach((f) => {
    const n = html.split(f).length - 1;
    if (n) line(`   ${f.padEnd(18)} ${n}`);
  });

  // ── B. 用浏览器打开嵌入页：看网络请求 + 能滚出多少条 ──────
  head('B. 浏览器打开嵌入页：接口 + 滚动加载能力');
  let chromium;
  try {
    chromium = require('playwright-core').chromium;
  } catch (e) {
    line('playwright-core 不可用，跳过：' + e.message);
    return;
  }
  const cfg = loadConfig();
  const launchOpts = { headless: true };
  const chromePath = process.env.CHROME_PATH || cfg.chromePath;
  if (chromePath) launchOpts.executablePath = chromePath;
  const proxy = process.env.TIKTOK_PROXY || cfg.proxy;
  if (proxy) launchOpts.proxy = { server: proxy };

  let br;
  try {
    br = await chromium.launch(launchOpts);
  } catch (e) {
    line('浏览器启动失败（runner 上需要先装 chromium）：' + e.message.split('\n')[0]);
    return;
  }

  const ctx = await br.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const apis = new Map();
  page.on('response', (res) => {
    const u = res.url();
    if (!/tiktok\.com/.test(u)) return;
    if (!/\/api\/|\/aweme\/|item_list|embed/i.test(u)) return;
    const key = u.split('?')[0];
    apis.set(key, (apis.get(key) || 0) + 1);
  });

  try {
    await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    const countIds = () =>
      page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        return new Set([...html.matchAll(/\/video\/(\d{17,20})/g)].map((m) => m[1])).size;
      });

    const before = await countIds();
    line(`滚动前页面内视频 ID 数 = ${before}`);

    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(2500);
    }
    const after = await countIds();
    line(`滚动 12 次后视频 ID 数 = ${after}`);

    const domInfo = await page.evaluate(() => ({
      anchors: document.querySelectorAll('a[href*="/video/"]').length,
      cards: document.querySelectorAll('[data-e2e*="item"], [class*="DivItemContainer"], [class*="video-card"]').length,
      bodyLen: document.body ? document.body.innerText.length : 0,
      scrollH: document.documentElement.scrollHeight,
    }));
    line(`DOM：/video/ 锚点=${domInfo.anchors} 卡片=${domInfo.cards} 滚动高度=${domInfo.scrollH} 可见文本长度=${domInfo.bodyLen}`);
  } catch (e) {
    line('浏览器操作失败：' + e.message.split('\n')[0]);
  }

  line('\n浏览器观察到的 TikTok 接口（次数）：');
  [...apis.entries()].slice(0, 25).forEach(([u, n]) => line(`   ${String(n).padStart(3)}×  ${u.slice(0, 110)}`));

  await ctx.close().catch(() => {});
  await br.close().catch(() => {});
})();
