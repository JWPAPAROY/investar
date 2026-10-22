/**
 * index-box-backtest.js — KOSPI 200 박스권(역추세) 매매 vs 보유 (2026-10-21)
 *
 * 판정 기준은 INDEX_BOX_VERDICT.md 에 결과를 보기 전에 등록했다. 규칙·구간·비용을 여기서 바꾸지 말 것.
 * 데이터: data/kospi-index-long.jsonl (collect-kospi-index-long.js). 없는 날은 krx-index.jsonl 에서 보충.
 *
 * 실행: node scripts/index-box-backtest.js [--set=box|trend|vol|combo] [--cost=0.0005] [--yearly]
 *   --set=trend 는 2차(추세추종) 사전 등록 규칙 — 같은 문서 하단.
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const COST = +arg('cost', 0.0005);
const YEARLY = process.argv.includes('--yearly');
const SET = arg('set', 'box');
const EVAL_START = '20110103';
const BAND = 0.1;   // 리밸런싱 밴드 (3차 사전 등록)

// ── 데이터 ───────────────────────────────────────────────────────────
const close = new Map();
const LONG = path.resolve(__dirname, '../data/kospi-index-long.jsonl');
const SHORT = path.resolve(__dirname, '../data/krx-index.jsonl');
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(s => s.trim()) : [];
for (const l of lines(LONG)) { const r = JSON.parse(l); if (!r.h && r.k200[0] > 0) close.set(r.d, r.k200[0]); }
let nFill = 0;
for (const l of lines(SHORT)) {
  const r = JSON.parse(l);
  if (close.has(r.d)) continue;
  const k = r.i.find(x => x[0] === '코스피 200');
  if (k && k[1] > 0) { close.set(r.d, k[1]); nFill++; }
}
const D = [...close.keys()].sort();
const C = D.map(d => close.get(d));
console.log(`KOSPI 200 종가 ${D.length}일 (${D[0]} ~ ${D[D.length - 1]}, krx-index 보충 ${nFill}일) | 편도 비용 ${(COST * 100).toFixed(3)}%`);

// 데이터 공백 점검 — 달력상 10일 넘게 비면 수집 누락
for (let i = 1; i < D.length; i++) {
  const gap = (Date.parse(fmt(D[i])) - Date.parse(fmt(D[i - 1]))) / 864e5;
  if (gap > 10) console.warn(`⚠️ 데이터 공백 ${D[i - 1]} → ${D[i]} (${gap}일)`);
}
function fmt(d) { return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; }

// ── 규칙: 당일 종가까지로 목표 포지션(1/0/null=유지) ────────────────────
function donchian(N) {
  return i => {
    if (i < N) return null;
    let H = -Infinity, L = Infinity;
    for (let j = i - N; j < i; j++) { if (C[j] > H) H = C[j]; if (C[j] < L) L = C[j]; }
    const p = (C[i] - L) / (H - L);
    return p <= 0.2 ? 1 : p >= 0.8 ? 0 : null;
  };
}
function bollinger(N, k) {
  return i => {
    if (i < N - 1) return null;
    let s = 0, s2 = 0;
    for (let j = i - N + 1; j <= i; j++) { s += C[j]; s2 += C[j] * C[j]; }
    const m = s / N, sd = Math.sqrt(Math.max(0, s2 / N - m * m));
    return C[i] < m - k * sd ? 1 : C[i] > m + k * sd ? 0 : null;
  };
}
function movingAvg(N) {
  return i => {
    if (i < N - 1) return null;
    let s = 0; for (let j = i - N + 1; j <= i; j++) s += C[j];
    const m = s / N;
    return C[i] > m ? 1 : C[i] < m ? 0 : null;
  };
}
/** 직전 nIn일 최고 돌파 → 보유, 직전 nOut일 최저 이탈 → 현금 (당일 제외) */
function breakout(nIn, nOut) {
  return i => {
    if (i < Math.max(nIn, nOut)) return null;
    let H = -Infinity, L = Infinity;
    for (let j = i - nIn; j < i; j++) H = Math.max(H, C[j]);
    for (let j = i - nOut; j < i; j++) L = Math.min(L, C[j]);
    return C[i] > H ? 1 : C[i] < L ? 0 : null;
  };
}
/** 연율 실현변동성 배열: 직전 N거래일(당일 포함) 일간 로그수익 표준편차 × √252 */
function realizedVol(N) {
  const out = new Array(C.length).fill(NaN);
  for (let i = N; i < C.length; i++) {
    let s = 0, s2 = 0;
    for (let j = i - N + 1; j <= i; j++) { const r = Math.log(C[j] / C[j - 1]); s += r; s2 += r * r; }
    const m = s / N;
    out[i] = Math.sqrt(Math.max(0, s2 / N - m * m) * 252);
  }
  return out;
}
/** 변동성 타기팅: 비중 = min(1, 목표 / σN) */
function volTarget(N, target) {
  const sig = realizedVol(N);
  return i => Number.isFinite(sig[i]) && sig[i] > 0 ? Math.min(1, target / sig[i]) : null;
}
/** 이진 스위치: σ20 이 직전 252일 σ20 분포의 q분위 초과면 현금 */
function volSwitch(N, look, q) {
  const sig = realizedVol(N);
  return i => {
    if (i < N + look || !Number.isFinite(sig[i])) return null;
    const past = sig.slice(i - look, i).sort((a, b) => a - b);
    return sig[i] > past[Math.floor(q * (look - 1))] ? 0 : 1;
  };
}
/** 4차: 추세 상태(0/1, 신호 없으면 유지) × 또는 + 변동성 비중. 호출이 시간순이라는 전제(simulate가 보장) */
function combine(trend, trendInit, vt, mode) {
  let t = trendInit;
  return i => {
    const sig = trend(i);
    if (sig !== null) t = sig;
    const v = vt(i);
    if (v === null) return null;
    return mode === 'mul' ? t * v : 0.5 * t + 0.5 * v;
  };
}
// init: 시작 포지션 (0 = 현금, 1 = 보유, 'rule' = 첫날 규칙대로)
const SETS = {
  box: { D60: [donchian(60), 0], D120: [donchian(120), 0], BB20: [bollinger(20, 2), 0] },
  trend: { MA200: [movingAvg(200), 'rule'], BRK120: [breakout(120, 60), 0], CUT60: [breakout(20, 60), 1] },
  combo: {
    'MA200xVT20': [combine(movingAvg(200), 0, volTarget(20, 0.15), 'mul'), 'rule'],
    'MA200+VT20': [combine(movingAvg(200), 0, volTarget(20, 0.15), 'avg'), 'rule'],
    'BRK120xVT60': [combine(breakout(120, 60), 0, volTarget(60, 0.15), 'mul'), 'rule'],
  },
  vol: { VT20: [volTarget(20, 0.15), 'rule'], VT60: [volTarget(60, 0.15), 'rule'], VSW: [volSwitch(20, 252, 0.8), 'rule'] },
};
if (!SETS[SET]) { console.error(`❌ --set=${SET} 없음 (box|trend|vol|combo)`); process.exit(1); }
const RULES = Object.fromEntries(Object.entries(SETS[SET]).map(([k, [r]]) => [k, r]));
const INIT = Object.fromEntries(Object.entries(SETS[SET]).map(([k, [, init]]) => [k, init]));

// ── 시뮬레이션 ───────────────────────────────────────────────────────
const i0 = D.findIndex(d => d >= EVAL_START);
function simulate(rule, init) {
  const nav = new Array(D.length).fill(NaN), held = new Array(D.length).fill(0);
  let v = 1, h = init === 'rule' ? (rule(i0) ?? 0) : init, pending = null, trades = [];
  nav[i0] = 1;
  for (let i = i0; i < D.length; i++) {
    if (i > i0) v *= 1 + h * (C[i] / C[i - 1] - 1);
    if (pending !== null) { v *= 1 - COST * Math.abs(pending - h); h = pending; pending = null; trades.push(i); }
    nav[i] = v; held[i] = h;
    const want = rule(i);
    // 비중 변화 0.1 미만은 무시 (0/1 규칙은 변화가 항상 1이라 영향 없음)
    if (want !== null && Math.abs(want - h) >= BAND) pending = want;
  }
  return { nav, held, trades };
}
const bh = D.map((_, i) => i >= i0 ? C[i] / C[i0] : NaN);

// ── 지표 ─────────────────────────────────────────────────────────────
function stats(nav, a, b) {
  const yrs = (Date.parse(fmt(D[b])) - Date.parse(fmt(D[a]))) / (365.25 * 864e5);
  const tot = nav[b] / nav[a] - 1;
  let peak = -Infinity, pk = a, mdd = 0, from = a, to = a;
  for (let i = a; i <= b; i++) {
    if (nav[i] > peak) { peak = nav[i]; pk = i; }
    if (nav[i] / peak - 1 < mdd) { mdd = nav[i] / peak - 1; from = pk; to = i; }
  }
  const cagr = Math.pow(1 + tot, 1 / yrs) - 1;
  return { tot, cagr, mdd, mddWin: `${D[from]}→${D[to]}`, calmar: mdd < 0 ? cagr / -mdd : Infinity };
}
const segIdx = (from, to) => {
  const a = Math.max(i0, D.findIndex(d => d >= from));
  let b = D.length - 1; while (D[b] > to) b--;
  return [a === i0 ? a : a - 1, b];   // 구간 직전 종가를 기준점으로
};
const SEGS = [
  ['전 구간', '20110101', '99991231'],
  ['A 박스장 2011-16', '20110101', '20161231'],
  ['중간 2017-19', '20170101', '20191231'],
  ['B 추세장 2020-', '20200101', '99991231'],
  ['참고 2011-2025', '20110101', '20251231'],   // 3차: 2026 급락을 뺀 성적 (판정에 안 씀)
  ['참고 2026-06-22~', '20260623', '99991231'],  // 3차: 급락 구간만 (판정에 안 씀, 직전 종가 = 6/22 고점 기준)
];
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';

const results = {};
for (const [key, rule] of Object.entries(RULES)) {
  const { nav, held, trades } = simulate(rule, INIT[key]);
  results[key] = {};
  console.log(`\n━━ ${key} ━━ 체결 ${trades.length}회`);
  console.log('구간'.padEnd(18) + '전략 누적  CAGR    MDD    | 보유 누적  CAGR    MDD    | 연초과   시장참여  체결');
  let mddNote = '';
  for (const [name, from, to] of SEGS) {
    const [a, b] = segIdx(from, to);
    const s = stats(nav, a, b), m = stats(bh, a, b);
    let inMkt = 0; for (let i = a + 1; i <= b; i++) inMkt += held[i - 1];
    const nt = trades.filter(t => t > a && t <= b).length;
    results[key][name] = { s, m, ex: s.cagr - m.cagr };
    if (name === '전 구간') mddNote = `  최대낙폭 구간: 전략 ${s.mddWin} / 보유 ${m.mddWin}`;
    console.log(name.padEnd(18) +
      `${pct(s.tot).padStart(8)} ${pct(s.cagr).padStart(6)} ${pct(s.mdd).padStart(7)} | ` +
      `${pct(m.tot).padStart(8)} ${pct(m.cagr).padStart(6)} ${pct(m.mdd).padStart(7)} | ` +
      `${pp(s.cagr - m.cagr).padStart(8)} ${(inMkt / (b - a) * 100).toFixed(0).padStart(5)}%  ${String(nt).padStart(4)}`);
  }
  console.log(mddNote);
  if (YEARLY) {
    const years = [...new Set(D.slice(i0).map(d => d.slice(0, 4)))];
    console.log('  연도별 (전략 / 보유 / 차이):');
    for (const y of years) {
      const [a, b] = segIdx(`${y}0101`, `${y}1231`);
      const s = nav[b] / nav[a] - 1, m = bh[b] / bh[a] - 1;
      console.log(`  ${y}  ${pct(s).padStart(7)} / ${pct(m).padStart(7)} / ${pp(s - m).padStart(8)}`);
    }
  }
}

// ── 판정 (INDEX_BOX_VERDICT.md) ─────────────────────────────────────
console.log('\n━━ 판정 (사전 등록 기준) ━━');
for (const key of Object.keys(RULES)) {
  const all = results[key]['전 구간'], B = results[key]['B 추세장 2020-'];
  let v;
  if (B.ex <= -0.05) v = '기각 (B 연초과 ≤ −5%p)';
  else if (all.ex >= 0) v = '통과';
  else if (all.s.mdd - all.m.mdd >= 0.10 && all.s.calmar > all.m.calmar) v = '낙폭 축소 후보';
  else v = '기각 (전 구간 초과 음수, 낙폭 조건 미충족)';
  console.log(`${key.padEnd(5)} 전 구간 ${pp(all.ex)} · B ${pp(B.ex)} · MDD ${pct(all.s.mdd)} vs ${pct(all.m.mdd)} · Calmar ${all.s.calmar.toFixed(2)} vs ${all.m.calmar.toFixed(2)} → ${v}`);
}
