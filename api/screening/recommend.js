// Vercel Serverless Function
// GET /api/screening/recommend
// Last updated: 2025-11-05 23:20 - Force redeploy to clear cache

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');

module.exports = async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONS 요청 처리 (CORS preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { market = 'ALL', limit, debug } = req.query;
    const limitNum = limit ? parseInt(limit) : undefined; // limit 없으면 전체 반환
    const result = await screener.screenAllStocks(market, limitNum);

    // v3.46: 기대수익 구간 매칭
    let expectations = [];
    try {
      if (supabase) {
        const { data } = await supabase.from('expected_return_stats').select('*');
        expectations = data || [];
      }
    } catch(e) {}

    if (expectations.length > 0) {
      const matchExpectedReturn = (stock) => {
        const grade = stock.recommendation?.grade;
        const whale = stock.advancedAnalysis?.indicators?.whale?.some(w => w.type === '매수고래') || false;
        let match = expectations.find(e => e.grade === grade && e.whale_detected === whale);
        if (!match) match = expectations.find(e => e.grade === grade && e.whale_detected === !whale);
        if (!match || match.median <= 0 || match.sample_count < 30) return null;
        return { days: match.optimal_days, p25: +match.p25, median: +match.median, p75: +match.p75, winRate: +match.win_rate, sampleCount: match.sample_count };
      };
      result.stocks.forEach(s => { s.expectedReturn = matchExpectedReturn(s); });
      if (result.top3) result.top3.forEach(s => { s.expectedReturn = matchExpectedReturn(s); });
      if (result.defenseTop3) result.defenseTop3.forEach(s => { s.expectedReturn = matchExpectedReturn(s); });
    }

    const response = {
      success: true,
      count: result.stocks.length,
      recommendations: result.stocks,
      top3: result.top3 || [],  // 🆕 TOP 3 추천 종목
      defenseTop3: result.defenseTop3 || [],  // v3.34: 방어 TOP 3
      metadata: result.metadata,
      timestamp: new Date().toISOString()
    };

    // 디버그 모드일 때 추가 정보 포함
    if (debug === 'true') {
      response.debug = {
        envCheck: {
          hasKisAppKey: !!process.env.KIS_APP_KEY,
          hasKisAppSecret: !!process.env.KIS_APP_SECRET
        },
        marketRequested: market,
        limitRequested: limitNum
      };
    }

    res.status(200).json(response);
  } catch (error) {
    console.error('Screening error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
}
