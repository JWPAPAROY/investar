require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  // 1. is_top3인 종목 전체 조회
  let allTop3 = [], from = 0;
  while (true) {
    const { data } = await supabase.from('screening_recommendations')
      .select('id,stock_code,stock_name,recommendation_date,total_score,recommendation_grade,whale_detected,recommended_price,is_top3')
      .eq('is_top3', true)
      .order('recommendation_date', { ascending: false })
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allTop3 = allTop3.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log('총 is_top3 종목:', allTop3.length);

  // 날짜별 그룹핑 → 점수 내림차순 정렬 → 순위 매기기
  const byDate = {};
  allTop3.forEach(s => {
    if (!byDate[s.recommendation_date]) byDate[s.recommendation_date] = [];
    byDate[s.recommendation_date].push(s);
  });

  const dates = Object.keys(byDate).sort();
  console.log('추천일 수:', dates.length);

  // 각 날짜에서 점수 내림차순 → rank 1,2,3
  const ranked = [];
  dates.forEach(date => {
    const stocks = byDate[date].sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
    stocks.forEach((s, i) => {
      ranked.push({ rank: i + 1, ...s });
    });
  });

  // 각 종목의 수익률 조회 (days 1~15)
  const ids = ranked.map(r => r.id);
  let allPrices = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const { data } = await supabase.from('recommendation_daily_prices')
      .select('recommendation_id,days_since_recommendation,cumulative_return')
      .in('recommendation_id', batch)
      .gte('days_since_recommendation', 1)
      .lte('days_since_recommendation', 15);
    if (data) allPrices = allPrices.concat(data);
  }

  const priceMap = {};
  allPrices.forEach(p => {
    if (!priceMap[p.recommendation_id]) priceMap[p.recommendation_id] = {};
    priceMap[p.recommendation_id][p.days_since_recommendation] = p.cumulative_return;
  });

  // 순위별 성과 분석
  const rankStats = { 1: [], 2: [], 3: [] };

  ranked.forEach(r => {
    if (r.rank > 3) return;
    const prices = priceMap[r.id];
    if (!prices) return;

    let maxReturn = -Infinity, maxDay = 0;
    let day3 = null, day5 = null, day7 = null, day10 = null;

    for (let d = 1; d <= 15; d++) {
      if (prices[d] !== undefined) {
        if (prices[d] > maxReturn) { maxReturn = prices[d]; maxDay = d; }
        if (d === 3) day3 = prices[d];
        if (d === 5) day5 = prices[d];
        if (d === 7) day7 = prices[d];
        if (d === 10) day10 = prices[d];
      }
    }

    const validDays = Object.keys(prices).map(Number).filter(d => d >= 1 && d <= 15);
    const lastDay = validDays.length > 0 ? Math.max(...validDays) : 0;
    const lastReturn = lastDay > 0 ? prices[lastDay] : null;

    if (maxReturn > -Infinity && lastReturn !== null) {
      rankStats[r.rank].push({
        name: r.stock_name,
        date: r.recommendation_date,
        score: r.total_score,
        grade: r.recommendation_grade,
        maxReturn, maxDay, lastReturn, lastDay,
        day3, day5, day7, day10
      });
    }
  });

  // 출력
  console.log('\n=============================================================');
  console.log('               TOP1 vs TOP2 vs TOP3 성과 비교');
  console.log('=============================================================');

  [1, 2, 3].forEach(rank => {
    const stats = rankStats[rank];
    if (stats.length === 0) return;

    const n = stats.length;
    const avgMax = stats.reduce((s, r) => s + r.maxReturn, 0) / n;
    const avgLast = stats.reduce((s, r) => s + r.lastReturn, 0) / n;
    const winMax = stats.filter(r => r.maxReturn > 0).length;
    const winLast = stats.filter(r => r.lastReturn > 0).length;
    const lossOver5 = stats.filter(r => r.lastReturn <= -5).length;
    const gainOver10 = stats.filter(r => r.maxReturn >= 10).length;
    const gainOver20 = stats.filter(r => r.maxReturn >= 20).length;

    const sortedMax = [...stats.map(r => r.maxReturn)].sort((a, b) => a - b);
    const medianMax = sortedMax[Math.floor(n / 2)];
    const sortedLast = [...stats.map(r => r.lastReturn)].sort((a, b) => a - b);
    const medianLast = sortedLast[Math.floor(n / 2)];

    const d3 = stats.filter(r => r.day3 !== null);
    const d5 = stats.filter(r => r.day5 !== null);
    const d7 = stats.filter(r => r.day7 !== null);
    const d10 = stats.filter(r => r.day10 !== null);

    console.log('\n--- TOP' + rank + ' (N=' + n + ') ---');
    console.log('  최고수익률: 평균 +' + avgMax.toFixed(2) + '% | 중앙값 +' + medianMax.toFixed(2) + '%');
    console.log('  최종수익률: 평균 ' + (avgLast >= 0 ? '+' : '') + avgLast.toFixed(2) + '% | 중앙값 ' + (medianLast >= 0 ? '+' : '') + medianLast.toFixed(2) + '%');
    console.log('  최고수익 승률: ' + (winMax / n * 100).toFixed(0) + '% (' + winMax + '/' + n + ')');
    console.log('  최종수익 승률: ' + (winLast / n * 100).toFixed(0) + '% (' + winLast + '/' + n + ')');
    console.log('  +10% 달성: ' + (gainOver10 / n * 100).toFixed(0) + '% (' + gainOver10 + '/' + n + ')');
    console.log('  +20% 달성: ' + (gainOver20 / n * 100).toFixed(0) + '% (' + gainOver20 + '/' + n + ')');
    console.log('  -5% 손절: ' + (lossOver5 / n * 100).toFixed(0) + '% (' + lossOver5 + '/' + n + ')');
    if (d3.length > 0) console.log('  day3 평균: ' + (d3.reduce((s, r) => s + r.day3, 0) / d3.length).toFixed(2) + '%');
    if (d5.length > 0) console.log('  day5 평균: ' + (d5.reduce((s, r) => s + r.day5, 0) / d5.length).toFixed(2) + '%');
    if (d7.length > 0) console.log('  day7 평균: ' + (d7.reduce((s, r) => s + r.day7, 0) / d7.length).toFixed(2) + '%');
    if (d10.length > 0) console.log('  day10 평균: ' + (d10.reduce((s, r) => s + r.day10, 0) / d10.length).toFixed(2) + '%');
  });

  // 분산투자 시뮬레이션
  console.log('\n=============================================================');
  console.log('               몰빵(TOP1) vs 분산(TOP3) 시뮬레이션');
  console.log('=============================================================');

  let top1Total = 0, top1Count = 0, top1Wins = 0;
  let diversifiedTotal = 0, diversifiedCount = 0, diversifiedWins = 0;

  dates.forEach(date => {
    const dayStocks = byDate[date].sort((a, b) => (b.total_score || 0) - (a.total_score || 0));

    // TOP1
    const top1Prices = priceMap[dayStocks[0]?.id];
    if (top1Prices) {
      const validDays = Object.keys(top1Prices).map(Number).filter(d => d >= 1 && d <= 15);
      if (validDays.length > 0) {
        const lastDay = Math.max(...validDays);
        const ret = top1Prices[lastDay];
        top1Total += ret;
        top1Count++;
        if (ret > 0) top1Wins++;
      }
    }

    // 3종목 균등 분산
    let dayReturn = 0, dayN = 0;
    dayStocks.slice(0, 3).forEach(s => {
      const prices = priceMap[s.id];
      if (prices) {
        const validDays = Object.keys(prices).map(Number).filter(d => d >= 1 && d <= 15);
        if (validDays.length > 0) {
          const lastDay = Math.max(...validDays);
          dayReturn += prices[lastDay];
          dayN++;
        }
      }
    });
    if (dayN > 0) {
      const avgDayReturn = dayReturn / dayN;
      diversifiedTotal += avgDayReturn;
      diversifiedCount++;
      if (avgDayReturn > 0) diversifiedWins++;
    }
  });

  console.log('\n몰빵 (TOP1만):');
  console.log('  거래일: ' + top1Count + '일');
  console.log('  평균 수익률: ' + (top1Total / top1Count).toFixed(2) + '%');
  console.log('  승률: ' + (top1Wins / top1Count * 100).toFixed(0) + '% (' + top1Wins + '/' + top1Count + ')');
  console.log('  누적 수익률: ' + top1Total.toFixed(2) + '%');

  console.log('\n분산 (TOP3 균등):');
  console.log('  거래일: ' + diversifiedCount + '일');
  console.log('  평균 수익률: ' + (diversifiedTotal / diversifiedCount).toFixed(2) + '%');
  console.log('  승률: ' + (diversifiedWins / diversifiedCount * 100).toFixed(0) + '% (' + diversifiedWins + '/' + diversifiedCount + ')');
  console.log('  누적 수익률: ' + diversifiedTotal.toFixed(2) + '%');

  // 개별 TOP1 종목 상세
  console.log('\n=============================================================');
  console.log('               TOP1 종목 상세 (최근순)');
  console.log('=============================================================');
  const top1s = rankStats[1].sort((a, b) => b.date.localeCompare(a.date));
  top1s.forEach(r => {
    const maxStr = '+' + r.maxReturn.toFixed(1) + '%(day' + r.maxDay + ')';
    const lastStr = (r.lastReturn >= 0 ? '+' : '') + r.lastReturn.toFixed(1) + '%(day' + r.lastDay + ')';
    const emoji = r.lastReturn >= 0 ? 'O' : 'X';
    console.log('  ' + r.date + ' | ' + r.name + ' (' + r.grade + ', ' + r.score + '점) | 최고 ' + maxStr + ' | 최종 ' + lastStr + ' ' + emoji);
  });
})();
