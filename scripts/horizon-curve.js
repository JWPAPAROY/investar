/**
 * horizon-curve.js — "D+1부터 며칠 보유했을 때 수익이 최대인가" (2026-08-25)
 *
 * 대상: ① 현행 풀(거래량 5랭킹 합집합, KRX 재구성) ② 실제 저장된 TOP3 ③ 통제 ④ 유니버스
 * 방법: D+1 종가 매수 → D+N 종가 매도, N = 2..MAXN. 원수익과 매칭초과를 함께 본다.
 *
 * ⚠️ 고정 코호트: N이 커질수록 최근 추천은 평가 불가로 빠져 **표본 구성이 바뀐다**.
 *   그러면 "N=20이 좋다"가 지평 효과인지 표본 교체 효과인지 구분되지 않는다.
 *   따라서 **최장 지평(MAXN)까지 평가 가능한 신호일만** 남겨 모든 N에서 같은 코호트를 쓴다.
 *
 * ⚠️ 비용 미반영: 왕복 약 0.38%. 어떤 N이든 이 값을 넘지 못하면 실전 수익은 음수다.
 *
 * 실행: node --max-old-space-size=8192 scripts/horizon-curve.js [--maxn=30]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const MAXN = arg('maxn', 30), BUY = 1, LOOK = 20, TOPN = 30;
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const f2 = v => (v == null ? '    -' : ((v >= 0 ? '+' : '') + v.toFixed(2)).padStart(6));

// ── KRX 일별 ───────────────────────────────────────────────────────────
const recsRaw = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recsRaw.map(r => r.d);
const N = days.length;
const dayIdx = new Map(days.map((d, i) => [d, i]));
const byDay = recsRaw.map(r => { const m = new Map(); for (const s of r.s) m.set(s[0], s); return m; });
const row = (c, i) => (i >= 0 && i < N ? byDay[i].get(c) : undefined);
const close = (c, i) => { const r = row(c, i); return r && r[4] > 0 ? r[4] : null; };
const ret = (c, i, n) => { const b = close(c, i + BUY), s = close(c, i + n); return (b && s) ? ((s - b) / b) * 100 : null; };

// 시총 5분위 (신호일 기준) + 지평별 분위 평균
const capQ = new Map();
for (let i = 0; i < N; i++) {
  const rs = [...byDay[i].values()].filter(r => r[7] > 0 && r[4] > 0).sort((a, b) => a[7] - b[7]);
  rs.forEach((r, k) => capQ.set(`${i}|${r[0]}`, Math.min(4, Math.floor((k / rs.length) * 5))));
}
const qMeanCache = new Map();   // `${i}|${n}` -> [5]
function qMean(i, n) {
  const key = `${i}|${n}`;
  if (qMeanCache.has(key)) return qMeanCache.get(key);
  const b = [[], [], [], [], []];
  for (const r of byDay[i].values()) {
    const q = capQ.get(`${i}|${r[0]}`); if (q == null) continue;
    const v = ret(r[0], i, n); if (v != null) b[q].push(v);
  }
  const m = b.map(x => (x.length >= 20 ? avg(x) : null));
  qMeanCache.set(key, m);
  return m;
}
const excess = (c, i, n) => { const v = ret(c, i, n); if (v == null) return null; const q = capQ.get(`${i}|${c}`); const m = qMean(i, n)[q]; return m == null ? null : v - m; };

// 현행 풀 재구성
const poolCache = new Map();
function poolAt(i) {
  if (poolCache.has(i)) return poolCache.get(i);
  const rows = [];
  for (const r of byDay[i].values()) {
    const [c, , , , cl, vol, val, cap] = r;
    if (!(cl > 0) || !(cap > 0)) continue;
    const vs = [];
    let ok = true;
    for (let k = LOOK; k >= 1; k--) { const p = row(c, i - k); if (!p) { ok = false; break; } vs.push(p[5] || 0); }
    if (!ok) continue;
    const av = avg(vs) || 1, prev = close(c, i - 1);
    rows.push({ c, vol, val, surge: val >= 1e8 ? vol / av : null, turn: vol / (cap / cl), chg: prev ? ((cl - prev) / prev) * 100 : null });
  }
  const pick = k => rows.filter(r => r[k] != null && isFinite(r[k])).sort((a, b) => b[k] - a[k]).slice(0, TOPN).map(r => r.c);
  const u = new Set();
  for (const k of ['vol', 'val', 'surge', 'turn', 'chg']) for (const c of pick(k)) u.add(c);
  poolCache.set(i, u);
  return u;
}

(async () => {
  // 실제 TOP3
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('screening_recommendations')
      .select('recommendation_date,stock_code').eq('is_top3', true).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  // 고정 코호트: MAXN까지 평가 가능한 신호일만
  const t3 = all.map(r => ({ c: r.stock_code, i: dayIdx.get(r.recommendation_date.replace(/-/g, '')) }))
    .filter(x => x.i != null && x.i + MAXN < N && close(x.c, x.i + BUY));
  const t3Days = [...new Set(t3.map(x => x.i))].sort((a, b) => a - b);
  // 풀/통제/유니버스는 표본이 크므로 TOP3와 같은 날짜로 맞춘 것과 전 구간 둘 다 본다
  const poolDays = [];
  for (let i = LOOK + 5; i + MAXN < N; i += 3) poolDays.push(i);   // 3일 간격 샘플링(연산량)

  console.log(`\n📈 보유기간 곡선 — D+${BUY} 종가 매수 → D+N 종가 매도 (고정 코호트)`);
  console.log(`TOP3: ${t3.length}건 / ${t3Days.length}일 (${days[t3Days[0]]} ~ ${days[t3Days[t3Days.length - 1]]})`);
  console.log(`풀·유니버스: ${poolDays.length}일 샘플 (${days[poolDays[0]]} ~ ${days[poolDays[poolDays.length - 1]]}), 3일 간격`);
  console.log(`⚠️ 비용 미반영 — 왕복 약 0.38%를 넘어야 실전 수익이 양수\n`);

  console.log('   N |            실제 TOP3            |            현행 풀             |    유니버스');
  console.log('     | 원수익평균 원수익중앙 매칭초과 승률 | 원수익평균 원수익중앙 매칭초과 승률 | 원수익평균 매칭초과');
  console.log('  ' + '-'.repeat(104));

  const best = { t3: { n: 0, v: -99 }, pool: { n: 0, v: -99 }, t3x: { n: 0, v: -99 }, poolx: { n: 0, v: -99 } };
  for (let n = 2; n <= MAXN; n++) {
    const a = [], ax = [];
    for (const x of t3) { const v = ret(x.c, x.i, n); if (v != null) a.push(v); const e = excess(x.c, x.i, n); if (e != null) ax.push(e); }
    const b = [], bx = [], u = [], ux = [];
    for (const i of poolDays) {
      const p = poolAt(i);
      for (const c of p) { const v = ret(c, i, n); if (v != null) b.push(v); const e = excess(c, i, n); if (e != null) bx.push(e); }
      for (const r of byDay[i].values()) { const v = ret(r[0], i, n); if (v != null) u.push(v); const e = excess(r[0], i, n); if (e != null) ux.push(e); }
    }
    if (avg(a) > best.t3.v) best.t3 = { n, v: avg(a) };
    if (med(ax) > best.t3x.v) best.t3x = { n, v: med(ax) };
    if (avg(b) > best.pool.v) best.pool = { n, v: avg(b) };
    if (med(bx) > best.poolx.v) best.poolx = { n, v: med(bx) };
    if (n <= 15 || n % 5 === 0) {
      console.log(`  ${String(n).padStart(2)} | ${f2(avg(a))} ${f2(med(a))} ${f2(med(ax))} ${String(winR(a) ? winR(a).toFixed(0) : '-').padStart(3)}% | ${f2(avg(b))} ${f2(med(b))} ${f2(med(bx))} ${String(winR(b) ? winR(b).toFixed(0) : '-').padStart(3)}% | ${f2(avg(u))} ${f2(med(ux))}`);
    }
  }
  console.log(`\n  최고 지점:`);
  console.log(`   TOP3  원수익 평균 최대 → D+${best.t3.n} (${best.t3.v.toFixed(2)}%) / 매칭초과 중앙 최대 → D+${best.t3x.n} (${best.t3x.v.toFixed(2)}%)`);
  console.log(`   풀    원수익 평균 최대 → D+${best.pool.n} (${best.pool.v.toFixed(2)}%) / 매칭초과 중앙 최대 → D+${best.poolx.n} (${best.poolx.v.toFixed(2)}%)`);
  console.log('\n  · 원수익은 시장 흐름이 섞여 있다(상승장이면 길수록 커짐). 전략 자체의 우열은 매칭초과로 볼 것.');
  console.log('  · TOP3 코호트는 2025-11 이후 164일 중 MAXN 평가 가능분에 한정 — 단일 구간이라 일반화 주의.\n');
})();
