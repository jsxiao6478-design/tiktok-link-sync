/**
 * feishu.cjs —— 飞书多维表格读写层
 *
 * 支持两种后端，自动切换：
 *
 *   1. lark-cli（默认，本机）
 *      调用本机 lark-cli 的 Node 入口（避开 Windows 上 .cmd 的引号问题），
 *      以「用户本人身份」(--as user) 读写，写入的记录归属用户自己。
 *
 *   2. openapi（CI / 服务器）
 *      直连飞书 OpenAPI，用 app_id + app_secret 换 tenant_access_token（bot 身份）。
 *      token 有效期 2 小时、自动续期，不存在 OAuth 那种约 7 天过期的问题，
 *      且无需在目标机器上安装 lark-cli。
 *
 * 后端判定（见 backendName）：
 *   - 环境变量 FEISHU_BACKEND 显式指定 openapi / lark-cli 时以它为准；
 *   - 否则「有 app 凭证就用 openapi，否则用 lark-cli」——所以本机不配任何东西时行为完全不变。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** lark-cli 的 Node 入口（默认位置，可用 config.larkCliPath 覆盖） */
const DEFAULT_CLI_RUN = path.join(
  os.homedir(),
  '.workbuddy/binaries/node/cli-connector-packages/node_modules/@larksuite/cli/scripts/run.js'
);

const MAX_BATCH = 50; // 单次写入记录数（官方上限 200，这里留足余量避免命令行过长）
const PAGE_LIMIT = 200; // 单次读取记录数上限

function resolveCli(config) {
  const candidates = [
    config && config.larkCliPath,
    process.env.LARK_CLI_RUN,
    DEFAULT_CLI_RUN,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 调用 lark-cli，返回解析后的 JSON。
 * @param {string[]} args 参数（不含可执行文件本身）
 * @param {object} config 全局配置
 * @param {string} cwd    工作目录（相对路径参数以此为基准）
 */
function callCli(args, config, cwd) {
  const runJs = resolveCli(config);
  const bin = runJs ? process.execPath : 'lark-cli';
  const prefix = runJs ? [runJs] : [];
  let stdout;
  try {
    stdout = execFileSync(bin, [...prefix, ...args], {
      encoding: 'utf8',
      cwd: cwd || process.cwd(),
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const detail = (err && err.stdout ? String(err.stdout) : '') + (err && err.stderr ? String(err.stderr) : '');
    throw new Error(`lark-cli 调用失败：${args.join(' ')}\n${detail || err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`lark-cli 返回不是合法 JSON：\n${stdout.slice(0, 800)}`);
  }
  if (parsed.ok === false) {
    const err = parsed.error || {};
    throw new Error(`lark-cli 返回错误：${err.subtype || err.type || ''} ${err.message || ''}`.trim());
  }
  return parsed;
}

/** 取飞书配置，缺失则报错 */
function feishuConfig(config) {
  const f = config && config.feishu;
  if (!f || !f.baseToken || !f.tableId) {
    throw new Error('config.json 缺少 feishu.baseToken / feishu.tableId，请先建表并写入配置');
  }
  return f;
}

/* ─────────────────────────── openapi 后端 ─────────────────────────── */

const OPENAPI_BASE = 'https://open.feishu.cn/open-apis';
const API_TIMEOUT_MS = 60 * 1000;

/**
 * 应用凭证：环境变量优先，其次 config.feishu.appId / appSecret。
 * 注意这里**不经过 feishuConfig()**：只判断「有没有 app 凭证」不该依赖表格坐标，
 * 否则用户漏配 baseToken 时会在「判定后端」这一步就抛出一个误导性的错误。
 */
function appCreds(config) {
  const f = (config && config.feishu) || {};
  const appId = process.env.FEISHU_APP_ID || f.appId;
  const appSecret = process.env.FEISHU_APP_SECRET || f.appSecret;
  return appId && appSecret ? { appId, appSecret } : null;
}

/** 用哪个后端：'openapi' | 'lark-cli' */
function backendName(config) {
  const forced = String(process.env.FEISHU_BACKEND || '').trim().toLowerCase();
  if (forced === 'openapi' || forced === 'bot') return 'openapi';
  if (forced === 'lark-cli' || forced === 'cli' || forced === 'user') return 'lark-cli';
  return appCreds(config) ? 'openapi' : 'lark-cli';
}

/** tenant_access_token 缓存（有效期 2 小时，提前 60 秒续期） */
let tokenCache = { token: '', expireAt: 0 };

async function tenantToken(config) {
  if (tokenCache.token && tokenCache.expireAt > Date.now() + 60 * 1000) return tokenCache.token;
  const creds = appCreds(config);
  if (!creds) {
    throw new Error(
      'openapi 后端缺少应用凭证：请设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（或写进 config.feishu.appId / appSecret）'
    );
  }
  const res = await fetch(`${OPENAPI_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：code=${j.code} msg=${j.msg || res.status}`);
  }
  tokenCache = {
    token: j.tenant_access_token,
    expireAt: Date.now() + (Number(j.expire) || 7200) * 1000,
  };
  return tokenCache.token;
}

/** 带鉴权调用 OpenAPI，返回 data 段；code !== 0 抛错（附常见错误提示） */
async function callApi(config, method, pathname, body) {
  const token = await tenantToken(config);
  const res = await fetch(`${OPENAPI_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => ({}));
  if (Number(j.code) !== 0) {
    let hint = '';
    if (Number(j.code) === 99991672) {
      hint = '\n  → 应用未申请多维表格权限：去开放平台开通 bitable:app 等权限并发布版本';
    } else if (Number(j.code) === 1254303 || Number(j.code) === 91403 || res.status === 403) {
      hint = '\n  → 应用没有这张表的访问权：把应用添加为该多维表格的「可编辑」协作者';
    }
    throw new Error(`飞书 API ${pathname} 失败：code=${j.code} msg=${j.msg || res.status}${hint}`);
  }
  return j.data || {};
}

/** 字段名 → 字段类型（type 3=单选 4=多选 2=数字 5=日期 1=文本 15=url） */
const fieldTypeCache = new Map();

async function fieldTypes(config, f) {
  const key = `${f.baseToken}/${f.tableId}`;
  if (fieldTypeCache.has(key)) return fieldTypeCache.get(key);
  const map = {};
  let pageToken = '';
  let guard = 0;
  do {
    guard += 1;
    const q = new URLSearchParams({ page_size: '200' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await callApi(
      config, 'GET',
      `/bitable/v1/apps/${f.baseToken}/tables/${f.tableId}/fields?${q.toString()}`
    );
    for (const it of data.items || []) map[it.field_name] = it.type;
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken && guard < 20);
  fieldTypeCache.set(key, map);
  return map;
}

/**
 * 把内部写法转成 OpenAPI 期望的值。
 * 内部沿用 lark-cli 的习惯：单选字段也写成数组（[值]）。
 * OpenAPI 的单选字段只接受标量字符串，所以这里按字段类型解包。
 */
function coerceForApi(value, type) {
  if (value === undefined || value === null) return value;
  if (type === 3) {
    if (Array.isArray(value)) return value.length ? String(value[0]) : null;
    return String(value);
  }
  if (type === 4) {
    if (Array.isArray(value)) return value.map(String);
    return [String(value)];
  }
  // URL 字段（type=15）写入要求 {link, text} 对象；传纯字符串会触发
  // URLFieldConvFail（1254068），整批原子回滚把其它行也带挂。
  if (type === 15) {
    const s = String(value || '').trim();
    if (!s) return null;
    if (typeof value === 'object' && value.link) return value;
    return { link: s, text: s };
  }
  return value;
}

/**
 * 把多维表格的日期单元格归一化成 YYYY-MM-DD。
 * 支持：ISO 字符串（2026-09-08T12:00:00.000+08:00）、纯日期串、毫秒时间戳。
 */
function normalizeDateCell(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

/** 单元格 → 数字；空值/非数字返回 null（用于播放量、点赞数这类 number 字段） */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? numOrNull(v[0]) : null;
  if (typeof v === 'object') return numOrNull(v.value ?? v.text ?? null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 单元格 → 纯文本（select / 文本 / 数字 / 数组都能兜住） */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === 'object' ? (x.text || x.name || x.value || '') : x))
      .filter((x) => x !== '' && x !== null && x !== undefined)
      .join(' ');
  }
  if (typeof v === 'object') return v.text || v.name || '';
  return String(v);
}

/**
 * 链接样式(url)的文本字段会把内容存成 Markdown 链接 `[text](url)`，
 * 这里统一还原成裸 URL，方便程序比对与再写入。
 */
function unwrapUrl(s) {
  const t = String(s || '').trim();
  const m = t.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (m) return m[1];
  const bare = t.match(/https?:\/\/[^\s)]+/);
  return bare ? bare[0] : t;
}

/**
 * 读取整张表（自动翻页，两种后端都支持）。
 * @returns {Promise<Array<object>>} 归一化后的记录
 */
async function readRecords(config, cwd) {
  const f = feishuConfig(config);
  const cols = f.fields;
  const raw = backendName(config) === 'openapi'
    ? await readRowsOpenApi(config, f)
    : readRowsCli(config, f, cwd);
  return raw.map((r) => normalizeRecord(r, cols));
}

/** openapi 路径：记录已经是「字段名 → 值」的对象形式 */
async function readRowsOpenApi(config, f) {
  const out = [];
  let pageToken = '';
  let guard = 0;
  do {
    guard += 1;
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await callApi(
      config, 'GET',
      `/bitable/v1/apps/${f.baseToken}/tables/${f.tableId}/records?${q.toString()}`
    );
    for (const it of data.items || []) {
      out.push({ recordId: it.record_id, fields: it.fields || {} });
    }
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken && guard < 200);
  return out;
}

/**
 * lark-cli 路径：--format json 返回的是「矩阵」，每行是数组、列顺序由 data.fields 给出。
 * 这里统一转成「字段名 → 值」的对象，好让两种后端共用同一套归一化逻辑。
 */
function readRowsCli(config, f, cwd) {
  const out = [];
  let offset = 0;
  let header = null;
  let hasMore = true;
  let guard = 0;

  while (hasMore && guard < 100) {
    guard += 1;
    const res = callCli(
      [
        'base', '+record-list',
        '--as', f.as || 'user',
        '--base-token', f.baseToken,
        '--table-id', f.tableId,
        '--limit', String(PAGE_LIMIT),
        '--offset', String(offset),
        '--json',
      ],
      config, cwd
    );
    const data = res.data || {};
    if (!header) header = data.fields || [];
    const matrix = data.data || [];
    const ids = data.record_id_list || [];
    for (let i = 0; i < matrix.length; i += 1) {
      const fields = {};
      header.forEach((name, k) => { fields[name] = matrix[i][k]; });
      out.push({ recordId: ids[i], fields });
    }
    hasMore = Boolean(data.has_more);
    if (matrix.length === 0) break;
    offset += matrix.length;
  }
  return out;
}

/** 原始行 → 归一化记录（两种后端共用） */
function normalizeRecord(raw, cols) {
  const fields = raw.fields || {};
  const get = (name) => (name && Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : null);
  return {
    recordId: raw.recordId,
    // account 字段在 url-style 下读出来可能是 markdown 链接源码 [text](url)，
    // 先 unwrap 成裸 URL 再交给 normalizeAccount 抽取账号名。
    account: unwrapUrl(cellText(get(cols.account))).trim(),
    title: cellText(get(cols.title)).trim(),
    date: normalizeDateCell(get(cols.date)),
    link: unwrapUrl(cellText(get(cols.link))).trim(),
    status: cellText(get(cols.status)).trim(),
    matchedTitle: cellText(get(cols.matchedTitle)).trim(),
    hint: cellText(get(cols.hint)).trim(),
    trigger: cellText(get(cols.trigger)).trim(),
    plays: numOrNull(get(cols.plays)),
    likes: numOrNull(get(cols.likes)),
  };
}

/** 分批写临时 JSON 文件，避免 Windows 命令行长度限制 */
function writeJsonTemp(cwd, payload) {
  const dir = path.join(cwd, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tmp-write-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

/**
 * 批量回填。
 * @param {Array<{recordId:string, fields:object}>} updates
 * @returns {Promise<number>} 实际写入记录数
 */
async function updateRecords(config, updates, cwd, opts) {
  const f = feishuConfig(config);
  let list = (updates || []).filter((u) => u && u.recordId);
  if (list.length === 0) return 0;
  const useApi = backendName(config) === 'openapi';
  const types = useApi ? await fieldTypes(config, f) : null;

  // ── 防御：以线上字段清单为准，丢弃表格里不存在的字段 ──
  // 飞书 batch_update 是「原子」的：只要有一条记录引用了不存在的字段名，
  // 整批（最多 50 条）会一起回滚并抛 1254045 FieldNameNotFound。
  // 典型诱因：配置里还留着已从表格删掉（或改了名）的列 —— 比如「视频文件名」。
  // 那种情况下同步会「看起来跑了、日志也没报错」，实际一条都没写进去，很难排查。
  // 所以这里不再盲信配置，先按线上实际字段过滤，并把丢弃的字段名显式打出来。
  if (types) {
    const unknown = new Set();
    for (const u of list) {
      for (const name of Object.keys(u.fields || {})) {
        if (name && !Object.prototype.hasOwnProperty.call(types, name)) {
          unknown.add(name);
          delete u.fields[name];
        }
      }
    }
    if (unknown.size) {
      console.warn(`⚠ 表格中不存在这些字段，已跳过（否则整批会被飞书回滚）：${[...unknown].join('、')}`);
    }
    // 字段全被丢光的记录没有写入意义（飞书也不接受空 fields）
    list = list.filter((u) => Object.keys(u.fields || {}).length > 0);
    if (list.length === 0) return 0;
  }

  let written = 0;
  for (let i = 0; i < list.length; i += MAX_BATCH) {
    const chunk = list.slice(i, i + MAX_BATCH);
    if (useApi) {
      const records = chunk.map((u) => {
        const fields = {};
        for (const [name, value] of Object.entries(u.fields || {})) {
          fields[name] = coerceForApi(value, types[name]);
        }
        return { record_id: u.recordId, fields };
      });
      await callApi(
        config, 'POST',
        `/bitable/v1/apps/${f.baseToken}/tables/${f.tableId}/records/batch_update`,
        { records }
      );
      written += chunk.length;
    } else {
      const updateRecordsMap = {};
      for (const u of chunk) updateRecordsMap[u.recordId] = u.fields;
      const tmp = writeJsonTemp(cwd, { update_records: updateRecordsMap });
      try {
        const args = [
          'base', '+record-batch-update',
          '--as', f.as || 'user',
          '--base-token', f.baseToken,
          '--table-id', f.tableId,
          '--json', `@${path.relative(cwd, tmp).split(path.sep).join('/')}`,
        ];
        callCli(args, config, cwd);
        written += chunk.length;
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      }
    }
    if (opts && opts.verbose) console.log(`  已回填 ${written}/${list.length} 条`);
  }
  return written;
}

/** 删除记录（用于清理测试数据） */
async function deleteRecords(config, recordIds, cwd) {
  const f = feishuConfig(config);
  const ids = (recordIds || []).filter(Boolean);
  const useApi = backendName(config) === 'openapi';
  let deleted = 0;
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const chunk = ids.slice(i, i + MAX_BATCH);
    if (useApi) {
      await callApi(
        config, 'POST',
        `/bitable/v1/apps/${f.baseToken}/tables/${f.tableId}/records/batch_delete`,
        { records: chunk }
      );
      deleted += chunk.length;
    } else {
      const tmp = writeJsonTemp(cwd, { record_id_list: chunk });
      try {
        callCli(
          [
            'base', '+record-delete',
            '--as', f.as || 'user',
            '--base-token', f.baseToken,
            '--table-id', f.tableId,
            '--json', `@${path.relative(cwd, tmp).split(path.sep).join('/')}`,
            '--yes',
          ],
          config, cwd
        );
        deleted += chunk.length;
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      }
    }
  }
  return deleted;
}

module.exports = {
  callCli,
  feishuConfig,
  readRecords,
  updateRecords,
  deleteRecords,
  normalizeDateCell,
  cellText,
  unwrapUrl,
  backendName,
  tenantToken,
  MAX_BATCH,
};