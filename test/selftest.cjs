/**
 * 离线自测：验证匹配算法的准确性（不联网，秒级完成）
 * 用真实抓取到的视频数据 + 人为变形的「用户记录标题」测试命中率
 *
 * 运行: node test/selftest.cjs
 */
const { matchRecords, titleSimilarity, normalizeTitle, parseDate } = require('../src/matcher.cjs');

const V = (id, title, createDate) => ({
  id,
  title,
  createDate,
  url: `https://www.tiktok.com/@tiktok/video/${id}`,
});

// 真实抓取样本（注意：其中两条同为 2026-09-08，用于测试同日消歧）
const videosByAccount = {
  tiktok: [
    V('7683195368279985438', 'hear how @Palina La Diva 🌐 spinning tracks on LIVE brings techno lovers together 🪩', '2026-09-08'),
    V('7681309378095353118', 'You showed us what it means to be a Pop Girl this summer 🎶 #SongsofTheSummer2026', '2026-09-08'),
    V('7681695065927912735', "@Alex Warren thinks he'll never write anything better than... can you guess? Search Files has the answer 👀", '2026-09-04'),
    V('7681414892942839071', "when words aren't enough, Photo Comments say more @mama | our filipino grandma", '2026-09-03'),
    V('7679101730352565535', 'what started on TikTok grew into a special IRL connection on tour between @Bella Kay "Behind the Breakthrough."', '2026-08-28'),
    V('7678745502359342366', 'she first connected with fans on TikTok. now @Bella Kay is meeting them on "Behind the Breakthrough."', '2026-08-27'),
  ],
};

// 用户记录（标题做了各种变形，模拟真实记录习惯）
const cases = [
  { account: 'tiktok', title: 'hear how Palina La Diva spinning tracks on LIVE brings techno lovers together', date: '2026-09-08', expect: '7683195368279985438', note: '完整标题去掉@和emoji' },
  { account: '@tiktok', title: "when words aren't enough, Photo Comments say more", date: '2026/9/3', expect: '7681414892942839071', note: '标题截断 + 斜杠日期' },
  { account: 'tiktok', title: 'Search Files has the answer', date: '2026-09-04', expect: '7681695065927912735', note: '只写句子片段' },
  { account: 'tiktok', title: 'Pop Girl this summer', date: '2026-09-08', expect: '7681309378095353118', note: '同日两条，考验消歧' },
  { account: 'tiktok', title: 'Bella Kay Behind the Breakthrough on tour', date: '2026-08-27', expect: '7678745502359342366', note: '同日两条相近标题' },
  { account: 'tiktok', title: '这个视频根本不存在xyzabc测试', date: '2026-09-01', expect: null, note: '负样本，应判未找到' },
];

console.log('\n========== 标题归一化演示 ==========');
const demo = 'she first connected with fans on TikTok. now @Bella Kay is meeting them on "Behind the Breakthrough."';
console.log('原始:', demo);
console.log('归一:', normalizeTitle(demo));

console.log('\n========== 匹配测试 ==========');
const results = matchRecords(cases, videosByAccount, { threshold: 0.45 });

let pass = 0;
results.forEach((r, i) => {
  const c = cases[i];
  const gotId = r.link ? r.link.split('/').pop() : null;
  const ok = gotId === c.expect;
  if (ok) pass++;
  console.log(
    `${ok ? '✓' : '✗'} [${c.note}]` +
      `\n    记录: "${c.title}" @ ${c.date}` +
      `\n    期望: ${c.expect || '未找到'}   实际: ${gotId || '未找到'}   置信度=${r.confidence} 状态=${r.status}`
  );
});

console.log(`\n通过 ${pass}/${cases.length}`);

// 相似度分布，便于调阈值
console.log('\n========== 相似度参考 ==========');
const pairs = [
  ['Pop Girl this summer', videosByAccount.tiktok[1].title],
  ['Search Files has the answer', videosByAccount.tiktok[2].title],
  ['这个视频根本不存在xyzabc测试', videosByAccount.tiktok[0].title],
];
pairs.forEach(([a, b]) => {
  console.log(`${titleSimilarity(a, b).toFixed(3)}  "${a.slice(0, 40)}" ↔ "${b.slice(0, 40)}"`);
});

console.log('\n日期解析自测:', ['2026-09-08', '2026/9/3', '2026.9.3', '2026年9月3日', ''].map((d) => `${d || '(空)'}=>${parseDate(d)}`).join('  '));
