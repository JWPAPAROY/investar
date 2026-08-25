/**
 * regime-validation.js — 저변동성·재무 신호를 **상승/하락 두 레짐에서** 대조 (2026-08-20)
 *
 * 배경: lowvol-attribution.js가 저변동성 우위의 ~85%를 베타로 설명했지만, 표본이
 *   60거래일 단일 하락 레짐이라 "상승장에선 뒤집힌다"를 하락장 안의 반등일로만 봤다.
 *   collect-price-history.js가 2024-01~2026-08 수정주가를 소급 수집 → 진짜 상승 레짐
 *   (KOSPI 2025-01 2,517 → 2026-05 8,476)과 크래시(2026-07 −22%)를 모두 포함한다.
 *
 * 묻는 것: 저변동성(및 재무) 우위가 **레짐을 건너 살아남는가**.
 *   살아남으면 알파 쪽 증거, 상승 레짐에서 부호가 뒤집히면 베타 확정.
 *
 * 규약: direction-signal-battery / lowvol-attribution과 통일.
 *   매일 상위K 매수, D+1 매수 → D+SELL 매도, 전방참조 없음, 유동성 하한,
 *   동일일 매칭 초과수익, 독립블록<3이면 판정 거부.
 *
 * ⚠️ 편향(collect-price-history.js 헤더 참고): 생존편향(상폐 종목 부재)은 고변동성
 *   그룹을 실제보다 좋게 보이게 하므로, **"상승장에서 저변동성이 뒤진다"는 결론을 부풀린다.**
 *   반대로 "저변동성이 상승장에서도 이긴다"가 나오면 그건 편향을 거스른 강한 증거다.
 *
 * 실행: node scripts/regime-validation.js [--sell=10] [--k=20] [--from=20240101]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const argS = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const SELL = arg('sell', 10);
const K = arg('k', 20);
// 매수일 오프셋(신호일 = D+0). active_policy를 따를 것 — 2026-08-23부터 D+2 매수 → D+10 매도.
const BUY = arg('buyoffset', 1);
if (!(BUY >= 1 && BUY < SELL)) { console.error(`❌ --buyoffset(${BUY})은 1 이상이고 --sell(${SELL})보다 작아야 함`); process.exit(1); }
const LOOK = arg('look', 20);
const SET = argS('set', 'core');   // core(기본) | slow(저회전 축 탐색, 2026-08-24)
const FROM = argS('from', '20240101');
const CAPMIN = arg('capmin', 3000) * 1e8;
const VALMIN = arg('valmin', 10) * 1e8;
const FIN_LAG_ANNUAL = 90, FIN_LAG_QUARTER = 45;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sgn = v => (v == null ? '      -' : ((v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) + '%').padStart(8));

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
    c.set(d, cl); v.set(d, vo); t.set(d, va); dateSet.add(d);
  }
  if (!c.size) continue;
  close.set(rec.c, c); vol.set(rec.c, v); val.set(rec.c, t); shares.set(rec.c, rec.s || null);
}
const days = [...dateSet].sort();
const codes = [...close.keys()];
// 상장 이전/거래정지로 결측인 날이 많으므로, 그날 가격이 있는 종목만 그날의 유니버스
const universe = days.map(d => codes.filter(c => close.get(c).has(d)));
console.log(`\n🔁 레짐 대조 검증 — 매일 상위 ${K}종목, D+${BUY} 매수 → D+${SELL} 매도`);
console.log(`데이터: ${days.length}거래일 × ${codes.length}종목 (${days[0]} ~ ${days[days.length - 1]})`);

const capOf = (c, i) => { const s = shares.get(c), p = close.get(c).get(days[i]); return (s && p) ? s * p : null; };
const at = (c, i) => (i >= 0 && i < days.length ? close.get(c)?.get(days[i]) : null);
const fwd = (c, i) => { const b = at(c, i + BUY), s = at(c, i + SELL); return (b && s) ? ((s - b) / b) * 100 : null; };

// ── 시장수익률(시총가중) + 레짐 라벨 ──────────────────────────────────
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
// 레짐 = 신호일 기준 **과거** 60거래일 시장 누적수익 (전방참조 없음)
const regimeOf = (i) => {
  if (i < 60) return null;
  let acc = 1;
  for (let k = i - 59; k <= i; k++) { if (mkt[k] == null) return null; acc *= 1 + mkt[k] / 100; }
  const r = (acc - 1) * 100;
  return r > 5 ? 'BULL' : r < -5 ? 'BEAR' : 'FLAT';
};

let cum = 1; for (let i = 1; i < days.length; i++) if (mkt[i] != null) cum *= 1 + mkt[i] / 100;
console.log(`시장(시총가중) 전 구간 누적 ${((cum - 1) * 100).toFixed(1)}%`);
{
  const cnt = { BULL: 0, BEAR: 0, FLAT: 0 };
  for (let i = 0; i < days.length; i++) { const r = regimeOf(i); if (r) cnt[r]++; }
  console.log(`레짐 분포(신호일 기준 과거 60일 누적): 상승 ${cnt.BULL}일 / 하락 ${cnt.BEAR}일 / 횡보 ${cnt.FLAT}일`);
}

// ── 재무 point-in-time ────────────────────────────────────────────────
const FIN = path.resolve(__dirname, '../data/financials.json');
const finByCode = new Map();
if (fs.existsSync(FIN)) {
  for (const r of JSON.parse(fs.readFileSync(FIN, 'utf-8')).rows) {
    const y = +r.ym.slice(0, 4), m = +r.ym.slice(4, 6);
    const end = new Date(Date.UTC(y, m, 0));
    const avail = new Date(end.getTime() + (m === 12 ? FIN_LAG_ANNUAL : FIN_LAG_QUARTER) * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
    if (!finByCode.has(r.code)) finByCode.set(r.code, []);
    finByCode.get(r.code).push({ avail, ym: r.ym, bps: r.bps, eps: r.eps, sps: r.sps, roe: r.roe, debt: r.debt, rsrv: r.rsrv });
  }
  for (const a of finByCode.values()) a.sort((x, y) => x.avail.localeCompare(y.avail));
  console.log(`재무: ${finByCode.size}종목 (공시시차 연 ${FIN_LAG_ANNUAL}일 / 분기 ${FIN_LAG_QUARTER}일)`);
}
const finAt = (c, d) => {
  const a = finByCode.get(c); if (!a) return null;
  let lo = 0, hi = a.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].avail <= d) { best = a[m]; lo = m + 1; } else hi = m - 1; }
  return best;
};

// ── 종목별 지표 ───────────────────────────────────────────────────────
const feat = new Map(), eligible = new Map();
for (let i = LOOK + 5; i < days.length; i++) {
  const list = [];
  for (const c of universe[i]) {
    const cap = capOf(c, i);
    if (!cap || cap < CAPMIN) continue;
    const rets = [], mrets = [];
    let ok = true, vsum = 0, n = 0;
    for (let k = LOOK; k >= 1; k--) {
      const p = at(c, i - k), q = at(c, i - k + 1);
      if (!p || !q) { ok = false; break; }
      rets.push(((q - p) / p) * 100); mrets.push(mkt[i - k + 1] ?? 0);
      const vv = val.get(c).get(days[i - k]); if (vv) { vsum += vv; n++; }
    }
    if (!ok || n < LOOK - 2) continue;
    if (!(vsum / n >= VALMIN)) continue;
    const mm = avg(mrets), rm = avg(rets);
    let cov = 0, varm = 0;
    for (let k = 0; k < rets.length; k++) { cov += (rets[k] - rm) * (mrets[k] - mm); varm += (mrets[k] - mm) ** 2; }
    const beta = varm > 0 ? cov / varm : null;
    const resid = beta == null ? null : rets.map((v, k) => v - (rm - beta * mm) - beta * mrets[k]);
    const fin = finAt(c, days[i]);
    const p = at(c, i);
    // 2026-08-24: --set=gap의 유일 생존 후보 '고점근접 조용'을 레짐 대조에 태운다.
    // 종가·거래량만 쓰므로 price-history.jsonl(open 없음)에서도 계산 가능하다 — 갭 조건은 불가.
    const vcl = [], vvo = [];
    let okv = true;
    for (let k = LOOK; k >= 0; k--) {
      const cl = at(c, i - k), vv = vol.get(c)?.get(days[i - k]);
      if (cl == null || vv == null) { okv = false; break; }
      vcl.push(cl); vvo.push(vv);
    }
    const dry5 = (okv && avg(vvo.slice(0, -5)) > 0) ? avg(vvo.slice(-5)) / avg(vvo.slice(0, -5)) : null;
    const hi20 = okv ? Math.max(...vcl) : null;
    const pbDepth = hi20 ? ((hi20 - vcl[vcl.length - 1]) / hi20) * 100 : null;
    // 2026-08-24: 배제 규칙 조합을 **일별 상위K 실행 규칙**으로 재현하기 위한 이격도.
    // funnel-regime-backtest --set=exclude는 조건 통과 전체를 균등 매수하는 슬라이스 통계라
    // 허위양성 검증이 안 된다(프로젝트 규약). 여기서 top-K 실행으로 재현한다.
    const ma20 = okv ? avg(vcl) : null;
    const disparity = ma20 ? (vcl[vcl.length - 1] / ma20) * 100 : null;
    const pair = SET === 'slow' ? finPair(c, days[i]) : null;
    feat.set(`${i}|${c}`, {
      disparity,
      per: (fin && fin.eps > 0) ? p / fin.eps : null,          // 흑자기업만
      rsrv: fin ? fin.rsrv : null,                              // 유보율
      // 전년동기 대비 EPS 개선 / 주가 — 증가율(%)이 아니라 주가 스케일(기저효과 면역)
      epsYield: (pair?.py && pair.cur?.eps != null && pair.py.eps != null)
        ? ((pair.cur.eps - pair.py.eps) / p) * 100 : null,
      vol20: sd(rets), beta, idio: resid ? sd(resid) : null, cap, dry5, pbDepth,
      pbr: fin && fin.bps > 0 ? p / fin.bps : null,
      roe: fin ? fin.roe : null, debt: fin ? fin.debt : null,
    });
    list.push(c);
  }
  eligible.set(i, list);
}

// ── 매칭 기준 ─────────────────────────────────────────────────────────
const capQ = new Map(), betaQ = new Map(), qMean = new Map(), qbMean = new Map();
for (let i = 0; i < days.length; i++) {
  const rows = universe[i].map(c => [c, capOf(c, i)]).filter(x => x[1]);
  rows.sort((a, b) => a[1] - b[1]);
  rows.forEach(([c], k) => capQ.set(`${i}|${c}`, Math.min(4, Math.floor((k / rows.length) * 5))));
  const b = [[], [], [], [], []];
  for (const [c] of rows) { const f = fwd(c, i); if (f != null) b[capQ.get(`${i}|${c}`)].push(f); }
  qMean.set(i, b.map(x => (x.length >= 20 ? avg(x) : null)));

  const wb = (eligible.get(i) || []).map(c => [c, feat.get(`${i}|${c}`)?.beta]).filter(x => x[1] != null);
  wb.sort((a, b2) => a[1] - b2[1]);
  wb.forEach(([c], k) => betaQ.set(`${i}|${c}`, Math.min(4, Math.floor((k / wb.length) * 5))));
  const bb = {};
  for (const [c] of wb) { const f = fwd(c, i); if (f == null) continue; const key = `${capQ.get(`${i}|${c}`)}|${betaQ.get(`${i}|${c}`)}`; (bb[key] = bb[key] || []).push(f); }
  const m = {}; for (const k in bb) if (bb[k].length >= 10) m[k] = avg(bb[k]);
  qbMean.set(i, m);
}
const exCap = (c, i) => { const f = fwd(c, i); if (f == null) return null; const m = qMean.get(i)?.[capQ.get(`${i}|${c}`)]; return m == null ? null : f - m; };
const exCapBeta = (c, i) => { const f = fwd(c, i); if (f == null) return null; const m = qbMean.get(i)?.[`${capQ.get(`${i}|${c}`)}|${betaQ.get(`${i}|${c}`)}`]; return m == null ? null : f - m; };
const alphaMM = (c, i) => { const f = fwd(c, i), mf = mktFwd(i), b = feat.get(`${i}|${c}`)?.beta; return (f == null || mf == null || b == null) ? null : f - b * mf; };

const cap300 = new Map();
for (let i = 0; i < days.length; i++) {
  const r = universe[i].map(c => [c, capOf(c, i)]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 300);
  cap300.set(i, new Set(r.map(x => x[0])));
}

// ── 저변동성 × 저PBR 결합용 일별 백분위 (2026-08-24) ────────────────────
// 두 축은 척도가 달라(σ는 %, PBR은 배수) 그대로 더할 수 없다 → 당일 cap300 내 백분위로 환산.
// 1 = 가장 저변동성 / 가장 저PBR. 결합은 백분위 합(랭크합)으로만 한다.
const pctVol = new Map(), pctPbr = new Map();
for (let i = LOOK + 5; i < days.length; i++) {
  const mem = [...(cap300.get(i) || [])].filter(c => feat.has(`${i}|${c}`));
  const wv = mem.filter(c => feat.get(`${i}|${c}`).vol20 != null)
    .sort((a, b) => feat.get(`${i}|${a}`).vol20 - feat.get(`${i}|${b}`).vol20);
  wv.forEach((c, k) => pctVol.set(`${i}|${c}`, wv.length > 1 ? 1 - k / (wv.length - 1) : 1));
  const wp = mem.filter(c => feat.get(`${i}|${c}`).pbr > 0)
    .sort((a, b) => feat.get(`${i}|${a}`).pbr - feat.get(`${i}|${b}`).pbr);
  wp.forEach((c, k) => pctPbr.set(`${i}|${c}`, wp.length > 1 ? 1 - k / (wp.length - 1) : 1));
}
const pv_ = (c, i) => pctVol.get(`${i}|${c}`);
const pp_ = (c, i) => pctPbr.get(`${i}|${c}`);

// ── 저회전 축 전용 피처 (--set=slow, 2026-08-24) ───────────────────────
// 왜 저회전인가: 거래비용 분석에서 회전율이 순α를 갈랐다(저PBR 11% 생존 / 고점근접 조용 91% 사망).
//   → 새 후보는 **느리게 변하는 축**에서만 찾는다. 긴 창(60·252일)과 분기 재무가 그것이다.
// 성능: 종목별 1회 O(n) 패스로 롤링 계산(252일 창을 매일 재계산하면 수억 회 연산이 된다).
const SLOW = new Map();   // code -> {vol60, mom121, h52} (일 인덱스 배열)
if (SET === 'slow') {
  const N = days.length;
  for (const c of codes) {
    const px = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) { const v = at(c, i); if (v) px[i] = v; }
    const vol60 = new Float64Array(N).fill(NaN);
    const mom121 = new Float64Array(N).fill(NaN);
    const h52 = new Float64Array(N).fill(NaN);
    // 롤링 60일 수익률 표준편차
    const rets = new Float64Array(N).fill(NaN);
    for (let i = 1; i < N; i++) if (px[i] && px[i - 1]) rets[i] = ((px[i] - px[i - 1]) / px[i - 1]) * 100;
    let s = 0, s2 = 0, cnt = 0;
    for (let i = 1; i < N; i++) {
      const add = rets[i], drop = i - 60 >= 1 ? rets[i - 60] : NaN;
      if (!isNaN(add)) { s += add; s2 += add * add; cnt++; }
      if (!isNaN(drop)) { s -= drop; s2 -= drop * drop; cnt--; }
      if (cnt >= 40) { const m = s / cnt; const v = Math.max(0, s2 / cnt - m * m); vol60[i] = Math.sqrt(v); }
      // 12-1 모멘텀: 252일 전 → 21일 전 (최근 1개월 제외 = 단기 반전 회피, 고전적 정의)
      if (i >= 252 && px[i - 252] && px[i - 21]) mom121[i] = ((px[i - 21] - px[i - 252]) / px[i - 252]) * 100;
    }
    // 52주 고가 대비 위치 (단조 데크로 O(n))
    const dq = [];
    for (let i = 0; i < N; i++) {
      while (dq.length && dq[0] < i - 251) dq.shift();
      if (!isNaN(px[i])) {
        while (dq.length && !(px[dq[dq.length - 1]] > px[i])) dq.pop();
        dq.push(i);
      }
      if (i >= 251 && dq.length && px[i]) h52[i] = (px[i] / px[dq[0]]) * 100;
    }
    SLOW.set(c, { vol60, mom121, h52 });
  }
  console.log('저회전 피처 준비: 60일σ / 12-1 모멘텀 / 52주고가대비 (종목별 O(n) 롤링)');
}
const sl = (c, i, k) => { const o = SLOW.get(c); const v = o ? o[k][i] : NaN; return isNaN(v) ? null : v; };
// 분기 재무 파생: 전년동기(ym−100) 대비 EPS 개선을 주가로 스케일 (기저효과 면역)
function finPair(c, d) {   // 함수 선언 = 호이스팅. feat 루프가 이 정의보다 위에서 호출한다.
  const a = finByCode.get(c); if (!a) return null;
  let lo = 0, hi = a.length - 1, cur = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].avail <= d) { cur = a[m]; lo = m + 1; } else hi = m - 1; }
  if (!cur) return null;
  const pyYm = String(+cur.ym.slice(0, 4) - 1) + cur.ym.slice(4);
  const py = a.find(x => x.ym === pyYm && x.avail <= d);
  return { cur, py };
};

const STRATS = [
  ['기준선: 유니버스 전체', null],
  ['[통제] 시총상위300 중 임의 20', (f, c, i) => { if (!cap300.get(i).has(c)) return null; let h = i * 2654435761; for (let k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0; return (h % 100000) / 100000; }],
  ['저변동성 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) ? -f.vol20 : null)],
  ['저베타 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) && f.beta != null ? -f.beta : null)],
  ['저잔차변동성 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) && f.idio != null ? -f.idio : null)],
  ['저변동성 (전 유니버스)', (f) => -f.vol20],
  ['저PBR', (f) => (f.pbr > 0 ? -f.pbr : null)],
  ['저PBR ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) && f.pbr > 0 ? -f.pbr : null)],
  ['퀄리티 (ROE상위 ∩ 부채≤100%)', (f) => (f.debt != null && f.debt <= 100 ? f.roe : null)],
  ['고변동성 ∩ 시총상위300 (역)', (f, c, i) => (cap300.get(i).has(c) ? f.vol20 : null)],
  ['★고점근접 조용 (마름 & 고점−5% 내)', (f) => (f.dry5 != null && f.dry5 <= 0.8 && f.pbDepth != null && f.pbDepth <= 5 ? -f.dry5 : null)],
  ['★고점근접 조용 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) && f.dry5 != null && f.dry5 <= 0.8 && f.pbDepth != null && f.pbDepth <= 5 ? -f.dry5 : null)],
  // 배제 규칙 조합 (2026-08-24). 슬라이스가 아니라 매일 상위K 실행으로 재현한 것.
  ['★이격도 90~110 ∩ cap300 (저σ 정렬)', (f, c, i) => (cap300.get(i).has(c) && f.disparity >= 90 && f.disparity <= 110 ? -f.vol20 : null)],
  ['★이격도 95~105 ∩ cap300 (저σ 정렬)', (f, c, i) => (cap300.get(i).has(c) && f.disparity >= 95 && f.disparity <= 105 ? -f.vol20 : null)],
  ['[대조] 이격도 배제 없음 ∩ cap300 (저σ)', (f, c, i) => (cap300.get(i).has(c) ? -f.vol20 : null)],
  // ── 저변동성 × 저PBR 결합 (2026-08-24). **사전 등록** — 늘리지 말 것. ──
  // 판정: 결합이 두 단독(저σ α +0.01 / 저PBR α +0.05)보다 나은가, 아니면 한쪽의 재탕인가.
  ['★결합 랭크합 (저σ+저PBR) ∩ cap300', (f, c, i) => {
    const a = pv_(c, i), b = pp_(c, i);
    return (a == null || b == null) ? null : a + b;
  }],
  ['★저PBR 하위50% 안에서 저σ 정렬', (f, c, i) => {
    const b = pp_(c, i);
    return (b == null || b < 0.5 || f.vol20 == null) ? null : -f.vol20;
  }],
  ['★저σ 하위50% 안에서 저PBR 정렬', (f, c, i) => {
    const a = pv_(c, i), b = pp_(c, i);
    return (a == null || a < 0.5 || b == null) ? null : b;
  }],
  ['[대조] 고σ+고PBR 랭크합 (역)', (f, c, i) => {
    const a = pv_(c, i), b = pp_(c, i);
    return (a == null || b == null) ? null : -(a + b);
  }],
];

// ── 저회전 축 탐색 세트 (--set=slow). **사전 등록** — 늘리지 말 것. ──────
// 배경(2026-08-24 비용 분석): 순α를 가른 건 신호의 세기가 아니라 **회전율**이었다.
//   저PBR(회전 11%) 순α +0.00% / 고점근접 조용(회전 91%) 순α −1.10%.
//   → 후보를 "느리게 변하는 축"으로 제한하고, **판정은 총α가 아니라 순α로** 한다.
// 가격 축은 창을 길게(60·252일), 재무 축은 분기 갱신이라 구조적으로 저회전이다.
// ⚠️ 12-1 모멘텀·52주 고가는 252일 이력이 필요해 2025-01 이후 신호일만 표본에 들어온다(n 감소).
// ⚠️ 신호 10개 동시검정 — 상위 1~2개는 우연일 수 있다. 레짐 3개 부호 일관성을 함께 볼 것.
const SLOW_STRATS = [
  ['기준선: 유니버스 전체', null],
  ['[통제] 시총상위300 중 임의 20', (f, c, i) => { if (!cap300.get(i).has(c)) return null; let h = i * 2654435761; for (let k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0; return (h % 100000) / 100000; }],
  ['[기존최선] 저PBR ∩ cap300', (f, c, i) => (cap300.get(i).has(c) && f.pbr > 0 ? -f.pbr : null)],
  ['[기존최선] 결합 랭크합 ∩ cap300', (f, c, i) => { const a = pv_(c, i), b = pp_(c, i); return (a == null || b == null) ? null : a + b; }],
  ['── 가격 기반 저회전 (긴 창) ──', null],
  ['★60일 저변동성 ∩ cap300', (f, c, i) => { const v = sl(c, i, 'vol60'); return (cap300.get(i).has(c) && v != null) ? -v : null; }],
  ['★12-1 모멘텀 상위 ∩ cap300', (f, c, i) => { const m = sl(c, i, 'mom121'); return (cap300.get(i).has(c) && m != null) ? m : null; }],
  ['★52주 고가 근접 ∩ cap300', (f, c, i) => { const h = sl(c, i, 'h52'); return (cap300.get(i).has(c) && h != null) ? h : null; }],
  ['── 재무 저회전 (641일 첫 정식 검정) ──', null],
  ['★저PER ∩ cap300', (f, c, i) => (cap300.get(i).has(c) && f.per > 0 ? -f.per : null)],
  ['★저부채 ∩ cap300', (f, c, i) => (cap300.get(i).has(c) && f.debt != null ? -f.debt : null)],
  ['★고ROE ∩ cap300', (f, c, i) => (cap300.get(i).has(c) && f.roe != null ? f.roe : null)],
  ['★ΔEPS/주가 상위 ∩ cap300', (f, c, i) => (cap300.get(i).has(c) && f.epsYield != null ? f.epsYield : null)],
  ['★유보율 상위 ∩ cap300', (f, c, i) => (cap300.get(i).has(c) && f.rsrv != null ? f.rsrv : null)],
  ['── 반대 방향 대조군 ──', null],
  ['[역] 12-1 모멘텀 하위 ∩ cap300', (f, c, i) => { const m = sl(c, i, 'mom121'); return (cap300.get(i).has(c) && m != null) ? -m : null; }],
  ['[역] 52주 고가에서 먼 종목 ∩ cap300', (f, c, i) => { const h = sl(c, i, 'h52'); return (cap300.get(i).has(c) && h != null) ? -h : null; }],
  ['[역] 고PER ∩ cap300', (f, c, i) => (cap300.get(i).has(c) && f.per > 0 ? f.per : null)],
];

const REG = ['BULL', 'BEAR', 'FLAT'];
const rows = [];
for (const [name, fn] of (SET === 'slow' ? SLOW_STRATS : STRATS)) {
  if (name.startsWith('──')) { rows.push({ sep: name }); continue; }   // 구분선
  const A = { all: [], mmAll: [], cbAll: [], beta: [] };
  for (const g of REG) A[g] = { cap: [], cb: [], mm: [] };
  const pickSets = new Map();   // 회전율 측정용 (2026-08-24)
  for (let i = LOOK + 5; i + SELL < days.length; i++) {
    const g = regimeOf(i); if (!g) continue;
    const list = eligible.get(i) || [];
    let picks;
    if (fn == null) picks = list;
    else {
      const sc = [];
      for (const c of list) { const f = feat.get(`${i}|${c}`); if (!f) continue; const v = fn(f, c, i); if (v == null || !isFinite(v)) continue; sc.push([c, v]); }
      picks = sc.sort((x, y) => y[1] - x[1]).slice(0, K).map(x => x[0]);
    }
    if (fn != null) pickSets.set(i, new Set(picks));
    for (const c of picks) {
      const e = exCap(c, i), eb = exCapBeta(c, i), am = alphaMM(c, i);
      if (e != null) { A.all.push(e); A[g].cap.push(e); }
      if (eb != null) { A.cbAll.push(eb); A[g].cb.push(eb); }
      if (am != null) { A.mmAll.push(am); A[g].mm.push(am); }
      const b = feat.get(`${i}|${c}`)?.beta; if (b != null) A.beta.push(b);
    }
  }
  if (A.all.length < 100) continue;

  // ── 회전율 (2026-08-24) ──────────────────────────────────────────────
  // HOLD = SELL − BUY = 실제 보유 거래일수. 이 주기로 리밸런싱한다고 보고,
  // 직전 리밸런싱 픽과 겹치는 비율(carry)만큼 매도·재매수를 건너뛴다.
  const HOLD = SELL - BUY;
  const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
  const carry1 = [], carryH = [];
  for (const [i, s] of pickSets) {
    const n1 = pickSets.get(i + 1), nH = pickSets.get(i + HOLD);
    if (n1 && s.size) carry1.push(inter(s, n1) / s.size);
    if (nH && s.size) carryH.push(inter(s, nH) / s.size);
  }

  rows.push({
    name, n: A.all.length, beta: avg(A.beta), all: med(A.all), cbAll: med(A.cbAll), mmAll: med(A.mmAll),
    allMean: avg(A.all), mmMean: avg(A.mmAll),
    win: winR(A.all), carry1: avg(carry1), carryH: avg(carryH),
    ...Object.fromEntries(REG.map(g => [g, { cap: med(A[g].cap), cb: med(A[g].cb), mm: med(A[g].mm), n: A[g].cap.length }])),
  });
}

console.log('\n  전 구간 (시총매칭 초과수익 중앙값)');
console.log('  ' + '-'.repeat(100));
console.log('  전략                               |     n  |  평균β | ①시총매칭 | ②+베타매칭 | ③시장모형α | 승률');
for (const r of rows) { if (r.sep) { console.log('  '+r.sep); continue; } console.log(`  ${r.name.padEnd(34)} | ${String(r.n).padStart(6)} | ${(r.beta == null ? '  -' : r.beta.toFixed(2)).padStart(6)} | ${sgn(r.all)} | ${sgn(r.cbAll)} | ${sgn(r.mmAll)} | ${r.win.toFixed(0).padStart(3)}%`); }

console.log('\n  ★ 레짐별 시총매칭 초과수익 중앙값 — 부호가 레짐을 건너 유지되는가');
console.log('  ' + '-'.repeat(100));
console.log('  전략                               | 상승레짐 (n)        | 하락레짐 (n)        | 횡보 (n)');
for (const r of rows) { if (r.sep) { console.log('  '+r.sep); continue; } console.log(`  ${r.name.padEnd(34)} | ${sgn(r.BULL.cap)} (${String(r.BULL.n).padStart(5)}) | ${sgn(r.BEAR.cap)} (${String(r.BEAR.n).padStart(5)}) | ${sgn(r.FLAT.cap)} (${String(r.FLAT.n).padStart(5)})`); }

console.log('\n  ★★ 레짐별 **시장모형 알파** (베타 노출 차감 후) — 진짜 남는 것');
console.log('  ' + '-'.repeat(100));
console.log('  전략                               | 상승레짐            | 하락레짐            | 횡보');
for (const r of rows) { if (r.sep) { console.log('  '+r.sep); continue; } console.log(`  ${r.name.padEnd(34)} | ${sgn(r.BULL.mm)}          | ${sgn(r.BEAR.mm)}          | ${sgn(r.FLAT.mm)}`); }

// ── 회전율 · 거래비용 (2026-08-24) ────────────────────────────────────
// α가 +0.1%p 수준이면 비용에 먹힐 수 있으므로 반드시 같이 본다.
// ⚠️ 세 파라미터는 **가정값**이다. 실제 수수료·세율·체결 슬리피지로 바꿔 재실행할 것.
//    비용은 "리밸런싱 1회(=보유기간 1회전)당 포트폴리오 대비 %"로 환산해 α에서 뺀다.
{
  const FEE = arg('fee', 0.015);    // 편도 수수료 %
  const TAX = arg('tax', 0.15);     // 매도분 증권거래세 %
  const SLIP = arg('slip', 0.10);   // 편도 슬리피지 %
  const HOLD = SELL - BUY;
  const roundTrip = (FEE + SLIP) + (FEE + SLIP + TAX);   // 신규 편입 1주당 왕복 비용 %
  console.log(`\n  💸 회전율 · 거래비용 — 리밸런싱 주기 ${HOLD}거래일 (보유기간 = D+${BUY}→D+${SELL})`);
  console.log(`     가정: 편도수수료 ${FEE}% / 매도세 ${TAX}% / 편도슬리피지 ${SLIP}% → 신규편입 왕복 ${roundTrip.toFixed(3)}%`);
  console.log('  ' + '-'.repeat(100));
  console.log(`  전략                               | 일간유지 | ${String(HOLD).padStart(2)}일유지 |  회전율 |  기간비용 |  총α(중앙) | 순α(중앙) | 총α(평균) | 순α(평균)`);
  for (const r of rows) {
    if (r.sep) { console.log('  ' + r.sep); continue; }
    if (r.carryH == null) { console.log(`  ${r.name.padEnd(34)} |    -     |    -     |    -    |     -     | ${sgn(r.mmAll)} |     -`); continue; }
    const turn = 1 - r.carryH;
    const cost = turn * roundTrip;
    const net = r.mmAll - cost;
    const netMean = r.mmMean - cost;
    console.log(`  ${r.name.padEnd(34)} | ${(r.carry1 * 100).toFixed(0).padStart(6)}%  | ${(r.carryH * 100).toFixed(0).padStart(6)}%  | ${(turn * 100).toFixed(0).padStart(5)}%  | ${('-' + cost.toFixed(2) + '%').padStart(8)}  | ${sgn(r.mmAll)} | ${sgn(net)} | ${sgn(r.mmMean)} | ${sgn(netMean)}`);
  }
  console.log('  · 회전율 = 1 − (직전 리밸런싱 픽과의 중복률). 중복 종목은 매도·재매수를 건너뛴다.');
  console.log('  · 순α = 시장모형α − 기간비용. **비용 파라미터는 가정값이므로 실측치로 재실행할 것**(--fee/--tax/--slip).');
  console.log('  · 현행 깔때기는 매일 풀이 갈리므로 회전율≈100%로 봐야 한다(이 표의 기준선/통제 행과 비교).');
}

console.log('\n  · 레짐 = 신호일 기준 **과거** 60거래일 시장 누적(>+5% 상승 / <−5% 하락). 전방참조 없음.');
console.log('  · 베타 베팅이면 상승/하락 레짐에서 ① 부호가 뒤집힌다. 알파면 양쪽 다 같은 부호.');
console.log('  · ③은 기준선 행과 비교해서 읽을 것 (시장 방향에 따라 전체가 함께 이동한다).');
const signalDays = days.length - LOOK - 5 - SELL - 60;
console.log(`\n독립블록 ≈ ${(signalDays / SELL).toFixed(1)} (신호일 ${signalDays}일 / 보유 ${SELL}일).`);
console.log('⚠️ 생존편향: 유니버스에 상폐 종목 부재 → 고변동성 그룹이 실제보다 좋게 보임');
console.log('   = "상승장에서 저변동성이 뒤진다"는 결론은 부풀려지고, "상승장에서도 이긴다"는 편향을 거스른 증거.\n');
