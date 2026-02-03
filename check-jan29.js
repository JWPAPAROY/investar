const https = require('https');
https.get('https://investar-xi.vercel.app/api/recommendations/performance?days=3', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const jan29 = (j.stocks || []).filter(s => s.recommendation_date === '2026-01-29');
    console.log('=== 1/29 저장 종목 ===');
    console.log('총', jan29.length, '개\n');
    jan29.forEach(s => {
      console.log(`${s.stock_name} | ${s.total_score}점 | ${s.recommendation_grade} | whale:${s.whale_detected}`);
    });
    console.log('\n고래 감지:', jan29.filter(s => s.whale_detected).length, '개');
    console.log('S+:', jan29.filter(s => s.recommendation_grade === 'S+').length, '개');
    console.log('비S+:', jan29.filter(s => s.recommendation_grade !== 'S+').length, '개');
  });
}).on('error', e => console.error(e));
