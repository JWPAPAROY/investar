/**
 * disclosure-event-study.js — 공시 이벤트 축 판정 (2026-09-07, 2회차)
 *
 * 🚨 **판정 조건은 DISCLOSURE_VERDICT.md에 데이터를 보기 전에 사전 등록돼 있다.**
 *    이 스크립트는 그 조건을 **코드로** 계산한다. 눈으로 고르지 않는다.
 *    유형·지평·임계값을 바꾸면 판정을 리셋하고 그 문서의 변경 이력에 남겨야 한다.
 *
 * ⚠️ 1회차(같은 날)는 **중단 조건에 걸려 무효**다. 통제군(정기보고서)이 -0.69%p로
 *    나왔고, 위약 테스트 결과 무작위 표본도 -0.66%였다 — 공시 효과가 아니라 자의 눈금이
 *    틀린 것이었다. 원인은 개별 종목을 분위 **평균**과 비교한 뒤 이벤트 사이에서
 *    **중앙값**을 취한 것(일간 수익률 우편향 → 하루 0.23%씩, 4일 누적 −0.9%p).
 *
 *    교정은 `disclosure-scale-calibration.js`가 **공시 데이터를 전혀 보지 않고**
 *    위약 편향 ≤0.1% 기준만으로 골랐다. 채택된 추정량 C:
 *      창(window) 수익 − 같은 창을 온전히 관측한 동일일·동일 시총분위 동료들의 중앙값
 *    → 이벤트와 대조군에 **같은 통계량·같은 생존 조건**이 걸린다.
 *    위약 실측: 주 판정 구간 +0.000%, 최악 구간 0.074%.
 *
 * 권리락: 상장주식수(=시총/종가)가 하루 5% 넘게 변한 날은 가격 수익률이 실제 수익이
 *   아니다(무상증자·액면분할). 재구성하지 않고 제외한다 — 이벤트·대조군 동일 적용.
 *
 * 진입: **D+1 종가**가 주 판정이다. rcept_dt에 접수 시각이 없어 장중/장후를 구분할 수
 *   없고, 장 마감 후 공시를 당일 종가 매수로 계상하면 실행 불가능한 수익이 된다.
 *   D0 진입은 "장중 공시였다면"의 낙관적 상한으로만 병기한다 — 판정 근거가 아니다.
 *
 * 실행: node --max-old-space-size=8192 scripts/disclosure-event-study.js [--csv=out.csv]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');

// ── 사전 등록 상수 — 임의로 바꾸지 말 것 ────────────────────────────────
const BUY = 1, SELL = 5;
const ALT_SELLS = [2, 10];
const CURVE = [-10, 10];
const COST = 0.38;
const PASS_EXCESS = 0.5;
const PASS_RESIDUAL = 0.5;
const FAIL_RESIDUAL = 0.3;
const PASS_BAD = -1.5;
const MIN_N = 100;
const MIN_BLOCKS = 20;
const SHARE_JUMP = 0.05;      // 권리락 의심 제외 기준 (교정 스크립트와 동일)

const CSV = (process.argv.find(a => a.startsWith('--csv=')) || '').split('=')[1] || null;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);

const med = a => { if (!a.length) return null; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = v => (v == null ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(2));

// ── KRX 로컬 데이터 ─────────────────────────────────────────────────────
const DAILY = path.resolve(__dirname, '../data/krx-daily.jsonl');
const MASTER = path.resolve(__dirname, '../data/krx-master.json');
if (!fs.existsSync(DAILY)) { console.error('❌ data/krx-daily.jsonl 없음'); process.exit(1); }

const common = new Set();
for (const r of JSON.parse(fs.readFileSync(MASTER, 'utf-8')).rows) if (r.stkType === '보통주') common.add(r.code);
const recs = fs.readFileSync(DAILY, 'utf-8').split('\n').filter(l => l.trim())
  .map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d);
const N = days.length;
const dayIdx = new Map(days.map((d, i) => [d, i]));
const codeIdx = new Map();
for (const r of recs) for (const s of r.s) { if (!common.has(s[0])) continue; if (!codeIdx.has(s[0])) codeIdx.set(s[0], codeIdx.size); }
const M = codeIdx.size;
const CL = new Float64Array(N * M).fill(NaN), CAP = new Float64Array(N * M).fill(NaN);
for (let i = 0; i < N; i++) for (const [c, , , , clo, , , cap] of recs[i].s) {
  const j = codeIdx.get(c); if (j === undefined) continue;
  CL[i * M + j] = clo; CAP[i * M + j] = cap;
}

console.log('\n📢 공시 이벤트 축 판정 (2회차) — 사전 등록: DISCLOSURE_VERDICT.md');
console.log(`데이터: ${N}거래일 × ${M}종목 (${days[0]} ~ ${days[N - 1]})`);
console.log('추정량: C (창 수익 − 동일창 시총분위 중앙값). 위약 편향 주 판정 +0.000%');

// ── 일간 수익률 + 권리락 제외 ───────────────────────────────────────────
const RET = new Float64Array(N * M).fill(NaN);
let exDropped = 0, retTotal = 0;
for (let i = 1; i < N; i++) for (let j = 0; j < M; j++) {
  const p = CL[(i - 1) * M + j], q = CL[i * M + j];
  if (!(p > 0) || !(q > 0)) continue;
  const c0 = CAP[(i - 1) * M + j], c1 = CAP[i * M + j];
  if (c0 > 0 && c1 > 0 && Math.abs((c1 / q) / (c0 / p) - 1) > SHARE_JUMP) { exDropped++; continue; }
  RET[i * M + j] = ((q - p) / p) * 100; retTotal++;
}
console.log(`권리락 의심 제외 ${exDropped.toLocaleString()}건 / 일간수익 ${retTotal.toLocaleString()}건`);

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

// 창 기준선: (i0, a, b) 한 번에 5분위 전부 계산 후 캐시
const baseCache = new Map();
function bases(i0, a, b) {
  const key = i0 + '|' + a + '|' + b;
  let v = baseCache.get(key);
  if (v !== undefined) return v;
  const buckets = [[], [], [], [], []];
  for (let j = 0; j < M; j++) {
    const q = quint[i0 * M + j]; if (q < 0) continue;
    const w = winRet(j, i0, a, b); if (w == null) continue;
    buckets[q].push(w);
  }
  v = buckets.map(x => (x.length >= 20 ? med(x) : null));
  baseCache.set(key, v);
  return v;
}
/** 추정량 C */
function ex(j, i0, a, b) {
  const w = winRet(j, i0, a, b); if (w == null) return null;
  const q = quint[i0 * M + j]; if (q < 0) return null;
  const m = bases(i0, a, b)[q]; if (m == null) return null;
  return w - m;
}

// 레짐 (신호일 기준 과거 60일 시총가중 누적)
const mkt = new Array(N).fill(null);
for (let i = 1; i < N; i++) {
  let num = 0, den = 0;
  for (let j = 0; j < M; j++) {
    const r = RET[i * M + j], w = CAP[(i - 1) * M + j];
    if (Number.isNaN(r) || !(w > 0)) continue;
    num += r * w; den += w;
  }
  mkt[i] = den ? num / den : null;
}
function regimeOf(i) {
  if (i < 60) return null;
  let acc = 1;
  for (let k = i - 59; k <= i; k++) { if (mkt[k] == null) return null; acc *= 1 + mkt[k] / 100; }
  const r = (acc - 1) * 100;
  return r > 5 ? 'BULL' : r < -5 ? 'BEAR' : 'FLAT';
}

async function loadDisclosures() {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await orderByPk(
      sb.from('disclosures').select('rcept_no,rcept_dt,stock_code,report_type,is_amendment,is_subsidiary'), 'disclosures'
    ).not('report_type', 'is', null).range(from, from + 999);
    if (error) throw new Error('disclosures 조회 실패: ' + error.message);
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

(async () => {
  const raw = await loadDisclosures();
  let dropAmend = 0, dropSubsid = 0, dropNoCode = 0, dropNoPrice = 0, dropNoDay = 0;
  const seen = new Set(), events = [];
  for (const r of raw) {
    if (r.is_amendment) { dropAmend++; continue; }
    if (r.is_subsidiary) { dropSubsid++; continue; }
    if (!r.stock_code) { dropNoCode++; continue; }
    const j = codeIdx.get(r.stock_code);
    if (j === undefined) { dropNoPrice++; continue; }
    const key = r.stock_code + '|' + r.rcept_dt + '|' + r.report_type;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = r.rcept_dt.replace(/-/g, '');
    let i0 = dayIdx.get(target);
    if (i0 === undefined) {   // 휴장일 공시 → 다음 거래일이 첫 반영 지점
      let lo = 0, hi = N - 1, found = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] >= target) { found = mid; hi = mid - 1; } else lo = mid + 1; }
      if (found < 0) { dropNoDay++; continue; }
      i0 = found;
    }
    events.push({ j, i0, type: r.report_type, group: r.report_type[0] });
  }
  const matchRate = (100 * events.length) / Math.max(1, raw.length - dropAmend - dropSubsid);
  console.log(`\n공시 ${raw.length.toLocaleString()}건 → 제외: 정정 ${dropAmend.toLocaleString()} / 자회사 ${dropSubsid.toLocaleString()} / 코드없음 ${dropNoCode.toLocaleString()} / KRX미매칭 ${dropNoPrice.toLocaleString()} / 날짜밖 ${dropNoDay.toLocaleString()}`);
  console.log(`판정 대상 ${events.length.toLocaleString()}건 (KRX 매칭률 ${matchRate.toFixed(1)}%)`);
  if (matchRate < 90) console.log('  ⚠️ 중단 조건: 매칭률 90% 미만');

  const byType = new Map();
  for (const e of events) { if (!byType.has(e.type)) byType.set(e.type, []); byType.get(e.type).push(e); }

  const csvRows = CSV ? ['type,offset,n,median_car'] : null;
  const summary = [];
  for (const type of [...byType.keys()].sort()) {
    const evs = byType.get(type);
    const sigDays = new Set(evs.map(e => e.i0)).size;
    const main = [], main0 = [], pre = [], post = [];
    const alts = new Map(ALT_SELLS.map(s => [s, []]));
    const byRegime = { BULL: [], BEAR: [], FLAT: [] }, byQuint = [[], [], [], [], []], half = [[], []];
    for (const e of evs) {
      const v = ex(e.j, e.i0, BUY + 1, SELL);
      if (v != null) {
        main.push(v);
        const rg = regimeOf(e.i0); if (rg) byRegime[rg].push(v);
        const q = quint[e.i0 * M + e.j]; if (q >= 0) byQuint[q].push(v);
        half[e.i0 < N / 2 ? 0 : 1].push(v);
      }
      const v0 = ex(e.j, e.i0, 1, SELL); if (v0 != null) main0.push(v0);
      const p1 = ex(e.j, e.i0, -5, -1), p2 = ex(e.j, e.i0, 0, SELL);
      if (p1 != null && p2 != null) { pre.push(p1); post.push(p2); }
      for (const s of ALT_SELLS) { const va = ex(e.j, e.i0, BUY + 1, s); if (va != null) alts.get(s).push(va); }
    }
    const curve = [];
    for (let t = CURVE[0]; t <= CURVE[1]; t++) {
      const vals = [];
      for (const e of evs) { const v = ex(e.j, e.i0, CURVE[0], t); if (v != null) vals.push(v); }
      curve.push({ t, n: vals.length, median: med(vals) });
      if (csvRows) csvRows.push([type, t, vals.length, med(vals)].join(','));
    }
    const mainMed = med(main);
    const preSum = med(pre), postSum = med(post);
    summary.push({
      type, group: type[0], n: main.length, sigDays, blocks: sigDays / (SELL - BUY),
      mainMed, net: mainMed == null ? null : mainMed - COST, main0: med(main0),
      alts: new Map([...alts].map(([s, a]) => [s, med(a)])),
      preSum, postSum,
      residual: (preSum != null && postSum != null && Math.abs(preSum) > 1e-9) ? postSum / preSum : null,
      regime: { BULL: med(byRegime.BULL), BEAR: med(byRegime.BEAR), FLAT: med(byRegime.FLAT) },
      quint: byQuint.map(a => med(a)), half: half.map(a => med(a)), curve,
    });
  }

  console.log('\n' + '='.repeat(96));
  console.log(`★ 주 판정표 — D+${BUY} 종가 매수 → D+${SELL} 종가 매도, 창매칭 초과수익 중앙값 (%)`);
  console.log('='.repeat(96));
  console.log('유형                   표본  신호일  블록   초과   비용차감    D+2    D+10   D0진입');
  for (const s of summary) {
    const warn = s.n < MIN_N ? ' ⚠️표본부족' : (s.blocks < MIN_BLOCKS ? ' ⚠️블록부족' : '');
    console.log(`${s.type.padEnd(20)} ${String(s.n).padStart(6)} ${String(s.sigDays).padStart(6)} ${s.blocks.toFixed(0).padStart(5)}  `
      + `${pct(s.mainMed).padStart(6)}  ${pct(s.net).padStart(8)} ${pct(s.alts.get(2)).padStart(7)} ${pct(s.alts.get(10)).padStart(7)} ${pct(s.main0).padStart(7)}${warn}`);
  }

  console.log('\n★ 사전 드리프트 vs 사후 잔여 (판정 ②)');
  console.log('유형                  D-5~D-1   D0~D+5   잔여비율');
  for (const s of summary) console.log(`${s.type.padEnd(20)} ${pct(s.preSum).padStart(8)} ${pct(s.postSum).padStart(8)}   ${s.residual == null ? '  —' : s.residual.toFixed(2)}`);

  console.log('\n★ 강건성 (판정 기준 아님)');
  console.log('유형                   전반    후반    BULL    BEAR    FLAT   시총Q1   시총Q5');
  for (const s of summary) console.log(`${s.type.padEnd(20)} ${pct(s.half[0]).padStart(6)} ${pct(s.half[1]).padStart(7)} ${pct(s.regime.BULL).padStart(7)} ${pct(s.regime.BEAR).padStart(7)} ${pct(s.regime.FLAT).padStart(7)} ${pct(s.quint[0]).padStart(8)} ${pct(s.quint[4]).padStart(8)}`);

  console.log('\n★ 누적 곡선 (중앙값 %, D-10 기준)');
  console.log('유형                   D-5     D-1      D0     D+1     D+3     D+5    D+10');
  for (const s of summary) {
    const at = t => pct(s.curve.find(c => c.t === t)?.median);
    console.log(`${s.type.padEnd(20)} ${at(-5).padStart(6)} ${at(-1).padStart(7)} ${at(0).padStart(7)} ${at(1).padStart(7)} ${at(3).padStart(7)} ${at(5).padStart(7)} ${at(10).padStart(7)}`);
  }

  console.log('\n' + '='.repeat(96));
  console.log('★ 사전 등록 판정 (DISCLOSURE_VERDICT.md)');
  console.log('='.repeat(96));
  const ctrl = summary.find(s => s.group === 'Z');
  if (ctrl) {
    const bad = ctrl.mainMed != null && Math.abs(ctrl.mainMed) > 0.5;
    console.log(`\n[중단 조건] 통제군 ${ctrl.type} ${pct(ctrl.mainMed)}%p `
      + (bad ? '→ 🚨 척도 고장. 판정 무효.' : '→ ✅ 0 근처. 척도 정상.'));
    if (bad) { console.log('\n판정을 출력하지 않는다.'); if (CSV) fs.writeFileSync(CSV, csvRows.join('\n')); return; }
  } else console.log('\n[중단 조건] 통제군 없음 — 척도 검증 불가');

  const aTypes = summary.filter(s => s.group === 'A');
  const measurable = aTypes.filter(s => s.n >= MIN_N && s.blocks >= MIN_BLOCKS);
  const excluded = aTypes.filter(s => s.n < MIN_N || s.blocks < MIN_BLOCKS);
  if (excluded.length) console.log('\n[측정 불가] ' + excluded.map(s => `${s.type}(n=${s.n}, 블록=${s.blocks.toFixed(0)})`).join(', '));

  console.log(`\n① 매수 축 (A군, 비용 차감 후 ≥ +${PASS_EXCESS}%p)`);
  const passed1 = [];
  for (const s of measurable) {
    const ok = s.net != null && s.net >= PASS_EXCESS;
    if (ok) passed1.push(s);
    console.log(`   ${s.type.padEnd(20)} ${pct(s.net)}%p → ${ok ? '✅ 통과' : '❌ 기각'}`);
  }
  if (!measurable.length) console.log('   측정 가능한 A군 없음 → 판정 불가');
  else if (!passed1.length) console.log('   ⇒ A군 전체 기각. 공시 매수 축 폐기.');

  console.log(`\n② 잔여 알파 비율 (①이 통과한 유형만, ≥ ${PASS_RESIDUAL})`);
  if (!passed1.length) console.log('   ①이 무너졌으므로 보지 않는다.');
  else for (const s of passed1) {
    const r = s.residual;
    console.log(`   ${s.type.padEnd(20)} 잔여비율 ${r == null ? '—' : r.toFixed(2)} → `
      + (r == null ? '판정불가' : r >= PASS_RESIDUAL ? '✅ 통과'
        : r < FAIL_RESIDUAL ? '❌ 기각 (이미 대부분 먹힌 뒤 — 잔반을 알파로 보지 않는다)' : '❌ 기각'));
  }

  console.log(`\n③ 악재 청산 축 (C군 D0→D+${SELL} ≤ ${PASS_BAD}%p) — ①②와 독립`);
  for (const s of summary.filter(x => x.group === 'C')) {
    if (s.n < MIN_N || s.blocks < MIN_BLOCKS) { console.log(`   ${s.type.padEnd(20)} n=${s.n}, 블록=${s.blocks.toFixed(0)} → 측정 불가`); continue; }
    const ok = s.postSum != null && s.postSum <= PASS_BAD;
    console.log(`   ${s.type.padEnd(20)} ${pct(s.postSum)}%p → ${ok ? '✅ 청산 규칙 채택' : '❌ 기각'}`);
  }

  console.log('\n※ 2회차 실행분(1회차는 척도 결함으로 무효). 조건을 바꿔 또 돌리면 사전 등록이 무효가 된다.');
  if (CSV) { fs.writeFileSync(CSV, csvRows.join('\n')); console.log(`📄 곡선 원자료 → ${CSV}`); }
})();
