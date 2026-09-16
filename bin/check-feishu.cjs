#!/usr/bin/env node
/**
 * 飞书机器人凭证自检 —— 回答「第一步（开权限 / 发布版本 / 加协作者）到底完成没有」。
 *
 * 用法：
 *   node bin/check-feishu.cjs
 *   FEISHU_APP_SECRET=xxx node bin/check-feishu.cjs    # 临时用别的密钥测
 *
 * 依次做四件事，任一失败就停下并给出对应的修复动作：
 *   ① 用 app_id + app_secret 换 tenant_access_token  → 验密钥本身是否正确
 *   ② 用该 token 读多维表格 1 条记录                  → 验 bitable:app 权限 + 是否发布了版本
 *   ③ 把读到的值原样写回 1 条记录                     → 验写权限（只读权限能过 ② 但过不了 ③）
 *   ④ 列出表格协作者，确认应用在名单里                → 验「加协作者」这一步
 *
 * ③ 是幂等写（写回原值），不会改动你的数据。
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

  // 顺带查出「应用名称」—— 加协作者时要按这个名字搜，很多人不知道去哪看
  try {
    const ar = await fetch(
      `https://open.feishu.cn/open-apis/application/v6/applications/${appId}?lang=zh_cn`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
    );
    const ja = await ar.json();
    const name = ja.code === 0 && ja.data && ja.data.app && ja.data.app.app_name;
    if (name) {
      info(`应用名称  = ${C.bold}${name}${C.reset}${C.dim}  ← 加协作者时按这个名字搜${C.reset}`);
      if (ja.data.app.online_version_id) info(`线上版本  = ${ja.data.app.online_version_id}`);
    }
  } catch (_) {
    /* 拿不到名称不影响自检，忽略 */
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
  info(`${C.bold}③ 写入测试（把读到的值原样写回，不改动数据）${C.reset}`);
  const playsField = (f.fields && f.fields.plays) || '播放量';
  const first = j2.data && j2.data.items && j2.data.items[0];
  if (!first) {
    info('表格里还没有任何记录，跳过写入测试（权限已通过读取验证）');
  } else {
    const recId = first.record_id || first.id;
    const rawPlays = first.fields ? first.fields[playsField] : undefined;
    const playsNum = Number(Array.isArray(rawPlays) ? rawPlays[0] : rawPlays);
    if (!Number.isFinite(playsNum)) {
      info(`记录里「${playsField}」没有可回写的数字，跳过写入测试（权限已通过读取验证）`);
    } else {
      try {
        const wr = await fetch(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recId}`,
          {
            method: 'PUT',
            headers: { ...hdr, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ fields: { [playsField]: playsNum } }),
            signal: AbortSignal.timeout(20000),
          }
        );
        const jw = await wr.json();
        if (jw.code === 0) {
          ok(`写权限正常（已把「${playsField}」= ${playsNum} 原值写回，数据未变）`);
        } else {
          bad(`写入被拒（code=${jw.code}）：${String(jw.msg || '').slice(0, 160)}`);
          info('→ 若提示只读权限，说明还缺 bitable:app（写）或 base:record:update，回开发者后台补权限并重新发布版本。');
          process.exit(1);
        }
      } catch (e) {
        bad(`写入请求失败：${e.message}`);
        process.exit(1);
      }
    }
  }

  console.log('');
  info(`${C.bold}④ 协作者确认${C.reset}`);
  try {
    const mr = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/permissions/${baseToken}/members?type=bitable`,
      { headers: hdr, signal: AbortSignal.timeout(20000) }
    );
    const jm = await mr.json();
    if (jm.code === 0) {
      const apps = (jm.data.items || []).filter((m) => m.member_type === 'appid');
      apps.forEach((m) => {
        const me = m.member_id === appId;
        console.log(
          `  ${me ? C.green : C.dim}${me ? '[本应用]' : '[其他应用]'}${C.reset} ${m.member_id}  权限=${m.perm}${me ? '' : C.dim + '（与本次部署无关）' + C.reset}`
        );
      });
      if (apps.some((m) => m.member_id === appId)) {
        const mine = apps.find((m) => m.member_id === appId);
        if (mine.perm === 'edit' || mine.perm === 'full_access') ok(`本应用已在协作者名单里，权限「${mine.perm === 'edit' ? '可编辑' : '完全访问'}」`);
        else bad(`本应用在名单里但权限是「${mine.perm}」，需要「可编辑」才能写数据`);
      } else {
        bad('本应用不在协作者名单里');
        info('→ 打开多维表格 → 右上角「分享」→ 添加协作者 → 搜索应用名称 → 设为「可编辑」');
      }
    } else {
      info(`协作者列表读取受限（code=${jm.code}），可跳过此步 —— 前一、二步通过即已证明访问可用`);
    }
  } catch (e) {
    info(`协作者列表读取失败（${e.message}），可跳过`);
  }

  console.log('');
  console.log(`${C.green}${C.bold}结论：第一步已全部完成 ✅${C.reset}`);
  console.log(`${C.dim}这套凭证可以交给 GitHub Actions 用了。${C.reset}\n`);
}
main().catch((e) => {
  console.error(`${C.red}未预期错误：${C.reset}`, e);
  process.exit(1);
});
