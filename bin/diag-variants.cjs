#!/usr/bin/env node
'use strict';

/**
 * 抓取受阻归因实验：在同一台机器、同一代理下，对比不同浏览器特征拿到的东西。
 * 目的：区分「出口 IP 被 TikTok 降级（只给壳不给作品列表）」与「无头浏览器被识别」。
 *
 *   node bin/diag-variants.cjs <账号名>
 */

const path = require('path');
const { USER_AGENT } = require(path.join(__dirname, '..', 'src', 'crawler.cjs'));
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config.cjs'));
const { chromium } = require('playwright-core');

const cfg = loadConfig();
const proxy = process.env.TIKTOK_PROXY || cfg.proxy || '';
const chromePath = process.env.CHROME_PATH || cfg.chromePath;
const user = String(process.argv[2] || 'tiktok').replace(/^@/, '');

async function attempt(label, opts) {
  const launchOpts = { headless: opts.headless };
  if (chromePath) launchOpts.executablePath = chromePath;
  if (proxy) launchOpts.proxy = { server: proxy };
  if (opts.channel) launchOpts.channel = opts.channel;

  let br;
  try {
    br = await chromium.launch(launchOpts);
  } catch (e) {
    console.log(`${label.padEnd(26)} 启动失败：${e.message.split('\n')[0]}`);
    return;
  }

  const ctx = await br.newContext({
    userAgent: opts.ua || USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = await ctx.newPage();

  let apiHits = 0;
  let apiBodySample = '';
  page.on('response', async (res) => {
    if (!res.url().includes('/api/post/item_list/')) return;
    apiHits++;
    try {
      const txt = await res.text();
      if (!apiBodySample) apiBodySample = txt.slice(0, 400);
    } catch {
      /* ignore */
    }
  });

  try {
    await page.goto(`https://www.tiktok.com/@${user}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(9000);
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`${label.padEnd(26)} 打开失败：${e.message.split('\n')[0]}`);
    await br.close().catch(() => {});
    return;
  }

  const r = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-e2e="user-post-item"]').length,
    links: document.querySelectorAll('a[href*="/video/"]').length,
    err: /Hubo un problema|Lo sentimos|Try again later|Something went wrong/i.test(document.body.innerText),
  }));

  console.log(`${label.padEnd(26)} 卡片=${String(r.cards).padStart(3)}  链接=${String(r.links).padStart(3)}  错误提示=${r.err ? '有' : '无'}  item_list请求=${apiHits}`);
  if (opts.showBody && apiBodySample) {
    console.log('     item_list 响应体前 400 字：');
    console.log('     ' + apiBodySample.replace(/\n/g, ' ').slice(0, 400));
  }

  await ctx.close().catch(() => {});
  await br.close().catch(() => {});
}

(async () => {
  console.log(`账号：@${user}`);
  console.log(`代理：${proxy || '(直连)'}`);
  console.log(`Chrome：${chromePath || '(playwright 自带)'}`);
  console.log(`UA：${USER_AGENT.slice(0, 60)}…\n`);

  await attempt('A 无头 + 默认UA', { headless: true, showBody: true });
  await attempt('B 有头（真实窗口）', { headless: false });
  await attempt('C 无头 + 真实Chrome渠道', { headless: true, channel: 'chrome' });
  await attempt('D 有头 + 西语UA', {
    headless: false,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  });
})().catch((e) => {
  console.error('实验失败：', e && e.message);
  process.exit(1);
});
