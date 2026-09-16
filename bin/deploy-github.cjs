#!/usr/bin/env node
'use strict';

/**
 * 一键部署到 GitHub Actions（完全免费）
 * ============================================================
 * 把「抓 TikTok + 写回飞书表格」搬到 GitHub 云端跑，
 * 之后你自己的电脑关机、换电脑都不影响。
 *
 * 用法：
 *   node bin/deploy-github.cjs
 *   node bin/deploy-github.cjs --repo-name my-tiktok-sync
 *   node bin/deploy-github.cjs --skip-smoke      # 只部署，不跑烟雾测试
 *
 * 也可以用环境变量喂入敏感值（不经过交互输入）：
 *   DEPLOY_GH_TOKEN=<github token>
 *   DEPLOY_FEISHU_SECRET=<飞书 App Secret>
 *   DEPLOY_FEISHU_APP_ID=<飞书 App ID>     （默认从 lark-cli 配置里读）
 *
 * 脚本是幂等的：中途失败可以直接重跑，已完成的步骤会自动跳过。
 * ============================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GH_VERSION = '2.101.0'; // 自动下载 gh CLI 时使用的版本

// ────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);

const log = (s = '') => process.stdout.write(s + '\n');
const ok = (s) => log(`  ${green('[OK]')}   ${s}`);
const bad = (s) => log(`  ${red('[!!]')}   ${s}`);
const warn = (s) => log(`  ${yellow('[??]')}   ${s}`);
const info = (s) => log(`  ${dim('·')}      ${s}`);

function step(n, total, title) {
  log('');
  log(bold(cyan(`[${n}/${total}] ${title}`)));
  log(dim('  ' + '─'.repeat(56)));
}

function banner() {
  log('');
  log(bold('  TikTok 表格同步 — 一键部署到 GitHub 云端'));
  log(dim('  全程免费：公开仓库的 Actions 不限时长、不计费'));
  log('');
}

// ────────────────────────────────────────────────────────────
// 进程 / 交互
// ────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    input: opts.input,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout || 300000,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
  };
}

/** 非交互环境：从管道安全读一行（流提前结束也不会挂死） */
function readPipeLine() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded) return resolve('');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.pause();
      } catch (_) {}
      resolve(v);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (d) => done(String(d).split('\n')[0].trim()));
    process.stdin.once('end', () => done(''));
    process.stdin.once('error', () => done(''));
  });
}

/** 可见输入 */
function ask(prompt) {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt + '\n  ');
    return readPipeLine();
  }
  process.stdout.write(prompt);
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('', (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

/** 隐藏输入（密钥类），终端下不回显任何字符 */
function askSecret(prompt) {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt + dim('（非交互环境，输入会明文显示）') + '\n  ');
    return readPipeLine();
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (c === '\u0003') {
          // Ctrl+C
          cleanup();
          process.stdout.write('\n' + yellow('  已取消。') + '\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        if (c === '\u001b') continue; // 忽略方向键等转义序列起始
        if (c >= ' ') buf += c;
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      try {
        process.stdin.setRawMode(false);
      } catch (_) {}
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

/** 是否继续（y/N） */
async function confirm(prompt, def = false) {
  const a = (await ask(`${prompt} ${dim(def ? '[Y/n]' : '[y/N]')} `)).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes' || a === '是';
}

// ────────────────────────────────────────────────────────────
// 本地配置
// ────────────────────────────────────────────────────────────
function loadLocalConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadCliAppId() {
  try {
    const p = path.join(os.homedir(), '.lark-cli', 'config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (c.apps && c.apps[0] && c.apps[0].appId) || '';
  } catch (_) {
    return '';
  }
}

// ────────────────────────────────────────────────────────────
// gh CLI
// ────────────────────────────────────────────────────────────
function findGh() {
  const candidates = [
    process.env.GH_BIN,
    path.join(os.homedir(), '.workbuddy', 'binaries', 'gh', 'bin', 'gh.exe'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'gh', 'bin', 'gh'),
    'gh',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (r.status === 0) return c;
    } catch (_) {}
  }
  return null;
}

function ensureGh(proxy) {
  const found = findGh();
  if (found) return found;

  warn('本机没有 gh 命令行工具，正在自动下载（约 15 MB，只下一次）…');
  const dir = path.join(os.homedir(), '.workbuddy', 'binaries', 'gh');
  fs.mkdirSync(dir, { recursive: true });

  const isWin = process.platform === 'win32';
  const asset = isWin
    ? `gh_${GH_VERSION}_windows_amd64.zip`
    : `gh_${GH_VERSION}_linux_amd64.tar.gz`;
  const url = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${asset}`;
  const file = path.join(dir, asset);

  // 用 curl 下载：它会自动读取 HTTPS_PROXY
  const env = { ...process.env };
  if (proxy && !env.HTTPS_PROXY && !env.https_proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
  }
  const dl = spawnSync('curl', ['-L', '--fail', '--max-time', '600', '-o', file, url], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 620000,
    windowsHide: true,
  });
  if (dl.status !== 0 || !fs.existsSync(file)) {
    bad('下载 gh 失败。请手动下载后设置环境变量 GH_BIN 指向 gh 可执行文件。');
    info(`下载地址：${url}`);
    return null;
  }

  const ex = isWin
    ? spawnSync('unzip', ['-o', '-q', file, '-d', dir], { encoding: 'utf8', windowsHide: true })
    : spawnSync('tar', ['-xzf', file, '-C', dir], { encoding: 'utf8', windowsHide: true });
  if (ex.status !== 0) {
    bad('解压 gh 失败。请手动解压后设置 GH_BIN。');
    return null;
  }

  const bin = findGh();
  if (bin) ok('gh 已就绪');
  return bin;
}

function gh(ghBin, args, opts = {}) {
  return run(ghBin, args, opts);
}

// ────────────────────────────────────────────────────────────
// 飞书
// ────────────────────────────────────────────────────────────
const FEISHU_ERR = {
  99991672: '应用没有开通多维表格权限（bitable:app）',
  99991663: 'App ID 或 App Secret 不正确',
  99991661: 'App Secret 不正确',
  91403: '应用没有被加进这张多维表格的协作者',
  1254303: '应用没有被加进这张多维表格的协作者',
  1254005: '表格坐标（baseToken / tableId）不正确',
};

function feishuHint(code, msg) {
  const hint = FEISHU_ERR[code];
  return hint ? `${msg || ''} → ${hint}` : `${msg || ''}（code=${code}）`;
}

async function feishuTenantToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(feishuHint(j.code, j.msg));
  return j.tenant_access_token;
}

async function feishuCountRecords(token, baseToken, tableId) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (j.code !== 0) throw new Error(feishuHint(j.code, j.msg));
  return (j.data && j.data.total) || 0;
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────
const TOTAL = 7;

async function main() {
  banner();

  const argv = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const repoName = getArg('--repo-name', 'tiktok-link-sync');
  const skipSmoke = argv.includes('--skip-smoke');

  // ── 1. 环境自检 ─────────────────────────────────────────
  step(1, TOTAL, '环境自检');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    bad(`Node 版本过低（${process.versions.node}），需要 18 以上`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);

  const gitV = run('git', ['--version']);
  if (gitV.status !== 0) {
    bad('本机找不到 git');
    process.exit(1);
  }
  ok(gitV.stdout);

  const cfg = loadLocalConfig();
  if (!cfg || !cfg.feishu || !cfg.feishu.baseToken || !cfg.feishu.tableId) {
    bad('读不到 config.json 里的飞书表格坐标（feishu.baseToken / feishu.tableId）');
    info('请确认当前目录是本项目根目录，且 config.json 存在。');
    process.exit(1);
  }
  ok('已读到表格坐标（不会打印出来）');

  const proxy = (cfg && cfg.proxy) || process.env.HTTPS_PROXY || '';

  const ghBin = ensureGh(proxy);
  if (!ghBin) process.exit(1);
  ok(`gh 命令就绪：${ghBin}`);

  // 确认 git 仓库干净
  const dirty = run('git', ['status', '--porcelain']);
  if (dirty.stdout) {
    warn('工作区有未提交的改动，将一并推送：');
    dirty.stdout.split('\n').slice(0, 8).forEach((l) => info(l));
    if (!(await confirm('  继续？', true))) process.exit(0);
    run('git', ['add', '-A']);
    const c = run('git', ['commit', '-m', '部署前自动提交']);
    if (c.status === 0) ok('已自动提交');
  } else {
    ok('工作区干净');
  }

  const branch = run('git', ['branch', '--show-current']).stdout || 'main';
  ok(`当前分支：${branch}`);

  // ── 2. 收集凭证 ─────────────────────────────────────────
  step(2, TOTAL, '收集凭证');

  let appId = process.env.DEPLOY_FEISHU_APP_ID || loadCliAppId();
  if (appId) {
    ok(`飞书 App ID：${appId}${process.env.DEPLOY_FEISHU_APP_ID ? '（来自环境变量）' : '（自动读取）'}`);
  } else {
    warn('没能自动读到飞书 App ID');
    appId = await ask('  请粘贴飞书 App ID（cli_ 开头）：');
    if (!appId) {
      bad('App ID 不能为空');
      process.exit(1);
    }
  }

  let appSecret = process.env.DEPLOY_FEISHU_SECRET || '';
  if (appSecret) {
    ok('飞书 App Secret：已从环境变量读取');
  } else {
    log('');
    log('  ' + bold('去飞书开放平台拿 App Secret：'));
    log(`    ${cyan(`https://open.feishu.cn/app/${appId}/baseinfo`)}`);
    log('    → 页面里「应用凭证」区域的 App Secret → 点「查看」→ 复制');
    log('');
    appSecret = await askSecret('  粘贴 App Secret（输入时不显示，粘贴后直接回车）：');
    if (!appSecret) {
      bad('App Secret 不能为空');
      process.exit(1);
    }
    ok('已收到 App Secret');
  }

  let ghToken = process.env.DEPLOY_GH_TOKEN || '';
  if (ghToken) {
    ok('GitHub 令牌：已从环境变量读取');
  } else {
    log('');
    log('  ' + bold('去 GitHub 生成一个令牌（只需一次，用完可以撤销）：'));
    log(`    ${cyan('https://github.com/settings/tokens/new')}`);
    log('    → Note 随便填，比如 tiktok-sync-deploy');
    log('    → Expiration 选 7 天或 30 天都行（部署完就能删）');
    log(`    → 勾选 ${bold('repo')}（整个大项）和 ${bold('workflow')}`);
    log('    → 页面最下面 Generate token → 复制那串 ghp_ 开头的字符');
    log('');
    ghToken = await askSecret('  粘贴 GitHub 令牌（输入时不显示）：');
    if (!ghToken) {
      bad('令牌不能为空');
      process.exit(1);
    }
    ok('已收到 GitHub 令牌');
  }

  // ── 3. 飞书权限自检 ─────────────────────────────────────
  step(3, TOTAL, '飞书应用权限自检');
  info('这一步验证「应用能不能读写你的多维表格」，不通过就先别往下走');

  let tenantToken;
  try {
    tenantToken = await feishuTenantToken(appId, appSecret);
    ok('tenant_access_token 获取成功（App ID / Secret 正确）');
  } catch (e) {
    bad(`飞书鉴权失败：${e.message}`);
    log('');
    log('  ' + bold('怎么办：'));
    log(`    1. 打开 ${cyan(`https://open.feishu.cn/app/${appId}/auth`)}`);
    log('       搜索并开通 bitable:app（查看、评论、编辑和管理多维表格）');
    log(`    2. 打开 ${cyan(`https://open.feishu.cn/app/${appId}/version`)}`);
    log('       创建版本 → 申请发布（权限必须发布版本后才生效！）');
    log('    3. 打开多维表格 → 右上角「分享」→ 把应用加为「可编辑」协作者');
    log('');
    process.exit(1);
  }

  try {
    const total = await feishuCountRecords(tenantToken, cfg.feishu.baseToken, cfg.feishu.tableId);
    ok(`读取表格成功，当前 ${total} 条记录（权限 + 协作者都没问题）`);
  } catch (e) {
    bad(`读写表格失败：${e.message}`);
    log('');
    log('  ' + bold('怎么办：'));
    log('    · 报「权限」→ 去开放平台开通 bitable:app 并创建版本发布');
    log('    · 报「协作者」→ 打开多维表格 → 分享 → 搜索应用名 → 加为「可编辑」');
    log('');
    process.exit(1);
  }

  // ── 4. 登录 GitHub + 建仓库 ─────────────────────────────
  step(4, TOTAL, '登录 GitHub 并创建公开仓库');

  const auth = gh(ghBin, ['auth', 'login', '--with-token'], { input: ghToken + '\n' });
  if (auth.status !== 0) {
    bad('GitHub 令牌无效或权限不足');
    info(auth.stderr || auth.stdout);
    process.exit(1);
  }
  ok('令牌有效');

  const me = gh(ghBin, ['api', 'user', '-q', '.login']);
  if (me.status !== 0 || !me.stdout) {
    bad('无法读取 GitHub 账号信息');
    info(me.stderr);
    process.exit(1);
  }
  const login = me.stdout.split('\n')[0].trim();
  ok(`已登录：${login}`);

  gh(ghBin, ['auth', 'setup-git']); // 让 git push 也走这个令牌

  const full = `${login}/${repoName}`;
  const exists = gh(ghBin, ['repo', 'view', full, '--json', 'name']);

  if (exists.status === 0) {
    warn(`仓库 ${full} 已存在，跳过创建，稍后直接推送最新代码`);
    const remote = run('git', ['remote', 'get-url', 'origin']);
    if (remote.status !== 0) {
      run('git', ['remote', 'add', 'origin', `https://github.com/${full}.git`]);
      ok('已绑定远程仓库');
    } else if (!remote.stdout.includes(full)) {
      run('git', ['remote', 'set-url', 'origin', `https://github.com/${full}.git`]);
      ok('已更新远程仓库地址');
    }
  } else {
    const create = gh(ghBin, [
      'repo',
      'create',
      repoName,
      '--public',
      '--source',
      '.',
      '--remote',
      'origin',
      '--push',
      '--description',
      '按账号+标题+日期自动补全 TikTok 视频链接并回填飞书多维表格（GitHub Actions 云端定时同步）',
    ]);
    if (create.status !== 0) {
      bad('创建仓库失败');
      info(create.stderr || create.stdout);
      log('');
      info('常见原因：令牌没勾 repo 权限；或该用户名下已有同名仓库。');
      process.exit(1);
    }
    ok(`已创建公开仓库 ${full} 并推送代码`);
  }
  log(`  仓库地址：${cyan(`https://github.com/${full}`)}`);

  // ── 5. 推送代码 ─────────────────────────────────────────
  step(5, TOTAL, '推送代码');

  const push = run('git', ['push', '-u', 'origin', branch]);
  if (push.status !== 0) {
    // 很多网络环境需要走代理才能 push
    warn('直连推送失败，尝试通过本机代理推送…');
    if (proxy) {
      run('git', ['config', `http.https://github.com.proxy`, proxy]);
      const push2 = run('git', ['push', '-u', 'origin', branch]);
      if (push2.status !== 0) {
        bad('推送仍然失败');
        info(push2.stderr);
        log('');
        info(`手动重试：git push -u origin ${branch}`);
        process.exit(1);
      }
      ok('已通过代理推送成功');
    } else {
      bad('推送失败');
      info(push.stderr);
      process.exit(1);
    }
  } else {
    ok(`已推送到 origin/${branch}`);
  }

  // ── 6. 写入 Secrets ─────────────────────────────────────
  step(6, TOTAL, '写入仓库密钥（Secrets）');

  const secrets = [
    ['FEISHU_APP_ID', appId],
    ['FEISHU_APP_SECRET', appSecret],
    ['FEISHU_BASE_TOKEN', cfg.feishu.baseToken],
    ['FEISHU_TABLE_ID', cfg.feishu.tableId],
  ];

  // 只有公网代理才写进云端；本机回环地址（127.0.0.1）云端用不了
  const isLoopback = /(127\.0\.0\.1|localhost|::1)/i.test(proxy);
  if (proxy && !isLoopback) {
    secrets.push(['TIKTOK_PROXY', proxy]);
    ok('检测到公网代理，已一并写入 TIKTOK_PROXY');
  } else if (proxy) {
    info('本机代理是回环地址，云端用不了，不写入 TIKTOK_PROXY（云端直连 TikTok）');
  }

  for (const [name, value] of secrets) {
    const r = gh(ghBin, ['secret', 'set', name, '--repo', full, '--body', value]);
    if (r.status !== 0) {
      bad(`写入 ${name} 失败`);
      info(r.stderr || r.stdout);
      process.exit(1);
    }
    ok(`已写入 ${name}`);
  }

  // ── 7. 触发烟雾测试 ─────────────────────────────────────
  step(7, TOTAL, '在 GitHub 上跑第一轮连通性测试');

  if (skipSmoke) {
    warn('已跳过（--skip-smoke）。去 Actions 页面手动 Run workflow 即可。');
    return finish(full);
  }

  info('测试内容：GitHub 机房能否直连 TikTok、飞书权限是否通、能否真的抓到视频');
  info('首次运行要下载浏览器，大约 3~5 分钟，请耐心等');

  const trigger = gh(ghBin, [
    'workflow',
    'run',
    'tiktok-sync.yml',
    '-f',
    'mode=smoke-only',
    '--repo',
    full,
  ]);
  if (trigger.status !== 0) {
    bad('触发测试失败');
    info(trigger.stderr || trigger.stdout);
    log('');
    info('可能原因：代码还没推上去，或 workflow 文件不在默认分支。');
    info(`手动触发：${cyan(`https://github.com/${full}/actions`)} → 左侧选工作流 → Run workflow`);
    return finish(full);
  }
  ok('已触发');

  // 等运行实例出现
  let runId = '';
  for (let i = 0; i < 12 && !runId; i++) {
    await sleep(5000);
    const r = gh(ghBin, [
      'run',
      'list',
      '--repo',
      full,
      '--workflow',
      'tiktok-sync.yml',
      '--limit',
      '1',
      '--json',
      'databaseId,status',
    ]);
    try {
      const arr = JSON.parse(r.stdout || '[]');
      if (arr[0] && arr[0].databaseId) runId = String(arr[0].databaseId);
    } catch (_) {}
  }

  if (!runId) {
    warn('没能拿到运行编号，请自己去 Actions 页面看结果');
    return finish(full);
  }
  ok(`运行编号 #${runId}`);

  // 轮询到结束（最多 12 分钟）
  let conclusion = '';
  let status = '';
  const deadline = Date.now() + 12 * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    await sleep(15000);
    tick++;
    const r = gh(ghBin, ['run', 'view', runId, '--repo', full, '--json', 'status,conclusion']);
    try {
      const j = JSON.parse(r.stdout || '{}');
      status = j.status || '';
      conclusion = j.conclusion || '';
    } catch (_) {}
    if (status === 'completed') break;
    process.stdout.write(`\r  ${dim(`·`)}      运行中… ${Math.round((tick * 15) / 60)} 分 ${(tick * 15) % 60} 秒（首次要装浏览器，慢是正常的）   `);
  }
  process.stdout.write('\r' + ' '.repeat(90) + '\r');
  log('');

  if (status !== 'completed') {
    warn('等超时了，去 Actions 页面看最终结果');
    return finish(full);
  }

  // 抓关键日志行
  const lr = gh(ghBin, ['run', 'view', runId, '--repo', full, '--log']);
  const lines = (lr.stdout || '')
    .split('\n')
    .filter((l) =>
      /\[(OK|FAIL|WARN)\]|出口 IP|tenant_access_token|读取表格|抓取|被降级|风控|Error|错误/.test(l)
    )
    .map((l) => l.replace(/^\S+\s+\S+\s+\S+\s+/, '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, ''));

  if (lines.length) {
    log('  ' + bold('测试输出：'));
    lines.slice(-24).forEach((l) => log('    ' + l));
    log('');
  }

  if (conclusion === 'success') {
    ok(green(bold('测试通过 —— 这套方案在你这里可行！')));
  } else {
    bad(`测试未通过（${conclusion || '未知'}）`);
    log('');
    log('  ' + bold('大概率是这两种情况之一：'));
    log('    · 「抓取返回 0 条（被降级 / 风控）」→ GitHub 机房 IP 被 TikTok 拦了，');
    log('      需要给 TIKTOK_PROXY 填一个公网可达的代理，或退回本机常驻方案');
    log('    · 飞书报权限错 → 开放平台权限没发布版本，或应用没加协作者');
    log('');
    log(`  完整日志：${cyan(`https://github.com/${full}/actions/runs/${runId}`)}`);
  }

  finish(full);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function finish(full) {
  log('');
  log(bold('  ────────────────────────────────────────────────────────'));
  log(bold('  接下来'));
  log('');
  log(`  1. 打开 ${cyan(`https://github.com/${full}/actions`)} 看运行结果`);
  log('  2. 只要烟雾测试是 [OK]，之后它会自己每 30 分钟跑一轮，不用管');
  log('  3. 想立刻手动跑一次：Actions → 选中工作流 → Run workflow → sync');
  log('  4. 云端确认没问题后，建议停掉本机守护进程，避免两边重复抓 TikTok：');
  log(`     ${dim('npm run watch:stop')}`);
  log('     想保留「按钮 60 秒响应」又不想和云端打架，就用：');
  log(`     ${dim('npm run watch:stop && npm run watch:start -- --stats-every 0')}`);
  log('');
  log('  注意：这个令牌现在存在本机 gh 配置里，不用了可以这样撤销：');
  log(`     ${dim('gh auth logout')}  ${dim('（令牌本体去 GitHub 设置页 Delete）')}`);
  log('');
}

main().catch((e) => {
  log('');
  bad(`出错了：${e && e.message ? e.message : e}`);
  if (e && e.stack) log(dim(e.stack.split('\n').slice(1, 4).join('\n')));
  process.exit(1);
});
