/**
 * gainer-consistency-scan.js — "당일 오른 주식 → 현행 선별 로직과의 정합성" (역방향 검증)
 *
 * 기존 검증(pool-slice-scan, validate-funnel-inversion, perf-final)은 전부
 * **정방향**이었다: "로직이 고른 종목이 올랐나?" (정밀도 side)
 * 이 스크립트는 사용자 제안대로 **역방향**을 본다: "실제로 오른 종목이
 * 우리 로직 조건을 갖췄었나?" (재현율 side)
 *
 * 검정 3가지:
 *  A. 철학 검정 — 상승 종목의 거래량이 (a) 당일 (b) 전일 늘어 있었나?
 *     동시(a)는 항등식에 가깝다(오르면 거래량 는다). 예측력은 (b)에만 있다.
 *  B. 포착률(recall) — 상승일 D의 종목이 D-1 깔때기(거래량 top30)에 있었나?
 *  C. 베이즈 대칭 — P(조건|상승)/P(조건) 은 P(상승|조건)/P(상승) 과 같은 값.
 *     즉 역방향 lift는 정방향 lift와 동일 수치. 다른 건 "커버리지" 정보다.
 *  D. 시총/업종별 포착률 — 놓치는 구간이 어디인가.
 *  E. 상승일 다음 성과 — 오른 종목을 D+1에 사는 것 자체가 되는 일인가(시총매칭 초과).
 *
 * 지표 주의: 절대수익은 사이즈 베타에 오염되므로 E에서는 동일일·동일 시총5분위
 * 매칭 초과수익을 주 지표로 쓴다(pool-slice-scan과 동일 규약).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10);       // 상승일 다음날 매수 → D+SELL 매도
const TOPN = arg('topn', 30);       // 깔때기 진입 폭(KIS 거래량순위 top30 근사)
const VOLW = arg('volw', 20);       // 거래량 평균 기간
const MIN_UNIVERSE = 2000;
const 조 = 1e12;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const pct = v => (v == null ? '   -  ' : `${v.toFixed(2)}%`.padStart(7));
const sgn = v => (v == null ? '   -  ' : ((v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) + '%').padStart(8));

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
  console.log(`\n📐 역방향 정합성 스캔 — "오른 종목이 우리 조건을 갖췄었나"`);
  console.log(`   깔때기 폭 top${TOPN} / 거래량 기준기간 ${VOLW}일 / 사후평가 D+1→D+${SELL}\n`);

  const flow = await fetchAll('market_flow_daily',
    'stock_code,trade_date,close,volume,market_cap,sector_name,inst_net_value,frgn_net_value');

  const byDate = new Map();
  for (const r of flow) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []);
    byDate.get(r.trade_date).push(r);
  }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();
  for (const r of flow) {
    if (!dayIdx.has(r.trade_date)) continue;
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, r);
  }
  console.log(`데이터: ${days.length}거래일 × ${px.size}종목 (${days[0]} ~ ${days[days.length - 1]})\n`);

  const at = (c, i) => (i >= 0 && i < days.length ? px.get(c)?.get(days[i]) : null);
  const ret0 = (c, i) => { const a = at(c, i - 1), b = at(c, i); return (a?.close && b?.close) ? ((b.close - a.close) / a.close) * 100 : null; };
  const fwd = (c, i, buy, sell) => { const b = at(c, i + buy), s = at(c, i + sell); return (b?.close && s?.close) ? ((s.close - b.close) / b.close) * 100 : null; };
  const volRatio = (c, i) => {
    const cur = at(c, i); if (!cur?.volume) return null;
    const base = [];
    for (let k = 1; k <= VOLW; k++) { const r = at(c, i - k); if (r?.volume != null) base.push(r.volume); }
    if (base.length < VOLW * 0.6) return null;
    const m = avg(base);
    return m > 0 ? cur.volume / m : null;
  };
  const streak = (c, i, f) => { // i일 포함 과거로 연속 순매수일
    let n = 0;
    for (let k = 0; k < 10 && i - k >= 0; k++) { const r = at(c, i - k); if (!r || (r[f] ?? 0) <= 0) break; n++; }
    return n;
  };

  // 일별 거래량 top-N (현행 깔때기 진입 근사) + 거래량증가율 top-N (철학 충실판)
  const volTop = new Map(), ratioTop = new Map(), capQuintile = new Map();
  for (let i = 0; i < days.length; i++) {
    const rows = byDate.get(days[i]).filter(r => r.volume != null && r.close);
    volTop.set(i, new Set([...rows].sort((a, b) => b.volume - a.volume).slice(0, TOPN).map(r => r.stock_code)));
    const withRatio = rows.map(r => ({ c: r.stock_code, v: volRatio(r.stock_code, i) })).filter(x => x.v != null);
    ratioTop.set(i, new Set(withRatio.sort((a, b) => b.v - a.v).slice(0, TOPN).map(x => x.c)));
    const caps = rows.filter(r => r.market_cap).sort((a, b) => a.market_cap - b.market_cap);
    caps.forEach((r, k) => capQuintile.set(`${days[i]}|${r.stock_code}`, Math.min(4, Math.floor((k / caps.length) * 5))));
  }

  // ── A. 철학 검정: 상승 종목의 거래량은 언제 늘어나는가 ──────────────────
  const THRESH = [3, 5, 10, 15];
  const rows = [];
  // 시장 전체 기준선
  const baseSame = [], basePrev = [];
  let baseN = 0, baseSameHit = 0, basePrevHit = 0;
  const obs = [];   // {i, code, ret, vrSame, vrPrev, inTop_prev, inTop_same, inRatioTop_prev, cap, sector}
  for (let i = VOLW + 1; i < days.length; i++) {
    for (const r of byDate.get(days[i])) {
      const c = r.stock_code;
      const rt = ret0(c, i); if (rt == null) continue;
      const vs = volRatio(c, i), vp = volRatio(c, i - 1);
      if (vs == null || vp == null) continue;
      baseN++; baseSame.push(vs); basePrev.push(vp);
      if (vs >= 2) baseSameHit++;
      if (vp >= 2) basePrevHit++;
      obs.push({
        i, c, rt, vs, vp,
        prevTop: volTop.get(i - 1).has(c),
        prevRatioTop: ratioTop.get(i - 1).has(c),
        sameTop: volTop.get(i).has(c),
        instP: streak(c, i - 1, 'inst_net_value'),
        frgnP: streak(c, i - 1, 'frgn_net_value'),
        cap: r.market_cap, sector: r.sector_name
      });
    }
  }
  const pBaseSame = (baseSameHit / baseN) * 100, pBasePrev = (basePrevHit / baseN) * 100;

  console.log('━━━ A. 철학 검정: "거래량 증가 → 상승"의 역방향 ' + '━'.repeat(28));
  console.log(`관측 ${baseN.toLocaleString()}건 (종목-일). 시장 기준선: 당일 거래량비≥2 ${pBaseSame.toFixed(1)}% / 전일 거래량비≥2 ${pBasePrev.toFixed(1)}%\n`);
  console.log('  상승기준 |     n  | 당일 거래량비≥2 (lift) | ★전일 거래량비≥2 (lift) | 전일 거래량비 중앙값');
  console.log('  ' + '-'.repeat(96));
  const baseMedPrev = med(basePrev);
  for (const t of THRESH) {
    const g = obs.filter(o => o.rt >= t);
    if (!g.length) continue;
    const ps = (g.filter(o => o.vs >= 2).length / g.length) * 100;
    const pp = (g.filter(o => o.vp >= 2).length / g.length) * 100;
    console.log(`  +${String(t).padStart(2)}% 이상 | ${String(g.length).padStart(6)} | ${ps.toFixed(1).padStart(7)}%  (×${(ps / pBaseSame).toFixed(2)})  | ${pp.toFixed(1).padStart(7)}%  (×${(pp / pBasePrev).toFixed(2)})   | ${med(g.map(o => o.vp)).toFixed(2)} (시장 ${baseMedPrev.toFixed(2)})`);
  }

  // ── B. 포착률(recall) ────────────────────────────────────────────────
  console.log('\n━━━ B. 포착률: 오른 종목이 전일 깔때기(D-1)에 있었나 ' + '━'.repeat(24));
  const baseTopPrev = (obs.filter(o => o.prevTop).length / obs.length) * 100;
  const baseRatioPrev = (obs.filter(o => o.prevRatioTop).length / obs.length) * 100;
  console.log(`기준선(무작위): 거래량 top${TOPN} ${baseTopPrev.toFixed(2)}% / 거래량증가율 top${TOPN} ${baseRatioPrev.toFixed(2)}%\n`);
  console.log('  상승기준 |     n  | D-1 거래량top' + TOPN + ' 포착 (lift) | D-1 거래량증가율top' + TOPN + ' (lift) | D-1 수급3일+ 보유');
  console.log('  ' + '-'.repeat(96));
  for (const t of THRESH) {
    const g = obs.filter(o => o.rt >= t); if (!g.length) continue;
    const a = (g.filter(o => o.prevTop).length / g.length) * 100;
    const b = (g.filter(o => o.prevRatioTop).length / g.length) * 100;
    const s = (g.filter(o => o.instP >= 3 || o.frgnP >= 3).length / g.length) * 100;
    const sBase = (obs.filter(o => o.instP >= 3 || o.frgnP >= 3).length / obs.length) * 100;
    console.log(`  +${String(t).padStart(2)}% 이상 | ${String(g.length).padStart(6)} | ${a.toFixed(2).padStart(6)}%  (×${(a / baseTopPrev).toFixed(2)})       | ${b.toFixed(2).padStart(6)}%  (×${(b / baseRatioPrev).toFixed(2)})        | ${s.toFixed(1)}% (시장 ${sBase.toFixed(1)}%)`);
  }

  // ── C. 정방향 대조 (베이즈 대칭 확인) ─────────────────────────────────
  console.log('\n━━━ C. 정방향 대조: 깔때기에 든 종목이 다음날 올랐나 ' + '━'.repeat(24));
  console.log('  조건(D-1)            |     n  | 다음날 +5%↑ 비율 (lift) | 다음날 평균등락 | 시장평균');
  console.log('  ' + '-'.repeat(88));
  const mktNext = avg(obs.map(o => o.rt));
  const p5Base = (obs.filter(o => o.rt >= 5).length / obs.length) * 100;
  const conds = [
    [`거래량 top${TOPN}`, o => o.prevTop],
    [`거래량증가율 top${TOPN}`, o => o.prevRatioTop],
    [`거래량비≥2`, o => o.vp >= 2],
    [`수급 3일+`, o => o.instP >= 3 || o.frgnP >= 3],
    [`거래량top${TOPN} & 수급3일+`, o => o.prevTop && (o.instP >= 3 || o.frgnP >= 3)],
  ];
  for (const [name, f] of conds) {
    const g = obs.filter(f); if (!g.length) continue;
    const p5 = (g.filter(o => o.rt >= 5).length / g.length) * 100;
    console.log(`  ${name.padEnd(20)} | ${String(g.length).padStart(6)} | ${p5.toFixed(2).padStart(6)}%  (×${(p5 / p5Base).toFixed(2)})      | ${sgn(avg(g.map(o => o.rt)))} | ${sgn(mktNext)}`);
  }

  // ── D. 놓치는 구간 ───────────────────────────────────────────────────
  console.log('\n━━━ D. 어디를 놓치나 — +5% 이상 상승의 D-1 포착률 분해 ' + '━'.repeat(20));
  const g5 = obs.filter(o => o.rt >= 5);
  const capBands = [['~1000억', 0, 1000e8], ['1000억~1조', 1000e8, 조], ['1~5조', 조, 5 * 조], ['5조~', 5 * 조, Infinity]];
  console.log('  시총대       | 상승건수 | D-1 포착률 | 상승 발생빈도(해당대 관측 대비)');
  console.log('  ' + '-'.repeat(76));
  for (const [name, lo, hi] of capBands) {
    const g = g5.filter(o => o.cap >= lo && o.cap < hi);
    const all = obs.filter(o => o.cap >= lo && o.cap < hi);
    if (!all.length) continue;
    const r = g.length ? (g.filter(o => o.prevTop).length / g.length) * 100 : null;
    console.log(`  ${name.padEnd(12)} | ${String(g.length).padStart(7)} | ${r == null ? '   -' : r.toFixed(2).padStart(7) + '%'}  | ${((g.length / all.length) * 100).toFixed(2)}%`);
  }
  const bySector = new Map();
  for (const o of g5) {
    const s = o.sector || '(미상)';
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s).push(o);
  }
  const sec = [...bySector.entries()].filter(([, v]) => v.length >= 30)
    .map(([k, v]) => [k, v.length, (v.filter(o => o.prevTop).length / v.length) * 100])
    .sort((a, b) => a[2] - b[2]);
  console.log('\n  업종별 D-1 포착률 (상승건수 30+ 업종, 낮은 순 = 구조적 사각지대)');
  console.log('  ' + '-'.repeat(60));
  for (const [k, n, r] of sec.slice(0, 6)) console.log(`  ${k.padEnd(16)} n=${String(n).padStart(4)}  포착 ${r.toFixed(2)}%`);
  console.log('  ...');
  for (const [k, n, r] of sec.slice(-3)) console.log(`  ${k.padEnd(16)} n=${String(n).padStart(4)}  포착 ${r.toFixed(2)}%`);

  // ── E. 오른 종목을 다음날 사면? (시총 매칭 초과) ──────────────────────
  console.log(`\n━━━ E. 상승일 다음날(D+1) 매수 → D+${SELL} 매도, 시총5분위 매칭 초과 ` + '━'.repeat(12));
  // 일자별 분위 평균 사전계산
  const qMean = new Map();
  for (let i = 0; i < days.length; i++) {
    const buckets = [[], [], [], [], []];
    for (const r of byDate.get(days[i])) {
      const q = capQuintile.get(`${days[i]}|${r.stock_code}`); if (q == null) continue;
      const f = fwd(r.stock_code, i, 1, SELL); if (f != null) buckets[q].push(f);
    }
    qMean.set(i, buckets.map(b => (b.length >= 20 ? avg(b) : null)));
  }
  const excessOf = o => {
    const f = fwd(o.c, o.i, 1, SELL); if (f == null) return null;
    const q = capQuintile.get(`${days[o.i]}|${o.c}`); if (q == null) return null;
    const m = qMean.get(o.i)?.[q]; if (m == null) return null;
    return f - m;
  };
  const groups = [
    ['시장 전체(기준선)', obs],
    ['당일 +3%↑', obs.filter(o => o.rt >= 3)],
    ['당일 +5%↑', g5],
    ['당일 +10%↑', obs.filter(o => o.rt >= 10)],
    [`+5%↑ & D-1 거래량top${TOPN}`, g5.filter(o => o.prevTop)],
    [`+5%↑ & D-1 미포착`, g5.filter(o => !o.prevTop)],
    ['당일 하락 -3%↓', obs.filter(o => o.rt <= -3)],
  ];
  console.log('  집단                        |     n  | 절대수익 | 매칭초과 | 승률(초과)');
  console.log('  ' + '-'.repeat(76));
  for (const [name, g] of groups) {
    const abs = [], ex = [];
    for (const o of g) { const f = fwd(o.c, o.i, 1, SELL); const e = excessOf(o); if (f != null) abs.push(f); if (e != null) ex.push(e); }
    if (!ex.length) continue;
    console.log(`  ${name.padEnd(27)} | ${String(ex.length).padStart(6)} | ${sgn(avg(abs))} | ${sgn(avg(ex))} | ${winR(ex).toFixed(0)}%`);
  }

  // ── F. 분포 검정: 로직은 "확률"을 올리나 "기대값"을 올리나 ────────────
  console.log('\n━━━ F. 다음날 등락 분포 — 급등확률 vs 기대수익 ' + '━'.repeat(28));
  console.log('  집단              |     n  | 평균등락 | 중앙값  | 상승률 | +5%↑  | -5%↓');
  console.log('  ' + '-'.repeat(78));
  const dists = [
    ['시장 전체', obs],
    [`D-1 거래량top${TOPN}`, obs.filter(o => o.prevTop)],
    [`D-1 거래량비≥2`, obs.filter(o => o.vp >= 2)],
    [`D-1 수급3일+`, obs.filter(o => o.instP >= 3 || o.frgnP >= 3)],
  ];
  for (const [name, g] of dists) {
    const r = g.map(o => o.rt);
    const up5 = (r.filter(v => v >= 5).length / r.length) * 100;
    const dn5 = (r.filter(v => v <= -5).length / r.length) * 100;
    console.log(`  ${name.padEnd(17)} | ${String(r.length).padStart(6)} | ${sgn(avg(r))} | ${sgn(med(r))} | ${winR(r).toFixed(0).padStart(4)}% | ${up5.toFixed(1).padStart(5)}% | ${dn5.toFixed(1).padStart(5)}%`);
  }

  const signalDays = days.length - VOLW - 1 - SELL;
  console.log(`\n독립블록 ≈ ${(signalDays / SELL).toFixed(1)} (신호일 ${signalDays}일 / 보유 ${SELL}일). 3 미만이면 판정 금지, 관측으로만 읽을 것.`);
  console.log('한계: 전 표본 단일 레짐. 포착률은 거래량 top' + TOPN + ' 근사(실제 KIS 순위 API와 미세차 가능).\n');
})().catch(e => { console.error(e); process.exit(1); });
