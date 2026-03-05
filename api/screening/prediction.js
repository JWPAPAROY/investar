// Vercel Serverless Function
// GET /api/screening/prediction
// 해외 시장 기반 전망 데이터 (경량 — 스크리닝 없이 단독 호출 가능)

const overnightPredictor = require('../../backend/overnightPredictor');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const bypassCache = req.query.bypassCache === 'true';
    const prediction = await overnightPredictor.fetchAndPredict(bypassCache);
    res.status(200).json({ success: true, prediction });
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
