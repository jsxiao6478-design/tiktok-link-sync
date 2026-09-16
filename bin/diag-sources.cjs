#!/usr/bin/env node
'use strict';

/**
 * 多数据源探测 —— 回答「在不依赖出口 IP 信誉的前提下，哪条路能拿到 TikTok 作品列表」。
 *
 * 背景：TikTok 会对机房 IP「降级」—— 主页壳能开，但 /api/post/item_list/ 只返回错误。
 * 本机代理池 IP 时好时坏，GitHub runner 的 Azure IP 稳定被降级。
 * 所以需要一个不吃 IP 信誉的通道。
 *
 * 逐个测试下列通道，打印可用性与数据完整度：
 *   1. 网页 SSR HTML（纯 HTTP，无浏览器）里有没有作品列表
 *   2. TikTok oEmbed（拿标题，但没有播放/点赞）
 *   3. tikwm 公开接口（第三方聚合，返回播放/点赞）
 *   4. TikTok 移动端接口 aweme/v1/aweme/post/（需要 sec_user_id）
 *   5. RSSHub 公开实例
 *
 *   node bin/diag-sources.cjs [账号] [样本视频URL]
 */

const USER = process.argv[2] || 'carlosmendoz89';
const SAMPLE_VIDEO = process.argv[3] || `https://www.tiktok.com/@${USER}/video/7685947685349657864`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function line(s = '') {
  console.log(s);
}
function head(s) {
  line('');
  line('── ' + s + ' ' + '─'.repeat(Math.max(0, 58 - s.length)));
}

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    line(`[OK]   ${label}  (${secs}s)`);
    return r;
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    line(`[FAIL] ${label}  (${secs}s)  ${String(e.message).slice(0, 140)}`);
    return null;
  }
}

async function getJson(url, headers = {}, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
    try {
      return { json: JSON.parse(txt), status: res.status, raw: txt };
    } catch {
      return { json: null, status: res.status, raw: txt };
    }
  } finally {
    clearTimeout(t);
  }
}

async function getText(url, headers = {}, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    const txt = await res.text();
    return { status: res.status, text: txt };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  line('TikTok 数据源可用性探测');
  line(`账号：@${USER}`);
  line(`出口 IP：${await getText('https://api.ipify.org').then((r) => r.text).catch(() => '?')}`);
  line(`Node：${process.version}`);

  // ── 1. 网页 SSR HTML ──────────────────────────────────────
  head('1. 网页 SSR HTML 里有没有作品列表（纯 HTTP）');
  await timed('GET /@user', async () => {
    const r = await getText(`https://www.tiktok.com/@${USER}`, { 'Accept-Language': 'en-US,en;q=0.9' });
    const html = r.text;
    const hasUniversal = html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const hasItemList = /"itemList"\s*:\s*\[/.test(html);
    const itemCount = (html.match(/"itemList"\s*:\s*\[([^\]]*)\]/) || [])[1];
    const ids = [...html.matchAll(/"id"\s*:\s*"(\d{17,20})"/g)].map((m) => m[1]);
    const videoIds = [...html.matchAll(/\/video\/(\d{17,20})/g)].map((m) => m[1]);
    line(`       HTTP ${r.status}  长度 ${html.length}`);
    line(`       UNIVERSAL_DATA=${hasUniversal}  "itemList":[ 出现=${hasItemList}`);
    if (itemCount !== undefined) line(`       itemList 长度约 ${itemCount.split(',').length}`);
    line(`       HTML 内 19 位 ID 去重数=${new Set(ids).size}  /video/ 链接去重数=${new Set(videoIds).size}`);
    return true;
  });

  // ── 2. oEmbed ─────────────────────────────────────────────
  head('2. TikTok oEmbed（标题/作者，无播放点赞）');
  await timed(`oembed ${SAMPLE_VIDEO}`, async () => {
    const r = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(SAMPLE_VIDEO)}`);
    if (!r.json) throw new Error('非 JSON：' + r.raw.slice(0, 80));
    line(`       title=${String(r.json.title || '').slice(0, 40)}  author=${r.json.author_name}`);
    return true;
  });

  // ── 3. tikwm 聚合接口 ────────────────────────────────────
  head('3. tikwm 公开聚合接口（第三方）');
  await timed(`tikwm user/posts @${USER}`, async () => {
    const r = await getJson(
      `https://www.tikwm.com/api/user/posts?unique_id=${encodeURIComponent(USER)}&count=35`,
      { Referer: 'https://www.tikwm.com/' }
    );
    const d = r.json || {};
    const list = (d.data && (d.data.videos || d.data)) || [];
    if (!Array.isArray(list)) throw new Error('结构不符：' + JSON.stringify(d).slice(0, 150));
    line(`       code=${d.code} msg=${d.msg}  条数=${list.length}`);
    if (list[0]) {
      line(
        `       首条 id=${list[0].video_id || list[0].id} title=${String(list[0].title || '').slice(0, 30)} plays=${list[0].play_count} likes=${list[0].digg_count}`
      );
    }
    return true;
  });

  await timed(`tikwm 单视频详情`, async () => {
    const r = await getJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(SAMPLE_VIDEO)}`, {
      Referer: 'https://www.tikwm.com/',
    });
    const d = (r.json || {}).data || {};
    line(`       code=${(r.json || {}).code} plays=${d.play_count} likes=${d.digg_count} title=${String(d.title || '').slice(0, 30)}`);
    return true;
  });

  // ── 4. 移动端接口 ────────────────────────────────────────
  head('4. TikTok 移动端接口（需 sec_user_id）');
  let secUid = '';
  await timed('先从主页 HTML 抠 secUid', async () => {
    const r = await getText(`https://www.tiktok.com/@${USER}`);
    const m = /"secUid"\s*:\s*"([^"]+)"/.exec(r.text);
    if (!m) throw new Error('HTML 里没有 secUid');
    secUid = m[1];
    line(`       secUid=${secUid.slice(0, 24)}…（长度 ${secUid.length}）`);
    return true;
  });

  if (secUid) {
    await timed('aweme/v1/aweme/post（移动端，无签名）', async () => {
      const url =
        `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/aweme/post/?sec_user_id=${secUid}` +
        `&count=35&max_cursor=0&aid=1988&version_code=300904&version_name=30.9.4` +
        `&device_platform=android&os_version=13&device_type=Pixel%207&channel=googleplay&app_name=musical_ly`;
      const r = await getText(url, {
        'User-Agent': 'com.zhiliaoapp.musically/2023009040 (Linux; U; Android 13; en_US; Pixel 7; Build/TQ3A.230901.001; Cronet/58.0.2991.0)',
      });
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch {
        /* not json */
      }
      if (!j) throw new Error(`HTTP ${r.status} 非 JSON：${r.text.slice(0, 100)}`);
      const n = (j.aweme_list || []).length;
      line(`       status_code=${j.status_code} 条数=${n}`);
      if (n) {
        const a = j.aweme_list[0];
        line(`       首条 id=${a.aweme_id} desc=${String(a.desc || '').slice(0, 30)}`);
      }
      return true;
    });
  }

  // ── 5. RSSHub ─────────────────────────────────────────────
  head('5. RSSHub 公开实例');
  await timed(`rsshub tiktok/user/@${USER}`, async () => {
    const r = await getText(`https://rsshub.app/tiktok/user/@${USER}`);
    line(`       HTTP ${r.status} 长度 ${r.text.length}`);
    const n = (r.text.match(/<item>/g) || []).length;
    line(`       <item> 数=${n}`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return true;
  });

  head('结论');
  line('把上面 [OK] 且条数>0 的通道挑出来，就是可以替换当前浏览器抓取的方案。');
  line('优先看第 3 项（有播放/点赞）与第 4 项（官方移动端）。');
})();
