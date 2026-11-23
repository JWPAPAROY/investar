/**
 * 두 포트폴리오 전략 같은 기간 비교 (2026-11-23) — 관측 전용, 판정에 쓰지 않는다
 *
 * 두 전략은 시작일(8/26 vs 10/2)·벤치(KOSPI vs 두 종목 제외 KOSPI)·비중(시총 vs 동일)이 달라
 * 누적치를 그대로 줄 세우면 안 된다. 늦게 시작한 쪽의 첫 매수일 종가부터, 둘 다 가격이 있는 마지막 날까지로 맞춘다.
 *
 * 계산은 scripts/portfolio-verdict.js 와 같다:
 *   - 가격 market_flow_daily.close, 매수 = 리밸런싱 다음 거래일 종가
 *   - 회차마다 매수일 종가 기준 비중 고정 후 보유(드리프트), 다음 회차 매수일에 갈아탄 일별 NAV 를 이어 붙임
 *   - 비중 키 = 전략 설정(STRATEGIES[s].weight === 'eq' → weightEq, 아니면 weight)
 *   - 벤치: 두 종목 제외 KOSPI 시총가중(capWeightedReturn), KOSPI(overnight_predictions.kospi_close)
 * 사용처: scripts/portfolio-verdict.js --compare, GET /api/portfolio?view=compare(📦 탭)
 */
const P = require('./portfolio');

async function fetchAll(sb, t, c, f) {
  let o = [], x = 0;
  for (;;) {
    let q = sb.from(t).select(c).range(x, x + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    o = o.concat(data); if (data.length < 1000) break; x += 1000;
  }
  return o;
}

const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

async function compareStrategies(sb, strategies = Object.keys(P.STRATEGIES)) {
  const weightKey = s => (P.STRATEGIES[s].weight === 'eq' ? 'weightEq' : 'weight');
  const rebs = {};
  for (const s of strategies) rebs[s] = await fetchAll(sb, 'portfolio_rebalances', '*', q => q.eq('strategy', s).order('rebalance_date'));
  if (strategies.some(s => !rebs[s].length)) return { ready: false, reason: '리밸런싱 기록이 없는 전략이 있다' };

  const codes = [...new Set(Object.values(rebs).flat().flatMap(r => (r.holdings || []).map(h => h.code)))];
  const start0 = strategies.map(s => rebs[s][0].rebalance_date).sort()[0];
  const px = await fetchAll(sb, 'market_flow_daily', 'stock_code,trade_date,close', q => q.in('stock_code', codes).gte('trade_date', start0).order('trade_date').order('stock_code'));
  const by = new Map();
  for (const r of px) { if (!by.has(r.stock_code)) by.set(r.stock_code, new Map()); by.get(r.stock_code).set(r.trade_date, r.close); }
  const days = [...new Set(px.map(r => r.trade_date))].sort();
  const next = d => days.find(x => x > d) || null;

  const navOf = s => {
    const wk = weightKey(s), nav = new Map();
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
  const from = strategies.map(s => next(rebs[s][0].rebalance_date)).filter(Boolean).sort().at(-1);
  const common = from ? days.filter(d => d >= from && strategies.every(s => navs[s].has(d))) : [];
  if (common.length < 2) return { ready: false, reason: '겹치는 기간이 아직 없다' };
  const a = common[0], b = common.at(-1);
  const ret = (s, x, y) => (navs[s].get(y) / navs[s].get(x) - 1) * 100;

  const kospiSet = new Set((await fetchAll(sb, 'stock_master', 'stock_code', q => q.eq('market', 'KOSPI').order('stock_code'))).map(r => r.stock_code));
  const marks = common.filter((d, i) => i % 5 === 0 || i === common.length - 1);
  const rowsByDay = new Map();
  await Promise.all(marks.map(async d => rowsByDay.set(d, (await fetchAll(sb, 'market_flow_daily', 'stock_code,close,market_cap,krx_market_cap', q => q.eq('trade_date', d).order('stock_code')))
    .map(r => ({ stock_code: r.stock_code, close: r.close, cap: r.krx_market_cap ?? r.market_cap })))));
  const exMega = (x, y) => P.capWeightedReturn(rowsByDay.get(x), rowsByDay.get(y), kospiSet, P.MEGA);
  const kp = await fetchAll(sb, 'overnight_predictions', 'prediction_date,kospi_close', q => q.gte('prediction_date', a).lte('prediction_date', b).not('kospi_close', 'is', null).order('prediction_date'));
  const km = new Map(kp.map(r => [r.prediction_date, r.kospi_close]));
  const kospi = (x, y) => (km.get(x) > 0 && km.get(y) > 0 ? (km.get(y) / km.get(x) - 1) * 100 : null);

  const exAll = exMega(a, b), kAll = kospi(a, b);
  const rows = strategies.map(s => {
    const r = ret(s, a, b);
    let pk = 0, mdd = 0; for (const d of common) { const v = navs[s].get(d); pk = Math.max(pk, v); mdd = Math.min(mdd, (v / pk - 1) * 100); }
    return {
      strategy: s, factor: P.STRATEGIES[s].factor, weighting: weightKey(s) === 'weight' ? '시총가중' : '동일가중',
      start: rebs[s][0].rebalance_date, ret: r2(r), mdd: r2(mdd),
      vsExMega: exAll == null ? null : r2(r - exAll), vsKospi: kAll == null ? null : r2(r - kAll),
      heldMega: rebs[s].some(x => (x.holdings || []).some(h => P.MEGA.includes(h.code))),
      nav: common.map(d => [d, r2((navs[s].get(d) / navs[s].get(a) - 1) * 100)]),
    };
  });
  const weeks = [];
  for (let i = 1; i < marks.length; i++) {
    const [x, y] = [marks[i - 1], marks[i]];
    weeks.push({ from: x, to: y, exMega: r2(exMega(x, y)), kospi: r2(kospi(x, y)), ret: Object.fromEntries(strategies.map(s => [s, r2(ret(s, x, y))])) });
  }
  return { ready: true, from: a, to: b, days: common.length, bench: { exMega: r2(exAll), kospi: r2(kAll) }, rows, weeks };
}

module.exports = { compareStrategies };
