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

    // v3.46: 기대수익 통계 조회
    let expectations = [];
    try {
      const { data } = await supabase.from('expected_return_stats').select('*');
      expectations = data || [];
    } catch(e) {}

    // 1단계: 종목명 사전 확보 — Supabase 우선, 없으면 KIS API getStockName fallback
    const nameMap = new Map();

    // 1-1: Supabase에서 종목명 일괄 조회 (가장 빠르고 안정적)
    try {
      const { data: dbNames } = await supabase
        .from('screening_recommendations')
        .select('stock_code, stock_name')
        .in('stock_code', uniqueCodes)
        .not('stock_name', 'is', null)
        .order('recommendation_date', { ascending: false });
      dbNames?.forEach(r => {
        if (!nameMap.has(r.stock_code) && r.stock_name && !r.stock_name.startsWith('[')) {
          nameMap.set(r.stock_code, r.stock_name);
        }
      });
      console.log(`📋 Supabase 종목명: ${nameMap.size}개`);
    } catch (e) {
      console.warn('⚠️ Supabase 종목명 조회 실패:', e.message);
    }

    // 1-2: Supabase에 없는 종목은 KIS API getStockName으로 개별 조회
    const missingCodes = uniqueCodes.filter(c => !nameMap.has(c));
    for (const code of missingCodes) {
      try {
        const name = await kisApi.getStockName(code);
        if (name) {
          nameMap.set(code, name);
          console.log(`📋 KIS API 종목명: ${code} → ${name}`);
        }
      } catch (e) { /* ignore */ }
    }

    // kisApi 내부 캐시에도 저장 (getCurrentPrice에서 활용)
    if (!kisApi.stockNameCache) kisApi.stockNameCache = new Map();
    nameMap.forEach((name, code) => kisApi.stockNameCache.set(code, name));

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
          // 종목명 보완: 없거나 [코드] 형태이거나 6자리 숫자(코드 자체)인 경우
          if (!result.stockName || result.stockName.startsWith('[') || /^\d{6}$/.test(result.stockName)) {
            const name = nameMap.get(code);
            if (name) result.stockName = name;
          }
          // v3.46: 기대수익 구간 매칭
          if (expectations.length > 0) {
            const grade = result.recommendation?.grade;
            const whale = result.advancedAnalysis?.indicators?.whale?.some(w => w.type === '매수고래') || false;
            let match = expectations.find(e => e.grade === grade && e.whale_detected === whale);
            if (!match) match = expectations.find(e => e.grade === grade && e.whale_detected === !whale);
            if (match && match.median > 0 && match.sample_count >= 30) {
              result.expectedReturn = { days: match.optimal_days, p25: +match.p25, median: +match.median, p75: +match.p75, winRate: +match.win_rate, sampleCount: match.sample_count };
            }
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
