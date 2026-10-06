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
// v3.98: 무상증자 신호는 별도 함수로 둘 수 없다 — Vercel Hobby 12함수 한도에 걸린다
//   (api/bonus/index.js 를 추가한 배포 d218abf 실패). ?view=bonus 로 여기에 얹는다.
const { bonusView } = require('../_bonusView');
const P = require('../../backend/portfolio');

// 2026-10-06: 전략 2개 병행. ?strategy=pbr_lowvol(기본) | ep_lowturn
//   ep_lowturn은 삼성전자·SK하이닉스를 뺀 "나머지 시장" 전략이라 벤치마크도 두 종목을 뺀
//   KOSPI 시총가중 수익을 같은 구간으로 직접 계산한다(backend/portfolio.js capWeightedReturn).
async function fetchDay(date) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('market_flow_daily')
      .select('stock_code,close,market_cap,krx_market_cap')
      .eq('trade_date', date).order('stock_code').range(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out.map(r => ({ stock_code: r.stock_code, close: r.close, cap: r.krx_market_cap ?? r.market_cap }));
}
async function kospiExMega(d0, d1) {
  const codes = new Set();
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('stock_master').select('stock_code')
      .eq('market', 'KOSPI').order('stock_code').range(f, f + 999);
    if (error) throw new Error(error.message);
    data.forEach(r => codes.add(r.stock_code));
    if (data.length < 1000) break;
  }
  const [a, b] = await Promise.all([fetchDay(d0), fetchDay(d1)]);
  return P.capWeightedReturn(a, b, codes, P.MEGA);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return res.status(503).json({ success: false, error: 'Supabase 미설정' });

  // 📢 무상증자 실전 신호 — 포트폴리오와 무관한 별도 라인이지만 함수 한도 때문에 같은 경로를 쓴다
  if (req.query && req.query.view === 'bonus') return bonusView(res);

  const strategy = (req.query && req.query.strategy) || 'pbr_lowvol';
  if (!P.STRATEGIES[strategy]) return res.status(400).json({ success: false, error: `알 수 없는 전략: ${strategy}` });

  try {
    const q = () => supabase.from('portfolio_rebalances').select('*')
      .order('rebalance_date', { ascending: false }).limit(12);
    let { data: rebs, error: rErr } = await q().eq('strategy', strategy);
    // strategy 컬럼 마이그레이션(supabase-portfolio-strategy.sql) 전: 기존 전략만 존재
    if (rErr && /strategy/.test(rErr.message)) {
      if (strategy !== 'pbr_lowvol') rebs = [];
      else ({ data: rebs, error: rErr } = await q());
      if (strategy !== 'pbr_lowvol') rErr = null;
    }
    if (rErr) throw new Error(rErr.message);
    if (!rebs || !rebs.length) {
      return res.status(200).json({
        success: true, strategy, current: null, history: [],
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
    const so = P.STRATEGIES[strategy];
    if (so.bench === 'kospi_ex_mega') {
      try {
        if (buyDate && latestDate && latestDate > buyDate) {
          const r = await kospiExMega(buyDate, latestDate);
          if (r != null) bench = { name: 'KOSPI(삼성전자·SK하이닉스 제외)', returnPct: +r.toFixed(2), from: buyDate, to: latestDate };
        }
      } catch (e) { /* 벤치마크는 선택 사항 */ }
    } else {
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
    }

    return res.status(200).json({
      success: true,
      strategy,
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
        // 전략의 기본 비중(cap/eq)으로 초과를 계산한다 — ep_lowturn은 동일가중이 검증된 설정
        excessVsBenchmark: (() => {
          const base = so.weight === 'eq' ? retEq : retCap;
          return (base != null && bench) ? +(base - bench.returnPct).toFixed(2) : null;
        })(),
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
