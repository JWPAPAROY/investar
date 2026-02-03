const https = require('https');

const url = 'https://investar-xi.vercel.app/api/recommendations/performance?days=14';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const stocks = j.stocks || [];

    // S+ 종목을 경로별로 분류
    const splus = stocks.filter(s => s.recommendation_grade === 'S+');

    // 경로 1: 과열+황금구간 (50-79점인데 S+)
    const route1 = splus.filter(s => s.total_score >= 50 && s.total_score < 80);
    // 경로 2: 90점+ (진짜 S+)
    const route2 = splus.filter(s => s.total_score >= 90);

    function stats(arr, label) {
      if (arr.length === 0) {
        console.log(`\n${label}: 0개\n`);
        return;
      }
      const rets = arr.map(s => s.current_return || 0);
      const wins = rets.filter(r => r > 0).length;
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      const maxR = Math.max(...rets);
      const minR = Math.min(...rets);
      const losers = arr.filter(s => (s.current_return || 0) < -5);

      console.log(`\n=== ${label} ===`);
      console.log(`개수: ${arr.length}개`);
      console.log(`승률: ${(wins / arr.length * 100).toFixed(1)}%`);
      console.log(`평균 수익률: ${avg.toFixed(2)}%`);
      console.log(`최대: ${maxR.toFixed(1)}% | 최소: ${minR.toFixed(1)}%`);
      console.log(`-5% 이하 폭락: ${losers.length}개`);

      if (losers.length > 0) {
        const loserAvg = losers.reduce((a, b) => a + (b.current_return || 0), 0) / losers.length;
        console.log(`폭락 종목 평균: ${loserAvg.toFixed(2)}%`);
      }

      // 폭락 종목 제외 시
      const noLosers = arr.filter(s => (s.current_return || 0) > -5);
      if (noLosers.length > 0 && losers.length > 0) {
        const nlRets = noLosers.map(s => s.current_return || 0);
        const nlWins = nlRets.filter(r => r > 0).length;
        const nlAvg = nlRets.reduce((a, b) => a + b, 0) / nlRets.length;
        console.log(`\n  [폭락 제외 시]`);
        console.log(`  개수: ${noLosers.length}개 | 승률: ${(nlWins / noLosers.length * 100).toFixed(1)}% | 평균: ${nlAvg.toFixed(2)}%`);
      }

      console.log(`\n종목 목록:`);
      arr.sort((a, b) => (a.current_return || 0) - (b.current_return || 0)).forEach(s => {
        const r = (s.current_return || 0);
        const emoji = r >= 0 ? '✅' : '❌';
        const whale = s.whale_detected ? '🐋' : '';
        console.log(`  ${s.stock_name}(${s.stock_code}) ${s.total_score}점 | ${s.recommended_price}→${s.current_price} | ${r.toFixed(1)}% ${emoji} ${whale} [${s.recommendation_date}]`);
      });
    }

    // 비교 대상: B등급
    const bGrade = stocks.filter(s => s.recommendation_grade === 'B');
    // A등급
    const aGrade = stocks.filter(s => s.recommendation_grade === 'A');

    console.log('========================================');
    console.log('S+ 등급 경로별 성과 분석 (14일)');
    console.log('========================================');

    stats(route1, '경로 1: 과열 + 황금구간 (50-79점)');
    stats(route2, '경로 2: 90점+ (순수 S+)');
    stats(bGrade, 'B등급 (45-59점, 비교용)');
    stats(aGrade, 'A등급 (60-74점, 비교용)');

    // 고래 감지 여부별 분석
    const whaleStocks = stocks.filter(s => s.whale_detected);
    const nonWhaleStocks = stocks.filter(s => !s.whale_detected);
    stats(whaleStocks, '고래 감지 종목 (전체)');

    // 종합 요약
    console.log('\n========================================');
    console.log('종합 요약');
    console.log('========================================');

    function summary(arr, label) {
      if (arr.length === 0) return;
      const rets = arr.map(s => s.current_return || 0);
      const wins = rets.filter(r => r > 0).length;
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      console.log(`${label}: ${arr.length}개 | 승률 ${(wins/arr.length*100).toFixed(0)}% | 평균 ${avg.toFixed(2)}%`);
    }

    summary(route1, '과열+황금구간(S+)');
    summary(route2, '90점+(S+)       ');
    summary(aGrade, 'A등급(60-74)     ');
    summary(bGrade, 'B등급(45-59)     ');
    summary(whaleStocks, '고래 감지        ');
  });
}).on('error', e => console.error(e));
