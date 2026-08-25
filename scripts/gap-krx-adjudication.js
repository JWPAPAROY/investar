/**
 * gap-krx-adjudication.js — 갭 축 정식 재판정 (2026-08-24)
 *
 * 배경: 2026-08-24 오전 `direction-signal-battery --set=gap`에서 "저거래량 눌림 + 갭상승"을
 *   기각했지만, 그 표본은 **62거래일(market_flow_daily)** 뿐이었다. price-history.jsonl에
 *   시가가 없어 641일로 승격할 수 없었고, D+10 지평은 독립블록 2.7로 **판정 불가**였다.
 *   KRX 일별매매정보로 시가를 확보해 이제 정식 판정이 가능하다.
 *
 * 이 스크립트가 오전과 다른 점 (전부 결론에 영향):
 *   ① 표본 62일 → **~1,140거래일(2022-01~)**, 레짐 4개
 *   ② 시가총액이 근사("수정주가 × 현재 상장주식수")가 아니라 **KRX 실측 MKTCAP**
 *   ③ 유니버스가 그날 시점 스냅샷이라 **상폐 종목 포함 = 생존편향 완화**
 *   ④ **우선주 배제**(krx-master.json의 KIND_STKCERT_TP_NM) — 오전 유니버스엔 삼성전자우 등이 섞여 있었다
 *
 * 규약(기존 스크립트와 통일): 매수 D+BUY 종가 → 매도 D+SELL 종가, 전방참조 없음,
 *   동일일 × 시총5분위 매칭 초과수익, 시장모형α, 레짐 = 신호일 기준 과거 60일,
 *   전·후반 부호 안정성, 독립블록<3이면 판정 거부.
 *
 * ⚠️ 갭(gapNext)만 i+1 시가를 쓴다. 매수가 i+BUY(기본 D+2) 종가이므로 전방참조가 아니다.
 *
 * 실행: node --max-old-space-size=8192 scripts/gap-krx-adjudication.js [--sell=10] [--buyoffset=2]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10);
const BUY = arg('buyoffset', 2);
const LOOK = arg('look', 20);
const CAPMIN = arg('capmin', 3000) * 1e8;
const VALMIN = arg('valmin', 10) * 1e8;
if (!(BUY >= 1 && BUY < SELL)) { console.error(`❌ --buyoffset(${BUY})은 1 이상 --sell(${SELL}) 미만`); process.exit(1); }

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sgn = v => (v == null ? '       -' : ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(8));

// ── 데이터 로드 ────────────────────────────────────────────────────────
const DAILY = path.resolve(__dirname, '../data/krx-daily.jsonl');
const MASTER = path.resolve(__dirname, '../data/krx-master.json');
if (!fs.existsSync(DAILY)) { console.error('❌ data/krx-daily.jsonl 없음 → collect-krx-daily.js 먼저'); process.exit(1); }

// 우선주 등 배제: 보통주만
const common = new Set();
let prefCount = 0;
if (fs.existsSync(MASTER)) {
  for (const r of JSON.parse(fs.readFileSync(MASTER, 'utf-8')).rows) {
    if (r.stkType === '보통주') common.add(r.code); else prefCount++;
  }
}

// 1패스: 일자·종목 인덱스 확보
const lines = fs.readFileSync(DAILY, 'utf-8').split('\n').filter(l => l.trim());
const recs = lines.map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d);
const N = days.length;
const codeIdx = new Map();
for (const r of recs) for (const s of r.s) if (!common.size || common.has(s[0])) if (!codeIdx.has(s[0])) codeIdx.set(s[0], codeIdx.size);
const M = codeIdx.size;

// 2패스: 타입배열 채우기 (Map 중첩은 3백만 엔트리에서 감당 안 됨)
const F = () => new Float64Array(N * M).fill(NaN);
const OP = F(), CL = F(), VO = F(), VA = F(), CAP = F();
for (let i = 0; i < N; i++) {
  for (const [c, o, h, l, cl, vol, val, cap] of recs[i].s) {
    const j = codeIdx.get(c); if (j === undefined) continue;
    const k = i * M + j;
    OP[k] = o; CL[k] = cl; VO[k] = vol; VA[k] = val; CAP[k] = cap;
  }
}
const cl = (j, i) => (i >= 0 && i < N ? CL[i * M + j] : NaN);
const op = (j, i) => (i >= 0 && i < N ? OP[i * M + j] : NaN);

console.log(`\n🕳️ 갭 축 정식 재판정 (KRX 데이터) — 매수 D+${BUY} 종가 → 매도 D+${SELL} 종가`);
console.log(`데이터: ${N}거래일 × ${M}종목 (${days[0]} ~ ${days[N - 1]})`);
console.log(`우선주 등 ${prefCount}종목 배제 | 시총 ${(CAPMIN / 1e8).toLocaleString()}억+ / 20일 평균 거래대금 ${(VALMIN / 1e8).toLocaleString()}억+`);

// ── 시장수익률(시총가중) + 레짐 ────────────────────────────────────────
const mkt = new Array(N).fill(null);
for (let i = 1; i < N; i++) {
  let num = 0, den = 0;
  for (let j = 0; j < M; j++) {
    const p = cl(j, i - 1), q = cl(j, i), w = CAP[(i - 1) * M + j];
    if (!(p > 0) || !(q > 0) || !(w > 0)) continue;
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
  let cum = 1; for (let i = 1; i < N; i++) if (mkt[i] != null) cum *= 1 + mkt[i] / 100;
  const cnt = { BULL: 0, BEAR: 0, FLAT: 0 };
  for (let i = 0; i < N; i++) { const r = regimeOf(i); if (r) cnt[r]++; }
  console.log(`시장(시총가중) 전 구간 ${((cum - 1) * 100).toFixed(1)}% | 레짐: 상승 ${cnt.BULL}일 / 하락 ${cnt.BEAR}일 / 횡보 ${cnt.FLAT}일\n`);
}

const fwd = (j, i) => { const b = cl(j, i + BUY), s = cl(j, i + SELL); return (b > 0 && s > 0) ? ((s - b) / b) * 100 : null; };

// ── 피처 (신호일 i 종가까지만; gapNext만 i+1 시가) ────────────────────
const feat = new Map();      // `${i}|${j}` -> {...}
const eligible = new Map();  // i -> [j]
for (let i = LOOK + 5; i < N; i++) {
  const list = [];
  for (let j = 0; j < M; j++) {
    const p = cl(j, i), cap = CAP[i * M + j];
    if (!(p > 0) || !(cap >= CAPMIN)) continue;
    const closes = [], vols = [];
    let ok = true, vsum = 0;
    for (let k = LOOK; k >= 0; k--) {
      const c2 = cl(j, i - k), v2 = VO[(i - k) * M + j], t2 = VA[(i - k) * M + j];
      if (!(c2 > 0)) { ok = false; break; }
      closes.push(c2); vols.push(v2 || 0); vsum += (t2 || 0);
    }
    if (!ok || !(vsum / (LOOK + 1) >= VALMIN)) continue;

    const avgV = avg(vols.slice(0, -1)) || 1;
    const volRatio = vols[vols.length - 1] / avgV;
    const v5 = avg(vols.slice(-5)), vPrior = avg(vols.slice(0, -5));
    const dry5 = vPrior > 0 ? v5 / vPrior : null;
    const ma20 = avg(closes);
    const disparity = (p / ma20) * 100;
    const hi20 = Math.max(...closes);
    const pbDepth = ((hi20 - p) / hi20) * 100;
    const ret5 = closes.length >= 6 ? ((p - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
    const nxOpen = op(j, i + 1);
    const gapNext = (nxOpen > 0) ? ((nxOpen - p) / p) * 100 : null;

    // 단기 추세추종 검정용 (--set=trend, 2026-08-25)
    const pPrev = closes[closes.length - 2];
    const ret1 = pPrev > 0 ? ((p - pPrev) / pPrev) * 100 : null;
    const mom20 = ((p - closes[0]) / closes[0]) * 100;
    const isHigh20 = p >= hi20 ? 1 : 0;   // 당일 종가가 20일 최고 = 신고가 돌파

    // RSI(14) — 과열 판정용 (현행: RSI>85 AND 이격도>120 이면 '과열')
    let gain = 0, loss = 0, cnt = 0;
    for (let k = closes.length - 14; k < closes.length; k++) {
      if (k <= 0) continue;
      const ch = closes[k] - closes[k - 1];
      if (ch >= 0) gain += ch; else loss -= ch;
      cnt++;
    }
    const rsi = cnt ? (loss === 0 ? 100 : 100 - 100 / (1 + (gain / cnt) / (loss / cnt))) : null;

    feat.set(`${i}|${j}`, { volRatio, dry5, disparity, pbDepth, ret5, gapNext, cap, ret1, mom20, isHigh20, rsi });
    list.push(j);
  }
  eligible.set(i, list);
}

// ── 매칭 기준: 동일일 × 시총5분위 ──────────────────────────────────────
const capQ = new Map(), qMean = new Map(), cap300 = new Map();
for (let i = 0; i < N; i++) {
  const rows = [];
  for (let j = 0; j < M; j++) { const c2 = CAP[i * M + j]; if (c2 > 0 && cl(j, i) > 0) rows.push([j, c2]); }
  rows.sort((a, b) => a[1] - b[1]);
  rows.forEach(([j], k) => capQ.set(`${i}|${j}`, Math.min(4, Math.floor((k / rows.length) * 5))));
  const b = [[], [], [], [], []];
  for (const [j] of rows) { const f = fwd(j, i); if (f != null) b[capQ.get(`${i}|${j}`)].push(f); }
  qMean.set(i, b.map(x => (x.length >= 20 ? avg(x) : null)));
  cap300.set(i, new Set(rows.slice(-300).map(x => x[0])));
}
const exCap = (j, i) => { const f = fwd(j, i); if (f == null) return null; const m = qMean.get(i)?.[capQ.get(`${i}|${j}`)]; return m == null ? null : f - m; };

// ── 베타 & 시장모형 알파 ───────────────────────────────────────────────
const betaOf = new Map();
for (let i = LOOK + 5; i < N; i++) {
  for (const j of eligible.get(i) || []) {
    const rets = [], mrets = [];
    let ok = true;
    for (let k = LOOK; k >= 1; k--) {
      const a = cl(j, i - k), b = cl(j, i - k + 1);
      if (!(a > 0) || !(b > 0)) { ok = false; break; }
      rets.push(((b - a) / a) * 100); mrets.push(mkt[i - k + 1] ?? 0);
    }
    if (!ok) continue;
    const mm = avg(mrets), rm = avg(rets);
    let cov = 0, varm = 0;
    for (let k = 0; k < rets.length; k++) { cov += (rets[k] - rm) * (mrets[k] - mm); varm += (mrets[k] - mm) ** 2; }
    if (varm > 0) betaOf.set(`${i}|${j}`, cov / varm);
  }
}
const alphaMM = (j, i) => { const f = fwd(j, i), mf = mktFwd(i), b = betaOf.get(`${i}|${j}`); return (f == null || mf == null || b == null) ? null : f - b * mf; };

// ── 신호 (오전 --set=gap과 **동일하게 사전 등록**된 것만) ──────────────
const dryOK = (f, t) => f.dry5 != null && f.dry5 <= t;
// ── 단기 추세추종 세트 (--set=trend, 2026-08-25). **사전 등록** — 늘리지 말 것. ──
// 묻는 것: "철학을 거래량 선행 → **시세 추종·단타**로 바꾸면 평가가 달라지는가."
// 지금까지 기각된 건 '거래량 폭발 + 가격 미반영'(선행 포착)이었고, 그 반대편인
// **이미 오르는 것을 따라 사는 것**은 정면으로 검정한 적이 없다(갭 추격은 특수 케이스).
// ⚠️ 비용: 이 지평(보유 1~4일)은 회전율 ≈100%라 왕복 0.38%를 매 거래 낸다.
//    초과중앙이 +0.38%를 넘지 못하면 신호가 '있어도' 돈은 못 번다. 표를 그 기준으로 읽을 것.
const TREND = [
  ['기준선: 유니버스 전체', () => true],
  ['[통제] 시총상위300 임의 20', (f, j, i) => {
    if (!cap300.get(i).has(j)) return false;
    let h = (i * 2654435761 + j * 40503) >>> 0;
    return (h % 100000) / 100000 > 1 - 20 / 300;
  }],
  ['── 단기 추세추종 (이미 오르는 것 사기) ──', null],
  ['전일 등락률 상위 10% (1일 모멘텀)', (f, j, i) => f.ret1 != null && f.ret1 >= 3],
  ['5일 수익률 ≥ +10%', f => f.ret5 >= 10],
  ['20일 수익률 ≥ +20%', f => f.mom20 >= 20],
  ['20일 신고가 돌파', f => f.isHigh20 === 1],
  ['★거래량급증(≥2) ∩ 당일 +3%↑ (추종형 현행철학)', f => f.volRatio >= 2 && f.ret1 >= 3],
  ['이격도 ≥ 110 (강세 추세)', f => f.disparity >= 110],
  ['── 역방향 대조 (눌림·반등 매수) ──', null],
  ['전일 등락률 ≤ −3% (하락 반등)', f => f.ret1 != null && f.ret1 <= -3],
  ['5일 수익률 ≤ −10%', f => f.ret5 <= -10],
  ['이격도 ≤ 90 (과매도)', f => f.disparity <= 90],
];

const CORE = [
  ['기준선: 유니버스 전체', () => true],
  ['[통제] 시총상위300 임의 20', (f, j, i) => {
    if (!cap300.get(i).has(j)) return false;
    let h = (i * 2654435761 + j * 40503) >>> 0;
    return (h % 100000) / 100000 > 1 - 20 / 300;
  }],
  ['── 눌림 단독 (갭 조건 없음) ──', null],
  ['눌림 엄격 (마름 & 5일↓ & 이격≤100)', f => dryOK(f, 0.8) && f.ret5 <= 0 && f.disparity <= 100],
  ['조용 완화 (거래량 마름만)', f => dryOK(f, 0.8)],
  ['고점근접 조용 (마름 & 고점-5% 내)', f => dryOK(f, 0.8) && f.pbDepth <= 5],
  ['── 갭상승 단독 ──', null],
  ['갭상승 ≥2% (i+1 시가)', f => f.gapNext >= 2],
  ['갭상승 ≥5%', f => f.gapNext >= 5],
  ['── ★교집합: 저거래량 눌림 + 갭상승 ──', null],
  ['★눌림 엄격 ∩ 갭≥2%', f => dryOK(f, 0.8) && f.ret5 <= 0 && f.disparity <= 100 && f.gapNext >= 2],
  ['★조용 완화 ∩ 갭≥2%', f => dryOK(f, 0.8) && f.gapNext >= 2],
  ['★조용 완화 ∩ 갭≥5%', f => dryOK(f, 0.8) && f.gapNext >= 5],
  ['★고점근접 조용 ∩ 갭≥2% (한미형)', f => dryOK(f, 0.8) && f.pbDepth <= 5 && f.gapNext >= 2],
  ['── 대조군 ──', null],
  ['고거래량(안 마름) ∩ 갭≥2%', f => f.dry5 != null && f.dry5 >= 1.5 && f.gapNext >= 2],
  ['조용 ∩ 갭하락 ≤−2% (역)', f => dryOK(f, 0.8) && f.gapNext <= -2],
];

// ── 선별 뼈대 검정 세트 (--set=select, 2026-08-25) ─────────────────────
// 배경: TOP3 귀속 분해에서 **선별 단계가 +2.29%p를 회복**하고 풀이 −1.96%p를 깎았다.
//   그 +2.29%p가 어느 부품에서 오는지 분해한다. 수급(기관/외인)은 62거래일만 존재해
//   소급 불가이므로, **수급을 뺀 뼈대**(과열 배제·이격도 컷·시총 플로어)만 1,133일로 검정한다.
//   → "선별이 작동하는가"라는 큰 질문은 블록 130으로 답하고, 수급의 증분만 나중에 62일로 본다.
const poolCache = new Map();
function poolAt(i) {
  if (poolCache.has(i)) return poolCache.get(i);
  const rows = [];
  for (const j of eligible.get(i) || []) {
    const f = feat.get(`${i}|${j}`);
    const c2 = cl(j, i), v = VO[i * M + j], t = VA[i * M + j], cap = CAP[i * M + j];
    if (!(c2 > 0)) continue;
    rows.push({ j, vol: v, val: t, surge: t >= 1e8 ? f.volRatio : null, turn: cap > 0 ? v / (cap / c2) : null, chg: f.ret1 });
  }
  const pick = k => rows.filter(r => r[k] != null && isFinite(r[k])).sort((a, b) => b[k] - a[k]).slice(0, 30).map(r => r.j);
  const u = new Set();
  for (const k of ['vol', 'val', 'surge', 'turn', 'chg']) for (const j of pick(k)) u.add(j);
  poolCache.set(i, u);
  return u;
}
const inPool = (j, i) => poolAt(i).has(j);
const notOverheated = f => !(f.rsi > 85 && f.disparity > 120);   // 현행 과열 판정
const SELECT = [
  ['기준선: 유니버스 전체', () => true],
  ['[통제] 시총상위300 임의 20', (f, j, i) => {
    if (!cap300.get(i).has(j)) return false;
    let h = (i * 2654435761 + j * 40503) >>> 0;
    return (h % 100000) / 100000 > 1 - 20 / 300;
  }],
  ['── 현행 풀 + 선별 부품 누적 ──', null],
  ['① 풀 전체 (선별 없음)', (f, j, i) => inPool(j, i)],
  ['② ① + 비과열 (RSI≤85 or 이격≤120)', (f, j, i) => inPool(j, i) && notOverheated(f)],
  ['③ ② + 이격도 < 130', (f, j, i) => inPool(j, i) && notOverheated(f) && f.disparity < 130],
  ['④ ③ + 시총 1조+', (f, j, i) => inPool(j, i) && notOverheated(f) && f.disparity < 130 && f.cap >= 1e12],
  ['⑤ ④ + 시총 5조+ (뼈대 완성)', (f, j, i) => inPool(j, i) && notOverheated(f) && f.disparity < 130 && f.cap >= 5e12],
  ['── 부품 단독 기여 (풀 위에 하나씩만) ──', null],
  ['풀 ∩ 비과열만', (f, j, i) => inPool(j, i) && notOverheated(f)],
  ['풀 ∩ 이격도<130만', (f, j, i) => inPool(j, i) && f.disparity < 130],
  ['풀 ∩ 시총 5조+만', (f, j, i) => inPool(j, i) && f.cap >= 5e12],
  ['── 참고: 풀 없이 시총 플로어만 ──', null],
  ['풀 무관 · 시총 5조+', f => f.cap >= 5e12],
];

const SET = (process.argv.find(x => x.startsWith('--set=')) || '').split('=')[1] || 'gap';
const STRATS = SET === 'trend' ? TREND : SET === 'select' ? SELECT : CORE;

const REG = ['BULL', 'BEAR', 'FLAT'];
const rows = [];
const half = Math.floor(N / 2);
for (const [name, fn] of STRATS) {
  if (fn == null) { rows.push({ sep: name }); continue; }
  const A = { all: [], mm: [], a: [], b: [] };
  for (const g of REG) A[g] = { cap: [], mm: [] };
  for (let i = LOOK + 5; i + SELL < N; i++) {
    const g = regimeOf(i);
    for (const j of eligible.get(i) || []) {
      const f = feat.get(`${i}|${j}`); if (!f || !fn(f, j, i)) continue;
      const e = exCap(j, i);
      if (e != null) { A.all.push(e); (i < half ? A.a : A.b).push(e); if (g) A[g].cap.push(e); }
      const am = alphaMM(j, i);
      if (am != null) { A.mm.push(am); if (g) A[g].mm.push(am); }
    }
  }
  if (A.all.length < 30) continue;
  rows.push({
    name, n: A.all.length, cap: med(A.all), capMean: avg(A.all), mm: med(A.mm), win: winR(A.all),
    a: avg(A.a), b: avg(A.b),
    reg: Object.fromEntries(REG.map(g => [g, { cap: med(A[g].cap), mm: med(A[g].mm), n: A[g].cap.length }])),
  });
}

console.log('  신호                                  |      n  | 초과중앙 | 초과평균 | 시장모형α | 승률 | 전반→후반');
console.log('  ' + '-'.repeat(108));
for (const r of rows) {
  if (r.sep) { console.log('  ' + r.sep); continue; }
  console.log(`  ${r.name.padEnd(35)} | ${String(r.n).padStart(7)} | ${sgn(r.cap)} | ${sgn(r.capMean)} | ${sgn(r.mm)} | ${r.win.toFixed(0).padStart(3)}% | ${sgn(r.a)}→${sgn(r.b)}${Math.sign(r.a) === Math.sign(r.b) ? '' : ' ⚠️'}`);
}

console.log('\n  ★ 레짐별 매칭 초과수익 중앙값');
console.log('  ' + '-'.repeat(108));
for (const r of rows) {
  if (r.sep) { console.log('  ' + r.sep); continue; }
  const f = g => `${sgn(r.reg[g].cap)} (${String(r.reg[g].n).padStart(6)})`;
  console.log(`  ${r.name.padEnd(35)} | 상승 ${f('BULL')} | 하락 ${f('BEAR')} | 횡보 ${f('FLAT')}`);
}

const signalDays = N - LOOK - 5 - SELL - 60;
console.log(`\n독립블록 ≈ ${(signalDays / (SELL - BUY)).toFixed(1)} (신호일 ${signalDays}일 / 보유 ${SELL - BUY}일). 3 미만이면 판정 금지.`);
console.log('  · 오전(62거래일) 판정과 같은 사전 등록 신호. 표본·시총실측·상폐포함·우선주배제만 달라졌다.\n');
