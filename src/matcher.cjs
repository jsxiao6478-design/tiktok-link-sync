/**
 * 标题匹配引擎
 *
 * 核心难点: 用户在表里记录的「标题」与 TikTok 上的 desc 往往不完全一致
 * (可能只写了关键词、被截断、或含额外备注), 所以做多路打分:
 *   1) 字符 bigram Jaccard  —— 抗语序变化
 *   2) 词级覆盖率          —— 抗长度差异
 *   3) 包含关系            —— 用户只写标题片段时命中
 * 再用「发布日期」做加权与消歧, 最后做全局唯一分配(一条视频只能归一条记录)
 */

/** 去掉 TikTok 自动追加的文案 / 话题标签 / emoji / 标点, 统一小写 */
function normalizeTitle(s) {
  if (!s) return '';
  let t = String(s);
  // TikTok 自动追加的音频署名
  t = t.replace(/creado por .*? con la m[úu]sica original sound.*/gi, ' ');
  t = t.replace(/created by .*? with the original sound.*/gi, ' ');
  t = t.replace(/con la m[úu]sica original sound.*/gi, ' ');
  t = t.replace(/original sound\s*[-–—]?\s*/gi, ' ');
  // 话题标签
  t = t.replace(/#[\p{L}\p{N}_]+/gu, ' ');
  t = t.replace(/@[\p{L}\p{N}_.]+/gu, ' ');
  // emoji / 符号
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/gu,
    ' '
  );
  t = t.toLowerCase();
  // 标点归一
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function bigrams(s) {
  const set = new Set();
  const clean = s.replace(/\s+/g, '');
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  if (!set.size && clean.length) set.add(clean);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function tokenCoverage(a, b) {
  const A = new Set(a.split(' ').filter((x) => x.length > 1));
  const B = new Set(b.split(' ').filter((x) => x.length > 1));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

function containmentScore(a, b) {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length < 6) return 0;
  return long.includes(short) ? 1 : 0;
}

/** 返回 0~1 的标题相似度 */
function titleSimilarity(rawA, rawB) {
  const a = normalizeTitle(rawA);
  const b = normalizeTitle(rawB);
  if (!a || !b) return 0;
  const j = jaccard(bigrams(a), bigrams(b));
  const t = tokenCoverage(a, b);
  const c = containmentScore(a, b);
  // 加权后取最大值，避免单一指标偏科
  return Math.max(j, t * 0.95, c * 0.92);
}

/** 日期解析：容忍 2026-09-03 / 2026/9/3 / 2026.9.3 / 2026-09-03 15:30 等写法 */
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // 纯数字时间戳
  if (/^\d{10}$/.test(s)) {
    return new Date(+s * 1000).toISOString().slice(0, 10);
  }
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  return null;
}

function daysApart(d1, d2) {
  if (!d1 || !d2) return null;
  const a = Date.parse(d1 + 'T00:00:00Z');
  const b = Date.parse(d2 + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round(Math.abs(a - b) / 86400000);
}

/** 日期得分：同天=1, 差1天=0.65(容忍时区), 差2天=0.35, 更远=0 */
function dateScore(d1, d2) {
  const diff = daysApart(d1, d2);
  if (diff === null) return 0.4; // 日期缺失时给中性值，靠标题决胜
  if (diff === 0) return 1;
  if (diff === 1) return 0.65;
  if (diff === 2) return 0.35;
  return 0;
}

const W_TITLE = 0.72;
const W_DATE = 0.28;

/**
 * @param records  待补链接的记录 [{account, title, date}]
 * @param videosByAccount  { accountName: [{id, title, createDate, url}] }
 * @param opts { threshold, allowDateFallback }
 * @returns 每条 record 的匹配结果
 */
function matchRecords(records, videosByAccount, opts = {}) {
  const threshold = opts.threshold ?? 0.45;
  const allowDateFallback = opts.allowDateFallback !== false;
  // 日期兜底的最低标题相似度：太低说明这条记录与唯一候选视频根本不像，宁可判「未找到」
  const fallbackMinSim = opts.fallbackMinSim ?? 0.2;

  // 1) 先算所有候选对
  const pairs = [];
  records.forEach((rec, ri) => {
    const key = normalizeAccount(rec.account);
    const pool = videosByAccount[key] || videosByAccount[rec.account] || [];
    const recDate = parseDate(rec.date);
    for (const v of pool) {
      const sim = titleSimilarity(rec.title, v.title);
      const ds = dateScore(recDate, v.createDate);
      const score = W_TITLE * sim + W_DATE * ds;
      if (score >= threshold) {
        pairs.push({ ri, video: v, sim, dateScore: ds, score });
      }
    }
  });

  // 2) 全局贪心分配：高分优先，一条视频只能被占用一次
  pairs.sort((a, b) => b.score - a.score);
  const usedRecord = new Set();
  const usedVideo = new Set();
  const assigned = new Map();

  for (const p of pairs) {
    const vkey = `${normalizeAccount(records[p.ri].account)}::${p.video.id}`;
    if (usedRecord.has(p.ri) || usedVideo.has(vkey)) continue;
    usedRecord.add(p.ri);
    usedVideo.add(vkey);
    assigned.set(p.ri, p);
  }

  // 3) 组织输出
  return records.map((rec, ri) => {
    const hit = assigned.get(ri);
    const key = normalizeAccount(rec.account);
    const pool = videosByAccount[key] || videosByAccount[rec.account] || [];

    if (!hit) {
      // 日期兜底：仅当「该账号当天恰好只有一条视频」且「标题不至于完全无关」时才认定。
      // 加了相似度门槛，避免把明显无关的记录硬塞一个链接。
      if (allowDateFallback) {
        const recDate = parseDate(rec.date);
        const sameDay = pool.filter((v) => v.createDate === recDate);
        if (sameDay.length === 1) {
          const cand = sameDay[0];
          const occupied = usedVideo.has(`${key}::${cand.id}`);
          const sim = titleSimilarity(rec.title, cand.title);
          if (!occupied && sim >= fallbackMinSim) {
            usedVideo.add(`${key}::${cand.id}`);
            return {
              ...rec,
              link: cand.url,
              matchedTitle: cand.title,
              matchedDate: cand.createDate,
              confidence: Math.round(Math.max(sim, 0.5) * 100) / 100,
              status: '日期兜底(请确认)',
              hint: '当天该账号仅此一条视频',
              plays: cand.plays,
              likes: cand.likes,
            };
          }
        }
      }
      return {
        ...rec,
        link: '',
        matchedTitle: '',
        matchedDate: '',
        confidence: 0,
        status: '未找到',
        hint: !pool.length
          ? '该账号未抓到任何视频(账号名有误或主页非公开)'
          : (() => {
              const recDate = parseDate(rec.date);
              const n = recDate ? pool.filter((v) => v.createDate === recDate).length : 0;
              return n > 1
                ? `当天该账号有 ${n} 条视频但标题都不像, 建议放宽标题或核对日期`
                : '日期不在抓取范围内, 或标题与视频描述差异过大';
            })(),
      };
    }

    const conf = Math.round(hit.score * 100) / 100;
    let status;
    if (conf >= 0.85) status = '已匹配';
    else if (conf >= 0.65) status = '待复核';
    else status = '低置信';

    return {
      ...rec,
      link: hit.video.url,
      matchedTitle: hit.video.title,
      matchedDate: hit.video.createDate,
      confidence: conf,
      status,
      plays: hit.video.plays,
      likes: hit.video.likes,
    };
  });
}

function normalizeAccount(a) {
  return String(a || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/?/, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '');
}

module.exports = {
  normalizeTitle,
  titleSimilarity,
  parseDate,
  daysApart,
  matchRecords,
  normalizeAccount,
};
