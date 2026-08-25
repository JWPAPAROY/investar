/**
 * lowvol-attribution.js — 저변동성 우위는 알파인가, 하락장 베타인가 (2026-08-20)
 *
 * 배경: direction-signal-battery에서 저변동성∩시총상위300이 유일 생존 후보(D+10 +1.69%,
 *   승률 59%). 그런데 전 표본이 단일 하락 레짐(시총가중 −16.76%, 7월 −22.3%)이다.
 *   하락장에서 저베타 종목이 덜 빠지는 건 알파가 아니라 **정의상 당연한 일**이다.
 *   기존 매칭(동일일 × 동일 시총5분위)은 사이즈만 통제하고 베타를 통제하지 않는다.
 *
 * 네 갈래로 가른다:
 *   ① 베타 매칭   — 동일일 × 시총5분위 × **베타5분위** 대비 초과. 베타 때문이면 여기서 소멸.
 *   ② 시장모형 알파 — 보유구간 수익 − β×시장수익. 베타 노출을 직접 차감.
 *   ③ 레짐 분리   — 보유구간 시장이 오른 경우 / 내린 경우로 분리. 베타면 부호가 뒤집힌다.
 *   ④ β vs 잔차σ  — 저베타로 뽑을 때와 저잔차변동성으로 뽑을 때를 분리. 베타 베팅인지 확인.
 *
 * 규약: direction-signal-battery.js와 통일 (매일 상위K 매수, D+1 매수 → D+SELL 매도,
 *   전방참조 없음, 유동성 하한, 전·후반 부호 유지 병기, 독립블록<3이면 판정 거부).
 *
 * 실행: node scripts/lowvol-attribution.js [--sell=2|10] [--k=20]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10);
const K = arg('k', 20);
// 매수일 오프셋(신호일 = D+0). active_policy를 따를 것 — 2026-08-23부터 D+2 매수 → D+10 매도.
const BUY = arg('buyoffset', 1);
if (!(BUY >= 1 && BUY < SELL)) { console.error(`❌ --buyoffset(${BUY})은 1 이상이고 --sell(${SELL})보다 작아야 함`); process.exit(1); }
const LOOK = arg('look', 20);
const CAPMIN = arg('capmin', 3000) * 1e8;
const VALMIN = arg('valmin', 10) * 1e8;
const MIN_UNIVERSE = 2000;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sgn = v => (v == null ? '     -' : ((v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) + '%').padStart(8));

async function fetchAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

(async () => {
  console.log(`\n🔬 저변동성 귀인 분석 — 매일 상위 ${K}종목, D+${BUY} 매수 → D+${SELL} 매도\n`);
  const flow = await fetchAll('market_flow_daily', 'stock_code,trade_date,close,volume,market_cap');

  const byDate = new Map();
  for (const r of flow) { if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []); byDate.get(r.trade_date).push(r); }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();
  for (const r of flow) {
    if (!dayIdx.has(r.trade_date)) continue;
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, r);
  }
  const at = (c, i) => (i >= 0 && i < days.length ? px.get(c)?.get(days[i]) : null);
  const fwd = (c, i) => { const b = at(c, i + BUY), s = at(c, i + SELL); return (b?.close && s?.close) ? ((s.close - b.close) / b.close) * 100 : null; };

  // ── 시장수익률(시총가중, 전일 시총 가중) ────────────────────────────
  const mkt = new Array(days.length).fill(null);
  for (let i = 1; i < days.length; i++) {
    let num = 0, den = 0;
    for (const r of byDate.get(days[i])) {
      const p = at(r.stock_code, i - 1);
      if (!p?.close || !r.close || !p.market_cap) continue;
      num += ((r.close - p.close) / p.close) * p.market_cap; den += p.market_cap;
    }
    mkt[i] = den ? (num / den) * 100 : null;
  }
  // 보유구간(i+1 매수 → i+SELL 매도) 시장 누적수익
  const mktFwd = (i) => {
    let acc = 1, ok = false;
    for (let k = i + BUY + 1; k <= i + SELL; k++) { if (mkt[k] == null) return null; acc *= 1 + mkt[k] / 100; ok = true; }
    return ok ? (acc - 1) * 100 : null;
  };
  const cum = days.reduce((a, _, i) => (i && mkt[i] != null ? a * (1 + mkt[i] / 100) : a), 1);
  console.log(`데이터: ${days.length}거래일 × ${px.size}종목 (${days[0]} ~ ${days[days.length - 1]})`);
  console.log(`시장(시총가중) 누적 ${((cum - 1) * 100).toFixed(2)}% — 단일 하락 레짐\n`);

  // ── 종목별 지표: 총변동성 σ, 베타 β, 잔차변동성 idioσ (신호일 i까지 20일) ──
  const feat = new Map(), eligible = new Map();
  for (let i = LOOK + 5; i < days.length; i++) {
    const list = [];
    for (const r of byDate.get(days[i])) {
      const c = r.stock_code;
      if (!r.close || !r.market_cap || r.market_cap < CAPMIN) continue;
      const closes = [], vols = [];
      let ok = true;
      for (let k = LOOK; k >= 0; k--) { const p = at(c, i - k); if (!p?.close) { ok = false; break; } closes.push(p.close); vols.push(p.volume ?? 0); }
      if (!ok) continue;
      const val20 = avg(closes.map((cl, k) => cl * vols[k]));
      if (!(val20 >= VALMIN)) continue;

      const rets = [], mrets = [];
      for (let k = 1; k < closes.length; k++) {
        rets.push(((closes[k] - closes[k - 1]) / closes[k - 1]) * 100);
        mrets.push(mkt[i - LOOK + k] ?? 0);
      }
      const mm = avg(mrets), rm = avg(rets);
      let cov = 0, varm = 0;
      for (let k = 0; k < rets.length; k++) { cov += (rets[k] - rm) * (mrets[k] - mm); varm += (mrets[k] - mm) ** 2; }
      const beta = varm > 0 ? cov / varm : null;
      const resid = beta == null ? null : rets.map((v, k) => v - (rm - beta * mm) - beta * mrets[k]);
      // 2026-08-24: --set=gap의 유일 생존 후보 '고점근접 조용'을 같은 귀인에 태우기 위한 피처.
      // dry5 = 직전 5일 평균거래량 / 그 앞 15일 평균, pbDepth = 20일 종가고점 대비 하락폭(%).
      const dry5 = (avg(vols.slice(0, -5)) > 0) ? avg(vols.slice(-5)) / avg(vols.slice(0, -5)) : null;
      const hi20 = Math.max(...closes);
      const pbDepth = hi20 > 0 ? ((r.close - hi20) / hi20) * -100 : null;

      feat.set(`${i}|${c}`, { vol20: sd(rets), beta, idio: resid ? sd(resid) : null, cap: r.market_cap, dry5, pbDepth });
      list.push(c);
    }
    eligible.set(i, list);
  }

  // ── 매칭 기준: 시총5분위 / 시총5분위×베타5분위 ────────────────────
  const capQ = new Map(), betaQ = new Map(), qMean = new Map(), qbMean = new Map();
  for (let i = 0; i < days.length; i++) {
    const rows = byDate.get(days[i]).filter(r => r.market_cap && r.close);
    const sorted = [...rows].sort((a, b) => a.market_cap - b.market_cap);
    sorted.forEach((r, k) => capQ.set(`${i}|${r.stock_code}`, Math.min(4, Math.floor((k / sorted.length) * 5))));
    const buckets = [[], [], [], [], []];
    for (const r of sorted) { const f = fwd(r.stock_code, i); if (f != null) buckets[capQ.get(`${i}|${r.stock_code}`)].push(f); }
    qMean.set(i, buckets.map(b => (b.length >= 20 ? avg(b) : null)));

    // 베타는 유동성 통과 종목만 계산돼 있음 → 그 집합 안에서 5분위
    const withB = (eligible.get(i) || []).map(c => [c, feat.get(`${i}|${c}`)?.beta]).filter(x => x[1] != null);
    withB.sort((a, b) => a[1] - b[1]);
    withB.forEach(([c], k) => betaQ.set(`${i}|${c}`, Math.min(4, Math.floor((k / withB.length) * 5))));
    const bb = {};
    for (const [c] of withB) {
      const f = fwd(c, i); if (f == null) continue;
      const key = `${capQ.get(`${i}|${c}`)}|${betaQ.get(`${i}|${c}`)}`;
      (bb[key] = bb[key] || []).push(f);
    }
    const m = {}; for (const k in bb) if (bb[k].length >= 10) m[k] = avg(bb[k]);
    qbMean.set(i, m);
  }
  const exCap = (c, i) => { const f = fwd(c, i); if (f == null) return null; const q = capQ.get(`${i}|${c}`); const m = qMean.get(i)?.[q]; return m == null ? null : f - m; };
  const exCapBeta = (c, i) => {
    const f = fwd(c, i); if (f == null) return null;
    const m = qbMean.get(i)?.[`${capQ.get(`${i}|${c}`)}|${betaQ.get(`${i}|${c}`)}`];
    return m == null ? null : f - m;
  };
  const alphaMM = (c, i) => { // 시장모형 알파: 수익 − β×시장수익
    const f = fwd(c, i), mf = mktFwd(i), b = feat.get(`${i}|${c}`)?.beta;
    return (f == null || mf == null || b == null) ? null : f - b * mf;
  };

  const cap300 = new Map();
  for (let i = 0; i < days.length; i++) cap300.set(i, new Set(byDate.get(days[i]).filter(r => r.market_cap).sort((a, b) => b.market_cap - a.market_cap).slice(0, 300).map(r => r.stock_code)));

  const STRATS = [
    ['기준선: 유니버스 전체', null],
    ['[통제] 시총상위300 중 임의 20', (f, c, i) => { if (!cap300.get(i).has(c)) return null; let h = i * 2654435761; for (let k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0; return (h % 100000) / 100000; }],
    ['저변동성 ∩ 시총상위300 (총 σ)', (f, c, i) => (cap300.get(i).has(c) ? -f.vol20 : null)],
    ['저베타 ∩ 시총상위300 (β)', (f, c, i) => (cap300.get(i).has(c) && f.beta != null ? -f.beta : null)],
    ['저잔차변동성 ∩ 시총상위300 (idioσ)', (f, c, i) => (cap300.get(i).has(c) && f.idio != null ? -f.idio : null)],
    ['저변동성 (전 유니버스, 총 σ)', (f) => -f.vol20],
    // --set=gap(2026-08-24)의 유일 생존 후보. 배터리에선 D+2 초과중앙 +0.35%/승률 54%/전후반
    // 부호 유지였지만, 저변동성 계열이라 베타 아티팩트 가능성을 여기서 가른다.
    ['★고점근접 조용 (마름 & 고점−5% 내)', (f) => (f.dry5 != null && f.dry5 <= 0.8 && f.pbDepth != null && f.pbDepth <= 5 ? -f.dry5 : null)],
    ['★고점근접 조용 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) && f.dry5 != null && f.dry5 <= 0.8 && f.pbDepth != null && f.pbDepth <= 5 ? -f.dry5 : null)],
  ];

  const half = Math.floor(days.length / 2);
  const out = [];
  for (const [name, fn] of STRATS) {
    const A = { cap: [], cb: [], mm: [], up: [], down: [], beta: [], a: [], b: [] };
    for (let i = LOOK + 5; i + SELL < days.length; i++) {
      const list = eligible.get(i) || [];
      let picks;
      if (fn == null) picks = list;
      else {
        const sc = [];
        for (const c of list) { const f = feat.get(`${i}|${c}`); if (!f) continue; const v = fn(f, c, i); if (v == null || !isFinite(v)) continue; sc.push([c, v]); }
        picks = sc.sort((x, y) => y[1] - x[1]).slice(0, K).map(x => x[0]);
      }
      const mf = mktFwd(i);
      for (const c of picks) {
        const e = exCap(c, i); if (e != null) { A.cap.push(e); (i < half ? A.a : A.b).push(e); if (mf != null) (mf > 0 ? A.up : A.down).push(e); }
        const eb = exCapBeta(c, i); if (eb != null) A.cb.push(eb);
        const am = alphaMM(c, i); if (am != null) A.mm.push(am);
        const bt = feat.get(`${i}|${c}`)?.beta; if (bt != null) A.beta.push(bt);
      }
    }
    if (A.cap.length < 30) continue;
    out.push({ name, n: A.cap.length, beta: avg(A.beta),
      cap: med(A.cap), cb: med(A.cb), mm: med(A.mm),
      up: med(A.up), nUp: A.up.length, down: med(A.down), nDown: A.down.length,
      win: winR(A.cap), a: avg(A.a), b: avg(A.b) });
  }

  console.log('  전략 (매일 상위' + K + ')                  |    n  |  평균β | ①시총매칭 | ②+베타매칭 | ③시장모형α');
  console.log('  ' + '-'.repeat(96));
  for (const r of out) console.log(`  ${r.name.padEnd(34)} | ${String(r.n).padStart(5)} | ${(r.beta == null ? '  -' : r.beta.toFixed(2)).padStart(6)} | ${sgn(r.cap)} | ${sgn(r.cb)} | ${sgn(r.mm)}`);

  console.log('\n  ④ 레짐 분리 — 보유구간 시장 방향별 시총매칭 초과수익 (중앙값)');
  console.log('  ' + '-'.repeat(96));
  console.log('  전략                               | 시장↑구간 (n)      | 시장↓구간 (n)      | 전반→후반');
  for (const r of out) console.log(`  ${r.name.padEnd(34)} | ${sgn(r.up)} (${String(r.nUp).padStart(4)}) | ${sgn(r.down)} (${String(r.nDown).padStart(4)}) | ${sgn(r.a)}→${sgn(r.b)}`);

  console.log('\n  · ① 기존 배터리 기준(동일일 × 시총5분위). 베타 미통제.');
  console.log('  · ② 동일일 × 시총5분위 × **베타5분위**. 저변동성 우위가 베타 때문이면 여기서 소멸한다.');
  console.log('  · ③ 보유구간 수익 − β×시장수익. 베타 노출을 직접 차감한 시장모형 알파.');
  console.log('  · ④ 베타 베팅이면 시장↑구간에서 **부호가 뒤집혀야** 한다. 양쪽 다 +면 알파 쪽 증거.');
  const signalDays = days.length - LOOK - 5 - SELL;
  console.log(`\n독립블록 ≈ ${(signalDays / SELL).toFixed(1)} (신호일 ${signalDays}일 / 보유 ${SELL}일). 3 미만이면 판정 금지.`);
  console.log('한계: 전 표본 단일 하락 레짐이라 "시장↑구간"은 하락장 속 반등일 뿐 상승 레짐이 아니다.\n');
})().catch(e => { console.error(e); process.exit(1); });
