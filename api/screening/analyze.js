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
    // Supabase에서 종목명 일괄 사전 조회
    const nameMap = new Map();
    try {
      const { data: knownNames } = await supabase
        .from('screening_recommendations')
        .select('stock_code, stock_name')
        .in('stock_code', uniqueCodes)
        .not('stock_name', 'like', '[%')
        .order('recommended_date', { ascending: false });
      knownNames?.forEach(r => {
        if (!nameMap.has(r.stock_code) && r.stock_name) {
          nameMap.set(r.stock_code, r.stock_name);
        }
      });
      console.log(`📋 Supabase 종목명 사전조회: ${nameMap.size}/${uniqueCodes.length}개 확보`);
    } catch (e) {
      console.warn('⚠️ Supabase 종목명 사전조회 실패:', e.message);
    }

    const results = [];
    const errors = [];

    // 순차 처리 - 하나의 프로세스에서 Rate Limiter 공유
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
          // 종목명이 누락되면 Supabase에서 보완
          if (!result.stockName || result.stockName.startsWith('[')) {
            const dbName = nameMap.get(code);
            if (dbName) result.stockName = dbName;
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
