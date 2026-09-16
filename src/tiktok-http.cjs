/**
 * TikTok 纯 HTTP 抓取通道（不需要浏览器）
 *
 * 背景：TikTok 会对机房 IP「降级」—— 主页壳能打开，但页面用来取作品列表的
 * `/api/post/item_list/` 接口只返回空响应，导致浏览器抓到 0 条。
 * GitHub Actions 的机房 IP 稳定命中这个降级，所以浏览器方案在云端不可用。
 *
 * 实测发现两条不吃 IP 信誉的通道（都走官方 SSR，纯 HTTP 就能拿）：
 *
 *   1. 嵌入页  https://www.tiktok.com/embed/@<账号>
 *      给外站 iframe 用的页面，SSR 直出最近 10 条作品，含 id / desc / playCount。
 *      ⚠️ 硬上限 10 条，且没有分页（实测滚动、?page=/?cursor= 均无效）。
 *
 *   2. 视频页  https://www.tiktok.com/@<账号>/video/<视频ID>
 *      SSR 里带完整 stats：playCount / diggCount / commentCount / createTime。
 *
 * 组合用法：用嵌入页拿「最近 10 条的 ID」，再逐个视频页补齐「发布时间 + 点赞数」，
 * 拼成与浏览器抓取完全一致的数据结构。
 *
 * 局限：只能覆盖每个账号「最近 10 条」。更早的作品云端拿不到，
 * 需要本地守护进程（带可用代理的浏览器通道）补位。
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 解析代理地址（TIKTOK_PROXY / config.proxy）→ 字符串或 null */
function resolveProxy(config = {}) {
  const p = process.env.TIKTOK_PROXY || config.proxy || '';
  return p ? String(p).trim() : null;
}

function normalizeUsername(u) {
  return String(u || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
    .replace(/\/.*$/, '');
}

/** 按指定时区把秒级时间戳格式化成 YYYY-MM-DD */
function localDate(ts, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
}

/**
 * 经 HTTP 代理（CONNECT 隧道）发 HTTPS GET —— 零依赖版 ProxyAgent。
 *
 * 为什么不用 NODE_USE_ENV_PROXY：实测 Node 22.22.2 里该环境变量不生效
 * （fetch 依然直连），它要到 Node 24 才可用；装 undici 又要动 package-lock。
 * 用 node:http 的 CONNECT + node:https 的 createConnection 即可，
 * 响应解析完全走 Node 自带的 HTTP parser（chunked 等都自动处理）。
 */
function proxiedHttpsGet(url, proxy, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout ?? 20000;
    const target = new URL(url);
    let p;
    try {
      p = new URL(proxy);
    } catch {
      return reject(new Error(`代理地址不合法: ${proxy}`));
    }

    const connectReq = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      timeout,
    });
    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`));
      }
      const headers = {
        Host: target.hostname,
        'User-Agent': opts.userAgent || DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'close',
        ...(opts.referer ? { Referer: opts.referer } : {}),
      };
      const req = https.request({
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
        // 注意：这里刻意不设 agent（连 false 都不行）——设了 agent:false
        // Node 会新建默认 Agent 走自己的 TCP/TLS，忽略 createConnection，
        // 请求就绕开隧道直连了（实测 ECONNREFUSED）。只有完全不传 agent，
        // per-request 的 createConnection 才会生效。
        createConnection: () => tls.connect({ socket, servername: target.hostname }),
        timeout,
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('error', reject);
        r.on('end', () => {
          let buf = Buffer.concat(chunks);
          try {
            const enc = String(r.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch { /* 解压失败就按原文返回，宁可乱码也不中断 */ }
          resolve({ status: r.statusCode, text: buf.toString('utf8') });
        });
        r.on('close', () => { socket.destroy(); });
      });
      req.on('timeout', () => req.destroy(new Error(`响应超时（>${timeout}ms）`)));
      req.on('error', (e) => { socket.destroy(); reject(e); });
      req.end();
    });
    connectReq.once('timeout', () => connectReq.destroy(new Error(`代理连接超时（>${timeout}ms）`)));
    connectReq.once('error', reject);
    connectReq.end();
  });
}

async function httpGet(url, opts = {}) {
  // 配了代理就走 CONNECT 隧道（本机没有境外直连能力）；
  // 云端 runner 不配代理，继续走原生 fetch 直连。
  const proxy = opts.proxy || null;
  if (proxy) return proxiedHttpsGet(url, proxy, opts);

  const timeout = opts.timeout ?? 20000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': opts.userAgent || DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.referer ? { Referer: opts.referer } : {}),
      },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 取出页面里带 id 的 <script> JSON 块 */
function extractScriptJson(html, id) {
  const re = new RegExp('<script[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</script>');
  const m = re.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 在 FRONTITY 状态树里找出带 videoList 的那个节点 */
function findVideoListNode(state) {
  const data = state && state.source && state.source.data;
  if (!data || typeof data !== 'object') return null;
  for (const key of Object.keys(data)) {
    const node = data[key];
    if (node && Array.isArray(node.videoList)) return { node, key };
  }
  return null;
}

/** 解析视频页 SSR 里的作品详情 */
function parseVideoDetail(html) {
  const universal = extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const scope = universal && universal.__DEFAULT_SCOPE__;
  const detail = scope && scope['webapp.video-detail'];
  const item = detail && detail.itemInfo && detail.itemInfo.itemStruct;
  if (item) {
    const st = item.stats || {};
    return {
      id: String(item.id),
      desc: item.desc || '',
      createTime: item.createTime ?? null,
      plays: typeof st.playCount === 'number' ? st.playCount : null,
      likes: typeof st.diggCount === 'number' ? st.diggCount : null,
      comments: typeof st.commentCount === 'number' ? st.commentCount : null,
      shares: typeof st.shareCount === 'number' ? st.shareCount : null,
      authorUniqueId: (item.author && item.author.uniqueId) || '',
    };
  }
  // 兜底：页面结构变化时用正则苟一下
  const num = (k) => {
    const m = new RegExp('"' + k + '"\\s*:\\s*(\\d+)').exec(html);
    return m ? Number(m[1]) : null;
  };
  const plays = num('playCount');
  if (plays === null) return null;
  const descM = /"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
  let desc = '';
  if (descM) {
    try {
      desc = JSON.parse('"' + descM[1] + '"');
    } catch {
      desc = descM[1];
    }
  }
  return {
    id: null,
    desc,
    createTime: num('createTime'),
    plays,
    likes: num('diggCount'),
    comments: num('commentCount'),
    shares: num('shareCount'),
    authorUniqueId: '',
  };
}

/** 解析嵌入页，取出 SSR 里的作品列表 */
function parseEmbedProfile(html) {
  const state = extractScriptJson(html, '__FRONTITY_CONNECT_STATE__');
  const found = findVideoListNode(state);
  if (!found) return null;
  const node = found.node;
  return {
    routeKey: found.key,
    page: node.page,
    playlistType: node.playlistType,
    playlistId: node.playlistId,
    videos: (node.videoList || []).filter((v) => v && v.id),
  };
}

/**
 * 用纯 HTTP 抓一个账号的近期作品
 * @returns {Promise<{username, videos, degraded, error, source}>}
 */
async function fetchAccountVideosHttp(username, config = {}) {
  const uname = normalizeUsername(username);
  const tz = config.timezone || 'Asia/Shanghai';
  const delay = config.httpDelayMs ?? 350;
  const proxy = resolveProxy(config);

  const embedRes = await httpGet(`https://www.tiktok.com/embed/@${uname}`, {
    referer: 'https://www.tiktok.com/',
    timeout: config.httpTimeoutMs ?? 20000,
    proxy,
  });
  if (embedRes.status !== 200) {
    throw new Error(`嵌入页返回 HTTP ${embedRes.status}`);
  }
  const profile = parseEmbedProfile(embedRes.text);
  if (!profile) {
    throw new Error('嵌入页里没有 videoList（账号不存在、非公开，或页面结构变了）');
  }

  const raw = profile.videos;
  const videos = [];
  const detailErrors = [];

  for (const item of raw) {
    const url = `https://www.tiktok.com/@${uname}/video/${item.id}`;
    let detail = null;
    try {
      const r = await httpGet(url, {
        referer: `https://www.tiktok.com/@${uname}`,
        timeout: config.httpTimeoutMs ?? 20000,
        proxy,
      });
      if (r.status === 200) detail = parseVideoDetail(r.text);
      else detailErrors.push(`${item.id} → HTTP ${r.status}`);
    } catch (e) {
      detailErrors.push(`${item.id} → ${e.message}`);
    }

    const ct = detail ? detail.createTime : null;
    videos.push({
      id: String(item.id),
      title: (detail && detail.desc) || item.desc || '',
      createTime: ct ?? null,
      createDate: ct ? localDate(ct, tz) : null,
      createIso: ct ? new Date(ct * 1000).toISOString() : null,
      url,
      plays:
        detail && detail.plays !== null && detail.plays !== undefined
          ? detail.plays
          : item.playCount ?? null,
      likes: detail ? detail.likes : null,
      author: uname,
    });

    if (delay) await sleep(delay);
  }

  return {
    username: uname,
    videos,
    degraded: videos.length === 0,
    error: null,
    source: 'http-embed',
    httpDetailErrors: detailErrors,
  };
}

/** 只取单个视频的实时数据（刷新播放量/点赞数用，最省） */
async function fetchVideoStatsHttp(username, videoId, config = {}) {
  const uname = normalizeUsername(username);
  const r = await httpGet(`https://www.tiktok.com/@${uname}/video/${videoId}`, {
    timeout: config.httpTimeoutMs ?? 20000,
    proxy: resolveProxy(config),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const d = parseVideoDetail(r.text);
  if (!d) throw new Error('页面里没有 stats（可能已删除或结构变化）');
  return d;
}

module.exports = {
  fetchAccountVideosHttp,
  fetchVideoStatsHttp,
  parseEmbedProfile,
  parseVideoDetail,
  localDate,
  normalizeUsername,
  httpGet,
  resolveProxy,
  DEFAULT_UA,
};
