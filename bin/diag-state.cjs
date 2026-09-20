#!/usr/bin/env node
/**
 * 诊断脚本：打印飞书表格当前每行的关键字段，找出带 TRIGGER 标记的行、
 * 状态异常的行、以及缺链接的行。
 */
const feishu = require('../src/feishu.cjs');
const { loadConfig, ROOT } = require('../src/config.cjs');

(async () => {
  const cfg = loadConfig();
  console.log('backend:', feishu.backendName(cfg));
  const rows = await feishu.readRecords(cfg, ROOT);
  console.log('总行数:', rows.length);

  const byStatus = {};
  let withTrigger = 0;
  const triggerRows = [];
  const noLinkRows = [];

  for (const r of rows) {
    const s = r.status || '(空)';
    byStatus[s] = (byStatus[s] || 0) + 1;
    const tg = String(r.trigger || '').trim();
    if (tg) {
      withTrigger++;
      triggerRows.push(r);
    }
    const l = String(r.link || '');
    const hasLink = /\/video\/\d+/.test(l);
    if (!hasLink) noLinkRows.push(r);
  }

  console.log('\n--- 状态分布 ---');
  for (const [k, v] of Object.entries(byStatus)) console.log(' ', k, '=', v);

  console.log('\n--- 带 TRIGGER 标记的行: ' + withTrigger + ' 条 ---');
  for (const r of triggerRows) {
    console.log('  ', r.recordId, '| acct=' + r.account, '| date=' + r.date, '| status=' + r.status, '| trigger=' + JSON.stringify(r.trigger));
    console.log('     link:', (r.link || '(空)').slice(0, 70));
  }

  console.log('\n--- 无有效链接的行: ' + noLinkRows.length + ' 条 ---');
  for (const r of noLinkRows.slice(0, 40)) {
    console.log('  ', r.recordId, '| acct=' + String(r.account || '').slice(0, 40), '| date=' + r.date, '| status=' + r.status);
    console.log('     title:', String(r.title || '').slice(0, 60));
    console.log('     link :', JSON.stringify(r.link || ''));
  }
})().catch((e) => console.error('ERR', e.stack || e.message));