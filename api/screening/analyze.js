// Vercel Serverless Function
// GET /api/screening/analyze?codes=005930,000660,402340
// 종목 분석 - 여러 종목코드를 한 번에 분석 (단일 프로세스, Rate Limiter 공유)

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  // codes (복수) 또는 code (단일) 파라미터 지원
  const codesParam = req.query.codes || req.query.code || '';
  const codes = codesParam.match(/\d{6}/g);
  if (!codes || codes.length === 0) {
    return res.status(400).json({ success: false, error: '6자리 종목코드를 입력해주세요 (예: codes=005930,000660)' });
  }

  const uniqueCodes = [...new Set(codes)].slice(0, 15); // 최대 15개
  console.log(`🔍 종목 분석: ${uniqueCodes.length}개 [${uniqueCodes.join(', ')}]`);

  try {
    const kisApi = require('../../backend/kisApi');

    // 1단계: 종목명 사전 확보 (스크리닝 탭과 동일 — 4종 랭킹 × 2시장 = 8 API calls)
    const nameMap = new Map();
    try {
      const rankResults = await Promise.all([
        kisApi.getVolumeSurgeRank('KOSPI', 50).catch(() => []),
        kisApi.getVolumeSurgeRank('KOSDAQ', 50).catch(() => []),
        kisApi.getTradingValueRank('KOSPI', 50).catch(() => []),
        kisApi.getTradingValueRank('KOSDAQ', 50).catch(() => []),
        kisApi.getPriceChangeRank('KOSPI', 50).catch(() => []),
        kisApi.getPriceChangeRank('KOSDAQ', 50).catch(() => []),
        kisApi.getVolumeRank('KOSPI', 50).catch(() => []),
        kisApi.getVolumeRank('KOSDAQ', 50).catch(() => [])
      ]);
      rankResults.flat().forEach(item => {
        if (item.code && item.name) nameMap.set(item.code, item.name);
      });
      // kisApi 내부 캐시도 채워서 getCurrentPrice()에서 바로 사용
      if (!kisApi.stockNameCache) kisApi.stockNameCache = new Map();
      nameMap.forEach((name, code) => kisApi.stockNameCache.set(code, name));
      console.log(`📋 랭킹 API 종목명 확보: ${nameMap.size}개`);
    } catch (e) {
      console.warn('⚠️ 랭킹 API 종목명 조회 실패:', e.message);
    }

    // 랭킹에 없는 종목은 Supabase에서 보완
    const missingCodes = uniqueCodes.filter(c => !nameMap.has(c));
    if (missingCodes.length > 0) {
      try {
        const { data: dbNames } = await supabase
          .from('screening_recommendations')
          .select('stock_code, stock_name')
          .in('stock_code', missingCodes)
          .not('stock_name', 'like', '[%')
          .order('recommended_date', { ascending: false });
        dbNames?.forEach(r => {
          if (!nameMap.has(r.stock_code) && r.stock_name) {
            nameMap.set(r.stock_code, r.stock_name);
          }
        });
        console.log(`📋 Supabase 보완: +${dbNames?.length || 0}개 → 총 ${nameMap.size}개`);
      } catch (e) { /* ignore */ }
    }

    // 2단계: 종목 순차 분석
    const results = [];
    const errors = [];

    for (const code of uniqueCodes) {
      try {
        let result = await screener.analyzeStock(code);

        // 실패 시 1회 재시도
        if (!result) {
          console.log(`⚠️ [${code}] 1차 분석 실패, 500ms 후 재시도...`);
          await new Promise(r => setTimeout(r, 500));
          result = await screener.analyzeStock(code);
        }

        if (result) {
          // 종목명 보완
          if (!result.stockName || result.stockName.startsWith('[')) {
            const name = nameMap.get(code);
            if (name) result.stockName = name;
          }
          results.push(result);
        } else {
          errors.push({ code, error: 'KIS API 응답 실패 또는 차트 데이터 부족' });
        }
      } catch (err) {
        errors.push({ code, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      data: results,
      errors: errors.length > 0 ? errors : undefined,
      total: uniqueCodes.length,
      analyzed: results.length
    });
  } catch (error) {
    console.error('종목 분석 실패:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
