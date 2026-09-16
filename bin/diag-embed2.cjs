#!/usr/bin/env node
'use strict';

/**
 * 用浏览器打开嵌入页，抓出「加载更多」到底调的是哪个接口。
 *
 *   node bin/diag-embed2.cjs [账号]
 */

const path = require('path');
const { chromium } = require('playwright-core');
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config.cjs'));

const USER = process.argv[2] || 'carlosmendoz89';
const URL_EMBED = `https://www.tiktok.com/embed/@${USER}`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const line = (s = '') => console.log(s);

(async () => {
  const cfg = loadConfig();
  const opts = { headless: true };
  const cp = process.env.CHROME_PATH || cfg.chromePath;
  if (cp) opts.executablePath = cp;
  const proxy = process.env.TIKTOK_PROXY || cfg.proxy;
  if (proxy) opts.proxy = { server: proxy };

  line(`打开 ${URL_EMBED}`);
  const br = await chromium.launch(opts);
  const ctx = await br.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage();

  const seen = new Map();
  page.on('response', (res) => {
    const u = res.url();
    if (!/tiktok\.com/.test(u)) return;
    if (/\.(js|css|png|jpg|webp|woff2?|svg|ico)(\?|$)/i.test(u)) return;
    const key = u.split('?')[0];
    if (!seen.has(key)) seen.set(key, { n: 0, sample: u });
    seen.get(key).n++;
  });

  await page.goto(URL_EMBED, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const count = () =>
    page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      return new Set([...html.matchAll(/\/video\/(\d{17,20})/g)].map((m) => m[1])).size;
    });

  line(`初始视频数 = ${await count()}`);

  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(2200);
  }
  const after = await count();
  line(`滚动 15 次后 = ${after}`);

  const dom = await page.evaluate(() => ({
    anchors: document.querySelectorAll('a[href*="/video/"]').length,
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
    cards: document.querySelectorAll('[data-e2e*="videoList"]').length,
  }));
  line(`DOM：锚点=${dom.anchors} 卡片容器=${dom.cards} 滚动高=${dom.scrollH} 视口高=${dom.clientH}`);

  line('\n非静态资源请求：');
  [...seen.entries()].forEach(([k, v]) => line(`   ${String(v.n).padStart(3)}×  ${k.slice(0, 120)}`));
  line('\n完整 URL 样本：');
  [...seen.values()].slice(0, 20).forEach((v) => line('   ' + v.sample.slice(0, 200)));

  await ctx.close().catch(() => {});
  await br.close().catch(() => {});
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
