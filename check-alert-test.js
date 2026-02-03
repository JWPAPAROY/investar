const https = require('https');

// 1/30 데이터를 직접 조회해서 selectAlertTop3 + selectWhaleStocks 시뮬레이션
https.get('https://investar-xi.vercel.app/api/recommendations/performance?days=2', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const jan30 = (j.stocks || []).filter(s => s.recommendation_date === '2026-01-30');

    console.log('=== 1/30 종목 ===');
    jan30.forEach(s => {
      console.log(`${s.stock_name} | ${s.total_score}점 | ${s.recommendation_grade} | whale:${s.whale_detected}`);
    });

    // selectAlertTop3 시뮬레이션
    const eligible = jan30.filter(s => s.recommendation_grade !== '과열');
    const top3 = [];
    const wg = eligible.filter(s => s.whale_detected && s.total_score >= 50 && s.total_score < 80)
      .sort((a, b) => b.total_score - a.total_score);
    top3.push(...wg.slice(0, 3));
    if (top3.length < 3) {
      const hs = eligible.filter(s => s.total_score >= 70 && !top3.some(t => t.stock_code === s.stock_code))
        .sort((a, b) => b.total_score - a.total_score);
      top3.push(...hs.slice(0, 3 - top3.length));
    }

    console.log('\n=== TOP 3 ===');
    top3.forEach((s, i) => console.log(`${i+1}. ${s.stock_name} ${s.total_score}점 ${s.recommendation_grade}`));
    if (top3.length === 0) console.log('(없음)');

    // selectWhaleStocks 시뮬레이션 (과열 포함)
    const top3Codes = top3.map(s => s.stock_code);
    const whaleStocks = jan30.filter(s => s.whale_detected && !top3Codes.includes(s.stock_code))
      .sort((a, b) => b.total_score - a.total_score);

    console.log('\n=== 고래 감지 (TOP 3 제외) ===');
    whaleStocks.forEach((s, i) => {
      const tag = s.recommendation_grade === '과열' ? ' ⚠️과열' : '';
      console.log(`${i+1}. ${s.stock_name} ${s.total_score}점 ${s.recommendation_grade}${tag}`);
    });
    if (whaleStocks.length === 0) console.log('(없음)');
  });
}).on('error', e => console.error(e));
