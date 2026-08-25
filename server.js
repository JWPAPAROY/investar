/**
 * Investar 로컬 개발 서버
 * Vercel Serverless Functions를 로컬에서 테스트하기 위한 Express 서버
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// 미들웨어
app.use(cors());
app.use(express.json());

// 정적 파일 제공
app.use(express.static('.'));

// API 라우트 매핑 (Vercel Serverless Functions → Express Routes)
const apiRoutes = {
  '/api/health': require('./api/health'),
  '/api/screening/recommend': require('./api/screening/recommend'),
  // v3.96: /api/recommendations/save 제거 — 인증 없이 호출자가 준 행을
  //   screening_recommendations(TOP3·알림·진단의 원천)에 그대로 쓰는 엔드포인트였고
  //   호출자는 0개였다(index.html의 saveRecommendationsToSupabase도 죽은 함수).
  '/api/recommendations/performance': require('./api/recommendations/performance'),
  '/api/recommendations/update-prices': require('./api/recommendations/update-prices'),
  '/api/stocks': require('./api/stocks/index')
};

// 라우트 등록
Object.entries(apiRoutes).forEach(([route, handler]) => {
  app.get(route, handler);
  app.post(route, handler); // POST도 지원
});

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 핸들러
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    path: req.path
  });
});

// 에러 핸들러
app.use((err, req, res, next) => {
  console.error('서버 에러:', err);
  res.status(500).json({
    success: false,
    error: err.message
  });
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🚀 Investar 로컬 서버 실행 중`);
  console.log(`========================================`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/health`);
  console.log(`🔥 스크리닝: http://localhost:${PORT}/api/screening/recommend?limit=3`);
  console.log(`========================================\n`);
});

module.exports = app;
