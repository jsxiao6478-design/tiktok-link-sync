#!/usr/bin/env node
'use strict';

/**
 * 第二轮数据源探测 —— 专攻「怎么在机房 IP 上拿到某账号的作品列表」。
 *
 * 第一轮结论：oEmbed 可用、tikwm 单视频详情可用，但所有「列表」通道都被拦。
 * 本轮的候选（按可行性排序）：
 *   1. TikTok 官方嵌入页 /embed/@user —— 给外部网站用的，反爬通常最松
 *   2. 视频页 SSR HTML —— 单个视频的详情（播放/点赞）能不能纯 HTTP 拿到
 *   3. 网页 item_list 接口直接裸调（带 secUid）
 *   4. tikwm 换域名/换请求头，试图绕过 Cloudflare
 *   5. 通用公共反代（allorigins / codetabs）套在网页 SSR 上
 *
 *   node bin/diag-sources2.cjs [账号] [样本视频ID]
 */

const USER = process.argv[2] || 'carlosmendoz89';
const VIDEO_ID = process.argv[3] || '7685947685349657864';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const line = (s = '') => console.log(s);
const head = (s) => line('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 58 - s.length)));

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const msg = await fn();
    line(`[OK]   ${label}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  ${msg || ''}`);
    return true;
  } catch (e) {
    line(`[FAIL] ${label}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  ${String(e.message).slice(0, 130)}`);
    return false;
  }
}

async function req(url, headers = {}, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

/** 从任意 HTML 里数作品：优先看视频链接，其次看 19 位 ID */
function countFromHtml(html) {
  const hrefs = new Set([...html.matchAll(/\/video\/(\d{17,20})/g)].map((m) => m[1]));
  const itemListMatch = /"itemList"\s*:\s*\[([\s\S]*?)\]\s*[,}]/.exec(html);
  const inItemList = itemListMatch ? [...itemListMatch[1].matchAll(/"id"\s*:\s*"(\d{17,20})"/g)].map((m) => m[1]) : [];
  const descs = [...html.matchAll(/"desc"\s*:\s*"([^"]{5,120})"/g)].map((m) => m[1]);
  return {
    hrefIds: hrefs.size,
    itemListIds: new Set(inItemList).size,
    descs: descs.length,
    sampleDesc: descs[0] || '',
    hasPlayCount: /"playCount"\s*:\s*\d+/.test(html),
    hasDiggCount: /"diggCount"\s*:\s*\d+/.test(html),
  };
}

(async () => {
  line('第二轮：TikTok 列表通道探测');
  line(`账号：@${USER}   样本视频：${VIDEO_ID}`);
  line(`出口 IP：${await req('https://api.ipify.org').then((r) => r.text).catch(() => '?')}`);

  // ── 1. 嵌入页 ────────────────────────────────────────────
  head('1. 官方嵌入页（给外站用的，反爬最松）');
  for (const u of [
    `https://www.tiktok.com/embed/@${USER}`,
    `https://www.tiktok.com/embed/v2/@${USER}`,
    `https://www.tiktok.com/embed/${VIDEO_ID}`,
  ]) {
    await timed(u.replace('https://www.tiktok.com/', ''), async () => {
      const r = await req(u, { Referer: 'https://www.tiktok.com/' });
      if (r.status !== 200) throw new Error(`HTTP ${r.status} len=${r.text.length}`);
      const c = countFromHtml(r.text);
      line(`       状态=${r.status} 长度=${r.text.length} /video/链接=${c.hrefIds} itemList=${c.itemListIds} desc=${c.descs} playCount=${c.hasPlayCount}`);
      if (!c.hrefIds && !c.itemListIds) throw new Error(`200 但无作品（长度 ${r.text.length}）`);
      return `作品链接 ${c.hrefIds} 条`;
    });
  }

  // ── 2. 视频页 SSR ────────────────────────────────────────
  head('2. 单个视频页 SSR（纯 HTTP 能否拿到播放/点赞）');
  await timed(`video ${VIDEO_ID}`, async () => {
    const r = await req(`https://www.tiktok.com/@${USER}/video/${VIDEO_ID}`, {
      'Accept-Language': 'en-US,en;q=0.9',
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const c = countFromHtml(r.text);
    const plays = /"playCount"\s*:\s*(\d+)/.exec(r.text);
    const diggs = /"diggCount"\s*:\s*(\d+)/.exec(r.text);
    const desc = /"desc"\s*:\s*"([^"]{5,80})"/.exec(r.text);
    line(`       长度=${r.text.length} playCount=${plays ? plays[1] : '无'} diggCount=${diggs ? diggs[1] : '无'}`);
    line(`       desc=${desc ? desc[1].slice(0, 50) : '无'}   作者相关视频链接=${c.hrefIds}`);
    if (!plays) throw new Error('无 playCount');
    return '可拿播放/点赞';
  });

  // ── 3. 网页列表接口裸调 ──────────────────────────────────
  head('3. 网页 item_list 接口裸调（带 secUid，无签名）');
  const home = await req(`https://www.tiktok.com/@${USER}`).catch(() => null);
  const secUid = home ? (/\"secUid\"\s*:\s*\"([^\"]+)\"/.exec(home.text) || [])[1] : '';
  if (secUid) {
    await timed('api/post/item_list (最小参数)', async () => {
      const u =
        `https://www.tiktok.com/api/post/item_list/?aid=1988&count=35&cursor=0` +
        `&secUid=${encodeURIComponent(secUid)}&app_language=en&app_name=tiktok_web&browser_language=en-US` +
        `&browser_name=Mozilla&browser_platform=Win32&channel=tiktok_web&cookie_enabled=true` +
        `&device_platform=web_pc&os=windows&priority_region=&region=US&screen_height=1080&screen_width=1920`;
      const r = await req(u, { Accept: 'application/json, text/plain, */*', Referer: `https://www.tiktok.com/@${USER}` });
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch {
        /* noop */
      }
      if (!j) throw new Error(`HTTP ${r.status} 非 JSON（${r.text.slice(0, 80)}）`);
      const n = (j.itemList || []).length;
      line(`       statusCode=${j.statusCode} itemList=${n} hasMore=${j.hasMore}`);
      if (!n) throw new Error(`statusCode=${j.statusCode} 空列表`);
      line(`       首条 id=${j.itemList[0].id} desc=${String(j.itemList[0].desc || '').slice(0, 40)}`);
      line(`       stats: play=${j.itemList[0].stats && j.itemList[0].stats.playCount}`);
      return `${n} 条`;
    });
  } else {
    line('       拿不到 secUid，跳过');
  }

  // ── 4. tikwm 绕 Cloudflare ───────────────────────────────
  head('4. tikwm：换域名 / 换请求头');
  const aggHeaders = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Referer: `https://www.tikwm.com/`,
  };
  for (const u of [
    `https://www.tikwm.com/api/user/posts?unique_id=${USER}&count=35&cursor=0`,
    `https://tikwm.com/api/user/posts?unique_id=${USER}&count=35&cursor=0`,
    `https://www.tikwm.com/api/user/info?unique_id=${USER}`,
  ]) {
    await timed(u.replace('https://', '').split('?')[0], async () => {
      const r = await req(u, aggHeaders);
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch {
        /* noop */
      }
      if (!j) throw new Error(`HTTP ${r.status} 非 JSON（${r.text.slice(0, 70)}）`);
      const d = j.data;
      const n = Array.isArray(d) ? d.length : Array.isArray(d && d.videos) ? d.videos.length : d ? 1 : 0;
      line(`       code=${j.code} msg=${j.msg} 条数=${n}`);
      if (!n) throw new Error(`code=${j.code} ${j.msg || ''}`);
      return `${n}`;
    });
  }

  // ── 5. 公共反代套 SSR ───────────────────────────────────
  head('5. 公共反向代理套在网页 SSR 上（换出口 IP）');
  const target = encodeURIComponent(`https://www.tiktok.com/@${USER}`);
  for (const u of [
    `https://api.codetabs.com/v1/proxy?quest=${target}`,
    `https://api.allorigins.win/raw?url=${target}`,
  ]) {
    await timed(u.slice(0, 46), async () => {
      const r = await req(u, {}, 40000);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const c = countFromHtml(r.text);
      line(`       长度=${r.text.length} /video/链接=${c.hrefIds} itemList=${c.itemListIds} desc=${c.descs} playCount=${c.hasPlayCount}`);
      if (!c.hrefIds && !c.itemListIds && !c.descs) throw new Error('拿到了页面但没作品数据');
      return `链接=${c.hrefIds}`;
    });
  }

  head('结论怎么读');
  line('· 第 1 项有作品链接 → 用嵌入页替代浏览器抓取（最轻量，纯 HTTP）');
  line('· 第 2 项有 playCount → 至少「刷新播放量/点赞」可以完全不用浏览器');
  line('· 第 3 项有 itemList → 直接换成裸接口，最理想');
  line('· 第 4 项有数据 → 走第三方聚合，但要知道数据可能滞后');
})();
