const https = require('https');
https.get('https://investar-xi.vercel.app/api/recommendations/performance?days=1', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const stocks = (j.stocks || []).filter(s => s.recommendation_date === '2026-01-30');
    console.log('=== 1/30 저장 종목 (버그 수정 후) ===');
    stocks.forEach(s => {
      console.log(`${s.stock_name} | ${s.total_score}점 | ${s.recommendation_grade} | whale:${s.whale_detected} | accum:${s.accumulation_detected}`);
    });
    console.log('\n고래 감지:', stocks.filter(s => s.whale_detected).length, '개');
    console.log('과열:', stocks.filter(s => s.recommendation_grade === '과열').length, '개');
  });
}).on('error', e => console.error(e));
