/**
 * 간단한 역방향 백테스팅
 * "현재 추천 종목을 N일 전에 매수했다면?" 시나리오 분석
 */

const screener = require('./backend/screening');

async function simpleBacktest() {
  console.log('🚀 간단한 역방향 백테스팅 시작...\n');
  console.log('=' .repeat(80));

  try {
    // 1. 현재 추천 종목 가져오기
    console.log('📊 현재 추천 종목 스크리닝 중...\n');
    const result = await screener.screenAllStocks('ALL', 20);
    const stocks = result.stocks || [];

    if (stocks.length === 0) {
      console.log('⚠️  추천 종목이 없습니다.');
      return;
    }

    console.log(`✅ ${stocks.length}개 종목 발견\n`);

    // 2. 각 종목의 과거 성과 계산
    const holdingPeriods = [1, 3, 5, 7, 10, 14]; // 보유기간 (일)
    const results = [];

    for (const stock of stocks) {
      console.log(`📈 분석 중: ${stock.stockName} (${stock.stockCode})`);

      // chartData는 analyzeStock에 포함되지 않으므로 직접 가져오기
      const kisApi = require('./backend/kisApi');
      const chartData = await kisApi.getDailyChart(stock.stockCode, 30);

      if (!chartData || chartData.length < 15) {
        console.log(`  ⚠️  충분한 데이터 없음`);
        continue;
      }

      for (const days of holdingPeriods) {
        if (chartData.length <= days) continue;

        // days일 전 가격 (매수가)
        const buyPrice = chartData[days].close;
        // 현재 가격 (매도가) = 최신 데이터
        const sellPrice = stock.currentPrice || chartData[0].close;

        const returnRate = ((sellPrice - buyPrice) / buyPrice) * 100;
        const isWin = returnRate > 0;

        results.push({
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          grade: stock.recommendation?.grade || 'N/A',
          totalScore: stock.totalScore,
          holdingDays: days,
          buyDate: chartData[days].date,
          sellDate: chartData[0].date,
          buyPrice,
          sellPrice,
          returnRate: parseFloat(returnRate.toFixed(2)),
          isWin
        });
      }
    }

    // 3. 통계 계산
    const stats = calculateStatistics(results, holdingPeriods);

    // 4. 결과 출력
    printResults(results, stats, holdingPeriods);

    // 5. JSON 저장
    const fs = require('fs');
    fs.writeFileSync(
      './simple-backtest-results.json',
      JSON.stringify({ results, statistics: stats, generatedAt: new Date().toISOString() }, null, 2)
    );
    console.log('\n💾 결과가 simple-backtest-results.json에 저장되었습니다.\n');

  } catch (error) {
    console.error('\n❌ 백테스팅 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * 통계 계산
 */
function calculateStatistics(results, holdingPeriods) {
  const stats = {
    overall: calculateGroupStats(results),
    byGrade: {},
    byHoldingPeriod: {}
  };

  // 등급별 통계
  const grades = ['S', 'A', 'B', 'C', 'D', '과열'];
  for (const grade of grades) {
    const gradeResults = results.filter(r => r.grade === grade);
    if (gradeResults.length > 0) {
      stats.byGrade[grade] = calculateGroupStats(gradeResults);
    }
  }

  // 보유기간별 통계
  for (const days of holdingPeriods) {
    const periodResults = results.filter(r => r.holdingDays === days);
    if (periodResults.length > 0) {
      stats.byHoldingPeriod[`${days}days`] = calculateGroupStats(periodResults);
    }
  }

  return stats;
}

/**
 * 그룹 통계 계산
 */
function calculateGroupStats(items) {
  if (items.length === 0) return null;

  const count = items.length;
  const winCount = items.filter(r => r.isWin).length;
  const winRate = (winCount / count) * 100;
  const returns = items.map(r => r.returnRate);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / count;
  const maxReturn = Math.max(...returns);
  const minReturn = Math.min(...returns);

  // 표준편차
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / count;
  const stdDev = Math.sqrt(variance);

  // Sharpe Ratio (간단 버전: 무위험 수익률 0% 가정)
  const sharpeRatio = stdDev === 0 ? 0 : avgReturn / stdDev;

  // Profit Factor
  const wins = items.filter(r => r.isWin);
  const losses = items.filter(r => !r.isWin);
  const totalProfit = wins.reduce((sum, r) => sum + r.returnRate, 0);
  const totalLoss = Math.abs(losses.reduce((sum, r) => sum + r.returnRate, 0));
  const profitFactor = totalLoss === 0 ? totalProfit : totalProfit / totalLoss;

  // 평균 승/패
  const avgWin = wins.length > 0 ? totalProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;

  return {
    count,
    winCount,
    lossCount: count - winCount,
    winRate: parseFloat(winRate.toFixed(2)),
    avgReturn: parseFloat(avgReturn.toFixed(2)),
    maxReturn: parseFloat(maxReturn.toFixed(2)),
    minReturn: parseFloat(minReturn.toFixed(2)),
    stdDev: parseFloat(stdDev.toFixed(2)),
    sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2))
  };
}

/**
 * 결과 출력
 */
function printResults(results, stats, holdingPeriods) {
  console.log('\n' + '='.repeat(80));
  console.log('📊 간단한 역방향 백테스팅 결과');
  console.log('='.repeat(80));

  // 전체 통계
  console.log('\n📈 전체 성과');
  console.log('─'.repeat(80));
  if (stats.overall) {
    const s = stats.overall;
    console.log(`  총 샘플: ${s.count}개`);
    console.log(`  승리: ${s.winCount}개 | 패배: ${s.lossCount}개`);
    console.log(`  승률: ${s.winRate}%`);
    console.log(`  평균 수익률: ${s.avgReturn > 0 ? '+' : ''}${s.avgReturn}%`);
    console.log(`  최고 수익: +${s.maxReturn}% | 최대 손실: ${s.minReturn}%`);
    console.log(`  표준편차: ${s.stdDev}%`);
    console.log(`  Sharpe Ratio: ${s.sharpeRatio}`);
    console.log(`  Profit Factor: ${s.profitFactor}`);
    console.log(`  평균 승/패: +${s.avgWin}% / -${s.avgLoss}%`);
  }

  // 등급별 성과
  if (Object.keys(stats.byGrade).length > 0) {
    console.log('\n🏆 등급별 성과');
    console.log('─'.repeat(80));
    for (const [grade, s] of Object.entries(stats.byGrade)) {
      console.log(`  ${grade}등급: 승률 ${s.winRate}% | 평균 ${s.avgReturn > 0 ? '+' : ''}${s.avgReturn}% | 샘플 ${s.count}개`);
    }
  }

  // 보유기간별 성과
  if (Object.keys(stats.byHoldingPeriod).length > 0) {
    console.log('\n📅 보유기간별 성과');
    console.log('─'.repeat(80));
    for (const days of holdingPeriods) {
      const s = stats.byHoldingPeriod[`${days}days`];
      if (!s) continue;
      console.log(`  ${days}일 보유: 승률 ${s.winRate}% | 평균 ${s.avgReturn > 0 ? '+' : ''}${s.avgReturn}% | 샘플 ${s.count}개`);
    }
  }

  // 최고 수익 TOP 5
  const topWinners = results
    .filter(r => r.isWin)
    .sort((a, b) => b.returnRate - a.returnRate)
    .slice(0, 5);

  if (topWinners.length > 0) {
    console.log('\n🎯 최고 수익 TOP 5');
    console.log('─'.repeat(80));
    topWinners.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.stockName}] ${r.grade}등급 | ${r.holdingDays}일 보유 | +${r.returnRate}%`);
      console.log(`     매수: ${r.buyDate} (${r.buyPrice.toLocaleString()}원) → 매도: ${r.sellDate} (${r.sellPrice.toLocaleString()}원)`);
    });
  }

  // 최대 손실 TOP 5
  const topLosers = results
    .filter(r => !r.isWin)
    .sort((a, b) => a.returnRate - b.returnRate)
    .slice(0, 5);

  if (topLosers.length > 0) {
    console.log('\n⚠️  최대 손실 TOP 5');
    console.log('─'.repeat(80));
    topLosers.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.stockName}] ${r.grade}등급 | ${r.holdingDays}일 보유 | ${r.returnRate}%`);
      console.log(`     매수: ${r.buyDate} (${r.buyPrice.toLocaleString()}원) → 매도: ${r.sellDate} (${r.sellPrice.toLocaleString()}원)`);
    });
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ 백테스팅 완료!\n');
}

// 실행
simpleBacktest();
