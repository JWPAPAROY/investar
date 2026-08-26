/**
 * GET /api/portfolio — 저PBR·저변동 포트폴리오 현황 + 성과 (v3.97)
 *
 * 현행 추천(TOP3)과 **무관한 별도 라인**이다. 프론트엔드에서 별도 탭으로 나란히 보여주고,
 * 성적을 눈으로 비교한 뒤 전환 여부를 판단하기 위한 것.
 * 구성 근거는 backend/portfolio.js 헤더 참고.
 *
 * 성과는 저장하지 않고 **매 호출 시 종가로 재계산**한다.
 *   저장하면 market_flow_daily와 두 출처가 갈라진다(이 저장소가 반복해서 당한 사고).
 */
const supabase = require('../../backend/supabaseClient');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return res.status(503).json({ success: false, error: 'Supabase 미설정' });

  try {
    const { data: rebs, error: rErr } = await supabase
      .from('portfolio_rebalances')
      .select('*')
      .order('rebalance_date', { ascending: false })
      .limit(12);
    if (rErr) throw new Error(rErr.message);
    if (!rebs || !rebs.length) {
      return res.status(200).json({
        success: true, current: null, history: [],
        message: '아직 리밸런싱 기록이 없습니다 (scripts/build-portfolio.js 실행 필요)',
      });
    }

    const cur = rebs[0];
    const codes = (cur.holdings || []).map(h => h.code);

    // 신호일 이후 종가 전부 가져온다.
    //   매수 기준일은 **저장 시점에 알 수 없다** — 신호일이 그날의 마지막 거래일이면
    //   다음 거래일이 아직 존재하지 않기 때문(2026-08-25 첫 리밸런싱에서 발견).
    //   그래서 buy_date 컬럼에 의존하지 않고 여기서 동적으로 푼다.
    const { data: px, error: pErr } = await supabase
      .from('market_flow_daily')
      .select('stock_code,trade_date,close')
      .in('stock_code', codes)
      .gte('trade_date', cur.rebalance_date)
      .order('trade_date');
    if (pErr) throw new Error(pErr.message);

    // 신호일보다 **뒤에 있는** 첫 거래일 = 매수 기준일. 아직 없으면 대기 상태.
    const dates = [...new Set((px || []).map(r => r.trade_date))].sort();
    const buyDate = dates.find(d => d > cur.rebalance_date) || null;
    const pending = buyDate == null;   // 신호만 나오고 아직 매수 시점이 안 온 상태

    const byCode = new Map();
    for (const r of px || []) {
      if (buyDate && r.trade_date < buyDate) continue;   // 매수 전 종가는 성과에서 제외
      if (!byCode.has(r.stock_code)) byCode.set(r.stock_code, []);
      byCode.get(r.stock_code).push(r);
    }

    // 종목별 수익률 (매수일 종가 → 최신 종가)
    let latestDate = null;
    const rows = (cur.holdings || []).map(h => {
      const arr = byCode.get(h.code) || [];
      const buy = arr.length ? arr[0] : null;
      const now = arr.length ? arr[arr.length - 1] : null;
      if (now && (!latestDate || now.trade_date > latestDate)) latestDate = now.trade_date;
      const ret = (buy && now && buy.close > 0) ? ((now.close - buy.close) / buy.close) * 100 : null;
      return {
        ...h,
        buyClose: buy ? buy.close : null,
        lastClose: now ? now.close : null,
        returnPct: ret == null ? null : +ret.toFixed(2),
      };
    });

    const wsum = (key) => {
      let num = 0, den = 0;
      for (const r of rows) {
        if (r.returnPct == null) continue;
        const w = r[key] || 0;
        num += w * r.returnPct; den += w;
      }
      return den > 0 ? +(num / den).toFixed(2) : null;
    };
    const retCap = wsum('weight');       // 시총가중 (기본 표시)
    const retEq = wsum('weightEq');      // 동일가중

    // 벤치마크: 같은 구간 KOSPI (overnight_predictions.kospi_close 시계열)
    //   ⚠️ kospi_close_change 가 아니라 close 시계열을 쓴다 — CLAUDE.md 벤치마크 주의.
    let bench = null;
    try {
      const { data: kp } = await supabase
        .from('overnight_predictions')
        .select('prediction_date,kospi_close')
        .lt('prediction_date', '2027-01-01')
        .not('kospi_close', 'is', null)
        .gte('prediction_date', buyDate || cur.rebalance_date)
        .order('prediction_date');
      if (kp && kp.length >= 2) {
        const a = kp[0].kospi_close, b = kp[kp.length - 1].kospi_close;
        if (a > 0) bench = { name: 'KOSPI', returnPct: +(((b - a) / a) * 100).toFixed(2), from: kp[0].prediction_date, to: kp[kp.length - 1].prediction_date };
      }
    } catch (e) { /* 벤치마크는 선택 사항 — 없으면 null */ }

    return res.status(200).json({
      success: true,
      current: {
        rebalanceDate: cur.rebalance_date,
        buyDate,
        buyDatePending: pending,   // true면 아직 매수 시점 전 (성과는 0)
        nextDate: cur.next_date,
        params: cur.params,
        universeSize: cur.universe_size,
        latestDate,
        holdings: rows,
      },
      performance: {
        returnCapWeighted: retCap,
        returnEqualWeighted: retEq,
        benchmark: bench,
        excessVsBenchmark: (retCap != null && bench) ? +(retCap - bench.returnPct).toFixed(2) : null,
      },
      history: rebs.map(r => ({
        rebalanceDate: r.rebalance_date,
        count: (r.holdings || []).length,
        universeSize: r.universe_size,
        params: r.params,
      })),
    });
  } catch (e) {
    console.error('❌ /api/portfolio:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
};
