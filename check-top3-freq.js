const https = require('https');
const url = 'https://investar-xi.vercel.app/api/recommendations/performance?days=14';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const stocks = j.stocks || [];

    // 날짜별 그룹핑
    const byDate = {};
    stocks.forEach(s => {
      const d = s.recommendation_date;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(s);
    });

    const dates = Object.keys(byDate).sort();
    console.log('=== 일자별 TOP 3 후보 분석 (S+ 제외 vs 포함) ===\n');

    let daysWithTop3 = 0;
    let daysWithTop3NoSP = 0;
    let allTop3 = [];
    let allTop3NoSP = [];

    dates.forEach(d => {
      const dayStocks = byDate[d];

      // S+ 포함 (현재 로직)
      const wg = dayStocks.filter(s => s.whale_detected && s.total_score >= 50 && s.total_score < 80)
        .sort((a, b) => b.total_score - a.total_score);
      const top3 = [...wg.slice(0, 3)];
      if (top3.length < 3) {
        const hs = dayStocks.filter(s => s.total_score >= 70 && !top3.some(t => t.stock_code === s.stock_code))
          .sort((a, b) => b.total_score - a.total_score);
        top3.push(...hs.slice(0, 3 - top3.length));
      }

      // S+ 제외
      const noSP = dayStocks.filter(s => s.recommendation_grade !== 'S+');
      const wgNoSP = noSP.filter(s => s.whale_detected && s.total_score >= 50 && s.total_score < 80)
        .sort((a, b) => b.total_score - a.total_score);
      const top3NoSP = [...wgNoSP.slice(0, 3)];
      if (top3NoSP.length < 3) {
        const hsNoSP = noSP.filter(s => s.total_score >= 70 && !top3NoSP.some(t => t.stock_code === s.stock_code))
          .sort((a, b) => b.total_score - a.total_score);
        top3NoSP.push(...hsNoSP.slice(0, 3 - top3NoSP.length));
      }

      if (top3.length > 0) daysWithTop3++;
      if (top3NoSP.length > 0) daysWithTop3NoSP++;
      allTop3.push(...top3);
      allTop3NoSP.push(...top3NoSP);

      const spCount = dayStocks.filter(s => s.recommendation_grade === 'S+').length;
      const spInTop3 = top3.filter(s => s.recommendation_grade === 'S+').length;

      console.log(`${d}: 전체 ${dayStocks.length}개 | S+ ${spCount}개 | TOP3(포함): ${top3.length}개(S+:${spInTop3}) | TOP3(제외): ${top3NoSP.length}개`);
    });

    console.log(`\n=== 요약 ===`);
    console.log(`분석 기간: ${dates.length}일\n`);

    // S+ 포함
    const rets = allTop3.map(s => s.current_return || 0);
    const wins = rets.filter(r => r > 0).length;
    const avg = rets.length > 0 ? rets.reduce((a,b) => a+b, 0) / rets.length : 0;
    const crashes = allTop3.filter(s => (s.current_return || 0) < -5);
    console.log('[S+ 포함 시]');
    console.log(`  추천 발생일: ${daysWithTop3}/${dates.length}일 (${(daysWithTop3/dates.length*100).toFixed(0)}%)`);
    console.log(`  총 추천 종목: ${allTop3.length}개`);
    console.log(`  승률: ${allTop3.length > 0 ? (wins/allTop3.length*100).toFixed(1) : 0}%`);
    console.log(`  평균 수익률: ${avg.toFixed(2)}%`);
    console.log(`  -5% 이하 폭락: ${crashes.length}개 (${(crashes.length/allTop3.length*100).toFixed(1)}%)`);

    // S+ 제외
    const retsNoSP = allTop3NoSP.map(s => s.current_return || 0);
    const winsNoSP = retsNoSP.filter(r => r > 0).length;
    const avgNoSP = retsNoSP.length > 0 ? retsNoSP.reduce((a,b) => a+b, 0) / retsNoSP.length : 0;
    const crashesNoSP = allTop3NoSP.filter(s => (s.current_return || 0) < -5);
    console.log(`\n[S+ 제외 시]`);
    console.log(`  추천 발생일: ${daysWithTop3NoSP}/${dates.length}일 (${(daysWithTop3NoSP/dates.length*100).toFixed(0)}%)`);
    console.log(`  총 추천 종목: ${allTop3NoSP.length}개`);
    console.log(`  승률: ${allTop3NoSP.length > 0 ? (winsNoSP/allTop3NoSP.length*100).toFixed(1) : 0}%`);
    console.log(`  평균 수익률: ${avgNoSP.toFixed(2)}%`);
    console.log(`  -5% 이하 폭락: ${crashesNoSP.length}개 (${allTop3NoSP.length > 0 ? (crashesNoSP.length/allTop3NoSP.length*100).toFixed(1) : 0}%)`);

    // 차이
    console.log(`\n[비교]`);
    console.log(`  추천 빈도: ${daysWithTop3NoSP} vs ${daysWithTop3}일`);
    console.log(`  승률: ${allTop3NoSP.length > 0 ? (winsNoSP/allTop3NoSP.length*100).toFixed(1) : 0}% vs ${allTop3.length > 0 ? (wins/allTop3.length*100).toFixed(1) : 0}%`);
    console.log(`  수익률: ${avgNoSP.toFixed(2)}% vs ${avg.toFixed(2)}%`);
    console.log(`  폭락률: ${allTop3NoSP.length > 0 ? (crashesNoSP.length/allTop3NoSP.length*100).toFixed(1) : 0}% vs ${(crashes.length/allTop3.length*100).toFixed(1)}%`);

    // S+ TOP3 상세
    console.log(`\n=== TOP3에 포함된 S+ 종목 상세 ===`);
    const spInAll = allTop3.filter(s => s.recommendation_grade === 'S+');
    if (spInAll.length > 0) {
      const spRets = spInAll.map(s => s.current_return || 0);
      const spWins = spRets.filter(r => r > 0).length;
      const spAvg = spRets.reduce((a,b) => a+b, 0) / spRets.length;
      console.log(`  개수: ${spInAll.length}개 | 승률: ${(spWins/spInAll.length*100).toFixed(1)}% | 평균: ${spAvg.toFixed(2)}%`);
      spInAll.sort((a,b) => (a.current_return||0) - (b.current_return||0)).forEach(s => {
        const r = (s.current_return || 0);
        console.log(`  ${s.stock_name}(${s.stock_code}) ${s.total_score}점 | ${r.toFixed(1)}% ${r>=0?'O':'X'} | whale:${s.whale_detected} [${s.recommendation_date}]`);
      });
    } else {
      console.log('  TOP3에 S+ 종목 없음');
    }

    // S+ 제외 TOP3 종목 상세
    console.log(`\n=== S+ 제외 TOP3 종목 상세 ===`);
    allTop3NoSP.sort((a,b) => a.recommendation_date.localeCompare(b.recommendation_date) || (a.current_return||0) - (b.current_return||0)).forEach(s => {
      const r = (s.current_return || 0);
      console.log(`  [${s.recommendation_date}] ${s.stock_name} ${s.total_score}점 ${s.recommendation_grade} | ${r.toFixed(1)}% ${r>=0?'O':'X'} | whale:${s.whale_detected}`);
    });
  });
}).on('error', e => console.error(e));
