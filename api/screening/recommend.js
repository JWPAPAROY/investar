// Vercel Serverless Function
// GET /api/screening/recommend
// Last updated: 2025-11-05 23:20 - Force redeploy to clear cache

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');
const overnightPredictor = require('../../backend/overnightPredictor');

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

    // v3.46: 기대수익 구간 매칭 (v3.66: 종목별 유사 매칭 우선)
    let expectations = [];
    let stockExpected = [];
    try {
      if (supabase) {
        const [expRes, stockExpRes] = await Promise.all([
          supabase.from('expected_return_stats').select('*'),
          supabase.from('stock_expected_returns').select('*')
            .gte('recommendation_date', new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0]),
        ]);
        expectations = expRes.data || [];
        stockExpected = stockExpRes.data || [];
      }
    } catch(e) {}

    if (expectations.length > 0 || stockExpected.length > 0) {
      const matchExpectedReturn = (stock) => {
        // v3.66: 종목별 유사 매칭 우선
        const stockCode = stock.stockCode || stock.stock_code;
        if (stockExpected.length > 0 && stockCode) {
          const stockMatch = stockExpected.find(e => e.stock_code === stockCode);
          if (stockMatch && stockMatch.sample_count >= 20) {
            return {
              days: stockMatch.optimal_days, p25: +stockMatch.p25, median: +stockMatch.median,
              p75: +stockMatch.p75, winRate: +stockMatch.win_rate, sampleCount: stockMatch.sample_count,
              matchMethod: stockMatch.match_method, matchDimensions: stockMatch.match_dimensions,
              updatedAt: stockMatch.updated_at,
            };
          }
        }
        // fallback: 등급 기반
        const grade = stock.recommendation?.grade;
        const whale = stock.advancedAnalysis?.indicators?.whale?.some(w => w.type === '매수고래') || false;
        let match = expectations.find(e => e.grade === grade && e.whale_detected === whale);
        if (!match || match.sample_count < 5) {
          match = expectations.find(e => e.grade === grade && e.whale_detected === !whale);
        }
        if (!match || match.sample_count < 5) return null;
        return { days: match.optimal_days, p25: +match.p25, median: +match.median, p75: +match.p75, winRate: +match.win_rate, sampleCount: match.sample_count, matchMethod: 'grade_based', updatedAt: match.updated_at };
      };
      result.stocks.forEach(s => { s.expectedReturn = matchExpectedReturn(s); });
      if (result.top3) result.top3.forEach(s => { s.expectedReturn = matchExpectedReturn(s); });
      if (result.defenseTop3) result.defenseTop3.forEach(s => { s.expectedReturn = matchExpectedReturn(s); });
    }

    // 해외 시장 기반 전망 (캐시 활용 — 같은 날짜면 Supabase에서 읽기)
    let prediction = null;
    try {
      prediction = await overnightPredictor.fetchAndPredict();
    } catch (e) {
      console.warn('⚠️ 해외 전망 조회 실패:', e.message);
    }

    const response = {
      success: true,
      count: result.stocks.length,
      recommendations: result.stocks,
      top3: result.top3 || [],  // 🆕 TOP 3 추천 종목
      defenseTop3: result.defenseTop3 || [],  // v3.34: 방어 TOP 3
      prediction: prediction || undefined,  // 해외 시장 기반 전망
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
