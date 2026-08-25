/**
 * funnel-regime-backtest.js — 현행 깔때기(풀)를 상승 레짐에서도 검증 (2026-08-24)
 *
 * 묻는 것 하나: **"풀 자체가 마이너스"라는 판정이 상승 레짐에서도 성립하는가.**
 *
 * 배경: 2026-08-08 풀 슬라이스 스캔에서 추천 풀 전체가 매칭초과 −7.39%(D+10)로 나와
 *   "문제는 랭킹이 아니라 풀 자체"로 결론했다. 그런데 그 표본은 market_flow_daily
 *   60거래일 = **단일 하락 레짐**이었다. 깔때기 기각(8/06·8/19)에 남은 마지막 변호가
 *   정확히 이것이다: "전 표본이 하락장이라 거래량 폭발이 투매로만 나타났다."
 *
 * 이제 처리할 수 있다. price-history.jsonl에는 종가·거래량·**거래대금**·상장주식수가
 *   641거래일(2024-01~2026-08, 상승 318일 포함) 들어 있어 **풀을 소급 재구성**할 수 있다.
 *   (수급은 소급 불가라 점수·TOP3는 재현하지 않는다. 8/08 결론이 풀 수준 주장이므로
 *    검증도 풀 수준에서 하는 것이 맞는 층위다.)
 *
 * 풀 대리변수 = KIS 5개 랭킹 각 상위 30의 합집합 (CLAUDE.md "Phase 1: 종목 풀 확보"):
 *   ① 거래량 ② 거래대금 ③ 거래량 증가율 ④ 거래회전율 ⑤ 등락률 상승
 *   서브랭크별로도 따로 측정한다 — 어느 랭킹이 독을 넣는지 분리해야 처방이 나온다.
 *
 * ⚠️ 대리변수의 한계 (결론과 함께 읽을 것):
 *   1. KIS 랭킹은 조회 시점(장중/장후) 스냅샷이고 여기서는 **당일 종가 확정치** 기준이다.
 *      장중 순위와 종가 순위는 다르므로 풀 구성이 완전히 같지 않다.
 *   2. 거래량 증가율 API의 내부 정의는 공개돼 있지 않다 → `당일거래량 / 직전 20일 평균`으로
 *      근사하고, 죽은 종목이 비율로 튀어오르는 것을 막기 위해 거래대금 하한을 둔다.
 *   3. 실제 풀에는 종목명 기반 ETF/스팩 필터가 있으나, 이 데이터의 유니버스는
 *      stock_master(ETF 없음)라 해당 필터가 불필요하다.
 *   4. 생존편향: 상폐 종목 부재. 풀은 급등락주가 많아 상폐 확률이 높으므로
 *      **풀 성과는 실제보다 좋게 추정된다** = "풀이 나쁘다"는 결론에 보수적으로 작동한다.
 *   5. 과거 시총 = 수정주가 × 현재 상장주식수 근사(collect-price-history.js 헤더 참고).
 *
 * 규약: regime-validation.js와 통일 — 매칭초과(동일일 × 시총5분위), 시장모형α,
 *   레짐 = 신호일 기준 과거 60일 누적(전방참조 없음), 독립블록<3이면 판정 거부.
 *   매수일 기본 D+2(2026-08-23 active_policy), 매도 D+10.
 *
 * 실행: node --max-old-space-size=8192 scripts/funnel-regime-backtest.js [--sell=10] [--buyoffset=2] [--top=30]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const argS = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const SELL = arg('sell', 10);
const BUY = arg('buyoffset', 2);          // active_policy(2026-08-23): D+2 매수 → D+10 매도
const TOPN = arg('top', 30);              // KIS 랭킹 1회 호출 = 30개
const LOOK = arg('look', 20);
const FROM = argS('from', '20240101');
const VALFLOOR = arg('valfloor', 1) * 1e8; // 거래량증가율 랭킹 하한: 당일 거래대금 1억+
if (!(BUY >= 1 && BUY < SELL)) { console.error(`❌ --buyoffset(${BUY})은 1 이상이고 --sell(${SELL})보다 작아야 함`); process.exit(1); }

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sgn = v => (v == null ? '       -' : ((v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) + '%').padStart(8));

// ── 데이터 로드 ────────────────────────────────────────────────────────
const HIST = path.resolve(__dirname, '../data/price-history.jsonl');
if (!fs.existsSync(HIST)) { console.error('❌ data/price-history.jsonl 없음 → node scripts/collect-price-history.js 먼저'); process.exit(1); }

const close = new Map(), vol = new Map(), val = new Map(), shares = new Map();
const dateSet = new Set();
for (const line of fs.readFileSync(HIST, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  if (!rec.r?.length) continue;
  const c = new Map(), v = new Map(), t = new Map();
  for (const [d, cl, vo, va] of rec.r) {
    if (d < FROM || !cl) continue;
    c.set(d, cl); v.set(d, vo || 0); t.set(d, va || 0); dateSet.add(d);
  }
  if (!c.size) continue;
  close.set(rec.c, c); vol.set(rec.c, v); val.set(rec.c, t); shares.set(rec.c, rec.s || null);
}
const days = [...dateSet].sort();
const codes = [...close.keys()];
const universe = days.map(d => codes.filter(c => close.get(c).has(d)));

console.log(`\n🕳️ 현행 깔때기 레짐 대조 — 풀 = 5개 랭킹 각 상위 ${TOPN} 합집합`);
console.log(`   매수 D+${BUY} 종가 → 매도 D+${SELL} 종가 (active_policy 2026-08-23)`);
console.log(`데이터: ${days.length}거래일 × ${codes.length}종목 (${days[0]} ~ ${days[days.length - 1]})`);

const at = (c, i) => (i >= 0 && i < days.length ? close.get(c)?.get(days[i]) : null);
const vAt = (c, i) => (i >= 0 && i < days.length ? vol.get(c)?.get(days[i]) : null);
const tAt = (c, i) => (i >= 0 && i < days.length ? val.get(c)?.get(days[i]) : null);
const capOf = (c, i) => { const s = shares.get(c), p = at(c, i); return (s && p) ? s * p : null; };
const fwd = (c, i) => { const b = at(c, i + BUY), s = at(c, i + SELL); return (b && s) ? ((s - b) / b) * 100 : null; };

// ── 시장수익률(시총가중) + 레짐 ────────────────────────────────────────
const mkt = new Array(days.length).fill(null);
for (let i = 1; i < days.length; i++) {
  let num = 0, den = 0;
  for (const c of universe[i]) {
    const p = at(c, i - 1), q = at(c, i); if (!p || !q) continue;
    const w = (shares.get(c) || 0) * p; if (!w) continue;
    num += ((q - p) / p) * w; den += w;
  }
  mkt[i] = den ? (num / den) * 100 : null;
}
const mktFwd = (i) => { let acc = 1, ok = false; for (let k = i + BUY + 1; k <= i + SELL; k++) { if (mkt[k] == null) return null; acc *= 1 + mkt[k] / 100; ok = true; } return ok ? (acc - 1) * 100 : null; };
const regimeOf = (i) => {
  if (i < 60) return null;
  let acc = 1;
  for (let k = i - 59; k <= i; k++) { if (mkt[k] == null) return null; acc *= 1 + mkt[k] / 100; }
  const r = (acc - 1) * 100;
  return r > 5 ? 'BULL' : r < -5 ? 'BEAR' : 'FLAT';
};
{
  let cum = 1; for (let i = 1; i < days.length; i++) if (mkt[i] != null) cum *= 1 + mkt[i] / 100;
  const cnt = { BULL: 0, BEAR: 0, FLAT: 0 };
  for (let i = 0; i < days.length; i++) { const r = regimeOf(i); if (r) cnt[r]++; }
  console.log(`시장(시총가중) 전 구간 누적 ${((cum - 1) * 100).toFixed(1)}% | 레짐: 상승 ${cnt.BULL}일 / 하락 ${cnt.BEAR}일 / 횡보 ${cnt.FLAT}일`);
}

// ── 베타(신호일까지 20일) ──────────────────────────────────────────────
const betaOf = new Map();
for (let i = LOOK + 5; i < days.length; i++) {
  for (const c of universe[i]) {
    const rets = [], mrets = [];
    let ok = true;
    for (let k = LOOK; k >= 1; k--) {
      const p = at(c, i - k), q = at(c, i - k + 1);
      if (!p || !q) { ok = false; break; }
      rets.push(((q - p) / p) * 100); mrets.push(mkt[i - k + 1] ?? 0);
    }
    if (!ok) continue;
    const mm = avg(mrets), rm = avg(rets);
    let cov = 0, varm = 0;
    for (let k = 0; k < rets.length; k++) { cov += (rets[k] - rm) * (mrets[k] - mm); varm += (mrets[k] - mm) ** 2; }
    if (varm > 0) betaOf.set(`${i}|${c}`, cov / varm);
  }
}

// ── 매칭 기준: 동일일 × 시총5분위 ──────────────────────────────────────
const capQ = new Map(), qMean = new Map(), cap300 = new Map();
for (let i = 0; i < days.length; i++) {
  const rows = universe[i].map(c => [c, capOf(c, i)]).filter(x => x[1]);
  rows.sort((a, b) => a[1] - b[1]);
  rows.forEach(([c], k) => capQ.set(`${i}|${c}`, Math.min(4, Math.floor((k / rows.length) * 5))));
  const b = [[], [], [], [], []];
  for (const [c] of rows) { const f = fwd(c, i); if (f != null) b[capQ.get(`${i}|${c}`)].push(f); }
  qMean.set(i, b.map(x => (x.length >= 20 ? avg(x) : null)));
  cap300.set(i, new Set([...rows].reverse().slice(0, 300).map(x => x[0])));
}
const exCap = (c, i) => { const f = fwd(c, i); if (f == null) return null; const m = qMean.get(i)?.[capQ.get(`${i}|${c}`)]; return m == null ? null : f - m; };
const alphaMM = (c, i) => { const f = fwd(c, i), mf = mktFwd(i), b = betaOf.get(`${i}|${c}`); return (f == null || mf == null || b == null) ? null : f - b * mf; };

// ── 풀 재구성: 5개 랭킹 각 상위 TOPN ──────────────────────────────────
// KIS Phase 1과 같은 순서. surge(거래량증가율)만 하한(거래대금)이 필요하다.
const SET = argS('set', 'funnel');   // funnel(기본) | vpd | vpd2
const USE_VPD = (SET === 'vpd' || SET === 'vpd2' || SET === 'exclude');
const sdev = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

// ── VPD 피처 (--set=vpd): 철학 원형을 그대로 검정하기 위한 것 ──────────
// 2026-08-24: "풀이 나쁘다"(B-4)는 풀 수준 판정이라 철학의 **교집합**을 테스트하지 않는다.
//   풀에는 '등락률 상위30'(이미 급등)과 투매 종목이 섞여 들어간다. 철학의 주장은
//   "거래량 폭발 **AND 가격 미반영**"이므로, 그 순수형을 CLAUDE.md의 실제 공식으로 검정한다.
//   volumeRatio = 당일거래량 / 20일 평균거래량
//   priceRatio  = |현재가 − 20일 평균가| / 20일 평균가 + 1.0
//   VPD         = volumeRatio − priceRatio      (≥3.0이 'Quiet Accumulation' 등급)
//
// --set=vpd2 (2026-08-24 교정판): 위 검정에서 두 항의 스케일이 실측으로 확인됐다 —
//   volumeRatio p10~p99 = 0.28~15.06(폭 14.78), priceRatio 1.01~1.40(폭 0.39).
//   즉 VPD ≈ volumeRatio − 1.05로, "가격 미반영" 항이 순위를 거의 바꾸지 못한다.
//   교정: **두 항을 당일 유니버스 내 백분위로 환산**해 같은 저울에 올린다.
//     pv = 백분위(volumeRatio)            높을수록 거래량이 시끄럽다
//     pq = 백분위(−|이격도 − 100|)         높을수록 가격이 조용하다(20일 평균에 붙어 있다)
//   원 공식의 의미(폭발 AND 미반영)를 그대로 두고 스케일만 고친 것이다.
//   (priceRatio − 1 = |이격도 − 100| / 100 이므로 항의 정의 자체는 바꾸지 않았다.)
const vfeat = new Map();
if (USE_VPD) {
  for (let i = LOOK + 5; i < days.length; i++) {
    for (const c of universe[i]) {
      const p = at(c, i), pv = at(c, i - 1), v = vAt(c, i);
      if (!p || !v) continue;
      const vs = [], cs = [];
      let ok = true;
      for (let k = LOOK; k >= 1; k--) {
        const x = vAt(c, i - k), y = at(c, i - k);
        if (x == null || y == null) { ok = false; break; }
        vs.push(x); cs.push(y);
      }
      if (!ok) continue;
      const avgV = avg(vs), avgP = avg(cs);
      if (!(avgV > 0) || !(avgP > 0)) continue;
      const volRatio = v / avgV;
      const priceRatio = Math.abs(p - avgP) / avgP + 1.0;
      const rets = [];
      for (let k = 1; k < cs.length; k++) rets.push(((cs[k] - cs[k - 1]) / cs[k - 1]) * 100);
      rets.push(((p - cs[cs.length - 1]) / cs[cs.length - 1]) * 100);

      vfeat.set(`${i}|${c}`, {
        volRatio,
        vol20: sdev(rets),                             // 20일 일간수익 표준편차 (고변동성 배제용)
        vpd: volRatio - priceRatio,
        chg1: pv ? ((p - pv) / pv) * 100 : null,      // 당일 등락률
        disparity: (p / avgP) * 100,                   // 20일 이격도
        val: tAt(c, i) || p * v,
      });
    }
  }
  console.log(`VPD 피처: ${vfeat.size.toLocaleString()}건 (거래대금 하한 ${(VALFLOOR / 1e8).toFixed(0)}억 적용은 신호별)`);
}

// 교정판: 당일 유니버스 내 백분위 부여 (유동성 통과 종목만이 기준집합)
if (SET === 'vpd2' || SET === 'exclude') {
  for (let i = LOOK + 5; i < days.length; i++) {
    const rows = [];
    for (const c of universe[i]) {
      const f = vfeat.get(`${i}|${c}`);
      if (f && f.val >= VALFLOOR) rows.push([c, f]);
    }
    if (rows.length < 100) continue;
    const n = rows.length;
    [...rows].sort((a, b) => a[1].volRatio - b[1].volRatio)
      .forEach(([, f], k) => { f.pv = k / (n - 1); });                       // 1 = 가장 시끄러움
    [...rows].sort((a, b) => Math.abs(b[1].disparity - 100) - Math.abs(a[1].disparity - 100))
      .forEach(([, f], k) => { f.pq = k / (n - 1); });                       // 1 = 가장 조용함
    [...rows].filter(x => x[1].vol20 != null).sort((a, b) => a[1].vol20 - b[1].vol20)
      .forEach(([, f], k, arr) => { f.pvol = k / (arr.length - 1); });       // 1 = 가장 고변동성
  }
  console.log('교정 VPD: 두 항을 당일 백분위로 환산 (pv=거래량 시끄러움, pq=가격 조용함)');
}
const vf = (c, i) => {
  const f = vfeat.get(`${i}|${c}`);
  return (f && f.val >= VALFLOOR) ? f : null;   // 죽은 종목이 비율로 튀는 것 방지
};

const RANKS = ['거래량', '거래대금', '거래량증가율', '회전율', '등락률'];
const poolOf = new Map();   // i -> Set(합집합)
const subOf = new Map();    // i -> {랭킹명: Set}
for (let i = LOOK + 5; (SET === 'funnel' || SET === 'exclude') && i < days.length; i++) {
  const rows = [];
  for (const c of universe[i]) {
    const v = vAt(c, i), t = tAt(c, i), p = at(c, i), pv = at(c, i - 1), sh = shares.get(c);
    if (!p || !v) continue;
    const vs = [];
    for (let k = LOOK; k >= 1; k--) { const x = vAt(c, i - k); if (x == null) { vs.length = 0; break; } vs.push(x); }
    const avgV = vs.length ? avg(vs) : null;
    rows.push({
      c,
      volume: v,
      value: t || p * v,
      surge: (avgV > 0 && (t || p * v) >= VALFLOOR) ? v / avgV : null,
      turnover: sh ? v / sh : null,
      change: pv ? ((p - pv) / pv) * 100 : null,
    });
  }
  const pick = (key) => {
    const arr = rows.filter(r => r[key] != null && isFinite(r[key]));
    arr.sort((a, b) => b[key] - a[key]);
    return new Set(arr.slice(0, TOPN).map(r => r.c));
  };
  const sub = {
    '거래량': pick('volume'),
    '거래대금': pick('value'),
    '거래량증가율': pick('surge'),
    '회전율': pick('turnover'),
    '등락률': pick('change'),
  };
  subOf.set(i, sub);
  const u = new Set();
  for (const k of RANKS) for (const c of sub[k]) u.add(c);
  poolOf.set(i, u);
}

// ── 전략 정의 ─────────────────────────────────────────────────────────
const CONTROL = ['[통제] 시총상위300 임의 20', (c, i) => {
  if (!cap300.get(i).has(c)) return false;
  let h = i * 2654435761;
  for (let k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0;
  return (h % 100000) / 100000 > 1 - 20 / 300;
}];

// 철학 원형 검정 세트 (--set=vpd). **사전 등록** — 늘리지 말 것.
// 묻는 것: "거래량 폭발 + 가격 미반영 = 급등 예정"이 **교집합 형태로, 상승 레짐에서** 성립하는가.
// 대조군 두 개(이미 급등 / 투매)를 반드시 같이 읽을 것 — 폭발을 부호로 가른 것이 이 둘이다.
const VPD_STRATS = [
  ['기준선: 유니버스 전체', () => true],
  CONTROL,
  ['── 거래량 폭발 (부호 무시) ──', null],
  ['거래량비 ≥2 (폭발 전체)', (c, i) => { const f = vf(c, i); return f && f.volRatio >= 2; }],
  ['거래량비 ≥3', (c, i) => { const f = vf(c, i); return f && f.volRatio >= 3; }],
  ['── ★철학 원형: 폭발 AND 가격 미반영 ──', null],
  ['★VPD ≥ 3.0 (Quiet Accumulation 등급)', (c, i) => { const f = vf(c, i); return f && f.vpd >= 3.0; }],
  ['★VPD ≥ 2.0 (Early Stage 등급)', (c, i) => { const f = vf(c, i); return f && f.vpd >= 2.0; }],
  ['★VPD ≥ 1.0 (Moderate 등급)', (c, i) => { const f = vf(c, i); return f && f.vpd >= 1.0; }],
  ['★폭발≥2 ∩ 당일등락 |3%| 이내', (c, i) => { const f = vf(c, i); return f && f.volRatio >= 2 && f.chg1 != null && Math.abs(f.chg1) <= 3; }],
  ['★폭발≥3 ∩ 이격도 95~105 (완전 미반영)', (c, i) => { const f = vf(c, i); return f && f.volRatio >= 3 && f.disparity >= 95 && f.disparity <= 105; }],
  ['★VPD ≥ 3.0 ∩ 시총상위300', (c, i) => { const f = vf(c, i); return f && f.vpd >= 3.0 && cap300.get(i).has(c); }],
  ['── 대조군: 폭발을 부호로 가른 것 ──', null],
  ['폭발≥2 ∩ 당일 +5% 이상 (이미 급등)', (c, i) => { const f = vf(c, i); return f && f.volRatio >= 2 && f.chg1 >= 5; }],
  ['폭발≥2 ∩ 당일 −5% 이하 (투매)', (c, i) => { const f = vf(c, i); return f && f.volRatio >= 2 && f.chg1 <= -5; }],
  ['거래량 조용 (거래량비 ≤0.8)', (c, i) => { const f = vf(c, i); return f && f.volRatio <= 0.8; }],
];

// 교정 VPD 세트 (--set=vpd2). **사전 등록** — 늘리지 말 것.
// 판정 기준: 교정판이 현행 VPD(−1.94%)를 넘는 건 최소 조건일 뿐이고,
//   **통제군(cap300 임의20)을 넘어야** 비로소 "철학이 살아 있다"가 된다.
const VPD2_STRATS = [
  ['기준선: 유니버스 전체', () => true],
  CONTROL,
  ['[비교] 현행 VPD ≥ 3.0', (c, i) => { const f = vf(c, i); return f && f.vpd >= 3.0; }],
  ['── ★교정 VPD: 두 항 동일 저울 ──', null],
  ['★교정: 거래량 상위10% ∩ 가격 조용 상위10%', (c, i) => { const f = vf(c, i); return f && f.pv >= 0.9 && f.pq >= 0.9; }],
  ['★교정 엄격: 둘 다 상위 5%', (c, i) => { const f = vf(c, i); return f && f.pv >= 0.95 && f.pq >= 0.95; }],
  ['★교정 완화: 둘 다 상위 25%', (c, i) => { const f = vf(c, i); return f && f.pv >= 0.75 && f.pq >= 0.75; }],
  ['★교정 ∩ 시총상위300', (c, i) => { const f = vf(c, i); return f && f.pv >= 0.9 && f.pq >= 0.9 && cap300.get(i).has(c); }],
  ['── 대조군: 2×2 사분면 ──', null],
  ['시끄럽고 이미 움직임 (pv≥.9 ∩ pq≤.1)', (c, i) => { const f = vf(c, i); return f && f.pv >= 0.9 && f.pq <= 0.1; }],
  ['조용하고 안 움직임 (pv≤.1 ∩ pq≥.9)', (c, i) => { const f = vf(c, i); return f && f.pv <= 0.1 && f.pq >= 0.9; }],
  ['조용한데 이미 움직임 (pv≤.1 ∩ pq≤.1)', (c, i) => { const f = vf(c, i); return f && f.pv <= 0.1 && f.pq <= 0.1; }],
  ['── 단일 항만 (어느 항이 일하는가) ──', null],
  ['거래량 상위10%만 (pv≥.9)', (c, i) => { const f = vf(c, i); return f && f.pv >= 0.9; }],
  ['가격 조용 상위10%만 (pq≥.9)', (c, i) => { const f = vf(c, i); return f && f.pq >= 0.9; }],
];

// 배제 규칙 조합 세트 (--set=exclude). **사전 등록** — 늘리지 말 것.
// 2026-08-24: 지금까지 검증을 통과한 재료는 전부 "버리는 규칙"이었다(고변동성 회피,
//   고PBR 회피, 뒤처진 업종 회피). 그리고 --set=vpd2에서 최악 사분면이 **이격도 극단**
//   ("이미 움직임", 거래량 무관 −3.2%, 레짐 3개 일관)으로 확인됐다.
//   현행 파이프라인은 이격도를 **TOP3 선별 단계에서 상한(130/140/150)으로만** 쓴다.
//   → 풀 단계에서 **양방향** 배제하면 풀이 통제군 수준까지 올라오는가?
// 판정 기준: 풀(−2.67%)이 통제(−0.91%)에 얼마나 접근하는가 + 레짐 3개 부호 일관성.
const EX = {
  disp: (f, lo, hi) => f && f.disparity >= lo && f.disparity <= hi,
  loVol: (f, p) => f && f.pvol != null && f.pvol <= p,
};
const EXCLUDE_STRATS = [
  ['기준선: 유니버스 전체', () => true],
  CONTROL,
  ['★현행 풀 전체 (배제 없음)', (c, i) => poolOf.get(i)?.has(c)],
  ['── 이격도 배제 (풀 단계) ──', null],
  ['풀 ∩ 이격도 ≤130 (현행 상한만 근사)', (c, i) => poolOf.get(i)?.has(c) && EX.disp(vf(c, i), 0, 130)],
  ['★풀 ∩ 이격도 90~110 (양방향)', (c, i) => poolOf.get(i)?.has(c) && EX.disp(vf(c, i), 90, 110)],
  ['★풀 ∩ 이격도 85~115 (양방향, 완화)', (c, i) => poolOf.get(i)?.has(c) && EX.disp(vf(c, i), 85, 115)],
  ['★풀 ∩ 이격도 95~105 (양방향, 엄격)', (c, i) => poolOf.get(i)?.has(c) && EX.disp(vf(c, i), 95, 105)],
  ['── 고변동성 배제 추가 (배제 규칙 조합) ──', null],
  ['풀 ∩ 저변동성 하위50%', (c, i) => poolOf.get(i)?.has(c) && EX.loVol(vf(c, i), 0.5)],
  ['★풀 ∩ 이격도 90~110 ∩ 저변동성 하위50%', (c, i) => poolOf.get(i)?.has(c) && EX.disp(vf(c, i), 90, 110) && EX.loVol(vf(c, i), 0.5)],
  ['★풀 ∩ 이격도 90~110 ∩ 저변동성 하위30%', (c, i) => poolOf.get(i)?.has(c) && EX.disp(vf(c, i), 90, 110) && EX.loVol(vf(c, i), 0.3)],
  ['★위 + 시총상위300', (c, i) => poolOf.get(i)?.has(c) && EX.disp(vf(c, i), 90, 110) && EX.loVol(vf(c, i), 0.5) && cap300.get(i).has(c)],
  ['── 참고: 풀을 버리고 배제 규칙만 ──', null],
  ['풀 무관: 이격도 90~110 ∩ 저변동성 하위50%', (c, i) => EX.disp(vf(c, i), 90, 110) && EX.loVol(vf(c, i), 0.5)],
  ['풀 무관: 위 ∩ 시총상위300', (c, i) => EX.disp(vf(c, i), 90, 110) && EX.loVol(vf(c, i), 0.5) && cap300.get(i).has(c)],
];

const FUNNEL_STRATS = [
  ['기준선: 유니버스 전체', (c, i) => true],
  CONTROL,
  ['★현행 풀 전체 (5랭킹 합집합)', (c, i) => poolOf.get(i)?.has(c)],
  ['★풀 ∩ 시총상위300', (c, i) => poolOf.get(i)?.has(c) && cap300.get(i).has(c)],
  ['풀 밖 (비풀 전체)', (c, i) => !poolOf.get(i)?.has(c)],
  ['── 서브랭킹별 ──', null],
  ...RANKS.map(k => [`  ${k} 상위${TOPN}`, (c, i) => subOf.get(i)?.[k]?.has(c)]),
];

const STRATS = SET === 'vpd' ? VPD_STRATS : SET === 'vpd2' ? VPD2_STRATS : SET === 'exclude' ? EXCLUDE_STRATS : FUNNEL_STRATS;

const REG = ['BULL', 'BEAR', 'FLAT'];
const rows = [];
for (const [name, fn] of STRATS) {
  if (fn == null) { rows.push({ sep: name }); continue; }
  const A = { all: [], mm: [], beta: [] };
  for (const g of REG) A[g] = { cap: [], mm: [] };
  const half = Math.floor(days.length / 2);
  const halves = { a: [], b: [] };
  for (let i = LOOK + 5; i + SELL < days.length; i++) {
    const g = regimeOf(i);
    for (const c of universe[i]) {
      if (!fn(c, i)) continue;
      const e = exCap(c, i);
      if (e != null) { A.all.push(e); (i < half ? halves.a : halves.b).push(e); if (g) A[g].cap.push(e); }
      const am = alphaMM(c, i);
      if (am != null) { A.mm.push(am); if (g) A[g].mm.push(am); }
      const bt = betaOf.get(`${i}|${c}`); if (bt != null) A.beta.push(bt);
    }
  }
  if (A.all.length < 30) continue;
  rows.push({
    name, n: A.all.length, beta: avg(A.beta), cap: med(A.all), capMean: avg(A.all),
    mm: med(A.mm), win: winR(A.all),
    a: avg(halves.a), b: avg(halves.b),
    reg: Object.fromEntries(REG.map(g => [g, { cap: med(A[g].cap), mm: med(A[g].mm), n: A[g].cap.length }])),
  });
}

console.log('\n  전 구간 — 동일일·시총5분위 매칭 초과수익');
console.log('  ' + '-'.repeat(104));
console.log('  전략                              |      n  |  평균β | 초과중앙 | 초과평균 | 시장모형α | 승률');
for (const r of rows) {
  if (r.sep) { console.log('  ' + r.sep); continue; }
  console.log(`  ${r.name.padEnd(33)} | ${String(r.n).padStart(7)} | ${(r.beta == null ? '  -' : r.beta.toFixed(2)).padStart(6)} | ${sgn(r.cap)} | ${sgn(r.capMean)} | ${sgn(r.mm)} | ${r.win.toFixed(0).padStart(3)}%`);
}

console.log('\n  ★ 레짐별 매칭 초과수익 중앙값 — "풀이 나쁘다"가 상승 레짐에서도 성립하는가');
console.log('  ' + '-'.repeat(104));
console.log('  전략                              | 상승레짐 (n)         | 하락레짐 (n)         | 횡보 (n)');
for (const r of rows) {
  if (r.sep) { console.log('  ' + r.sep); continue; }
  const f = g => `${sgn(r.reg[g].cap)} (${String(r.reg[g].n).padStart(6)})`;
  console.log(`  ${r.name.padEnd(33)} | ${f('BULL')} | ${f('BEAR')} | ${f('FLAT')}`);
}

console.log('\n  ★★ 레짐별 시장모형 알파 (베타 차감 후)');
console.log('  ' + '-'.repeat(104));
for (const r of rows) {
  if (r.sep) { console.log('  ' + r.sep); continue; }
  console.log(`  ${r.name.padEnd(33)} | ${sgn(r.reg.BULL.mm)}          | ${sgn(r.reg.BEAR.mm)}          | ${sgn(r.reg.FLAT.mm)}`);
}

const signalDays = days.length - LOOK - 5 - SELL;
console.log(`\n독립블록 ≈ ${(signalDays / (SELL - BUY + 1)).toFixed(1)} (신호일 ${signalDays}일 / 보유 ${SELL - BUY}일).`);
console.log('전·후반 안정성(전 구간 초과평균):');
for (const r of rows) if (!r.sep) console.log(`  ${r.name.padEnd(33)} ${sgn(r.a)} → ${sgn(r.b)}${Math.sign(r.a) === Math.sign(r.b) ? '' : '   ⚠️ 부호 불안정'}`);
console.log('\n  · 풀 성과는 생존편향으로 **실제보다 좋게** 추정된다(상폐 종목 부재) → "풀이 나쁘다"에 보수적.');
console.log('  · 랭킹은 종가 확정치 기준 근사. KIS 장중 스냅샷과 풀 구성이 완전히 같지 않다.');
console.log('  · 수급 소급 불가 → 점수·TOP3는 재현하지 않음. 이 검증은 **풀 수준**이다.\n');
