#!/usr/bin/env node
'use strict';

/**
 * 专攻 /api/recommend/embed_videos/ ：把常见参数组合都堆上去，看哪套能满足它的 required fields。
 *
 *   node bin/diag-embedvideos.cjs [账号]
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
  await page.goto(`https://www.tiktok.com/embed/@${USER}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  const base = await page.evaluate(() => {
    const h = document.documentElement.outerHTML;
    const ids = [...new Set([...h.matchAll(/\/video\/(\d{17,20})/g)].map((m) => m[1]))];
    return {
      ids,
      userId: (/"id":"(\d{17,20})","desc"/.exec(h) || [])[1] || '',
      authorUniqueId: (/"authorUniqueId":"([^"]+)"/.exec(h) || [])[1] || '',
      msToken: (document.cookie.match(/msToken=([^;]+)/) || [])[1] || '',
    };
  });
  line(`视频数=${base.ids.length}  首个视频=${base.ids[0]}  authorUniqueId=${base.authorUniqueId}`);
  line(`msToken 长度=${base.msToken.length}`);

  const webBase =
    `aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla` +
    `&browser_online=true&browser_platform=Win32&channel=tiktok_web&cookie_enabled=true` +
    `&device_platform=web_pc&focus_state=true&history_len=1&is_fullscreen=false&is_page_visible=true` +
    `&os=windows&priority_region=US&region=US&screen_height=900&screen_width=1280` +
    `&tz_name=America/New_York&webcast_language=en`;

  const variants = [
    ['web基础 + uniqueId + itemId', `${webBase}&uniqueId=${USER}&itemId=${base.ids[0]}&count=30&cursor=0`],
    ['web基础 + playletId/playlistId', `${webBase}&playlistId=${USER}&itemId=${base.ids[0]}&count=30&cursor=0`],
    ['web基础 + userId + itemId', `${webBase}&userId=${base.userId}&itemId=${base.ids[0]}&count=30&cursor=0`],
    ['web基础 + authorId', `${webBase}&authorId=${base.userId}&itemId=${base.ids[0]}&count=30&cursor=0`],
    ['web基础 + only itemId', `${webBase}&itemId=${base.ids[0]}&count=30&cursor=0`],
    ['web基础 + uniqueId+videoId', `${webBase}&uniqueId=${USER}&videoId=${base.ids[0]}&count=30&cursor=0`],
  ];

  for (const [label, q] of variants) {
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
        return {
          status: res.status,
          len: t.length,
          sc: j && (j.statusCode ?? j.status_code),
          msg: j && (j.statusMsg || j.status_msg),
          items: j ? (j.itemList || j.aweme_list || j.items || j.videos || []).length : 0,
          head: t.slice(0, 150),
        };
      } catch (e) {
        return { err: e.message };
      }
    }, `/api/recommend/embed_videos/?${q}`);

    if (r.err) {
      line(`[异常] ${label}: ${r.err}`);
    } else {
      line(`[${r.items ? 'OK ' : '-- '}] ${label}  HTTP ${r.status} len=${r.len} sc=${r.sc || '-'} 条数=${r.items}${r.msg ? '  msg=' + String(r.msg).slice(0, 60) : ''}`);
      if (!r.items && r.sc) line(`        ${r.head}`);
    }
  }

  await ctx.close().catch(() => {});
  await br.close().catch(() => {});
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
