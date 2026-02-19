// Vercel Serverless Function
// GET /api/screening/analyze?code=005930
// 단일 종목 분석 - 종목코드를 입력하면 스크리닝 결과 반환

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { code } = req.query;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ success: false, error: '6자리 종목코드를 입력해주세요 (예: 005930)' });
  }

  try {
    console.log(`🔍 단일 종목 분석: ${code}`);

    // analyzeStock() 내부에서 getCurrentPrice + getDailyChart + getInvestorData 호출
    // 중복 호출 방지를 위해 여기서 getCurrentPrice를 별도로 호출하지 않음
    let result = await screener.analyzeStock(code);

    // 실패 시 1회 재시도 (KIS API 간헐적 응답 실패 대응)
    if (!result) {
      console.log(`⚠️ [${code}] 1차 분석 실패, 500ms 후 재시도...`);
      await new Promise(r => setTimeout(r, 500));
      result = await screener.analyzeStock(code);
    }

    if (!result) {
      return res.status(404).json({
        success: false,
        error: `종목 ${code}: 분석에 실패했습니다. KIS API 응답 오류 또는 차트 데이터 부족일 수 있습니다. 잠시 후 다시 시도해주세요.`
      });
    }

    // 종목명이 [코드] 형태로 fallback된 경우 Supabase에서 이전 기록 조회
    if (!result.stockName || result.stockName.startsWith('[')) {
      try {
        const { data: prev } = await supabase
          .from('screening_recommendations')
          .select('stock_name')
          .eq('stock_code', code)
          .not('stock_name', 'like', '[%')
          .order('recommended_date', { ascending: false })
          .limit(1);
        if (prev && prev.length > 0 && prev[0].stock_name) {
          result.stockName = prev[0].stock_name;
          console.log(`✅ 종목명 Supabase 복구 [${code}] → ${prev[0].stock_name}`);
        }
      } catch (e) {
        console.warn(`⚠️ 종목명 Supabase 조회 실패:`, e.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('단일 종목 분석 실패:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
