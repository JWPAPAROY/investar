/**
 * buyback-verdict.js — 자기주식취득 = 강제 흐름 축 판정 (2026-09-07)
 *
 * 🚨 예측·방향·임계값은 BUYBACK_VERDICT.md에 **데이터를 보기 전에** 사전 등록돼 있다.
 *    이 스크립트는 그 조건을 코드로 계산한다. 눈으로 고르지 않는다.
 *    실행은 1회. 조건을 바꿔 다시 돌리면 사전 등록이 무효가 된다.
 *
 * 가설: 자기주식취득의 초과수익은 정보가 아니라 **강제 매수 흐름**에서 나온다.
 *
 *   P0 척도 게이트  위약 편향 ≤0.1% AND 통제군 |x| ≤0.3%p
 *   P4 반증 게이트  자기주식취득**결과보고서** |x| ≤0.3%p
 *                   (이미 다 산 뒤 → 흐름이 원인이면 효과가 없어야 한다)
 *   P1 용량-반응    취득금액/시총 5분위, Q5-Q1 ≥+1.0%p AND Spearman ≥+0.8
 *   P2 실행 경로    직접취득 − 신탁계약 ≥+0.5%p
 *   P3 지속성       취득기간 중 D+1→D+20 순초과 ≥0 AND 기간 종료 후 20일 ≤+0.2%p
 *   P5 목적 분해    병기만. 판정에 쓰지 않는다.
 *   채택 = P0 AND P4 AND P1 AND (P2 또는 P3)
 *
 * 척도는 disclosure-event-study.js와 동일한 **추정량 C**
 *   (창 수익 − 같은 창을 온전히 관측한 동일일·동일 시총분위 동료의 중앙값).
 *
 * 실행: node --max-old-space-size=8192 scripts/buyback-verdict.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');

// ── 사전 등록 상수 ──────────────────────────────────────────────────────
const BUY = 1, SELL = 5, LONG = 20;
const COST = 0.38;
const P0_PLACEBO = 0.1, P0_CTRL = 0.3;
const P4_TOL = 0.3;
const P1_SPREAD = 1.0, P1_RHO = 0.8;
const P2_GAP = 0.5;
const P3_POST = 0.2;
const MIN_N = 100, MIN_BLOCKS = 20;
const SHARE_JUMP = 0.05;
const PLACEBO_N = 60000;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);
const med = a => { if (!a.length) return null; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = v => (v == null ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(2));

// ── KRX 데이터 ──────────────────────────────────────────────────────────
const common = new Set();
for (const r of JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/krx-master.json'), 'utf-8')).rows)
  if (r.stkType === '보통주') common.add(r.code);
const recs = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d), N = recs.length;
const dayIdx = new Map(days.map((d, i) => [d, i]));
const codeIdx = new Map();
for (const r of recs) for (const s of r.s) { if (!common.has(s[0])) continue; if (!codeIdx.has(s[0])) codeIdx.set(s[0], codeIdx.size); }
const M = codeIdx.size;
const CL = new Float64Array(N * M).fill(NaN), CAP = new Float64Array(N * M).fill(NaN);
for (let i = 0; i < N; i++) for (const [c, , , , clo, , , cap] of recs[i].s) {
  const j = codeIdx.get(c); if (j === undefined) continue;
  CL[i * M + j] = clo; CAP[i * M + j] = cap;
}
const RET = new Float64Array(N * M).fill(NaN);
for (let i = 1; i < N; i++) for (let j = 0; j < M; j++) {
  const p = CL[(i - 1) * M + j], q = CL[i * M + j];
  if (!(p > 0) || !(q > 0)) continue;
  const c0 = CAP[(i - 1) * M + j], c1 = CAP[i * M + j];
  if (c0 > 0 && c1 > 0 && Math.abs((c1 / q) / (c0 / p) - 1) > SHARE_JUMP) continue;  // 권리락 의심
  RET[i * M + j] = ((q - p) / p) * 100;
}
const LOGC = new Float64Array(N * M), VC = new Int32Array(N * M);
for (let j = 0; j < M; j++) {
  let acc = 0, vc = 0;
  for (let i = 0; i < N; i++) {
    const r = RET[i * M + j];
    if (!Number.isNaN(r)) { acc += Math.log(1 + r / 100); vc++; }
    LOGC[i * M + j] = acc; VC[i * M + j] = vc;
  }
}
function winRet(j, i0, a, b) {
  const lo = i0 + a - 1, hi = i0 + b;
  if (lo < 0 || hi >= N) return null;
  if (VC[hi * M + j] - VC[lo * M + j] !== b - a + 1) return null;
  return (Math.exp(LOGC[hi * M + j] - LOGC[lo * M + j]) - 1) * 100;
}
const quint = new Int8Array(N * M).fill(-1);
for (let i = 0; i < N; i++) {
  const rows = [];
  for (let j = 0; j < M; j++) { const c = CAP[i * M + j]; if (c > 0 && CL[i * M + j] > 0) rows.push([j, c]); }
  rows.sort((a, b) => a[1] - b[1]);
  rows.forEach(([j], k) => { quint[i * M + j] = Math.min(4, Math.floor((k / rows.length) * 5)); });
}
const baseCache = new Map();
function bases(i0, a, b) {
  const key = i0 + '|' + a + '|' + b;
  let v = baseCache.get(key); if (v !== undefined) return v;
  const bk = [[], [], [], [], []];
  for (let j = 0; j < M; j++) {
    const q = quint[i0 * M + j]; if (q < 0) continue;
    const w = winRet(j, i0, a, b); if (w == null) continue;
    bk[q].push(w);
  }
  v = bk.map(x => (x.length >= 20 ? med(x) : null));
  baseCache.set(key, v); return v;
}
/** 추정량 C */
function ex(j, i0, a, b) {
  const w = winRet(j, i0, a, b); if (w == null) return null;
  const q = quint[i0 * M + j]; if (q < 0) return null;
  const m = bases(i0, a, b)[q]; if (m == null) return null;
  return w - m;
}
const toIdx = (dt) => {
  const t = String(dt).replace(/-/g, '');
  const i = dayIdx.get(t); if (i !== undefined) return i;
  let lo = 0, hi = N - 1, f = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] >= t) { f = mid; hi = mid - 1; } else lo = mid + 1; }
  return f < 0 ? null : f;
};

async function fetchAll(table, cols, filter) {
  let out = [], from = 0;
  for (;;) {
    let q = orderByPk(sb.from(table).select(cols), table).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}
const stat = (arr) => ({ n: arr.length, m: med(arr) });

(async () => {
  console.log('\n🏦 자기주식취득 = 강제 흐름 축 판정 — 사전 등록: BUYBACK_VERDICT.md');
  console.log(`데이터: ${N}거래일 × ${M}종목 (${days[0]} ~ ${days[N - 1]})`);

  // ── P0 척도 게이트 ────────────────────────────────────────────────────
  let seed = 20260907;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pb = [];
  for (let k = 0; k < PLACEBO_N; k++) {
    const v = ex(Math.floor(rnd() * M), 25 + Math.floor(rnd() * (N - 50)), BUY + 1, SELL);
    if (v != null) pb.push(v);
  }
  const placebo = med(pb);
  const ctrlRows = await fetchAll('disclosures', 'rcept_dt,stock_code',
    q => q.eq('report_type', 'Z1_정기보고서').eq('is_amendment', false).eq('is_subsidiary', false));
  const ctrlVals = [];
  for (const r of ctrlRows) {
    const j = codeIdx.get(r.stock_code); if (j === undefined) continue;
    const i0 = toIdx(r.rcept_dt); if (i0 == null) continue;
    const v = ex(j, i0, BUY + 1, SELL); if (v != null) ctrlVals.push(v);
  }
  const ctrl = med(ctrlVals);
  const p0 = Math.abs(placebo) <= P0_PLACEBO && Math.abs(ctrl) <= P0_CTRL;
  console.log(`\n[P0 척도 게이트]`);
  console.log(`  위약 ${pb.length.toLocaleString()}건 편향 ${pct(placebo)}%  (기준 ≤${P0_PLACEBO}) ${Math.abs(placebo) <= P0_PLACEBO ? '✅' : '🚨'}`);
  console.log(`  통제군 정기보고서 ${ctrlVals.length.toLocaleString()}건 ${pct(ctrl)}%p (기준 ≤${P0_CTRL}) ${Math.abs(ctrl) <= P0_CTRL ? '✅' : '🚨'}`);
  if (!p0) { console.log('\n🚨 척도 게이트 실패 — 판정을 출력하지 않는다.'); return; }

  // ── P4 반증 게이트: 결과보고서 ────────────────────────────────────────
  const resRows = await fetchAll('disclosures', 'rcept_dt,stock_code,report_nm',
    q => q.ilike('report_nm', '%자기주식취득결과보고서%').eq('is_amendment', false).eq('is_subsidiary', false));
  const resVals = [];
  const resSeen = new Set();
  for (const r of resRows) {
    const key = r.stock_code + '|' + r.rcept_dt; if (resSeen.has(key)) continue; resSeen.add(key);
    const j = codeIdx.get(r.stock_code); if (j === undefined) continue;
    const i0 = toIdx(r.rcept_dt); if (i0 == null) continue;
    const v = ex(j, i0, BUY + 1, SELL); if (v != null) resVals.push(v);
  }
  const p4v = med(resVals);
  const p4Days = new Set(); // 블록 계산용
  const p4 = resVals.length >= MIN_N && p4v != null && Math.abs(p4v) <= P4_TOL;
  console.log(`\n[P4 반증 게이트] 자기주식취득결과보고서 (이미 다 산 뒤 → 효과가 없어야 한다)`);
  console.log(`  표본 ${resVals.length.toLocaleString()}건  초과 ${pct(p4v)}%p  (기준 |x| ≤${P4_TOL})  ${p4 ? '✅ 통과' : '🚨 실패'}`);
  if (resVals.length < MIN_N) console.log('  ⚠️ 표본 100건 미만 — 반증 시험이 성립하지 않는다');

  // ── 상세 조인 ─────────────────────────────────────────────────────────
  const det = await fetchAll('buyback_details', 'rcept_no,stock_code,rcept_dt,method,plan_amount,period_bgd,period_edd,purpose');
  console.log(`\n상세 ${det.length.toLocaleString()}건 로드`);
  const evs = [];
  const seenEv = new Set();
  for (const d of det) {
    const j = codeIdx.get(d.stock_code); if (j === undefined) continue;
    const i0 = toIdx(d.rcept_dt); if (i0 == null) continue;
    const key = d.stock_code + '|' + d.rcept_dt; if (seenEv.has(key)) continue; seenEv.add(key);
    const cap = CAP[i0 * M + j]; if (!(cap > 0)) continue;
    evs.push({
      j, i0, method: d.method, purpose: d.purpose,
      ratio: d.plan_amount > 0 ? d.plan_amount / cap : null,
      eddIdx: d.period_edd ? toIdx(d.period_edd) : null,
      main: ex(j, i0, BUY + 1, SELL),
      long: ex(j, i0, BUY + 1, LONG),
    });
  }
  const usable = evs.filter(e => e.main != null);
  const sigDays = new Set(usable.map(e => e.i0)).size;
  console.log(`판정 대상 ${usable.length.toLocaleString()}건 / 신호일 ${sigDays}일 / 독립블록 ${(sigDays / (SELL - BUY)).toFixed(0)}`);

  // ── P1 용량-반응 ──────────────────────────────────────────────────────
  const withRatio = usable.filter(e => e.ratio != null).sort((a, b) => a.ratio - b.ratio);
  const qs = [[], [], [], [], []];
  withRatio.forEach((e, k) => qs[Math.min(4, Math.floor((k / withRatio.length) * 5))].push(e));
  const qStats = qs.map(g => ({ n: g.length, m: med(g.map(e => e.main)), lo: g.length ? g[0].ratio : null, hi: g.length ? g[g.length - 1].ratio : null }));
  console.log(`\n[P1 용량-반응] 취득예정금액 ÷ 신호일 시가총액 5분위 (표본 ${withRatio.length.toLocaleString()})`);
  console.log('  분위   표본   금액/시총 구간          D+1→D+5 초과');
  qStats.forEach((q, k) => console.log(`   Q${k + 1}  ${String(q.n).padStart(6)}   `
    + `${(q.lo * 100).toFixed(2)}% ~ ${(q.hi * 100).toFixed(2)}%`.padEnd(22) + `  ${pct(q.m)}`));
  const spread = (qStats[4].m != null && qStats[0].m != null) ? qStats[4].m - qStats[0].m : null;
  // Spearman: 분위 순위(1..5) vs 초과 중앙값 순위
  const ms = qStats.map(q => q.m);
  let rho = null;
  if (ms.every(v => v != null)) {
    const rank = arr => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => { r[i] = k + 1; }); return r; };
    const r1 = [1, 2, 3, 4, 5], r2 = rank(ms);
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const m1 = mean(r1), m2 = mean(r2);
    let cov = 0, v1 = 0, v2 = 0;
    for (let i = 0; i < 5; i++) { cov += (r1[i] - m1) * (r2[i] - m2); v1 += (r1[i] - m1) ** 2; v2 += (r2[i] - m2) ** 2; }
    rho = cov / Math.sqrt(v1 * v2);
  }
  const p1nOK = qStats.every(q => q.n >= MIN_N);
  const p1 = p1nOK && spread != null && spread >= P1_SPREAD && rho != null && rho >= P1_RHO;
  console.log(`  Q5−Q1 = ${pct(spread)}%p (기준 ≥+${P1_SPREAD})  |  Spearman ρ = ${rho == null ? '—' : rho.toFixed(2)} (기준 ≥+${P1_RHO})`);
  console.log(`  분위당 표본 ≥${MIN_N} ${p1nOK ? '✅' : '🚨'}   →  ${p1 ? '✅ 통과' : '❌ 기각'}`);

  // ── P2 실행 경로 ──────────────────────────────────────────────────────
  const dS = stat(usable.filter(e => e.method === 'direct').map(e => e.main));
  const tS = stat(usable.filter(e => e.method === 'trust').map(e => e.main));
  const gap = (dS.m != null && tS.m != null) ? dS.m - tS.m : null;
  const p2measurable = dS.n >= MIN_N && tS.n >= MIN_N;
  const p2 = p2measurable && gap != null && gap >= P2_GAP;
  console.log(`\n[P2 실행 경로] 직접취득은 즉시 매수, 신탁은 위탁 분산 → 단기엔 직접이 커야 한다`);
  console.log(`  직접취득 ${String(dS.n).padStart(5)}건 ${pct(dS.m)}%p   신탁체결 ${String(tS.n).padStart(5)}건 ${pct(tS.m)}%p`);
  console.log(`  차이 ${pct(gap)}%p (기준 ≥+${P2_GAP})  →  ${p2measurable ? (p2 ? '✅ 통과' : '❌ 기각') : '⚠️ 측정 불가(표본 부족)'}`);

  // ── P3 지속성 ─────────────────────────────────────────────────────────
  // 취득 기간 중: D+1→D+20 창이 통째로 취득 기간 안에 드는 건만
  const inPeriod = usable.filter(e => e.long != null && e.eddIdx != null && e.eddIdx >= e.i0 + LONG);
  const longS = stat(inPeriod.map(e => e.long));
  const longNet = longS.m == null ? null : longS.m - COST;
  // 기간 종료 후 20거래일
  const after = [];
  for (const e of usable) {
    if (e.eddIdx == null) continue;
    const v = ex(e.j, e.eddIdx, 1, LONG);
    if (v != null) after.push(v);
  }
  const afterS = stat(after);
  const p3measurable = longS.n >= MIN_N && afterS.n >= MIN_N;
  const p3 = p3measurable && longNet != null && longNet >= 0 && afterS.m != null && afterS.m <= P3_POST;
  console.log(`\n[P3 지속성] 흐름이 원인이면 흐름이 멈출 때 효과도 멈춰야 한다`);
  console.log(`  취득기간 중 D+1→D+${LONG}  ${String(longS.n).padStart(5)}건 ${pct(longS.m)}%p → 비용차감 ${pct(longNet)}%p (기준 ≥0)`);
  console.log(`  기간 종료 후 ${LONG}거래일   ${String(afterS.n).padStart(5)}건 ${pct(afterS.m)}%p (기준 ≤+${P3_POST})`);
  console.log(`  →  ${p3measurable ? (p3 ? '✅ 통과' : '❌ 기각') : '⚠️ 측정 불가(표본 부족)'}`);

  // ── P5 목적 분해 (병기, 판정 아님) ────────────────────────────────────
  const PURPOSE = [
    ['주가안정·주주가치', /주가|주주가치|기업가치|안정/],
    ['이익소각·소각', /소각/],
    ['임직원 인센티브', /임직원|직원|스톡|성과|보상/],
  ];
  console.log(`\n[P5 목적 분해] 병기 — 판정에 쓰지 않는다`);
  for (const [label, re] of PURPOSE) {
    const s = stat(usable.filter(e => e.purpose && re.test(e.purpose)).map(e => e.main));
    console.log(`  ${label.padEnd(18)} ${String(s.n).padStart(5)}건 ${pct(s.m)}%p`);
  }
  const other = stat(usable.filter(e => !e.purpose || !PURPOSE.some(([, re]) => re.test(e.purpose))).map(e => e.main));
  console.log(`  ${'그 외·미분류'.padEnd(18)} ${String(other.n).padStart(5)}건 ${pct(other.m)}%p`);

  // ── 최종 ──────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(72));
  const accept = p0 && p4 && p1 && (p2 || p3);
  console.log(`채택 조건 = P0 AND P4 AND P1 AND (P2 또는 P3)`);
  console.log(`  P0 ${p0 ? '✅' : '🚨'}  P4 ${p4 ? '✅' : '🚨'}  P1 ${p1 ? '✅' : '❌'}  P2 ${p2 ? '✅' : '❌'}  P3 ${p3 ? '✅' : '❌'}`);
  console.log(`\n⇒ ${accept ? '✅ 채택 — 강제 흐름 축 확정' : '❌ 기각'}`);
  if (!p4) console.log('   P4 실패 = 흐름 가설 폐기. 결과보고서에도 효과가 있다면 원인이 흐름이 아니다.');
  else if (!p1) console.log('   P1 실패 = 용량과 무관. 흐름이 원인이라면 살 물량이 클수록 효과가 커야 한다.');
  else if (!p2 && !p3) console.log('   P1만 통과 = 시총 효과의 재탕일 수 있다. 사전 등록대로 기각.');
  console.log('\n※ 1회 실행분. 조건을 바꿔 다시 돌리면 사전 등록이 무효가 된다.');
})();
