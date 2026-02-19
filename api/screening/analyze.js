// Vercel Serverless Function
// GET /api/screening/analyze?code=005930
// 단일 종목 분석 - 종목코드를 입력하면 스크리닝 결과 반환

const screener = require('../../backend/screening');

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
    const result = await screener.analyzeStock(code);

    if (!result) {
      return res.status(404).json({ success: false, error: `종목 ${code}을 찾을 수 없거나 분석에 실패했습니다.` });
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
