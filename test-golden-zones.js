#!/usr/bin/env node

/**
 * Golden Zones 패턴 백테스트 스크립트 (v3.10.0-beta)
 *
 * 목적: 4대 패턴의 실제 성과를 검증하여 배점 조정 및 패턴 선별
 *
 * 검증 기준:
 * - 패턴별 승률 75% 이상
 * - 패턴 없는 종목 대비 평균 수익률 +5% 이상
 * - 과적합 방지: 감지 빈도 주당 5개 이내
 */

const screener = require('./backend/screening');
const kisApi = require('./backend/kisApi');

// ========================================
// Utility Functions
// ========================================

function groupBy(array, key) {
  return array.reduce((result, item) => {
    const group = key.split('.').reduce((obj, k) => obj?.[k], item);
    if (!result[group]) result[group] = [];
    result[group].push(item);
    return result;
  }, {});
}

function calculateStats(trades) {
  if (trades.length === 0) {
    return {
      count: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      avgReturn: 0,
      medianReturn: 0,
      maxReturn: 0,
      minReturn: 0,
      stdDev: 0
    };
  }

  const returns = trades.map(t => t.returnRate);
  const wins = trades.filter(t => t.returnRate > 0);
  const losses = trades.filter(t => t.returnRate <= 0);

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  const sortedReturns = [...returns].sort((a, b) => a - b);
  const medianReturn = sortedReturns[Math.floor(sortedReturns.length / 2)];

  return {
    count: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: (wins.length / trades.length * 100).toFixed(2),
    avgReturn: avgReturn.toFixed(2),
    medianReturn: medianReturn.toFixed(2),
    maxReturn: Math.max(...returns).toFixed(2),
    minReturn: Math.min(...returns).toFixed(2),
    stdDev: stdDev.toFixed(2)
  };
}

// ========================================
// Main Backtest Function
// ========================================

async function backtestGoldenZones(holdingDays = [5, 10]) {
  console.log('🎯 Golden Zones 백테스트 시작...\n');
  console.log(`보유 기간: ${holdingDays.join(', ')}일`);
  console.log('=' .repeat(80));

  try {
    // Step 1: 현재 추천 종목 수집
    console.log('\n📊 Step 1: 종목 수집 중...');
    const result = await screener.screenAllStocks('ALL');
    const allStocks = result.stocks || [];

    console.log(`✅ 총 ${allStocks.length}개 종목 수집 완료`);

    // Step 2: Golden Zone 감지된 종목 필터
    const goldenStocks = allStocks.filter(s => s.goldenZone?.detected);
    const nonGoldenStocks = allStocks.filter(s => !s.goldenZone?.detected);

    console.log(`\n✅ Golden Zone 감지: ${goldenStocks.length}개`);
    console.log(`✅ Golden Zone 미감지: ${nonGoldenStocks.length}개`);

    if (goldenStocks.length === 0) {
      console.log('\n⚠️ Golden Zone 패턴이 감지된 종목이 없습니다.');
      return;
    }

    // Step 3: 패턴별 분류
    const byPattern = groupBy(goldenStocks, 'goldenZone.pattern');

    console.log('\n📋 패턴별 종목 수:');
    for (const [pattern, stocks] of Object.entries(byPattern)) {
      console.log(`  - ${pattern}: ${stocks.length}개`);
    }

    // Step 4: 각 보유 기간별 백테스트
    const results = {};

    for (const days of holdingDays) {
      console.log(`\n\n${'='.repeat(80)}`);
      console.log(`📈 보유 기간: ${days}일 백테스트`);
      console.log('='.repeat(80));

      results[days] = {
        byPattern: {},
        golden: [],
        nonGolden: []
      };

      // Step 4-1: 패턴별 백테스트
      for (const [pattern, stocks] of Object.entries(byPattern)) {
        console.log(`\n🔍 ${pattern} 백테스트 중...`);

        const trades = [];

        for (const stock of stocks) {
          try {
            // 과거 차트 데이터 가져오기 (30일)
            const chartData = await kisApi.getDailyChart(stock.stockCode, 30);

            if (!chartData || chartData.length < days + 1) {
              continue;
            }

            // 매수일: 최신 데이터 (chartData[0])
            const buyPrice = parseFloat(chartData[0].close);
            const buyDate = chartData[0].date;

            // 매도일: days일 후 (chartData[days])
            const sellPrice = parseFloat(chartData[days].close);
            const sellDate = chartData[days].date;

            // 수익률 계산
            const returnRate = ((sellPrice - buyPrice) / buyPrice * 100);

            trades.push({
              stockCode: stock.stockCode,
              stockName: stock.stockName,
              pattern,
              bonus: stock.goldenZone.bonus,
              buyDate,
              buyPrice,
              sellDate,
              sellPrice,
              returnRate: parseFloat(returnRate.toFixed(2)),
              isWin: returnRate > 0
            });

            // API Rate Limiting
            await new Promise(resolve => setTimeout(resolve, 200));

          } catch (error) {
            console.error(`  ⚠️ ${stock.stockName} 백테스트 실패:`, error.message);
          }
        }

        results[days].byPattern[pattern] = trades;
        results[days].golden.push(...trades);

        // 통계 출력
        const stats = calculateStats(trades);
        console.log(`  ✅ 거래 수: ${stats.count}개`);
        console.log(`  📊 승률: ${stats.winRate}%`);
        console.log(`  💰 평균 수익률: ${stats.avgReturn}%`);
        console.log(`  📈 최고 수익: ${stats.maxReturn}%`);
        console.log(`  📉 최대 손실: ${stats.minReturn}%`);
      }

      // Step 4-2: Golden Zone 없는 종목 백테스트 (비교군)
      console.log(`\n🔍 Golden Zone 미감지 종목 백테스트 중...`);

      const nonGoldenTrades = [];
      const sampleSize = Math.min(nonGoldenStocks.length, 20); // 최대 20개 샘플링

      for (let i = 0; i < sampleSize; i++) {
        const stock = nonGoldenStocks[i];

        try {
          const chartData = await kisApi.getDailyChart(stock.stockCode, 30);

          if (!chartData || chartData.length < days + 1) {
            continue;
          }

          const buyPrice = parseFloat(chartData[0].close);
          const buyDate = chartData[0].date;
          const sellPrice = parseFloat(chartData[days].close);
          const sellDate = chartData[days].date;
          const returnRate = ((sellPrice - buyPrice) / buyPrice * 100);

          nonGoldenTrades.push({
            stockCode: stock.stockCode,
            stockName: stock.stockName,
            pattern: 'None',
            bonus: 0,
            buyDate,
            buyPrice,
            sellDate,
            sellPrice,
            returnRate: parseFloat(returnRate.toFixed(2)),
            isWin: returnRate > 0
          });

          await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error) {
          console.error(`  ⚠️ ${stock.stockName} 백테스트 실패:`, error.message);
        }
      }

      results[days].nonGolden = nonGoldenTrades;

      const nonGoldenStats = calculateStats(nonGoldenTrades);
      console.log(`  ✅ 거래 수: ${nonGoldenStats.count}개`);
      console.log(`  📊 승률: ${nonGoldenStats.winRate}%`);
      console.log(`  💰 평균 수익률: ${nonGoldenStats.avgReturn}%`);
    }

    // Step 5: 최종 리포트 생성
    console.log('\n\n');
    console.log('='.repeat(80));
    console.log('📊 Golden Zones 백테스트 최종 리포트');
    console.log('='.repeat(80));

    for (const days of holdingDays) {
      console.log(`\n\n🔹 보유 기간: ${days}일`);
      console.log('-'.repeat(80));

      // 패턴별 성과
      console.log('\n📈 패턴별 성과:\n');

      for (const [pattern, trades] of Object.entries(results[days].byPattern)) {
        const stats = calculateStats(trades);
        const goldenStats = calculateStats(results[days].golden);
        const nonGoldenStats = calculateStats(results[days].nonGolden);
        const returnDiff = parseFloat((parseFloat(stats.avgReturn) - parseFloat(nonGoldenStats.avgReturn)).toFixed(2));

        console.log(`${pattern}:`);
        console.log(`  종목 수: ${stats.count}개`);
        console.log(`  승률: ${stats.winRate}% ${parseFloat(stats.winRate) >= 75 ? '✅' : '❌'} (기준: 75% 이상)`);
        console.log(`  평균 수익률: ${stats.avgReturn}%`);
        console.log(`  비교군 대비: ${returnDiff > 0 ? '+' : ''}${returnDiff}% ${returnDiff >= 5 ? '✅' : '❌'} (기준: +5% 이상)`);
        console.log(`  중앙값: ${stats.medianReturn}%`);
        console.log(`  표준편차: ${stats.stdDev}%`);
        console.log(`  최고/최저: ${stats.maxReturn}% / ${stats.minReturn}%`);

        // 합격/불합격 판정
        const pass = parseFloat(stats.winRate) >= 75 && returnDiff >= 5;
        console.log(`  판정: ${pass ? '✅ 합격' : '❌ 불합격'}\n`);
      }

      // 전체 Golden Zone vs 비교군
      const goldenStats = calculateStats(results[days].golden);
      const nonGoldenStats = calculateStats(results[days].nonGolden);
      const returnDiff = parseFloat((parseFloat(goldenStats.avgReturn) - parseFloat(nonGoldenStats.avgReturn)).toFixed(2));

      console.log('-'.repeat(80));
      console.log('\n📊 Golden Zone vs 비교군:\n');

      console.log(`Golden Zone (전체):`);
      console.log(`  종목 수: ${goldenStats.count}개`);
      console.log(`  승률: ${goldenStats.winRate}%`);
      console.log(`  평균 수익률: ${goldenStats.avgReturn}%`);
      console.log(`  중앙값: ${goldenStats.medianReturn}%`);

      console.log(`\n비교군 (Golden Zone 미감지):`);
      console.log(`  종목 수: ${nonGoldenStats.count}개`);
      console.log(`  승률: ${nonGoldenStats.winRate}%`);
      console.log(`  평균 수익률: ${nonGoldenStats.avgReturn}%`);
      console.log(`  중앙값: ${nonGoldenStats.medianReturn}%`);

      console.log(`\n성과 차이:`);
      console.log(`  수익률 차이: ${returnDiff > 0 ? '+' : ''}${returnDiff}%`);
      console.log(`  승률 차이: ${(parseFloat(goldenStats.winRate) - parseFloat(nonGoldenStats.winRate)).toFixed(2)}%`);
    }

    // Step 6: TOP 5 수익/손실 종목
    console.log('\n\n');
    console.log('='.repeat(80));
    console.log('🏆 TOP 5 수익 종목 (Golden Zones)');
    console.log('='.repeat(80));

    const allGoldenTrades = holdingDays.flatMap(days => results[days].golden);
    const topWinners = allGoldenTrades.sort((a, b) => b.returnRate - a.returnRate).slice(0, 5);

    topWinners.forEach((trade, idx) => {
      console.log(`\n${idx + 1}. ${trade.stockName} (${trade.stockCode})`);
      console.log(`   패턴: ${trade.pattern} (+${trade.bonus}점)`);
      console.log(`   매수: ${trade.buyDate} ${trade.buyPrice.toLocaleString()}원`);
      console.log(`   매도: ${trade.sellDate} ${trade.sellPrice.toLocaleString()}원`);
      console.log(`   수익률: +${trade.returnRate}%`);
    });

    console.log('\n\n');
    console.log('='.repeat(80));
    console.log('📉 TOP 5 손실 종목 (Golden Zones)');
    console.log('='.repeat(80));

    const topLosers = allGoldenTrades.sort((a, b) => a.returnRate - b.returnRate).slice(0, 5);

    topLosers.forEach((trade, idx) => {
      console.log(`\n${idx + 1}. ${trade.stockName} (${trade.stockCode})`);
      console.log(`   패턴: ${trade.pattern} (+${trade.bonus}점)`);
      console.log(`   매수: ${trade.buyDate} ${trade.buyPrice.toLocaleString()}원`);
      console.log(`   매도: ${trade.sellDate} ${trade.sellPrice.toLocaleString()}원`);
      console.log(`   손실률: ${trade.returnRate}%`);
    });

    // Step 7: 권장사항
    console.log('\n\n');
    console.log('='.repeat(80));
    console.log('💡 권장사항 (Recommendations)');
    console.log('='.repeat(80));

    console.log('\n검증 기준:');
    console.log('  ✅ 패턴별 승률 75% 이상');
    console.log('  ✅ 비교군 대비 평균 수익률 +5% 이상');
    console.log('  ✅ 과적합 방지: 감지 빈도 주당 5개 이내');

    console.log('\n다음 단계:');
    console.log('  1. 합격 패턴: 배점 유지 또는 상향 (승률 90%+ → +20점)');
    console.log('  2. 불합격 패턴: 조건 강화 또는 제거');
    console.log('  3. 1주일 실전 데이터 수집 후 재검증');
    console.log('  4. 프론트엔드에 Golden Zone 배지 추가');
    console.log('  5. v3.10.0-beta 브랜치 생성 및 배포');

    console.log('\n\n✅ 백테스트 완료!\n');

    // JSON 결과 파일 생성
    const fs = require('fs');
    const outputFile = `/tmp/golden-zones-backtest-${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`📄 상세 결과: ${outputFile}`);

  } catch (error) {
    console.error('❌ 백테스트 실패:', error);
    console.error(error.stack);
  }
}

// ========================================
// CLI Execution
// ========================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const holdingDays = args.length > 0
    ? args[0].split(',').map(d => parseInt(d))
    : [5, 10];

  backtestGoldenZones(holdingDays)
    .then(() => {
      console.log('\n🎉 Golden Zones 백테스트 완료!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ 백테스트 실패:', error.message);
      process.exit(1);
    });
}

module.exports = { backtestGoldenZones };
