#!/usr/bin/env node
'use strict';

/**
 * 在浏览器里（带着 ttwid/msToken 等 cookies、同源）直接试调各列表接口，
 * 看看到底哪个能用、需要什么参数。
 *
 *   node bin/diag-api.cjs [账号]
 */

const path = require('path');
const { chromium } = require('playwright-core');
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config.cjs'));

const USER = process.argv[2] || 'carlosmendoz89';
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

  const br = await chromium.launch(opts);
  const ctx = await br.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage();

  // 先进嵌入页拿到 cookies（ttwid / msToken）与 secUid
  await page.goto(`https://www.tiktok.com/embed/@${USER}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  const info = await page.evaluate(() => {
    const h = document.documentElement.outerHTML;
    return {
      secUid: (/"secUid":"([^"]+)"/.exec(h) || [])[1] || '',
      userId: (/"userInfo":\{"id":"(\d+)"/.exec(h) || [])[1] || '',
      cookies: document.cookie,
    };
  });
  line(`secUid=${info.secUid ? info.secUid.slice(0, 30) + '…' : '(空)'}`);
  line(`userId=${info.userId || '(空)'}`);
  line(`document.cookie 可见长度=${info.cookies.length}`);

  const ck = await ctx.cookies();
  line(`浏览器 cookies: ${ck.map((c) => c.name).join(', ')}`);

  // 同源 fetch 各种接口
  const tests = [
    ['item_list（仅 secUid）', `/api/post/item_list/?aid=1988&count=35&cursor=0&secUid=${encodeURIComponent(info.secUid)}`],
    ['item_list（secUid+完整web参数）',
      `/api/post/item_list/?aid=1988&count=35&cursor=0&secUid=${encodeURIComponent(info.secUid)}` +
      `&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true` +
      `&browser_platform=Win32&channel=tiktok_web&cookie_enabled=true&device_platform=web_pc&focus_state=true` +
      `&from_page=user&history_len=2&is_fullscreen=false&is_page_visible=true&os=windows&priority_region=US` +
      `&referer=&region=US&screen_height=900&screen_width=1280&tz_name=America/New_York&webcast_language=en`],
    ['embed_videos（uniqueId）', `/api/recommend/embed_videos/?uniqueId=${USER}&count=30&cursor=0`],
    ['embed_videos（uniqueId+itemId）', `/api/recommend/embed_videos/?uniqueId=${USER}&count=30&cursor=0&itemId=7685947685349657864`],
    ['embed_videos（secUid）', `/api/recommend/embed_videos/?secUid=${encodeURIComponent(info.secUid)}&count=30&cursor=0`],
    ['user/detail', `/api/user/detail/?uniqueId=${USER}`],
    ['user/detail?secUid', `/api/user/detail/?secUid=${encodeURIComponent(info.secUid)}`],
  ];

  for (const [label, url] of tests) {
    const r = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: 'include' });
        const t = await res.text();
        let j = null;
        try {
          j = JSON.parse(t);
        } catch {
          /* noop */
        }
        const n = j ? (j.itemList || j.aweme_list || j.items || []).length : 0;
        return { status: res.status, len: t.length, statusCode: j && (j.statusCode ?? j.status_code), msg: j && (j.statusMsg || j.status_msg), count: n, head: t.slice(0, 130) };
      } catch (e) {
        return { err: e.message };
      }
    }, url);
    if (r.err) {
      line(`[异常] ${label}  ${r.err}`);
    } else {
      line(`[${r.count ? 'OK ' : '-- '}] ${label}`);
      line(`         HTTP ${r.status} len=${r.len} statusCode=${r.statusCode || '-'} 条数=${r.count}`);
      if (r.msg) line(`         msg=${String(r.msg).slice(0, 90)}`);
      if (!r.count) line(`         head=${r.head}`);
    }
  }

  await ctx.close().catch(() => {});
  await br.close().catch(() => {});
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
