#!/usr/bin/env node
'use strict';

/**
 * 单账号抓取探针：用当前配置真实抓一个账号，打印抓到多少条与耗时。
 * 用途：区分「账号本身没视频」和「出口 IP 被 TikTok 拦」这两种 0 条。
 *
 *   node bin/probe-account.cjs <账号名>
 */

const path = require('path');
const { launchBrowser, fetchAccountVideos } = require(path.join(__dirname, '..', 'src', 'crawler.cjs'));
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config.cjs'));

(async () => {
  const cfg = loadConfig();
  const user = process.argv[2] || 'carlosmendoz89';
  const proxyShown = process.env.TIKTOK_PROXY || cfg.proxy || '(直连)';
  console.log(`目标账号：@${user}`);
  console.log(`出口代理：${proxyShown}`);
  console.log('');
  const br = await launchBrowser(cfg);
  const t0 = Date.now();
  let r = { videos: [], degraded: false, error: null };
  try {
    r = await fetchAccountVideos(br, user, cfg);
  } finally {
    await br.close();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const items = r.videos || [];
  console.log(`结果：抓到 ${items.length} 条，耗时 ${secs}s`);
  console.log(`降级标记 degraded=${r.degraded}${r.error ? `  错误：${r.error}` : ''}`);
  items.slice(0, 8).forEach((it, i) => {
    console.log(`  ${i + 1}. [${it.date || '?'}] ${String(it.title || '').slice(0, 45)}  plays=${it.plays} likes=${it.likes}`);
  });
  if (!items.length) console.log('  (0 条)');
})().catch((e) => {
  console.error('ERR', e && e.message);
  process.exit(1);
});
