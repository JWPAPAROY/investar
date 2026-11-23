/**
 * portfolio-verdict.js — 포트폴리오 전환 판정 (v3.97, 2026-08-26)
 *
 * ⚠️ 판정 기준은 **PORTFOLIO_VERDICT.md 에 성적을 보기 전에 못 박아** 뒀다.
 *   이 파일은 그 기준을 코드로 계산할 뿐이다. 여기서 기준을 바꾸면
 *   사후 선택이 되므로, 바꿔야 한다면 그 문서의 "변경 이력"에 이유를 먼저 남길 것.
 *
 * 왜 이렇게까지 하나: 이 프로젝트는 사후에 유리한 기준을 고르다 세 번 데였다.
 *   저변동성 "우위"가 62일 표본에서만 1등(641일·1,133일에선 죽음),
 *   60일 리밸런싱 IS 승률 78%가 9기간 중 7회, 깔때기 뒤집기 3회 기각.
 *
 * 실행: node scripts/portfolio-verdict.js [--strategy=pbr_lowvol|ep_lowturn]
 *   2026-10-06: 전략별 판정. 기준은 각자의 문서(VERDICT[strategy].doc)에 사전 등록돼 있다.
 *       node scripts/portfolio-verdict.js --compare
 *   2026-11-23: 두 전략을 **같은 기간**(늦게 시작한 쪽의 첫 매수일 종가 → 둘 다 가격이 있는 마지막 날)으로 맞춘 비교.
 *     관측 전용 — 판정에 쓰지 않는다(판정은 각 전략 문서의 기준·기간으로만). 시작일·벤치가 달라 누적치를 그대로 줄 세우면 안 돼서 만들었다.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

// ── 사전 등록된 기준 (각 문서와 일치해야 한다) ──────────────────────────
const P = require('../backend/portfolio');
const VERDICT = {
  pbr_lowvol: { doc: 'PORTFOLIO_VERDICT.md',    date: '2027-02-26', weightKey: 'weight',   bench: 'kospi' },
  ep_lowturn: { doc: 'PORTFOLIO_VERDICT_EP.md', date: '2027-04-06', weightKey: 'weightEq', bench: 'kospi_ex_mega' },
};
const STRATEGY = (process.argv.find(a => a.startsWith('--strategy=')) || '--strategy=pbr_lowvol').split('=')[1];
const V = VERDICT[STRATEGY];
if (!V) { console.error(`알 수 없는 전략: ${STRATEGY}`); process.exit(1); }
const VERDICT_DATE = V.date;           // 판정일 (6개월)
const EXCESS_PASS  = 0;                // ① 초과수익 ≥ 0%p 통과
const EXCESS_FAIL  = -5;               // ① 초과수익 < −5%p 기각
const MDD_PASS     = -20;              // ② MDD −20% 이내 통과
const MDD_FAIL     = -25;              // ② MDD −25% 초과 즉시 기각
const UNIV_MIN     = 200;              // 중단: 유니버스 3회 연속 200 미만

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);
const pct = v => (v == null ? '  —' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

async function fetchAll(t, c, f) {
  let o = [], x = 0;
  while (true) {
    let q = sb.from(t).select(c).range(x, x + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    o = o.concat(data); if (data.length < 1000) break; x += 1000;
  }
  return o;
}

// ── --compare: 두 전략 같은 기간 비교 (관측 전용) ─────────────────────────
//   회차마다 매수일 종가 기준 비중으로 보유(드리프트), 다음 회차 매수일에 갈아탄 일별 NAV를 이어 붙인다.
//   비중 키는 각 전략 판정과 같다(VERDICT[s].weightKey). 가격은 판정과 같은 market_flow_daily.close.
async function compare() {
  const strategies = Object.keys(VERDICT);
  const rebs = {};
  for (const s of strategies) rebs[s] = await fetchAll('portfolio_rebalances', '*', q => q.eq('strategy', s).order('rebalance_date'));
  if (strategies.some(s => !rebs[s].length)) { console.log('리밸런싱 기록이 없는 전략이 있다'); return; }
  const codes = [...new Set(Object.values(rebs).flat().flatMap(r => (r.holdings || []).map(h => h.code)))];
  const start0 = strategies.map(s => rebs[s][0].rebalance_date).sort()[0];
  const px = await fetchAll('market_flow_daily', 'stock_code,trade_date,close', q => q.in('stock_code', codes).gte('trade_date', start0).order('trade_date').order('stock_code'));
  const by = new Map();
  for (const r of px) { if (!by.has(r.stock_code)) by.set(r.stock_code, new Map()); by.get(r.stock_code).set(r.trade_date, r.close); }
  const days = [...new Set(px.map(r => r.trade_date))].sort();
  const next = d => days.find(x => x > d) || null;

  const navOf = s => {
    const wk = VERDICT[s].weightKey, nav = new Map();
    let base = 1;
    for (let i = 0; i < rebs[s].length; i++) {
      const buy = next(rebs[s][i].rebalance_date); if (!buy) break;
      const end = i + 1 < rebs[s].length ? next(rebs[s][i + 1].rebalance_date) : days.at(-1);
      const hs = (rebs[s][i].holdings || []).filter(h => by.get(h.code)?.get(buy) > 0 && (h[wk] || 0) > 0);
      const W = hs.reduce((a, h) => a + h[wk], 0);
      let last = base;
      for (const d of days.filter(x => x >= buy && x <= (end || buy))) {
        let v = 0, w = 0;
        for (const h of hs) { const c = by.get(h.code).get(d); if (c > 0) { v += (h[wk] / W) * (c / by.get(h.code).get(buy)); w += h[wk] / W; } }
        if (w > 0.8) { last = base * v / w; nav.set(d, last); }   // 비중 80% 이상 가격이 있는 날만(거래정지 등 결측일 제외)
      }
      base = last;
    }
    return nav;
  };
  const navs = Object.fromEntries(strategies.map(s => [s, navOf(s)]));
  const from = strategies.map(s => next(rebs[s][0].rebalance_date)).sort().at(-1);
  const common = days.filter(d => d >= from && strategies.every(s => navs[s].has(d)));
  if (common.length < 2) { console.log('겹치는 기간이 아직 없다'); return; }
  const a = common[0], b = common.at(-1);
  const ret = (s, x, y) => (navs[s].get(y) / navs[s].get(x) - 1) * 100;
  const mddOf = s => { let pk = 0, m = 0; for (const d of common) { const v = navs[s].get(d); pk = Math.max(pk, v); m = Math.min(m, (v / pk - 1) * 100); } return m; };

  // 벤치마크: 두 종목 제외 KOSPI(시총가중, 판정과 같은 P.capWeightedReturn)와 KOSPI(overnight_predictions.kospi_close)
  const kospiSet = new Set((await fetchAll('stock_master', 'stock_code', q => q.eq('market', 'KOSPI').order('stock_code'))).map(r => r.stock_code));
  const rowsCache = new Map();
  const dayRows = async d => {
    if (!rowsCache.has(d)) rowsCache.set(d, (await fetchAll('market_flow_daily', 'stock_code,close,market_cap,krx_market_cap', q => q.eq('trade_date', d).order('stock_code')))
      .map(r => ({ stock_code: r.stock_code, close: r.close, cap: r.krx_market_cap ?? r.market_cap })));
    return rowsCache.get(d);
  };
  const exMega = async (x, y) => P.capWeightedReturn(await dayRows(x), await dayRows(y), kospiSet, P.MEGA);
  const kp = await fetchAll('overnight_predictions', 'prediction_date,kospi_close', q => q.gte('prediction_date', a).lte('prediction_date', b).not('kospi_close', 'is', null).order('prediction_date'));
  const km = new Map(kp.map(r => [r.prediction_date, r.kospi_close]));
  const kospi = (x, y) => (km.get(x) > 0 && km.get(y) > 0 ? (km.get(y) / km.get(x) - 1) * 100 : null);

  const NAME = { pbr_lowvol: '저PBR·저변동', ep_lowturn: 'E/P·저회전' };
  const exAll = await exMega(a, b), kAll = kospi(a, b);
  console.log(`📊 같은 기간 비교 — ${a} 종가 → ${b} 종가 (${common.length}거래일) · 관측 전용, 판정 아님\n`);
  for (const s of strategies) {
    const r = ret(s, a, b);
    const mega = rebs[s].some(x => (x.holdings || []).some(h => P.MEGA.includes(h.code)));
    console.log(`  ${NAME[s].padEnd(9)} 수익 ${pct(r)}  MDD ${pct(mddOf(s))}  | 두 종목 제외 KOSPI 대비 ${exAll == null ? '—' : pct(r - exAll) + 'p'}  | KOSPI 대비 ${kAll == null ? '—' : pct(r - kAll) + 'p'}  (${VERDICT[s].weightKey === 'weight' ? '시총가중' : '동일가중'}${mega ? ', 삼성·하이닉스 보유 이력 있음' : ''})`);
  }
  console.log(`  벤치: KOSPI(삼성·하이닉스 제외) ${pct(exAll)} · KOSPI ${pct(kAll)}`);

  console.log('\n  주별 (5거래일)');
  const marks = common.filter((d, i) => i % 5 === 0 || i === common.length - 1);
  for (let i = 1; i < marks.length; i++) {
    const [x, y] = [marks[i - 1], marks[i]];
    console.log(`    ${x} → ${y}  ${strategies.map(s => `${NAME[s]} ${pct(ret(s, x, y))}`).join('  ')}  두 종목 제외 KOSPI ${pct(await exMega(x, y))}`);
  }
  console.log('\n  ⚠️ 판정은 각 전략 문서의 기준·기간으로만 한다. 이 비교로 어느 쪽을 바꾸거나 멈추지 않는다.');
}

(async () => {
  if (process.argv.includes('--compare')) return compare();
  // strategy 컬럼 마이그레이션 전이면 전 행이 pbr_lowvol이다
  let rebs;
  try { rebs = await fetchAll('portfolio_rebalances', '*', q => q.eq('strategy', STRATEGY).order('rebalance_date')); }
  catch (e) {
    if (!/strategy/.test(e.message)) throw e;
    rebs = STRATEGY === 'pbr_lowvol' ? await fetchAll('portfolio_rebalances', '*', q => q.order('rebalance_date')) : [];
  }
  if (!rebs.length) { console.log('리밸런싱 기록 없음'); return; }

  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const start = rebs[0].rebalance_date;
  console.log(`📋 [${STRATEGY}] 포트폴리오 판정 (기준 ${V.doc}) — 시작 ${start} / 오늘 ${today} / 판정일 ${VERDICT_DATE}`);
  console.log(`   리밸런싱 ${rebs.length}회\n`);

  // ── 파라미터 연속성: 바뀌었으면 성과를 이어 붙일 수 없다 ────────────────
  const sig = (p) => [p?.factor, p?.k, p?.hold, p?.weight, p?.univ, p?.capMin, p?.valMin].join('|');
  const sigs = [...new Set(rebs.map(r => sig(r.params)))];
  if (sigs.length > 1) {
    console.log('⚠️ 파라미터가 도중에 바뀌었다 — 성과의 연속성이 끊긴다. 판정 리셋 대상.');
    rebs.forEach(r => console.log(`   ${r.rebalance_date}  ${sig(r.params)}`));
    console.log('');
  }

  // ── 각 회차 수익률 (매수 기준일 종가 → 다음 리밸런싱 매수일 종가) ───────
  const codes = [...new Set(rebs.flatMap(r => (r.holdings || []).map(h => h.code)))];
  const px = await fetchAll('market_flow_daily', 'stock_code,trade_date,close',
    q => q.in('stock_code', codes).gte('trade_date', start));
  const byCode = new Map();
  for (const r of px) {
    if (!byCode.has(r.stock_code)) byCode.set(r.stock_code, new Map());
    byCode.get(r.stock_code).set(r.trade_date, r.close);
  }
  const days = [...new Set(px.map(r => r.trade_date))].sort();
  const nextTradingDay = (d) => days.find(x => x > d) || null;

  let nav = 1, navPath = [1];
  const periods = [];
  for (let i = 0; i < rebs.length; i++) {
    const buy = nextTradingDay(rebs[i].rebalance_date);
    if (!buy) { periods.push({ date: rebs[i].rebalance_date, ret: null, note: '매수 미도래' }); continue; }
    const end = (i + 1 < rebs.length) ? nextTradingDay(rebs[i + 1].rebalance_date) : days[days.length - 1];
    if (!end || end <= buy) { periods.push({ date: rebs[i].rebalance_date, ret: null, note: '진행 중(1일 미만)' }); continue; }
    let num = 0, den = 0;
    for (const h of rebs[i].holdings || []) {
      const m = byCode.get(h.code); if (!m) continue;
      const b = m.get(buy), e = m.get(end);
      if (!(b > 0) || !(e > 0)) continue;
      const w = h[V.weightKey] || 0;
      num += w * ((e - b) / b) * 100; den += w;
    }
    const ret = den > 0 ? num / den : null;
    if (ret != null) { nav *= (1 + ret / 100); navPath.push(nav); }
    periods.push({ date: rebs[i].rebalance_date, buy, end, ret, note: (i + 1 < rebs.length) ? '' : '진행 중' });
  }

  console.log(`회차별 (${V.weightKey === 'weight' ? '시총가중' : '동일가중'})`);
  periods.forEach((p, i) => console.log(
    `  ${i + 1}. ${p.date} → ${p.end || '-'}  ${p.ret == null ? '  —' : pct(p.ret)}  ${p.note}`));

  const cum = (nav - 1) * 100;
  let peak = 1, mdd = 0;
  for (const v of navPath) { if (v > peak) peak = v; const d = (v / peak - 1) * 100; if (d < mdd) mdd = d; }

  // ── 벤치마크: 같은 구간 KOSPI ─────────────────────────────────────────
  const firstBuy = periods.find(p => p.buy)?.buy;
  let bench = null;
  if (firstBuy && V.bench === 'kospi_ex_mega') {
    // 두 종목을 뺀 KOSPI — 회차별 매수후보유 수익을 이어 붙인다(구간 내 편입 변동 무시)
    const kospi = new Set((await fetchAll('stock_master', 'stock_code', q => q.eq('market', 'KOSPI').order('stock_code'))).map(r => r.stock_code));
    const dayRows = async d => (await fetchAll('market_flow_daily', 'stock_code,close,market_cap,krx_market_cap',
      q => q.eq('trade_date', d).order('stock_code'))).map(r => ({ stock_code: r.stock_code, close: r.close, cap: r.krx_market_cap ?? r.market_cap }));
    let bnav = 1;
    for (const p of periods) {
      if (!p.buy || !p.end || p.end <= p.buy) continue;
      const r = P.capWeightedReturn(await dayRows(p.buy), await dayRows(p.end), kospi, P.MEGA);
      if (r != null) bnav *= 1 + r / 100;
    }
    bench = (bnav - 1) * 100;
  } else if (firstBuy) {
    // 끝 날짜를 포트폴리오 마지막 가격일에 맞춘다 — overnight_predictions 는 당일 장마감 직후 채워져
    // market_flow_daily(저녁 수집)보다 하루 앞설 수 있다 (2026-10-22: 10/22 −3.2% 가 벤치에만 들어가 초과 +3%p 부풀림)
    const lastEnd = periods.filter(p => p.end).at(-1)?.end;
    const { data: kp } = await sb.from('overnight_predictions')
      .select('prediction_date,kospi_close').lt('prediction_date', '2027-01-01')
      .not('kospi_close', 'is', null).gte('prediction_date', firstBuy).lte('prediction_date', lastEnd || '9999-12-31')
      .order('prediction_date');
    if (kp && kp.length >= 2) {
      const a = kp[0].kospi_close, b = kp[kp.length - 1].kospi_close;
      if (a > 0) bench = ((b - a) / a) * 100;
    }
  }
  const excess = (bench != null) ? cum - bench : null;

  console.log(`\n누적 ${pct(cum)} | MDD ${pct(mdd)} | ${V.bench === 'kospi' ? 'KOSPI' : 'KOSPI(삼성·하이닉스 제외)'} ${pct(bench)} | 초과 ${excess == null ? '—' : pct(excess) + 'p'}`);

  // ── 중단 조건 ────────────────────────────────────────────────────────
  const stops = [];
  if (mdd < MDD_FAIL) stops.push(`MDD ${pct(mdd)} < ${MDD_FAIL}% — 즉시 기각`);
  const lastU = rebs.slice(-3).map(r => r.universe_size);
  if (lastU.length === 3 && lastU.every(u => u != null && u < UNIV_MIN)) stops.push(`유니버스 3회 연속 ${UNIV_MIN} 미만 (${lastU.join('/')}) — 파이프라인 점검`);
  if (stops.length) { console.log('\n🛑 중단 조건'); stops.forEach(s => console.log('   ' + s)); }

  // ── 판정 ─────────────────────────────────────────────────────────────
  console.log('');
  if (today < VERDICT_DATE) {
    const left = Math.ceil((new Date(VERDICT_DATE) - new Date(today)) / 864e5);
    console.log(`⏳ 판정일까지 ${left}일 — **아직 판정하지 않는다.** 위 값은 경과 관측일 뿐이다.`);
    console.log('   (중간 성적으로 기준을 바꾸는 것이 이 프로젝트가 세 번 데인 함정이다)');
    return;
  }
  const v1 = excess == null ? '판정 불가(벤치마크 없음)'
    : excess >= EXCESS_PASS ? '통과' : excess < EXCESS_FAIL ? '기각' : '애매 → **기각으로 처리**';
  const v2 = mdd > MDD_PASS ? '통과' : mdd < MDD_FAIL ? '기각' : '경계';
  console.log(`① 초과수익 ${excess == null ? '—' : pct(excess) + 'p'} → ${v1}`);
  console.log(`② MDD ${pct(mdd)} → ${v2}`);
  console.log(`\n최종: ${(v1 === '통과' && v2 === '통과') ? '✅ 관측 연장' : '❌ 기각'}  (기준: ${V.doc})`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
