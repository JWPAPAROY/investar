/**
 * score-validity.js — "100점 스코어링은 실제로 정보를 담고 있는가" (2026-08-25)
 *
 * 왜: 오늘까지 점수의 **부품**(거래량·VPD·갭·이격도·시총 플로어)만 검정했지
 *   **합산 점수 자체**를 성과와 붙여본 적이 없다. 부품이 대부분 무효였다고 해서
 *   합산이 무효라는 보장은 없다(가중 합이 개별보다 나을 수 있다). 직접 확인한다.
 *
 * 방법: 저장된 `screening_recommendations.total_score`와 **KRX 기준 매칭초과**
 *   (동일일 × 시총5분위, D+2→D+10)를 밴드별로 붙인다. 점수가 정보를 담고 있다면
 *   밴드 간 성과가 갈려야 한다 — 단조든(높을수록 좋다) 스윗스팟이든(중간이 좋다).
 *
 * ⚠️ 설계상 스코어는 **비단조**(50-69 스윗스팟)로 의도됐으므로 상관계수 ≈ 0이
 *   곧 실패는 아니다. 밴드별 패턴을 봐야 한다.
 * ⚠️ 시총 보정(−5~+7)이 점수에 이미 들어있다 → 점수 효과가 사실은 시총 효과일 수 있다.
 *   그래서 **시총 구간을 나눠 안에서 다시** 본다(시총 통제).
 *
 * 실행: node --max-old-space-size=8192 scripts/score-validity.js [--sell=10] [--buyoffset=2]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10), BUY = arg('buyoffset', 2);
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const f2 = v => (v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(8));

const recs = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d), N = days.length;
const dayIdx = new Map(days.map((d, i) => [d, i]));
const byDay = recs.map(r => { const m = new Map(); for (const s of r.s) m.set(s[0], s); return m; });
const close = (c, i) => { const r = (i >= 0 && i < N) ? byDay[i].get(c) : null; return r && r[4] > 0 ? r[4] : null; };
const fwd = (c, i) => { const b = close(c, i + BUY), s = close(c, i + SELL); return (b && s) ? ((s - b) / b) * 100 : null; };

const capQ = new Map(), qMean = new Map();
for (let i = 0; i < N; i++) {
  const rs = [...byDay[i].values()].filter(r => r[7] > 0 && r[4] > 0).sort((a, b) => a[7] - b[7]);
  rs.forEach((r, k) => capQ.set(`${i}|${r[0]}`, Math.min(4, Math.floor((k / rs.length) * 5))));
  const b = [[], [], [], [], []];
  for (const r of rs) { const f = fwd(r[0], i); if (f != null) b[capQ.get(`${i}|${r[0]}`)].push(f); }
  qMean.set(i, b.map(x => (x.length >= 20 ? avg(x) : null)));
}
const excess = (c, i) => { const f = fwd(c, i); if (f == null) return null; const m = qMean.get(i)?.[capQ.get(`${i}|${c}`)]; return m == null ? null : f - m; };

// 스피어만 상관 (순위 상관)
function spearman(xs, ys) {
  const n = xs.length; if (n < 10) return null;
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); idx.forEach(([, i], k) => { r[i] = k + 1; }); return r; };
  const rx = rank(xs), ry = rank(ys);
  const mx = avg(rx), my = avg(ry);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (rx[i] - mx) * (ry[i] - my); vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2; }
  return (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : null;
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('screening_recommendations')
      .select('recommendation_date,stock_code,total_score,market_cap,is_top3').not('total_score', 'is', null).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  const pts = [];
  for (const r of all) {
    const i = dayIdx.get(r.recommendation_date.replace(/-/g, ''));
    if (i == null || i + SELL >= N) continue;
    const e = excess(r.stock_code, i);
    if (e == null) continue;
    pts.push({ s: r.total_score, e, cap: r.market_cap, top3: r.is_top3 });
  }
  const dates = [...new Set(all.map(r => r.recommendation_date))].sort();
  console.log(`\n🧮 스코어 유효성 — 저장 추천 ${all.length}건 중 평가 가능 ${pts.length}건`);
  console.log(`기간 ${dates[0]} ~ ${dates[dates.length - 1]} | 매칭초과 D+${BUY}→D+${SELL}\n`);

  const bands = [[0, 30], [30, 40], [40, 45], [45, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
  const table = (title, sel) => {
    const sub = pts.filter(sel);
    if (sub.length < 30) { console.log(`  ${title}: 표본 부족(${sub.length})\n`); return; }
    console.log(`  ${title} (n=${sub.length})`);
    console.log('    점수밴드   |     n | 매칭초과중앙 | 매칭초과평균 | 승률');
    for (const [lo, hi] of bands) {
      const a = sub.filter(p => p.s >= lo && p.s < hi).map(p => p.e);
      if (a.length < 10) continue;
      console.log(`    ${String(lo).padStart(3)}~${String(hi - 1).padEnd(3)}   | ${String(a.length).padStart(5)} | ${f2(med(a))} | ${f2(avg(a))} | ${winR(a).toFixed(0).padStart(3)}%`);
    }
    const r = spearman(sub.map(p => p.s), sub.map(p => p.e));
    console.log(`    스피어만 상관(점수↔초과수익) = ${r == null ? '-' : r.toFixed(3)}\n`);
  };

  table('▍전체', () => true);
  table('▍시총 1조 이상 (대형주 안에서)', p => p.cap >= 1e12);
  table('▍시총 1조 미만 (중소형 안에서)', p => p.cap < 1e12);

  // 시총 자체의 설명력과 비교
  const big = pts.filter(p => p.cap >= 1e12).map(p => p.e), small = pts.filter(p => p.cap < 1e12).map(p => p.e);
  console.log(`  ▍비교: 시총만으로 가른 경우`);
  console.log(`    1조 이상 | ${String(big.length).padStart(5)} | ${f2(med(big))} | ${f2(avg(big))} | ${winR(big).toFixed(0)}%`);
  console.log(`    1조 미만 | ${String(small.length).padStart(5)} | ${f2(med(small))} | ${f2(avg(small))} | ${winR(small).toFixed(0)}%`);
  console.log(`    격차 ${f2(med(big) - med(small))}\n`);
  console.log('  · 설계상 스코어는 비단조(50-69 스윗스팟)이므로 상관 ≈ 0이 곧 실패는 아니다 — 밴드 패턴을 볼 것.');
  console.log('  · 시총 보정(−5~+7)이 점수에 포함돼 있어, 점수 효과가 시총 효과의 재탕일 수 있다.\n');
})();
