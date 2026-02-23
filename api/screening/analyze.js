// Vercel Serverless Function
// GET /api/screening/analyze?codes=005930,000660,402340
// 종목 분석 - 여러 종목코드를 한 번에 분석 (단일 프로세스, Rate Limiter 공유)
// v3.42: 불필요한 8개 랭킹 API 제거 → getCurrentPrice 내장 종목명 + Supabase fallback

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
    // 1단계: Supabase에서 종목명 사전 확보 (API 호출 없이 DB 조회만)
    const nameMap = new Map();
    try {
      const { data: dbNames } = await supabase
        .from('screening_recommendations')
        .select('stock_code, stock_name')
        .in('stock_code', uniqueCodes)
        .not('stock_name', 'like', '[%')
        .order('recommended_date', { ascending: false });
      dbNames?.forEach(r => {
        if (!nameMap.has(r.stock_code) && r.stock_name) {
          nameMap.set(r.stock_code, r.stock_name);
        }
      });
      if (nameMap.size > 0) {
        // kisApi 내부 캐시에 미리 저장 → getCurrentPrice()에서 활용
        const kisApi = require('../../backend/kisApi');
        if (!kisApi.stockNameCache) kisApi.stockNameCache = new Map();
        nameMap.forEach((name, code) => kisApi.stockNameCache.set(code, name));
      }
      console.log(`📋 Supabase 종목명 확보: ${nameMap.size}/${uniqueCodes.length}개`);
    } catch (e) {
      console.warn('⚠️ Supabase 종목명 조회 실패:', e.message);
    }

    // 2단계: 종목 순차 분석 (종목당 3 API: getCurrentPrice + getDailyChart + getInvestorData)
    // getCurrentPrice 내부에서 hts_kor_isnm → CTPF1002R fallback으로 종목명 자동 확보
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
          // 종목명 보완 (getCurrentPrice에서 못 가져온 경우 Supabase fallback)
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
