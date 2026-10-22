/**
 * index-principal-test.js — 원금 기준 판정: 매주 열어봤을 때 원금 아래인가 (2026-10-22)
 *
 * 판정 기준은 INDEX_PRINCIPAL_VERDICT.md 에 돌리기 전에 등록했다. 규칙·임계값·구간을 여기서 바꾸지 말 것.
 * 규칙 정의는 index-box-backtest.js(D60~BRK120xVT60) / index-signal-test.js(F1·F3) 에서 그대로 옮겼다.
 * 실행: node scripts/index-principal-test.js [--cashrate=0.025] [--years=3]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const CASH_RATE = +arg('cashrate', 0.025);
const YEARS = +arg('years', 3);
const COST = 0.0005, BAND = 0.1;
const fp = f => path.resolve(__dirname, '../data', f);
const lines = f => fs.existsSync(fp(f)) ? fs.readFileSync(fp(f), 'utf-8').split('\n').filter(s => s.trim()) : [];

// ── 데이터 ───────────────────────────────────────────────────────────
const px = new Map();
for (const l of lines('kospi-index-long.jsonl')) { const r = JSON.parse(l); if (!r.h && r.k200[0] > 0) px.set(r.d, r.k200[0]); }
for (const l of lines('krx-index.jsonl')) {
  const r = JSON.parse(l); if (px.has(r.d)) continue;
  const k = r.i.find(x => x[0] === '코스피 200'); if (k && k[1] > 0) px.set(r.d, k[1]);
}
const D = [...px.keys()].sort(), n = D.length, C = D.map(d => px.get(d));
const utc = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
const wk = d => Math.floor((utc(d) / 864e5 + 3) / 7);
const weekEnd = D.map((d, i) => i === n - 1 || wk(D[i + 1]) !== wk(d));
console.log(`KOSPI 200 ${n}일 (${D[0]}~${D[n - 1]}) | 현금이자 연 ${(CASH_RATE * 100).toFixed(1)}% | 창 ${YEARS}년 · 매주 1단위 입금`);

// ── 규칙 (index-box-backtest.js 와 동일) ──────────────────────────────
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
function breakout(nIn, nOut) {
  return i => {
    if (i < Math.max(nIn, nOut)) return null;
    let H = -Infinity, L = Infinity;
    for (let j = i - nIn; j < i; j++) H = Math.max(H, C[j]);
    for (let j = i - nOut; j < i; j++) L = Math.min(L, C[j]);
    return C[i] > H ? 1 : C[i] < L ? 0 : null;
  };
}
function realizedVol(N) {
  const out = new Array(n).fill(NaN);
  for (let i = N; i < n; i++) {
    let s = 0, s2 = 0;
    for (let j = i - N + 1; j <= i; j++) { const r = Math.log(C[j] / C[j - 1]); s += r; s2 += r * r; }
    const m = s / N;
    out[i] = Math.sqrt(Math.max(0, s2 / N - m * m) * 252);
  }
  return out;
}
function volTarget(N, target) {
  const sig = realizedVol(N);
  return i => Number.isFinite(sig[i]) && sig[i] > 0 ? Math.min(1, target / sig[i]) : null;
}
function volSwitch(N, look, q) {
  const sig = realizedVol(N);
  return i => {
    if (i < N + look || !Number.isFinite(sig[i])) return null;
    const past = sig.slice(i - look, i).sort((a, b) => a - b);
    return sig[i] > past[Math.floor(q * (look - 1))] ? 0 : 1;
  };
}
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

// ── F1·F3 (index-signal-test.js 와 동일) ─────────────────────────────
const fund = new Map();
for (const l of lines('market-funds-daily.jsonl')) { const r = JSON.parse(l); fund.set(r.d, { cap: +r.hts_avls / 100, crdt: +r.crdt_loan_rmnd, dep: +r.cust_dpmn_amt }); }
const crdt = [], dep = [], cap = []; let last = null;
for (const d of D) { const f = fund.get(d); if (f && f.cap > 0 && f.crdt > 0 && f.dep > 0) last = f; crdt.push(last?.crdt ?? NaN); dep.push(last?.dep ?? NaN); cap.push(last?.cap ?? NaN); }
const pctl = (a, L = 500) => a.map((x, i) => { if (i < L || !Number.isFinite(x)) return NaN; const w = a.slice(i - L, i).filter(Number.isFinite); return w.filter(v => v < x).length / w.length; });
const pF1 = pctl(crdt.map((x, i) => x / cap[i])), pF3 = pctl(dep.map((x, i) => x / cap[i]));

// [규칙, 시작 상태] — 시작 상태: 첫 신호 전까지의 비중
const RULES = {
  '보유': [() => 1, 1],
  '전액 현금': [() => 0, 0],
  D60: [donchian(60), 0], D120: [donchian(120), 0], BB20: [bollinger(20, 2), 0],
  MA200: [movingAvg(200), 0], BRK120: [breakout(120, 60), 0], CUT60: [breakout(20, 60), 1],
  VT20: [volTarget(20, 0.15), 0], VT60: [volTarget(60, 0.15), 0], VSW: [volSwitch(20, 252, 0.8), 0],
  'MA200xVT20': [combine(movingAvg(200), 0, volTarget(20, 0.15), 'mul'), 0],
  'MA200+VT20': [combine(movingAvg(200), 0, volTarget(20, 0.15), 'avg'), 0],
  'BRK120xVT60': [combine(breakout(120, 60), 0, volTarget(60, 0.15), 'mul'), 0],
  'F1 신용과열 현금': [i => Number.isFinite(pF1[i]) ? (pF1[i] >= 0.9 ? 0 : 1) : null, 1],
  'F3 예탁금부족 현금': [i => Number.isFinite(pF3[i]) ? (pF3[i] <= 0.1 ? 0 : 1) : null, 1],
};
// 목표 비중을 전 기간 시간순으로 한 번 계산 (combine 의 상태가 시간순 호출을 전제)
const TARGET = {};
for (const [k, [rule, init]] of Object.entries(RULES)) {
  const t = new Array(n); let h = init;
  for (let i = 0; i < n; i++) { const w = rule(i); if (w !== null) h = w; t[i] = h; }
  TARGET[k] = t;
}

/** [a, b] 구간 정액 입금 계좌 */
function run(T, a, b) {
  const rc = Math.pow(1 + CASH_RATE, 1 / 252) - 1;
  let eq = 0, cash = 0, paid = 0, pending = false, held = 0;
  let checks = 0, under = 0, worst = 0;
  for (let i = a; i <= b; i++) {
    if (i > a) { eq *= C[i] / C[i - 1]; cash *= 1 + rc; }
    if (pending) {
      const tot = eq + cash, want = T[i - 1] * tot, trade = want - eq;
      eq = want - Math.abs(trade) * COST; cash = tot - want;   // 비용은 주식 쪽에서 뺀다
      held = T[i - 1]; pending = false;
    }
    if (weekEnd[i]) {
      if (paid > 0) { const v = eq + cash, r = v / paid - 1; checks++; if (r < 0) under++; worst = Math.min(worst, r); }
      if (i < b) { cash += 1; paid += 1; pending = true; }
    } else {
      const tot = eq + cash, cur = tot > 0 ? eq / tot : 0;
      if (paid > 0 && Math.abs(T[i] - cur) >= BAND && Math.abs(T[i] - held) >= BAND) pending = true;
    }
  }
  return { uw: under / checks, worst, mult: (eq + cash) / paid };
}

const starts = [];
for (let i = 1; i < n; i++) if (D[i].slice(0, 6) !== D[i - 1].slice(0, 6) && D[i] >= '20110101') starts.push(i);
const wins = [];
for (const a of starts) {
  const end = String(+D[a].slice(0, 4) + YEARS) + D[a].slice(4);
  const b = D.findIndex(d => d >= end); if (b < 0) break; wins.push([a, b]);
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const pct = (x, k = 0) => (x >= 0 ? '+' : '') + (x * 100).toFixed(k) + '%';
const SEG = { IS: ([a]) => D[a] < '20160101', OOS: ([a]) => D[a] >= '20160101' };

const out = {};
for (const k of Object.keys(RULES)) {
  out[k] = {};
  for (const [s, f] of Object.entries(SEG)) {
    const rs = wins.filter(f).map(([a, b]) => run(TARGET[k], a, b));
    out[k][s] = { uw: mean(rs.map(r => r.uw)), worst: Math.min(...rs.map(r => r.worst)), mult: median(rs.map(r => r.mult)), n: rs.length,
      uwMed: median(rs.map(r => r.uw)), endLoss: rs.filter(r => r.mult < 1).length / rs.length };
  }
}
console.log(`창 ${wins.length}개 (IS ${out['보유'].IS.n} / OOS ${out['보유'].OOS.n})\n`);
console.log('규칙'.padEnd(16) + '|   IS: 원금아래주 최대손실 최종배수 종료손실창 |  OOS: 원금아래주 최대손실 최종배수 종료손실창 | 판정');
const verdict = (k) => {
  const res = ['IS', 'OOS'].map(s => {
    const r = out[k][s], cashM = out['전액 현금'][s].mult, hold = out['보유'][s].uw;
    if (r.uw <= 0.15 && r.worst >= -0.15 && r.mult > cashM) return 2;
    if (r.uw <= hold / 2 && r.mult > cashM) return 1;
    return 0;
  });
  const m = Math.min(...res);
  return m === 2 ? '✅ 통과' : m === 1 ? '🟡 개선' : '기각';
};
for (const k of Object.keys(RULES)) {
  const f = s => { const r = out[k][s]; return `${pct(r.uw).padStart(8)} ${pct(r.worst).padStart(8)} ${r.mult.toFixed(3).padStart(8)} ${pct(r.endLoss).padStart(9)}`; };
  console.log(`${k.padEnd(16)}| ${f('IS')}    | ${f('OOS')}    | ${k === '보유' || k === '전액 현금' ? '(기준선)' : verdict(k)}`);
}

// 현재 상태
const i = n - 1;
console.log(`\n현재(${D[i]}) 목표 비중: ` + Object.keys(RULES).filter(k => k !== '보유' && k !== '전액 현금').map(k => `${k} ${(TARGET[k][i] * 100).toFixed(0)}%`).join(' · '));
