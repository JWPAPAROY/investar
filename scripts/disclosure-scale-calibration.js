/**
 * disclosure-scale-calibration.js — 척도 교정 (2026-09-07)
 *
 * 🚨 **이 스크립트는 공시 데이터를 읽지 않는다.** 오직 무작위 위약(placebo)만 본다.
 *    추정량을 고를 때 유형별 성적이 눈에 들어오면 그 순간 사전 등록이 무너진다.
 *    선택 기준은 단 하나: **위약 중앙값이 ±0.1% 이내인가.**
 *
 * 왜: 1회차 판정(2026-09-07)에서 통제군(정기보고서)이 -0.69%p로 나와 중단 조건이 걸렸다.
 *   위약 테스트 결과 무작위 표본도 -0.66%였다 — 공시 효과가 아니라 **자의 눈금이 틀린 것**.
 *   원인: 개별 종목을 분위 **평균**과 비교한 뒤 이벤트 사이에서 **중앙값**을 취했다.
 *   일간 수익률이 우편향이라 분위 평균이 중앙값보다 하루 0.23%씩 높고,
 *   4거래일 누적에서 약 -0.9%p의 가짜 하방 편향이 생긴다.
 *
 * 후보 추정량 3종을 같은 위약으로 비교한다:
 *   A) 일간 초과(분위 평균 기준) 합         — 1회차가 쓴 것
 *   B) 일간 초과(분위 중앙값 기준) 합       — 통계량을 맞춘 것
 *   C) 창(window) 수익 − 동일창 분위 중앙값 — 조건까지 맞춘 것
 *      C만이 이벤트와 대조군에 **같은 생존 조건**을 건다.
 *      (A·B는 이벤트에만 "창 전체에 가격이 있을 것"을 요구해 생존편향이 남는다)
 *
 * 권리락 처리: 상장주식수(=시총/종가)가 하루에 5% 넘게 변한 날은 가격 수익률이
 *   실제 수익이 아니다(무상증자·액면분할 권리락). 재구성하지 않고 **제외**한다 —
 *   이벤트와 대조군에 동일하게 적용되므로 대칭이다.
 *
 * 실행: node --max-old-space-size=8192 scripts/disclosure-scale-calibration.js
 */
const fs = require('fs');
const path = require('path');

const PLACEBO_N = 120000;
const TOL = 0.1;              // 통과 기준: |위약 중앙값| ≤ 0.1%
const SHARE_JUMP = 0.05;      // 상장주식수 변동 5% 초과 = 권리락 의심 → 제외
const BUY = 1, SELL = 5;      // 사전 등록 지평 (주 판정)

const DAILY = path.resolve(__dirname, '../data/krx-daily.jsonl');
const MASTER = path.resolve(__dirname, '../data/krx-master.json');

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const common = new Set();
for (const r of JSON.parse(fs.readFileSync(MASTER, 'utf-8')).rows) if (r.stkType === '보통주') common.add(r.code);
const recs = fs.readFileSync(DAILY, 'utf-8').split('\n').filter(l => l.trim())
  .map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d);
const N = days.length;
const codeIdx = new Map();
for (const r of recs) for (const s of r.s) { if (!common.has(s[0])) continue; if (!codeIdx.has(s[0])) codeIdx.set(s[0], codeIdx.size); }
const M = codeIdx.size;
const CL = new Float64Array(N * M).fill(NaN), CAP = new Float64Array(N * M).fill(NaN);
for (let i = 0; i < N; i++) for (const [c, , , , clo, , , cap] of recs[i].s) {
  const j = codeIdx.get(c); if (j === undefined) continue;
  CL[i * M + j] = clo; CAP[i * M + j] = cap;
}
console.log(`데이터 ${N}거래일 × ${M}종목 (${days[0]} ~ ${days[N - 1]})`);

// ── 일간 수익률 + 권리락 제외 ───────────────────────────────────────────
// RET[i*M+j] = i일의 1일 수익률(%). 유효하지 않으면 NaN.
const RET = new Float64Array(N * M).fill(NaN);
let exDropped = 0, retTotal = 0;
for (let i = 1; i < N; i++) {
  for (let j = 0; j < M; j++) {
    const p = CL[(i - 1) * M + j], q = CL[i * M + j];
    if (!(p > 0) || !(q > 0)) continue;
    const c0 = CAP[(i - 1) * M + j], c1 = CAP[i * M + j];
    if (c0 > 0 && c1 > 0) {
      const s0 = c0 / p, s1 = c1 / q;                 // 상장주식수
      if (Math.abs(s1 / s0 - 1) > SHARE_JUMP) { exDropped++; continue; }  // 권리락 의심
    }
    RET[i * M + j] = ((q - p) / p) * 100;
    retTotal++;
  }
}
console.log(`일간 수익률 ${retTotal.toLocaleString()}건 / 권리락 의심 제외 ${exDropped.toLocaleString()}건 `
  + `(${(100 * exDropped / (retTotal + exDropped)).toFixed(3)}%)`);

// 누적 로그수익 + 유효일 누적 → 임의 창 수익을 O(1)로
const LOGC = new Float64Array(N * M), VC = new Int32Array(N * M);
for (let j = 0; j < M; j++) {
  let acc = 0, vc = 0;
  for (let i = 0; i < N; i++) {
    const r = RET[i * M + j];
    if (!Number.isNaN(r)) { acc += Math.log(1 + r / 100); vc++; }
    LOGC[i * M + j] = acc; VC[i * M + j] = vc;
  }
}
/** 오프셋 [a,b] 창의 누적 수익(%). 창 안에 결측·권리락이 하나라도 있으면 null. */
function winRet(j, i0, a, b) {
  const lo = i0 + a - 1, hi = i0 + b;
  if (lo < 0 || hi >= N) return null;
  const need = b - a + 1;
  if (VC[hi * M + j] - VC[lo * M + j] !== need) return null;
  return (Math.exp(LOGC[hi * M + j] - LOGC[lo * M + j]) - 1) * 100;
}

// ── 시총 5분위 ──────────────────────────────────────────────────────────
const quint = new Int8Array(N * M).fill(-1);
for (let i = 0; i < N; i++) {
  const rows = [];
  for (let j = 0; j < M; j++) { const c = CAP[i * M + j]; if (c > 0 && CL[i * M + j] > 0) rows.push([j, c]); }
  rows.sort((a, b) => a[1] - b[1]);
  rows.forEach(([j], k) => { quint[i * M + j] = Math.min(4, Math.floor((k / rows.length) * 5)); });
}

// A·B용 일간 분위 기준선 (평균 / 중앙값)
const qMean = [], qMed = [];
for (let i = 0; i < N; i++) {
  const b = [[], [], [], [], []];
  for (let j = 0; j < M; j++) { const r = RET[i * M + j]; const q = quint[i * M + j]; if (!Number.isNaN(r) && q >= 0) b[q].push(r); }
  qMean.push(b.map(x => (x.length >= 20 ? avg(x) : null)));
  qMed.push(b.map(x => (x.length >= 20 ? med(x) : null)));
}

// C용 창 기준선: (i0, 분위) → 같은 창을 온전히 관측한 동료들의 창수익 중앙값
const winBase = new Map();   // key `${i0}|${q}` → median
function baseWin(i0, q, a, b) {
  const key = `${i0}|${q}|${a}|${b}`;
  let v = winBase.get(key);
  if (v !== undefined) return v;
  const vals = [];
  for (let j = 0; j < M; j++) {
    if (quint[i0 * M + j] !== q) continue;
    const w = winRet(j, i0, a, b);
    if (w != null) vals.push(w);
  }
  v = vals.length >= 20 ? med(vals) : null;
  winBase.set(key, v);
  return v;
}

// ── 추정량 3종 ──────────────────────────────────────────────────────────
function estA(j, i0, a, b) {   // 일간 초과(분위 평균) 합
  let s = 0;
  for (let t = a; t <= b; t++) {
    const i = i0 + t; if (i <= 0 || i >= N) return null;
    const r = RET[i * M + j]; if (Number.isNaN(r)) return null;
    const q = quint[i * M + j]; if (q < 0) return null;
    const m = qMean[i][q]; if (m == null) return null;
    s += r - m;
  }
  return s;
}
function estB(j, i0, a, b) {   // 일간 초과(분위 중앙값) 합
  let s = 0;
  for (let t = a; t <= b; t++) {
    const i = i0 + t; if (i <= 0 || i >= N) return null;
    const r = RET[i * M + j]; if (Number.isNaN(r)) return null;
    const q = quint[i * M + j]; if (q < 0) return null;
    const m = qMed[i][q]; if (m == null) return null;
    s += r - m;
  }
  return s;
}
function estC(j, i0, a, b) {   // 창 수익 − 동일창 분위 중앙값
  const w = winRet(j, i0, a, b); if (w == null) return null;
  const q = quint[i0 * M + j]; if (q < 0) return null;
  const m = baseWin(i0, q, a, b); if (m == null) return null;
  return w - m;
}

// ── 위약 표본 (공시와 무관, 완전 무작위) ────────────────────────────────
let seed = 20260907;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const picks = [];
for (let k = 0; k < PLACEBO_N; k++) {
  picks.push([Math.floor(rnd() * M), 15 + Math.floor(rnd() * (N - 35))]);
}

const RANGES = [
  ['주 판정  D+1→D+5', BUY + 1, SELL],
  ['보조      D+1→D+2', BUY + 1, 2],
  ['보조      D+1→D+10', BUY + 1, 10],
  ['사전      D-5→D-1', -5, -1],
  ['사후      D0→D+5', 0, SELL],
];

console.log('\n' + '='.repeat(78));
console.log('★ 위약 테스트 — 공시와 무관한 무작위 표본. 정상이면 0.');
console.log('='.repeat(78));
console.log('구간                      A(분위평균)   B(분위중앙)   C(창매칭)');
const verdict = { A: [], B: [], C: [] };
for (const [label, a, b] of RANGES) {
  const out = { A: [], B: [], C: [] };
  for (const [j, i0] of picks) {
    const va = estA(j, i0, a, b); if (va != null) out.A.push(va);
    const vb = estB(j, i0, a, b); if (vb != null) out.B.push(vb);
    const vc = estC(j, i0, a, b); if (vc != null) out.C.push(vc);
  }
  const f = v => (v == null ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(3));
  console.log(`${label.padEnd(24)} ${f(med(out.A)).padStart(9)}     ${f(med(out.B)).padStart(9)}     ${f(med(out.C)).padStart(9)}`);
  for (const k of ['A', 'B', 'C']) verdict[k].push(Math.abs(med(out[k]) ?? 99));
}
console.log(`\n표본 ${PLACEBO_N.toLocaleString()}건 추첨 / 유효분만 집계`);

console.log('\n★ 채택 판정 (기준: 모든 구간에서 |위약 중앙값| ≤ ' + TOL + '%)');
let chosen = null;
for (const k of ['C', 'B', 'A']) {          // 조건까지 맞춘 C를 우선 검토
  const worst = Math.max(...verdict[k]);
  const ok = worst <= TOL;
  console.log(`   ${k}: 최악 구간 편향 ${worst.toFixed(3)}% → ${ok ? '✅ 통과' : '❌ 기각'}`);
  if (ok && !chosen) chosen = k;
}
console.log(chosen
  ? `\n⇒ 추정량 ${chosen} 채택. 이 기준만으로 골랐고 유형별 성적은 보지 않았다.`
  : '\n⇒ 세 후보 모두 기준 미달. 추가 교정이 필요하다 — 판정을 돌리지 말 것.');
