/**
 * portfolio-sim.js — 절대 누적수익 위생 검사 (2026-08-24)
 *
 * 왜: 지평 스캔에서 결합(저σ+저PBR) 순α가 D+120 +7.92%, 통제 −7.90%로 **15.8%p** 격차가
 *   나왔다. 이 크기는 정상적인 팩터 프리미엄이 아니다. 의심되는 원인은 시장모형α의 기준이
 *   **시총가중** 시장인데 표본이 메가캡 주도장(전 구간 +125%)이라, 동일가중 대형주 바스켓이면
 *   무엇이든 α가 크게 음수로 나온다는 것(통제 자체가 −7.67%).
 *
 * 그래서 파생 지표(매칭초과·시장모형α)를 **전부 걷어내고** 실제 포트폴리오를 굴린다.
 *   매 리밸런싱일에 상위 K종목 등가중 매수 → 다음 리밸런싱까지 보유 → 비용 차감 → 복리.
 *   벤치마크도 같은 규칙으로 굴린 **시총가중 시장**과 **동일가중 cap300** 둘 다 놓는다.
 *   동일가중 벤치마크가 핵심이다 — 전략도 동일가중이므로 이게 진짜 비교 대상이다.
 *
 * 규약: 전방참조 없음(신호일 i 종가까지만), 매수 D+BUY 종가, 다음 리밸런싱 D+BUY 종가에 교체.
 *   비용은 회전율 × 왕복비용으로 기간수익에서 차감.
 *
 * ⚠️ 생존편향(상폐 종목 부재)은 이 시뮬에서 **모든 전략과 벤치마크에 동일하게** 작용하지만,
 *   고위험 종목을 많이 담는 쪽(통제·거래량)이 더 큰 혜택을 받는다 = 전략에 보수적.
 *
 * 실행: node --max-old-space-size=8192 scripts/portfolio-sim.js [--hold=60] [--k=20] [--buyoffset=2]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const argS = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const HOLD = arg('hold', 60);
const K = arg('k', 20);
const BUY = arg('buyoffset', 2);
const LOOK = arg('look', 20);
const FROM = argS('from', '20240101');
const TO = argS('to', '99999999');   // 기간 분할 검정용 (밸류업 전/후 등)
const CAPMIN = arg('capmin', 3000) * 1e8;
const VALMIN = arg('valmin', 10) * 1e8;
// 비중 배분 (2026-08-24 A-1): 오늘의 모든 검정이 등가중이었고, 유일하게 이긴 벤치마크가
//   시총가중이었다 → 패배 원인이 신호가 아니라 배분일 가능성을 배제해야 한다.
//   eq: 등가중 / cap: 픽 내 시총가중 / sqrtcap: √시총 틸트(둘의 절충, 집중도 완화)
const WEIGHT = argS('weight', 'eq');
const FEE = arg('fee', 0.015), TAX = arg('tax', 0.15), SLIP = arg('slip', 0.10);
const ROUND = (FEE + SLIP) + (FEE + SLIP + TAX);
const FIN_LAG_ANNUAL = 90, FIN_LAG_QUARTER = 45;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pct = v => (v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(8));

// ── 데이터 ─────────────────────────────────────────────────────────────
// --src=krx (2026-08-24): KRX 일별매매정보. 기존 price-history 대비 세 가지가 고쳐진다 —
//   ①시가총액이 실측(근사 아님) ②그날 시점 스냅샷이라 **상폐 종목 포함**(생존편향 완화)
//   ③krx-master.json으로 **우선주 배제**. 결론을 바꿀 수 있는 차이라 반드시 같은 기간으로도
//   돌려 "데이터 품질 효과"와 "기간 효과"를 분리할 것.
const SRC = argS('src', 'hist');
// 업종 제외 필터 (--exsec=은행,보험,증권). 저PBR이 가치 팩터인지 업종 베팅인지 가르는 결정적 검정.
const EXSEC = argS('exsec', '').split(',').filter(Boolean);
const SECMAP = (() => { const f = path.resolve(__dirname, '../data/sector-map.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}; })();
const secOf = c => SECMAP[c] || '(미상)';
const secExcluded = c => EXSEC.some(k => secOf(c).includes(k));
let days, codes, at, capOf, valAt;

if (SRC === 'krx') {
  const DAILY = path.resolve(__dirname, '../data/krx-daily.jsonl');
  if (!fs.existsSync(DAILY)) { console.error('❌ data/krx-daily.jsonl 없음 → collect-krx-daily.js 먼저'); process.exit(1); }
  const MASTER = path.resolve(__dirname, '../data/krx-master.json');
  const common = new Set();
  if (fs.existsSync(MASTER)) for (const r of JSON.parse(fs.readFileSync(MASTER, 'utf-8')).rows) if (r.stkType === '보통주') common.add(r.code);

  const recs = fs.readFileSync(DAILY, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l)).filter(r => r.d >= FROM && r.d <= TO).sort((a, b) => (a.d < b.d ? -1 : 1));
  days = recs.map(r => r.d);
  const N = days.length, idx = new Map();
  for (const r of recs) for (const s of r.s) if ((!common.size || common.has(s[0])) && !idx.has(s[0])) idx.set(s[0], idx.size);
  const M = idx.size;
  codes = [...idx.keys()];
  const CL = new Float64Array(N * M).fill(NaN), VA = new Float64Array(N * M).fill(NaN), CP = new Float64Array(N * M).fill(NaN);
  for (let i = 0; i < N; i++) for (const [c, , , , cl2, , va, cap] of recs[i].s) {
    const j = idx.get(c); if (j === undefined) continue;
    CL[i * M + j] = cl2; VA[i * M + j] = va; CP[i * M + j] = cap;
  }
  const g = (A, c, i) => { const j = idx.get(c); if (j === undefined || i < 0 || i >= N) return null; const v = A[i * M + j]; return Number.isNaN(v) ? null : v; };
  at = (c, i) => g(CL, c, i);
  capOf = (c, i) => g(CP, c, i);
  valAt = (c, i) => g(VA, c, i);
} else {
  const HIST = path.resolve(__dirname, '../data/price-history.jsonl');
  if (!fs.existsSync(HIST)) { console.error('❌ data/price-history.jsonl 없음'); process.exit(1); }
  const close = new Map(), val = new Map(), shares = new Map();
  const dateSet = new Set();
  for (const line of fs.readFileSync(HIST, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (!rec.r?.length) continue;
    const c = new Map(), t = new Map();
    for (const [d, cl2, , va] of rec.r) { if (d < FROM || d > TO || !cl2) continue; c.set(d, cl2); t.set(d, va || 0); dateSet.add(d); }
    if (!c.size) continue;
    close.set(rec.c, c); val.set(rec.c, t); shares.set(rec.c, rec.s || null);
  }
  days = [...dateSet].sort();
  codes = [...close.keys()];
  at = (c, i) => (i >= 0 && i < days.length ? close.get(c)?.get(days[i]) : null);
  capOf = (c, i) => { const s = shares.get(c), p = at(c, i); return (s && p) ? s * p : null; };
  valAt = (c, i) => (i >= 0 && i < days.length ? val.get(c)?.get(days[i]) : null);
}

const WLABEL = WEIGHT === 'cap' ? '시총가중' : WEIGHT === 'sqrtcap' ? '√시총틸트' : '등가중';
console.log(`\n💼 절대 누적수익 시뮬 — ${WLABEL} ${K}종목, ${HOLD}거래일마다 리밸런싱 (매수 D+${BUY} 종가)`);
console.log(`데이터: ${days.length}거래일 × ${codes.length}종목 (${days[0]} ~ ${days[days.length - 1]}) | 출처 ${SRC === 'krx' ? 'KRX(실측시총·상폐포함·우선주배제)' : 'KIS price-history'}`);
console.log(`비용 가정: 편도수수료 ${FEE}% / 매도세 ${TAX}% / 편도슬리피지 ${SLIP}% → 신규편입 왕복 ${ROUND.toFixed(3)}%`);

// ── 재무 point-in-time ─────────────────────────────────────────────────
const FIN = path.resolve(__dirname, '../data/financials.json');
const finByCode = new Map();
if (fs.existsSync(FIN)) {
  for (const r of JSON.parse(fs.readFileSync(FIN, 'utf-8')).rows) {
    const y = +r.ym.slice(0, 4), m = +r.ym.slice(4, 6);
    const end = new Date(Date.UTC(y, m, 0));
    const avail = new Date(end.getTime() + (m === 12 ? FIN_LAG_ANNUAL : FIN_LAG_QUARTER) * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
    if (!finByCode.has(r.code)) finByCode.set(r.code, []);
    finByCode.get(r.code).push({ avail, bps: r.bps });
  }
  for (const a of finByCode.values()) a.sort((x, y) => x.avail.localeCompare(y.avail));
}
const bpsAt = (c, d) => {
  const a = finByCode.get(c); if (!a) return null;
  let lo = 0, hi = a.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].avail <= d) { best = a[m]; lo = m + 1; } else hi = m - 1; }
  return best ? best.bps : null;
};

// ── 리밸런싱일마다 후보·지표 계산 ──────────────────────────────────────
const rebal = [];
for (let i = LOOK + 5; i + BUY + HOLD + BUY < days.length; i += HOLD) rebal.push(i);
console.log(`리밸런싱 ${rebal.length}회 (${days[rebal[0]]} ~ ${days[rebal[rebal.length - 1]]})\n`);

const cand = new Map();   // i -> [{c, vol20, pbr, cap, volRatio}]
for (const i of rebal) {
  const rows = [];
  for (const c of codes) {
    const p = at(c, i); if (!p) continue;
    const cap = capOf(c, i); if (!cap || cap < CAPMIN) continue;
    const rets = []; let ok = true, vsum = 0, n = 0;
    for (let k = LOOK; k >= 1; k--) {
      const a = at(c, i - k), b = at(c, i - k + 1);
      if (!a || !b) { ok = false; break; }
      rets.push(((b - a) / a) * 100);
      const vv = valAt(c, i - k); if (vv) { vsum += vv; n++; }
    }
    if (!ok || n < LOOK - 2 || !(vsum / n >= VALMIN)) continue;
    if (EXSEC.length && secExcluded(c)) continue;
    const bps = bpsAt(c, days[i]);
    rows.push({ c, cap, vol20: sd(rets), pbr: bps > 0 ? p / bps : null, val20: vsum / n });
  }
  rows.sort((a, b) => b.cap - a.cap);
  const top300 = rows.slice(0, 300);
  // 당일 백분위 (1 = 가장 저변동성 / 가장 저PBR)
  const wv = top300.filter(r => r.vol20 != null).sort((a, b) => a.vol20 - b.vol20);
  wv.forEach((r, k) => { r.pv = wv.length > 1 ? 1 - k / (wv.length - 1) : 1; });
  const wp = top300.filter(r => r.pbr > 0).sort((a, b) => a.pbr - b.pbr);
  wp.forEach((r, k) => { r.pp = wp.length > 1 ? 1 - k / (wp.length - 1) : 1; });
  cand.set(i, { top300, all: rows });
}

// ── 전략 정의: (i) → 상위 K 종목코드 배열 ──────────────────────────────
const pickTop = (rows, scoreFn) => rows
  .map(r => [r.c, scoreFn(r)])
  .filter(x => x[1] != null && isFinite(x[1]))
  .sort((a, b) => b[1] - a[1])
  .slice(0, K).map(x => x[0]);

const STRATS = [
  ['★결합 (저σ+저PBR) ∩ cap300', i => pickTop(cand.get(i).top300, r => (r.pv != null && r.pp != null) ? r.pv + r.pp : null)],
  ['저PBR ∩ cap300', i => pickTop(cand.get(i).top300, r => r.pbr > 0 ? -r.pbr : null)],
  ['저변동성 ∩ cap300', i => pickTop(cand.get(i).top300, r => r.vol20 != null ? -r.vol20 : null)],
  ['[통제] cap300 임의 20 (해시)', i => pickTop(cand.get(i).top300, r => {
    let h = i * 2654435761 + 12345;
    for (let k = 0; k < r.c.length; k++) h = (h * 31 + r.c.charCodeAt(k)) >>> 0;
    return (h % 1000003) / 1000003;
  })],
  ['[현행 근사] 거래대금 상위 20 (전 유니버스)', i => pickTop(cand.get(i).all, r => r.val20)],
];

// ── PBR 5분위 단조성 (--quintile, 2026-08-25) ──────────────────────────
// 왜: 상위 20종목 성과는 소수 종목 운일 수 있다(상위10이 슬롯의 45%, 4종목은 109회 전부 편입).
//   횡단면 팩터가 진짜면 **cap300 전체를 PBR로 5등분했을 때 수익이 단조**여야 한다.
//   Q1(저PBR) > Q2 > … > Q5(고PBR)가 나오면 소수 종목이 아니라 축 자체가 작동하는 것이다.
//   각 분위는 그날 cap300 중 PBR이 있는 종목을 5등분한 **전체**(≈50~60종목)를 등가중으로 담는다.
if (process.argv.includes('--quintile')) {
  STRATS.length = 0;
  for (let q = 0; q < 5; q++) {
    STRATS.push([`PBR 5분위 Q${q + 1}${q === 0 ? ' (최저PBR)' : q === 4 ? ' (최고PBR)' : ''}`, i => {
      const rows = cand.get(i).top300.filter(r => r.pbr > 0).sort((a, b) => a.pbr - b.pbr);
      const n = rows.length, lo = Math.floor(n * q / 5), hi = Math.floor(n * (q + 1) / 5);
      return rows.slice(lo, hi).map(r => r.c);
    }]);
  }
}

// ── 특정 종목 제외 (--exclude-codes=005930,000660) ─────────────────────
// 집중도 검정용: 109회 전부 편입된 종목들을 빼도 결과가 남는지.
{
  const ex = new Set(argS('exclude-codes', '').split(',').filter(Boolean));
  if (ex.size) {
    for (const s of STRATS) { const f = s[1]; s[1] = i => f(i).filter(c => !ex.has(c)); }
    console.log(`제외 종목 ${ex.size}개: ${[...ex].join(', ')}`);
  }
}

// ── 시뮬레이션 ─────────────────────────────────────────────────────────
const run = (name, pickFn) => {
  let nav = 1, prev = new Map();   // code -> 직전 기간 비중
  const periodRets = [], navPath = [1], effNs = [];
  for (let k = 0; k < rebal.length - 1; k++) {
    const i = rebal[k], j = rebal[k + 1];
    const picks = pickFn(i);
    if (!picks.length) { navPath.push(nav); continue; }
    // 비중 산출: 매수 가능한 종목만 대상으로 정규화
    const capOfPick = new Map();
    const usable = [];
    for (const c of picks) {
      const bp = at(c, i + BUY), sp = at(c, j + BUY);
      if (!bp || !sp) continue;
      usable.push([c, ((sp - bp) / bp) * 100]);
      capOfPick.set(c, capOf(c, i) || 0);
    }
    if (!usable.length) { navPath.push(nav); continue; }
    const rawW = usable.map(([c]) => WEIGHT === 'cap' ? (capOfPick.get(c) || 0)
      : WEIGHT === 'sqrtcap' ? Math.sqrt(capOfPick.get(c) || 0) : 1);
    const wsum = rawW.reduce((s, v) => s + v, 0) || 1;
    const cur = new Map();
    let gross = 0;
    usable.forEach(([c, ret], idx) => { const w = rawW[idx] / wsum; cur.set(c, w); gross += ret * w; });
    // 회전율: 비중 변화 기준 Σ|Δw|/2. (기간 중 비중 드리프트는 무시 — 비용 과소추정 방향)
    let dw = 0;
    for (const [c, w] of cur) dw += Math.abs(w - (prev.get(c) || 0));
    for (const [c, w] of prev) if (!cur.has(c)) dw += w;
    const turn = prev.size ? dw / 2 : 1;
    const net = gross - turn * ROUND;
    nav *= 1 + net / 100;
    let hhi=0; for (const w of cur.values()) hhi += w*w;
    effNs.push(hhi>0 ? 1/hhi : null);
    periodRets.push(net); navPath.push(nav); prev = cur;
  }
  let peak = 0, mdd = 0;
  for (const v of navPath) { if (v > peak) peak = v; const dd = (v / peak - 1) * 100; if (dd < mdd) mdd = dd; }
  const years = (rebal.length - 1) * HOLD / 252;
  return {
    name, total: (nav - 1) * 100, cagr: (Math.pow(nav, 1 / years) - 1) * 100,
    mdd, effN: avg(effNs.filter(v=>v!=null)), win: periodRets.filter(v => v > 0).length / periodRets.length * 100,
    med: periodRets.slice().sort((a, b) => a - b)[periodRets.length >> 1], n: periodRets.length,
  };
};

// 벤치마크: 시총가중 시장 / 동일가중 cap300 / 동일가중 전 유니버스
const bench = (name, mode) => {
  let nav = 1;
  const navPath = [1], periodRets = [];
  for (let k = 0; k < rebal.length - 1; k++) {
    const i = rebal[k], j = rebal[k + 1];
    const rows = mode === 'cap300' ? cand.get(i).top300 : cand.get(i).all;
    let num = 0, den = 0, rs = [];
    for (const r of rows) {
      const bp = at(r.c, i + BUY), sp = at(r.c, j + BUY);
      if (!bp || !sp) continue;
      const ret = ((sp - bp) / bp) * 100;
      rs.push(ret);
      const w = r.cap; num += ret * w; den += w;
    }
    if (!rs.length) { navPath.push(nav); continue; }
    const ret = mode === 'capw' ? num / den : avg(rs);
    nav *= 1 + ret / 100; periodRets.push(ret); navPath.push(nav);
  }
  let peak = 0, mdd = 0;
  for (const v of navPath) { if (v > peak) peak = v; const dd = (v / peak - 1) * 100; if (dd < mdd) mdd = dd; }
  const years = (rebal.length - 1) * HOLD / 252;
  return { name, total: (nav - 1) * 100, cagr: (Math.pow(nav, 1 / years) - 1) * 100, mdd,
    win: periodRets.filter(v => v > 0).length / periodRets.length * 100,
    med: periodRets.slice().sort((a, b) => a - b)[periodRets.length >> 1], n: periodRets.length };
};

// ── NAV 경로 내보내기 (--emit-nav=파일, 2026-08-25) ────────────────────
// ETF와 같은 격자(리밸런싱 매수일)에서 비교하기 위해 전략의 NAV를 날짜와 함께 남긴다.
{
  const EMIT = argS('emit-nav', '');
  if (EMIT) {
    const target = argS('emit-strat', '저PBR ∩');
    const hit = STRATS.find(([n]) => n.includes(target));
    if (hit) {
      const [, fn] = hit;
      let nav = 1, prev = new Map();
      const path2 = [{ d: days[rebal[0] + BUY], nav: 1 }];
      for (let k = 0; k < rebal.length - 1; k++) {
        const i = rebal[k], j = rebal[k + 1];
        const usable = [], capw = new Map();
        for (const c of fn(i)) {
          const bp = at(c, i + BUY), sp = at(c, j + BUY);
          if (bp && sp) { usable.push([c, ((sp - bp) / bp) * 100]); capw.set(c, capOf(c, i) || 0); }
        }
        if (!usable.length) { path2.push({ d: days[j + BUY], nav }); continue; }
        const rw = usable.map(([c]) => WEIGHT === 'cap' ? (capw.get(c) || 0) : WEIGHT === 'sqrtcap' ? Math.sqrt(capw.get(c) || 0) : 1);
        const ws = rw.reduce((s, v) => s + v, 0) || 1;
        const cur = new Map();
        let gross = 0;
        usable.forEach(([c, r], x) => { const w = rw[x] / ws; cur.set(c, w); gross += r * w; });
        let dw = 0;
        for (const [c, w] of cur) dw += Math.abs(w - (prev.get(c) || 0));
        for (const [c, w] of prev) if (!cur.has(c)) dw += w;
        nav *= 1 + (gross - (prev.size ? dw / 2 : 1) * ROUND) / 100;
        prev = cur;
        path2.push({ d: days[j + BUY], nav });
      }
      fs.writeFileSync(EMIT, JSON.stringify(path2));
      console.log(`\n💾 NAV 경로 저장: ${EMIT} (${path2.length}점, "${hit[0]}")`);
    }
  }
}

const out = [
  bench('[벤치] 시총가중 전 유니버스', 'capw'),
  bench('[벤치] 동일가중 전 유니버스', 'eq'),
  bench('[벤치] 동일가중 cap300', 'cap300'),
  ...STRATS.map(([n, f]) => run(n, f)),
];

console.log('  전략 / 벤치마크                          | 누적수익 |  CAGR  |  MDD   | 유효종목 | 기간승률 | 기간중앙');
console.log('  ' + '-'.repeat(104));
for (const r of out) {
  console.log(`  ${r.name.padEnd(38)} | ${pct(r.total)} | ${pct(r.cagr)} | ${pct(r.mdd)} | ${(r.effN==null?"  -":r.effN.toFixed(1)).padStart(7)} | ${(r.win).toFixed(0).padStart(6)}% | ${pct(r.med)}`);
}
console.log('\n  · 전략은 비용 차감 후(net), 벤치마크는 비용 미차감(= 전략에 불리한 보수적 비교).');
console.log('  · **동일가중 벤치마크가 진짜 비교 대상이다** — 전략도 등가중이므로 시총가중과의 차이는 실력이 아니다.');
console.log(`  · 기간 = ${HOLD}거래일. MDD는 리밸런싱 시점 NAV 기준이라 장중 낙폭보다 작게 나온다.\n`);

// ── 픽 구성 덤프 (--dump=저PBR 등, 2026-08-24) ─────────────────────────
// 왜: 저PBR ∩ cap300이 4.6년 +213%로 나왔는데, 이게 "가치 팩터"인지 "특정 업종 베팅"인지
//   가리려면 실제로 무엇을 담았는지 봐야 한다. 종목 빈도부터 확인하고, 업종은 별도 수집.
{
  const DUMP = argS('dump', '');
  if (DUMP) {
    const hit = STRATS.find(([n]) => n.includes(DUMP));
    if (!hit) { console.log(`\n⚠️ --dump=${DUMP} 에 해당하는 전략 없음`); }
    else {
      const [name, fn] = hit;
      const cnt = new Map();
      let slots = 0;
      for (let k = 0; k < rebal.length - 1; k++) {
        for (const c of fn(rebal[k])) { cnt.set(c, (cnt.get(c) || 0) + 1); slots++; }
      }
      const master = (() => {
        const p = path.resolve(__dirname, '../data/krx-master.json');
        if (!fs.existsSync(p)) return new Map();
        return new Map(JSON.parse(fs.readFileSync(p, 'utf-8')).rows.map(r => [r.code, r.name]));
      })();
      const sorted = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`\n📋 "${name}" 픽 구성 — 고유 ${sorted.length}종목 / 총 ${slots}슬롯 (${rebal.length - 1}회 리밸런싱 × ${K})`);
      console.log('  종목                       회수   비중');
      for (const [c, v] of sorted.slice(0, 25)) {
        console.log(`  ${c} ${String(master.get(c) || '').padEnd(14)} ${String(v).padStart(4)}회 ${(v / slots * 100).toFixed(1).padStart(5)}%`);
      }
      const top10 = sorted.slice(0, 10).reduce((s, x) => s + x[1], 0);
      console.log(`  ── 상위 10종목이 전체 슬롯의 ${(top10 / slots * 100).toFixed(0)}% 차지`);

      // 업종 집계: "가치 팩터인가, 업종 베팅인가"의 1차 판별
      const bySec = new Map();
      for (const [c, v] of sorted) bySec.set(secOf(c), (bySec.get(secOf(c)) || 0) + v);
      const secs = [...bySec.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`\n  📊 업종별 슬롯 비중 (${secs.length}개 업종)`);
      for (const [nm, v] of secs.slice(0, 15)) {
        console.log(`  ${nm.padEnd(16)} ${(v / slots * 100).toFixed(1).padStart(5)}%  (${v}슬롯)`);
      }
      const fin = secs.filter(([nm]) => /은행|보험|증권|금융/.test(nm)).reduce((s2, x) => s2 + x[1], 0);
      console.log(`  ── 금융 계열(은행·보험·증권·기타금융) 합계 ${(fin / slots * 100).toFixed(1)}%`);
    }
  }
}
