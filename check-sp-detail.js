const https = require('https');

const url = 'https://investar-xi.vercel.app/api/recommendations/performance?days=14';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const sp = j.stocks
      .filter(s => s.recommendation_grade === 'S+')
      .sort((a, b) => a.current_return - b.current_return);

    console.log('=== S+ 등급 종목 상세 (수익률 오름차순) ===\n');
    sp.forEach((s, i) => {
      const emoji = s.current_return >= 0 ? '✅' : '❌';
      console.log(`${i+1}. ${s.stock_name} (${s.stock_code})`);
      console.log(`   점수: ${s.total_score} | 추천일: ${s.recommendation_date}`);
      console.log(`   추천가: ${s.recommended_price} → 현재가: ${s.current_price}`);
      console.log(`   수익률: ${s.current_return.toFixed(2)}% ${emoji}`);
      console.log(`   고래: ${s.whale_detected} | 매집: ${s.accumulation_detected}`);
      console.log('');
    });

    // 통계
    const rets = sp.map(s => s.current_return);
    const losers = sp.filter(s => s.current_return < -5);
    console.log(`--- 요약 ---`);
    console.log(`총 ${sp.length}개 중 -5% 이하: ${losers.length}개`);
    if (losers.length > 0) {
      const loserAvg = losers.reduce((a, b) => a + b.current_return, 0) / losers.length;
      console.log(`폭락 종목 평균: ${loserAvg.toFixed(2)}%`);
    }
    const winners = sp.filter(s => s.current_return > 0);
    if (winners.length > 0) {
      const winAvg = winners.reduce((a, b) => a + b.current_return, 0) / winners.length;
      console.log(`수익 종목 평균: +${winAvg.toFixed(2)}%`);
    }
  });
}).on('error', e => console.error(e));
