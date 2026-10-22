/**
 * index-strategy-search.js — KOSPI 200 지수 매매 규칙 그리드 탐색 (2026-10-21)
 *
 * 판정 기준·그리드·구간은 INDEX_SEARCH_VERDICT.md 에 돌리기 전에 등록했다. 여기서 바꾸지 말 것.
 *   판정 1: 분할 검정 (설계 2011~2018 에서 선택 → 검증 2019~ 한 번)
 *   판정 2: walk-forward (매년 직전 5년 Calmar 1위로 교체, 2016~) — 주 판정
 *
 * 실행: node scripts/index-strategy-search.js [--top=15]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TOP = +arg('top', 15);
const COST = 0.0005, BAND = 0.1, LEV_FEE = 0.03, INV_FEE = 0.01, MIN_TRADES = 10;
const IS_FROM = '20110101', IS_TO = '20181231', OOS_FROM = '20190101', OOS_TO = '99991231';

// ── 데이터 (index-box-backtest.js 와 동일) ──────────────────────────────
const close = new Map();
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(s => s.trim()) : [];
for (const l of lines(path.resolve(__dirname, '../data/kospi-index-long.jsonl'))) {
  const r = JSON.parse(l); if (!r.h && r.k200[0] > 0) close.set(r.d, r.k200[0]);
}
for (const l of lines(path.resolve(__dirname, '../data/krx-index.jsonl'))) {
  const r = JSON.parse(l); if (close.has(r.d)) continue;
  const k = r.i.find(x => x[0] === '코스피 200'); if (k && k[1] > 0) close.set(r.d, k[1]);
}
const D = [...close.keys()].sort();
const C = D.map(d => close.get(d));
const n = C.length;
const fmt = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const i0 = D.findIndex(d => d >= '20110103');
console.log(`KOSPI 200 ${n}일 (${D[0]} ~ ${D[n - 1]}) | 평가 시작 ${D[i0]}`);

// ── 지표 캐시 ────────────────────────────────────────────────────────
const memo = new Map();
const cached = (key, f) => { if (!memo.has(key)) memo.set(key, f()); return memo.get(key); };
const sma = N => cached(`sma${N}`, () => {
  const o = new Array(n).fill(NaN); let s = 0;
  for (let i = 0; i < n; i++) { s += C[i]; if (i >= N) s -= C[i - N]; if (i >= N - 1) o[i] = s / N; }
  return o;
});
const sd = N => cached(`sd${N}`, () => {
  const m = sma(N), o = new Array(n).fill(NaN);
  for (let i = N - 1; i < n; i++) { let s2 = 0; for (let j = i - N + 1; j <= i; j++) s2 += (C[j] - m[i]) ** 2; o[i] = Math.sqrt(s2 / N); }
  return o;
});
/** 직전 N일(당일 제외) 종가 최고/최저 */
const priorHi = N => cached(`hi${N}`, () => { const o = new Array(n).fill(NaN); for (let i = N; i < n; i++) { let h = -Infinity; for (let j = i - N; j < i; j++) h = Math.max(h, C[j]); o[i] = h; } return o; });
const priorLo = N => cached(`lo${N}`, () => { const o = new Array(n).fill(NaN); for (let i = N; i < n; i++) { let l = Infinity; for (let j = i - N; j < i; j++) l = Math.min(l, C[j]); o[i] = l; } return o; });
const rvol = N => cached(`rv${N}`, () => {
  const o = new Array(n).fill(NaN);
  for (let i = N; i < n; i++) {
    let s = 0, s2 = 0;
    for (let j = i - N + 1; j <= i; j++) { const r = Math.log(C[j] / C[j - 1]); s += r; s2 += r * r; }
    o[i] = Math.sqrt(Math.max(0, s2 / N - (s / N) ** 2) * 252);
  }
  return o;
});
const rsi = N => cached(`rsi${N}`, () => {   // Wilder
  const o = new Array(n).fill(NaN); let up = 0, dn = 0;
  for (let i = 1; i < n; i++) {
    const ch = C[i] - C[i - 1], u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (i <= N) { up += u / N; dn += d / N; } else { up = (up * (N - 1) + u) / N; dn = (dn * (N - 1) + d) / N; }
    if (i >= N) o[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return o;
});

// ── 규칙: i → 목표 비중 또는 null(유지) ──────────────────────────────
const off = short => short ? -1 : 0;
const R = [];
const add = (name, init, fn) => R.push({ name, init, fn });
add('보유', 1, () => 1);
for (const short of [false, true]) {
  const sfx = short ? '/인버스' : '';
  for (const N of [20, 50, 100, 150, 200, 250]) { const m = sma(N); add(`MA${N}${sfx}`, 0, i => isNaN(m[i]) ? null : C[i] > m[i] ? 1 : off(short)); }
  for (const f of [5, 10, 20, 50]) for (const s of [50, 100, 200]) if (f < s) {
    const a = sma(f), b = sma(s); add(`MA${f}/${s}${sfx}`, 0, i => isNaN(b[i]) ? null : a[i] > b[i] ? 1 : off(short));
  }
  for (const nin of [20, 60, 120, 250]) for (const nout of [10, 20, 60, 120]) if (nout <= nin) {
    const h = priorHi(nin), l = priorLo(nout);
    add(`BRK${nin}/${nout}${sfx}`, 0, i => isNaN(h[i]) || isNaN(l[i]) ? null : C[i] > h[i] ? 1 : C[i] < l[i] ? off(short) : null);
  }
  for (const N of [20, 60, 120, 250]) add(`TSM${N}${sfx}`, 0, i => i < N ? null : C[i] > C[i - N] ? 1 : off(short));
}
for (const N of [20, 60, 120, 250]) for (const lo of [0.1, 0.2, 0.3]) for (const hi of [0.7, 0.8, 0.9]) {
  const h = priorHi(N), l = priorLo(N);
  add(`BOX${N}(${lo}/${hi})`, 0, i => { if (isNaN(h[i])) return null; const p = (C[i] - l[i]) / (h[i] - l[i]); return p <= lo ? 1 : p >= hi ? 0 : null; });
}
for (const N of [10, 20, 60]) for (const k of [1.5, 2, 2.5]) {
  const m = sma(N), s = sd(N);
  add(`BB${N}(${k})`, 0, i => isNaN(m[i]) ? null : C[i] < m[i] - k * s[i] ? 1 : C[i] > m[i] + k * s[i] ? 0 : null);
}
for (const N of [2, 5, 14]) for (const lo of [10, 20, 30]) for (const hi of [70, 80, 90]) {
  const r = rsi(N); add(`RSI${N}(${lo}/${hi})`, 0, i => isNaN(r[i]) ? null : r[i] < lo ? 1 : r[i] > hi ? 0 : null);
}
for (const N of [10, 20, 60]) for (const tg of [0.10, 0.15, 0.20, 0.25]) for (const cap of [1, 1.5, 2]) {
  const v = rvol(N); add(`VT${N}(${tg * 100}%,≤${cap})`, 1, i => isNaN(v[i]) || v[i] <= 0 ? null : Math.min(cap, tg / v[i]));
}
for (const M of [100, 200]) for (const N of [20, 60]) for (const tg of [0.15, 0.20]) for (const cap of [1, 2]) {
  const m = sma(M), v = rvol(N);
  add(`MA${M}xVT${N}(${tg * 100}%,≤${cap})`, 0, i => isNaN(m[i]) || isNaN(v[i]) ? null : C[i] > m[i] ? Math.min(cap, tg / v[i]) : 0);
}

// ── 시뮬레이션 (전 구간 연속 운용) ─────────────────────────────────────
function simulate(rule) {
  const nav = new Float64Array(n).fill(NaN), held = new Float64Array(n), tradeAt = new Uint8Array(n);
  let v = 1, h = rule.init, pending = null;
  const w0 = rule.fn(i0); if (w0 !== null && rule.init !== 1) h = w0;
  nav[i0] = 1; held[i0] = h;
  for (let i = i0 + 1; i < n; i++) {
    const r = C[i] / C[i - 1] - 1;
    v *= 1 + h * r - (Math.max(0, h - 1) * LEV_FEE + Math.max(0, -h) * INV_FEE) / 252;
    if (pending !== null) { v *= 1 - COST * Math.abs(pending - h); h = pending; pending = null; tradeAt[i] = 1; }
    nav[i] = v; held[i] = h;
    const want = rule.fn(i);
    if (want !== null && Math.abs(want - h) >= BAND - 1e-12) pending = want;
  }
  return { nav, held, tradeAt };
}
const lastIdxBefore = d => { let k = -1; for (let i = 0; i < n; i++) if (D[i] < d) k = i; return k; };
const lastIdxUpTo = d => { let k = -1; for (let i = 0; i < n; i++) if (D[i] <= d) k = i; return k; };
function stats(nav, tradeAt, a, b) {
  const yrs = (Date.parse(fmt(D[b])) - Date.parse(fmt(D[a]))) / (365.25 * 864e5);
  const tot = nav[b] / nav[a] - 1, cagr = Math.pow(Math.max(1e-9, 1 + tot), 1 / yrs) - 1;
  let peak = -Infinity, mdd = 0, tr = 0;
  for (let i = a; i <= b; i++) { peak = Math.max(peak, nav[i]); mdd = Math.min(mdd, nav[i] / peak - 1); if (i > a && tradeAt[i]) tr++; }
  return { tot, cagr, mdd, calmar: cagr / Math.max(1e-9, -mdd), trades: tr };
}
const win = (from, to) => [Math.max(i0, lastIdxBefore(from)), lastIdxUpTo(to)];

const t0 = Date.now();
const sims = R.map(r => ({ ...r, ...simulate(r) }));
console.log(`규칙 ${R.length}개 시뮬레이션 ${((Date.now() - t0) / 1000).toFixed(1)}초\n`);
const BH = sims[0];

const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
const row = (name, s, m) => `${name.padEnd(26)} CAGR ${pct(s.cagr).padStart(7)} MDD ${pct(s.mdd).padStart(7)} Calmar ${s.calmar.toFixed(2).padStart(5)} 체결 ${String(s.trades).padStart(4)} | 연초과 ${pp(s.cagr - m.cagr).padStart(8)}`;

// ── 판정 1: 분할 검정 ────────────────────────────────────────────────
const [ia, ib] = win(IS_FROM, IS_TO), [oa, ob] = win(OOS_FROM, OOS_TO);
const rows = sims.map(s => ({ s, is: stats(s.nav, s.tradeAt, ia, ib), oos: stats(s.nav, s.tradeAt, oa, ob) }));
const bhIS = rows[0].is, bhOOS = rows[0].oos;
console.log(`━━ 판정 1: 분할 검정 ━━  설계 ${D[ia]}~${D[ib]} / 검증 ${D[oa]}~${D[ob]}`);
console.log(row('보유 (설계)', bhIS, bhIS)); console.log(row('보유 (검증)', bhOOS, bhOOS));
const eligible = rows.filter(r => r.is.trades >= MIN_TRADES);
const pickCal = [...eligible].sort((a, b) => b.is.calmar - a.is.calmar)[0];
const pickEx = [...eligible].sort((a, b) => b.is.cagr - a.is.cagr)[0];
for (const [label, p] of [['Calmar 1위', pickCal], ['연초과 1위', pickEx]]) {
  const pass = p.oos.cagr > bhOOS.cagr && p.oos.calmar > bhOOS.calmar;
  console.log(`\n▶ 설계 ${label}: ${p.s.name}`);
  console.log('  설계 ' + row('', p.is, bhIS));
  console.log('  검증 ' + row('', p.oos, bhOOS) + `  → ${pass ? '통과' : '기각'}`);
}
// 순위상관 (Spearman, 적격 규칙)
const rank = a => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); o.forEach(([, i], k) => r[i] = k); return r; };
const spear = (x, y) => { const rx = rank(x), ry = rank(y), m = (x.length - 1) / 2; let num = 0, dx = 0, dy = 0; for (let i = 0; i < x.length; i++) { num += (rx[i] - m) * (ry[i] - m); dx += (rx[i] - m) ** 2; dy += (ry[i] - m) ** 2; } return num / Math.sqrt(dx * dy); };
console.log(`\n설계↔검증 순위상관 (적격 ${eligible.length}개): Calmar ${spear(eligible.map(r => r.is.calmar), eligible.map(r => r.oos.calmar)).toFixed(2)} · CAGR ${spear(eligible.map(r => r.is.cagr), eligible.map(r => r.oos.cagr)).toFixed(2)}`);
const beatOOS = rows.filter(r => r.oos.cagr > bhOOS.cagr && r.oos.calmar > bhOOS.calmar);
console.log(`검증 구간에서 보유를 (CAGR·Calmar 둘 다) 이긴 규칙: ${beatOOS.length}/${rows.length}  ← 사후 집계, 선택 근거 아님`);

console.log(`\n설계 Calmar 상위 ${TOP} (참고):`);
for (const r of [...eligible].sort((a, b) => b.is.calmar - a.is.calmar).slice(0, TOP))
  console.log(`  ${r.s.name.padEnd(26)} 설계 Calmar ${r.is.calmar.toFixed(2).padStart(5)} 연초과 ${pp(r.is.cagr - bhIS.cagr).padStart(8)} | 검증 Calmar ${r.oos.calmar.toFixed(2).padStart(5)} 연초과 ${pp(r.oos.cagr - bhOOS.cagr).padStart(8)}`);
console.log(`\n검증 구간 사후 상위 ${TOP} (참고 — 이걸 고르면 스누핑):`);
for (const r of [...rows].sort((a, b) => b.oos.calmar - a.oos.calmar).slice(0, TOP))
  console.log(`  ${r.s.name.padEnd(26)} 검증 Calmar ${r.oos.calmar.toFixed(2).padStart(5)} 연초과 ${pp(r.oos.cagr - bhOOS.cagr).padStart(8)} MDD ${pct(r.oos.mdd).padStart(7)} | 설계 Calmar ${r.is.calmar.toFixed(2).padStart(5)}`);

// ── 판정 2: walk-forward ─────────────────────────────────────────────
function walkForward(score) {
  const wnav = new Float64Array(n).fill(NaN), picks = [];
  let base = 1, prevRule = null, start = null;
  for (let y = 2016; y <= +D[n - 1].slice(0, 4); y++) {
    const [a, b] = [lastIdxBefore(`${y - 5}0101`), lastIdxBefore(`${y}0101`)];
    const e = lastIdxUpTo(`${y}1231`);
    if (start === null) { start = b; wnav[b] = 1; }
    const cand = sims.map(s => ({ s, st: stats(s.nav, s.tradeAt, Math.max(i0, a), b) })).filter(c => c.st.trades >= MIN_TRADES);
    const best = cand.sort((p, q) => score(q.st) - score(p.st))[0].s;
    if (prevRule) base *= 1 - COST * Math.abs(best.held[b] - prevRule.held[b]);
    for (let i = b + 1; i <= e; i++) wnav[i] = base * best.nav[i] / best.nav[b];
    base = wnav[e];
    picks.push([y, best.name, best.nav[e] / best.nav[b] - 1, BH.nav[e] / BH.nav[b] - 1]);
    prevRule = best;
  }
  return { wnav, picks, start };
}
for (const [label, score] of [['Calmar 1위 (주 판정)', st => st.calmar], ['연초과 1위 (보조)', st => st.cagr]]) {
  const { wnav, picks, start } = walkForward(score);
  console.log(`\n━━ 판정 2: walk-forward — ${label} ━━`);
  for (const [y, name, r, m] of picks) console.log(`  ${y}  ${name.padEnd(26)} ${pct(r).padStart(7)} / 보유 ${pct(m).padStart(7)} / ${pp(r - m).padStart(8)}`);
  const s = stats(wnav, new Uint8Array(n), start, n - 1), m = stats(BH.nav, BH.tradeAt, start, n - 1);
  const pass = s.cagr > m.cagr && s.calmar > m.calmar;
  console.log(`  연결 ${D[start]}~${D[n - 1]}: CAGR ${pct(s.cagr)} MDD ${pct(s.mdd)} Calmar ${s.calmar.toFixed(2)} | 보유 CAGR ${pct(m.cagr)} MDD ${pct(m.mdd)} Calmar ${m.calmar.toFixed(2)} | 연초과 ${pp(s.cagr - m.cagr)} → ${pass ? '통과' : '기각'}`);
}
