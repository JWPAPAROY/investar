/**
 * top3-attribution.js — "성과 부진은 TOP3 선별 탓인가, 풀 탓인가" (2026-08-25)
 *
 * 왜: 지금까지 풀(−2.67%)과 TOP3(원수익 −2.09%)를 **서로 다른 척도**로 비교해 왔다.
 *   풀은 매칭초과, TOP3는 실현수익이라 직접 비교가 불가능했다.
 *   여기서는 **실제 저장된 TOP3 추천을 KRX 데이터로 같은 척도(동일일 × 시총5분위 매칭초과)**
 *   에 올려, 같은 날의 풀 대리변수와 나란히 놓는다.
 *
 *   실제 TOP3 매칭초과 − 같은 날 풀 매칭초과 = **선별(랭킹)의 기여분**
 *     기여분 > 0 → 선별은 제 몫을 했고 문제는 풀
 *     기여분 < 0 → 선별이 풀보다 못한 것을 골랐다
 *
 * 규약: 매수 D+BUY 종가 → 매도 D+SELL 종가(active_policy 기본 D+2→D+10), 전방참조 없음.
 * 실행: node --max-old-space-size=8192 scripts/top3-attribution.js [--sell=10] [--buyoffset=2]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10), BUY = arg('buyoffset', 2), TOPN = arg('top', 30), LOOK = 20;
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sgn = v => (v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(8));

// ── KRX 일별 ───────────────────────────────────────────────────────────
const recs = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d);
const dayIdx = new Map(days.map((d, i) => [d, i]));
const N = days.length;
const px = new Map();   // date-index -> Map(code -> [o,h,l,c,vol,val,cap])
recs.forEach((r, i) => { const m = new Map(); for (const s of r.s) m.set(s[0], s); px.set(i, m); });
const row = (c, i) => px.get(i)?.get(c);
const close = (c, i) => { const r = row(c, i); return r && r[4] > 0 ? r[4] : null; };
const fwd = (c, i) => { const b = close(c, i + BUY), s = close(c, i + SELL); return (b && s) ? ((s - b) / b) * 100 : null; };

// 동일일 × 시총5분위 매칭 기준
const qOf = new Map(), qMean = new Map();
for (let i = 0; i < N; i++) {
  const rows = [...px.get(i).values()].filter(r => r[7] > 0 && r[4] > 0).sort((a, b) => a[7] - b[7]);
  rows.forEach((r, k) => qOf.set(`${i}|${r[0]}`, Math.min(4, Math.floor((k / rows.length) * 5))));
  const b = [[], [], [], [], []];
  for (const r of rows) { const f = fwd(r[0], i); if (f != null) b[qOf.get(`${i}|${r[0]}`)].push(f); }
  qMean.set(i, b.map(x => (x.length >= 20 ? avg(x) : null)));
}
const excess = (c, i) => { const f = fwd(c, i); if (f == null) return null; const q = qOf.get(`${i}|${c}`); const m = qMean.get(i)?.[q]; return m == null ? null : f - m; };

// 풀 대리변수(그날): 거래량·거래대금·거래량증가율·회전율·등락률 상위 TOPN 합집합
function poolAt(i) {
  if (i < LOOK + 1) return new Set();
  const rows = [];
  for (const r of px.get(i).values()) {
    const [c, , , , cl, vol, val, cap] = r;
    if (!(cl > 0) || !(cap > 0)) continue;
    const vs = [];
    let ok = true;
    for (let k = LOOK; k >= 1; k--) { const p = row(c, i - k); if (!p) { ok = false; break; } vs.push(p[5] || 0); }
    if (!ok) continue;
    const av = avg(vs) || 1;
    const prev = close(c, i - 1);
    rows.push({ c, vol, val, surge: val >= 1e8 ? vol / av : null, turn: cap > 0 ? vol / (cap / cl) : null, chg: prev ? ((cl - prev) / prev) * 100 : null });
  }
  const pick = key => rows.filter(r => r[key] != null && isFinite(r[key])).sort((a, b) => b[key] - a[key]).slice(0, TOPN).map(r => r.c);
  const u = new Set();
  for (const k of ['vol', 'val', 'surge', 'turn', 'chg']) for (const c of pick(k)) u.add(c);
  return u;
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('screening_recommendations')
      .select('recommendation_date,stock_code,stock_name,total_score').eq('is_top3', true).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  const dates = [...new Set(all.map(r => r.recommendation_date))].sort();
  console.log(`\n🔎 TOP3 귀속 분해 — 매수 D+${BUY} → 매도 D+${SELL} (동일일 × 시총5분위 매칭초과)`);
  console.log(`실제 TOP3 추천 ${all.length}건 / ${dates.length}일 (${dates[0]} ~ ${dates[dates.length - 1]})`);

  const t3 = [], pool = [], uni = [];
  let miss = 0;
  const usedDates = new Set();
  for (const r of all) {
    const d = r.recommendation_date.replace(/-/g, '');
    const i = dayIdx.get(d);
    if (i == null || i + SELL >= N) { miss++; continue; }
    const e = excess(r.stock_code, i);
    if (e == null) { miss++; continue; }
    t3.push(e); usedDates.add(i);
  }
  // 같은 날짜들의 풀 / 유니버스
  for (const i of usedDates) {
    for (const c of poolAt(i)) { const e = excess(c, i); if (e != null) pool.push(e); }
    for (const r of px.get(i).values()) { const e = excess(r[0], i); if (e != null) uni.push(e); }
  }

  const line = (nm, a) => console.log(`  ${nm.padEnd(28)} n=${String(a.length).padStart(6)} | 중앙 ${sgn(med(a))} | 평균 ${sgn(avg(a))} | 승률 ${a.length ? winR(a).toFixed(0) : '-'}%`);
  console.log(`\n  (평가 불가 ${miss}건 제외 — 데이터 구간 밖이거나 가격 결측)\n`);
  line('① 실제 TOP3', t3);
  line('② 같은 날 풀 전체', pool);
  line('③ 같은 날 유니버스 전체', uni);
  const sel = (med(t3) ?? 0) - (med(pool) ?? 0);
  const poolCost = (med(pool) ?? 0) - (med(uni) ?? 0);
  console.log(`\n  선별(랭킹)의 기여 = ① − ② = ${sgn(sel)}`);
  console.log(`  풀 선정의 기여   = ② − ③ = ${sgn(poolCost)}`);
  console.log('\n  · 기여가 음수인 쪽이 성과를 깎은 단계다. 둘 다 음수면 두 단계 모두 문제.');
  console.log('  · TOP3 표본은 저장된 추천에 한정되므로 풀·유니버스보다 n이 훨씬 작다 — 중앙값 위주로 읽을 것.\n');
})();
