// Vercel Serverless Function
// GET /api/screening/prediction
// 해외 시장 기반 전망 데이터 (경량 — 스크리닝 없이 단독 호출 가능)

const overnightPredictor = require('../../backend/overnightPredictor');
const { macroView, sensView } = require('../_macroView'); // ?view=macro|sens — 시장 흐름 탭(2026-11-15). 함수 한도 때문에 여기에 얹는다

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  if (req.query && req.query.view === 'macro') return macroView(res);
  if (req.query && req.query.view === 'sens') return sensView(req, res);

  try {
    const bypassCache = req.query.bypassCache === 'true';
    const prediction = await overnightPredictor.fetchAndPredict(bypassCache);
    res.status(200).json({ success: true, prediction });
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
