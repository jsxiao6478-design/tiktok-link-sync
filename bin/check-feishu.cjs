#!/usr/bin/env node
/**
 * 飞书机器人凭证自检 —— 回答「第一步（开权限 / 发布版本 / 加协作者）到底完成没有」。
 *
 * 用法：
 *   node bin/check-feishu.cjs
 *   FEISHU_APP_SECRET=xxx node bin/check-feishu.cjs    # 临时用别的密钥测
 *
 * 依次做三件事，任一失败就停下并给出对应的修复动作：
 *   ① 用 app_id + app_secret 换 tenant_access_token  → 验密钥本身是否正确
 *   ② 用该 token 读多维表格 1 条记录                  → 验 bitable:app 权限 + 是否发布了版本
 *   ③ 打印表格可见的行数与字段名                      → 验应用是否被加为该表格的协作者
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
const ok = (s) => console.log(`  ${C.green}[OK]${C.reset}   ${s}`);
const bad = (s) => console.log(`  ${C.red}[FAIL]${C.reset} ${s}`);
const info = (s) => console.log(`  ${C.dim}${s}${C.reset}`);
const step = (n, s) => console.log(`\n${C.bold}${n} ${s}${C.reset}`);

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) {
    console.log(`${C.yellow}找不到 config.json${C.reset}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const config = loadConfig();
  const f = config.feishu || {};
  const cloud = f.cloud || {};

  const appId = process.env.FEISHU_APP_ID || cloud.appId || f.appId;
  const appSecret = process.env.FEISHU_APP_SECRET || cloud.appSecret || f.appSecret;
  const baseToken = process.env.FEISHU_BASE_TOKEN || f.baseToken;
  const tableId = process.env.FEISHU_TABLE_ID || f.tableId;

  console.log(`${C.bold}飞书机器人凭证自检${C.reset}`);
  info(`app_id    = ${appId || '(缺失)'}`);
  info(`app_secret= ${appSecret ? appSecret.slice(0, 6) + '…' + appSecret.slice(-4) + ` (${appSecret.length} 位)` : '(缺失)'}`);
  info(`baseToken = ${baseToken || '(缺失)'}`);
  info(`tableId   = ${tableId || '(缺失)'}`);
  if (!appId || !appSecret) {
    bad('缺少 app_id / app_secret，无法自检');
    process.exit(1);
  }

  // ── ① 换 token ──────────────────────────────────────────────
  step('①', '用凭证换 tenant_access_token（验密钥本身）');
  let token = '';
  try {
    const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.code === 0 && j.tenant_access_token) {
      token = j.tenant_access_token;
      ok(`密钥正确，拿到 token（有效期 ${j.expire} 秒 ≈ ${(j.expire / 3600).toFixed(1)} 小时）`);
    } else {
      bad(`换取失败：${JSON.stringify(j)}`);
      if (/app secret/i.test(JSON.stringify(j))) {
        info('→ App Secret 填错了，或复制时带了空格。去「开发者后台 → 凭证与基础信息」重新复制。');
      }
      process.exit(1);
    }
  } catch (e) {
    bad(`网络请求失败：${e.message}`);
    info('→ 本机访问 open.feishu.cn 异常，检查网络/代理。');
    process.exit(1);
  }

  // ── ② 读表（验权限 + 版本发布） ────────────────────────────
  step('②', '读多维表格（验 bitable:app 权限是否已生效）');
  const api = `https://open.feishu.cn/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=1`;
  const hdr = { Authorization: `Bearer ${token}` };
  let j2;
  try {
    const r = await fetch(api, { headers: hdr, signal: AbortSignal.timeout(20000) });
    j2 = await r.json();
  } catch (e) {
    bad(`网络请求失败：${e.message}`);
    process.exit(1);
  }

  if (j2.code === 0) {
    ok('权限已生效，能够访问该多维表格');
    const total = j2.data && j2.data.total;
    if (typeof total === 'number') info(`表格当前共 ${total} 条记录`);
    const first = j2.data && j2.data.items && j2.data.items[0];
    if (first && first.fields) {
      info(`字段：${Object.keys(first.fields).join(' / ')}`);
    }
  } else {
    const msg = String(j2.msg || '');
    bad(`访问被拒（code=${j2.code}）`);

    if (j2.code === 99991672 || /app_scope_not_applied|Access denied.*scopes/i.test(msg)) {
      console.log('');
      console.log(`  ${C.yellow}诊断：权限没生效 —— 属于「第一步没做完」${C.reset}`);
      console.log(`  按顺序做完这三件事（漏任何一件都会卡在这一步）：`);
      console.log(`   1. 开权限：点击下面这个链接，把 bitable:app 等权限全部申请开通`);
      console.log(`      ${C.bold}https://open.feishu.cn/app/${appId}/auth?q=bitable:app:readonly,bitable:app,base:record:retrieve&op_from=openapi&token_type=tenant${C.reset}`);
      console.log(`   2. ${C.bold}发布版本${C.reset}（最容易漏！）：开发者后台 → 左侧「版本管理与发布」→「创建版本」→ 填版本号 → 申请发布`);
      console.log(`      ${C.dim}权限是「申请后要发布版本才生效」，只点开通不发布 = 不生效${C.reset}`);
      console.log(`   3. 加协作者：打开那张多维表格 → 右上角「分享」→ 搜索应用名 → 加为「可编辑」`);
      console.log('');
      console.log(`  ${C.dim}做完后用同一条命令再跑一次本脚本即可。${C.reset}`);
    } else if (j2.code === 91403 || j2.code === 1254303 || /Forbidden|permission/i.test(msg)) {
      console.log('');
      console.log(`  ${C.yellow}诊断：应用没被加进这张多维表格${C.reset}`);
      console.log(`  → 打开多维表格 → 右上角「分享」→ 搜索应用名 → 加为「可编辑」`);
    } else {
      info(`原始返回：${JSON.stringify(j2).slice(0, 400)}`);
    }
    process.exit(1);
  }

  console.log('');
  console.log(`${C.green}${C.bold}结论：第一步已全部完成 ✅${C.reset}`);
  console.log(`${C.dim}这套凭证可以交给 GitHub Actions 用了。${C.reset}\n`);
}

main().catch((e) => {
  console.error(`${C.red}未预期错误：${C.reset}`, e);
  process.exit(1);
});
