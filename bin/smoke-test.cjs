#!/usr/bin/env node
/**
 * smoke-test.cjs —— 「能不能上云」的烟雾测试
 *
 * 在目标机器（GitHub runner / 服务器 / 另一台电脑）上先跑这个，依次确认三件事：
 *   1) 出网能不能访问 TikTok —— 决定这个方案是否可行（go / no-go 关卡）
 *   2) 能不能拿到飞书 tenant_access_token 并读到表格 —— 决定凭证与权限是否配好
 *   3) 浏览器能不能真的抓到视频数据
 *
 * 实现说明：网络探测一律走 curl，而不是 Node 的 fetch。
 * 因为 Node 的 fetch（undici）**不会自动读取 HTTPS_PROXY 环境变量**，
 * 用它测出来的出口 IP / 可达性都是「直连结果」，和真正抓取时的路径不一致，会误判。
 *
 * 用法：
 *   node bin/smoke-test.cjs                 全量测试（含真实抓取，约 60~120 秒）
 *   node bin/smoke-test.cjs --skip-crawl    只测网络与飞书（秒级）
 *   node bin/smoke-test.cjs --account xxx   指定试抓的账号（默认从表里取第一个）
 */

const os = require('os');
const { execFileSync } = require('child_process');
const { loadConfig, ROOT } = require('../src/config.cjs');
const feishu = require('../src/feishu.cjs');
const { launchBrowser, fetchAccountVideos } = require('../src/crawler.cjs');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

let problems = 0;
const ok = (m) => console.log('[OK]   ' + m);
const bad = (m) => { problems += 1; console.log('[FAIL] ' + m); };
const warn = (m) => console.log('[WARN] ' + m);
const info = (m) => console.log('[INFO] ' + m);

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a[name] = next; i += 1; } else { a[name] = true; }
  }
  return a;
}

/** 当前生效的代理（优先级：TIKTOK_PROXY > HTTPS_PROXY > HTTP_PROXY） */
function activeProxy() {
  return (
    process.env.TIKTOK_PROXY ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    ''
  );
}

function curlErr(e) {
  const raw = String((e && (e.stderr || e.message)) || '').trim();
  return raw.split('\n').filter(Boolean).pop() || 'curl 调用失败';
}

/** 探测 HTTP 状态码 */
function curlStatus(url, ms = 20000, proxy = '') {
  const args = ['-sS', '-o', os.devNull, '-w', '%{http_code}', '--max-time', String(Math.ceil(ms / 1000)), '-A', UA];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  try {
    const code = Number(execFileSync('curl', args, {
      encoding: 'utf8', timeout: ms + 8000, windowsHide: true,
    }).trim());
    return { ok: code >= 200 && code < 400, status: code };
  } catch (e) {
    return { ok: false, error: curlErr(e) };
  }
}

/** 取回响应正文 */
function curlText(url, ms = 15000, proxy = '') {
  const args = ['-sS', '--max-time', String(Math.ceil(ms / 1000)), '-A', UA];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  try {
    return execFileSync('curl', args, {
      encoding: 'utf8', timeout: ms + 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
  } catch (_) {
    return '';
  }
}

/** 出口 IP（走当前代理，反映真实出口） */
function outboundIp(proxy) {
  for (const url of ['https://ipinfo.io/json', 'https://api.ipify.org?format=json']) {
    const body = curlText(url, 15000, proxy);
    if (!body) continue;
    try {
      const j = JSON.parse(body);
      if (j && j.ip) {
        return { ip: j.ip, country: j.country || j.country_code || '', org: j.org || '' };
      }
    } catch (_) { /* 换下一个源 */ }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args.config);
  const proxy = activeProxy() || config.proxy || '';

  console.log('=== TikTok 表格同步 · 上云可行性烟雾测试 ===');
  info(`运行环境: Node ${process.version} / ${process.platform} ${process.arch}`);
  info(`容器时区: ${process.env.TZ || '(未设置，容器默认 UTC)'}`);
  info(`抓取代理: ${proxy || '(直连)'}`);
  console.log('');

  // ── 1) 出口 IP ──────────────────────────────────────────────
  const ip = outboundIp(proxy);
  if (ip) ok(`出口 IP: ${ip.ip}${ip.country ? ' [' + ip.country + ']' : ''}${ip.org ? '  ' + ip.org : ''}`);
  else warn('取不到出口 IP（可能只是拿不到 IP 查询服务，不一定是断网）');

  // ── 2) TikTok 连通性（直连 vs 代理，分别测）────────────────
  const tkDirect = curlStatus('https://www.tiktok.com/', 15000, '');
  const tkViaProxy = proxy ? curlStatus('https://www.tiktok.com/', 25000, proxy) : null;

  if (tkViaProxy) {
    if (tkViaProxy.ok) ok(`TikTok 经代理可达 (HTTP ${tkViaProxy.status})`);
    else bad(`TikTok 经代理不可达：${tkViaProxy.error || 'HTTP ' + tkViaProxy.status}`);
    info(`  对比 · 直连: ${tkDirect.ok ? 'HTTP ' + tkDirect.status : tkDirect.error}`);
  } else if (tkDirect.ok) {
    ok(`TikTok 直连可达 (HTTP ${tkDirect.status})`);
  } else {
    bad(`TikTok 不可达：${tkDirect.error || 'HTTP ' + tkDirect.status}  → 没有境外出口时这个方案不可行`);
  }

  // ── 3) 飞书 OpenAPI ────────────────────────────────────────
  const backend = feishu.backendName(config);
  info(`飞书后端: ${backend}`);
  if (backend === 'openapi') {
    try {
      const token = await feishu.tenantToken(config);
      if (token) ok('tenant_access_token 获取成功（bot 身份，2 小时自动续期，不会像 OAuth 那样过期）');
      else bad('tenant_access_token 为空');
    } catch (e) {
      bad(`获取 tenant_access_token 失败：${e.message}`);
    }
  } else {
    warn('当前是 lark-cli 后端 —— 在 CI / 服务器上跑不了（没有本机授权）。');
    info('  云端运行请配置 FEISHU_APP_ID + FEISHU_APP_SECRET 以启用 openapi 后端。');
  }

  // ── 4) 读表格 ──────────────────────────────────────────────
  let all = [];
  try {
    all = await feishu.readRecords(config, ROOT);
    const withLink = all.filter((r) => /\/video\//.test(r.link || '')).length;
    ok(`读取表格成功：${all.length} 条记录（已有链接 ${withLink} 条）`);
  } catch (e) {
    bad(`读取表格失败：${e.message}`);
  }

  // ── 5) 真实抓取 ────────────────────────────────────────────
  if (args['skip-crawl']) {
    info('--skip-crawl 已跳过抓取测试');
  } else {
    const account = args.account || (all.find((r) => r.account) || {}).account || '';
    const uname = String(account).replace(/^.*@/, '').replace(/\/$/, '');
    if (!uname) {
      warn('拿不到可试抓的账号（表里没读到账号），跳过抓取测试');
    } else {
      info(`开始试抓 @${uname} ...`);
      let browser = null;
      try {
        browser = await launchBrowser(config);
        ok('浏览器启动成功');
        const started = Date.now();
        const { videos, degraded, error } = await fetchAccountVideos(browser, uname, config);
        const secs = Math.round((Date.now() - started) / 1000);
        if (videos.length > 0) {
          ok(`抓取 @${uname} 成功：${videos.length} 条视频，耗时 ${secs}s`);
          const v = videos[0];
          info(`  最新一条: ${String(v.title).slice(0, 40)} | plays=${v.plays} likes=${v.likes}`);
          info(`  单次运行预计耗时：约 ${secs * 2 + 30}s（两个账号 + 启动开销）`);
        } else {
          bad(`抓取 @${uname} 返回 0 条${degraded ? '（被降级 / 风控 / 无公开视频）' : ''} ${error || ''}`);
          info('  → 这台机器的出口 IP 被 TikTok 拦了。可尝试给 TIKTOK_PROXY 配一个可用的境外出口。');
        }
      } catch (e) {
        bad(`抓取异常：${e.message}`);
        if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(e.message)) {
          info('  → 浏览器没装：先跑 npx playwright install --with-deps chromium');
        }
      } finally {
        if (browser) { try { await browser.close(); } catch (_) { /* ignore */ } }
      }
    }
  }

  // ── 结论 ──────────────────────────────────────────────────
  console.log('');
  if (problems === 0) {
    console.log('结论：全部通过 —— 这台机器可以承担无人值守的定时同步。');
    process.exit(0);
  } else {
    console.log(`结论：有 ${problems} 项未通过（见上面 [FAIL]），先解决再考虑托管。`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('烟雾测试异常终止：', e && e.stack ? e.stack : e);
  process.exit(1);
});
