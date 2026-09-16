#!/usr/bin/env node
'use strict';

/**
 * 抓取故障诊断：打开 TikTok 账号页，把「TikTok 实际返回了什么」摊开看。
 * 用于区分：验证码拦截 / 登录墙 / 地区限制 / 页面结构变化 / IP 封锁。
 *
 *   node bin/diag-crawl.cjs <账号名>
 */

const fs = require('fs');
const path = require('path');
const { launchBrowser, USER_AGENT } = require(path.join(__dirname, '..', 'src', 'crawler.cjs'));
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config.cjs'));

(async () => {
  const cfg = loadConfig();
  const user = String(process.argv[2] || 'tiktok').replace(/^@/, '');
  const url = `https://www.tiktok.com/@${user}`;
  console.log(`诊断目标：${url}`);
  console.log(`代理：${process.env.TIKTOK_PROXY || cfg.proxy || '(直连)'}\n`);

  const br = await launchBrowser(cfg);
  const ctx = await br.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: cfg.locale || 'es-MX',
    timezoneId: cfg.timezone || 'Asia/Shanghai',
  });
  const page = await ctx.newPage();

  const statuses = [];
  page.on('response', (res) => {
    const u = res.url();
    if (/item_list|api\/|captcha|verify|challenge/i.test(u)) {
      statuses.push(`${res.status()}  ${u.slice(0, 120)}`);
    }
  });

  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`HTTP 状态：${resp ? resp.status() : '(无响应)'}`);
  await page.waitForTimeout(9000);

  const title = await page.title();
  console.log(`页面标题：${title}`);

  const markers = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const has = (re) => re.test(html);
    return {
      htmlLen: html.length,
      hydrate: has(/__UNIVERSAL_DATA_FOR_REHYDRATION__/),
      sigiState: has(/__SIGI_STATE__/),
      captcha: has(/captcha|验证|Verify|verify-bar|secsdk/i),
      loginWall: has(/log in to TikTok|登录 TikTok|login-container/i),
      noResults: has(/Couldn't find this account|找不到此账号|no results/i),
      postItem: document.querySelectorAll('[data-e2e="user-post-item"]').length,
      postItemAll: document.querySelectorAll('[data-e2e*="user-post-item"]').length,
      videoLinks: document.querySelectorAll('a[href*="/video/"]').length,
      bodyText: document.body ? document.body.innerText.slice(0, 400) : '',
    };
  });

  console.log('\n页面标记：');
  console.log(`  HTML 长度              : ${markers.htmlLen}`);
  console.log(`  UNIVERSAL_DATA 存在    : ${markers.hydrate}`);
  console.log(`  SIGI_STATE 存在        : ${markers.sigiState}`);
  console.log(`  疑似验证码/风控         : ${markers.captcha}`);
  console.log(`  疑似登录墙             : ${markers.loginWall}`);
  console.log(`  找不到该账号提示        : ${markers.noResults}`);
  console.log(`  作品卡片 (user-post-item): ${markers.postItem} / 模糊匹配 ${markers.postItemAll}`);
  console.log(`  页面内 /video/ 链接     : ${markers.videoLinks}`);
  console.log('\n页面可见文本（前 400 字）：');
  console.log(markers.bodyText.replace(/\n{2,}/g, '\n').split('\n').slice(0, 15).map((l) => '  ' + l).join('\n'));

  if (statuses.length) {
    console.log('\n相关网络请求：');
    [...new Set(statuses)].slice(0, 15).forEach((s) => console.log('  ' + s));
  }

  const shot = path.join(__dirname, '..', 'data', 'diag-crawl.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`\n截图已保存：${shot}`);

  await ctx.close().catch(() => {});
  await br.close().catch(() => {});
})().catch((e) => {
  console.error('诊断失败：', e && e.message);
  process.exit(1);
});
