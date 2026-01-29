/**
 * 포괄적 백테스팅 실행 스크립트
 * - 더 긴 기간 (최대 365일)
 * - 더 많은 종목 (TOP 15개)
 * - 더 짧은 샘플링 간격 (3일)
 * - 다양한 보유 기간 (1, 3, 5, 7일)
 */

const backtest = require('./backend/backtest');
const screener = require('./backend/screening');
const kisApi = require('./backend/kisApi');

/**
 * 개선된 백테스트 엔진
 */
class ComprehensiveBacktest {
  /**
   * 다양한 보유 기간으로 백테스트 실행
   */
  async runMultiPeriodBacktest(lookbackDays = 180, samplingInterval = 3) {
    console.log('🚀 포괄적 백테스팅 시작...\n');
    console.log(`📅 기간: ${lookbackDays}일 전 ~ 현재`);
    console.log(`🔄 샘플링 간격: ${samplingInterval}일`);
    console.log(`📊 보유 기간: 1일, 3일, 5일, 7일\n`);
    console.log('='.repeat(80));

    const holdingPeriods = [1, 3, 5, 7];
    const allResults = {};

    for (const holdingDays of holdingPeriods) {
      console.log(`\n🔍 보유 기간 ${holdingDays}일 백테스트 시작...`);

      const result = await this.runSingleBacktest(
        lookbackDays,
        holdingDays,
        samplingInterval,
        15 // TOP 15개 종목
      );

      allResults[`${holdingDays}days`] = result;

      console.log(`✅ ${holdingDays}일 완료: ${result.results.length}개 샘플\n`);

      // API 호출 간격
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return allResults;
  }

  /**
   * 단일 보유 기간 백테스트
   */
  async runSingleBacktest(lookbackDays, holdingDays, samplingInterval, topN) {
    const testDates = this.generateTestDates(lookbackDays, samplingInterval);
    const allResults = [];

    console.log(`  📅 테스트 날짜: ${testDates.length}개`);

    for (let i = 0; i < testDates.length; i++) {
      const testDate = testDates[i];

      // 진행 상황 표시
      if ((i + 1) % 10 === 0) {
        console.log(`  진행: ${i + 1}/${testDates.length} (${Math.round((i + 1) / testDates.length * 100)}%)`);
      }

      try {
        // 현재 시점의 TOP N 종목 추출
        const result = await screener.screenAllStocks('ALL', topN);
        const topStocks = result.stocks || [];

        // 각 종목의 수익률 계산
        for (const stock of topStocks) {
          const performance = await this.calculateReturns(
            stock.stockCode,
            testDate,
            holdingDays
          );

          if (performance) {
            allResults.push({
              stockCode: stock.stockCode,
              stockName: stock.stockName,
              score: stock.totalScore,
              grade: stock.recommendation.grade,
              category: this.detectCategory(stock),
              ...performance,
              recommendDate: testDate,
              holdingDays
            });
          }

          // API 호출 간격
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`  ❌ ${testDate} 분석 실패:`, error.message);
      }
    }

    // 통계 계산
    const statistics = this.calculateStatistics(allResults);

    return {
      results: allResults,
      statistics,
      parameters: { lookbackDays, holdingDays, samplingInterval, topN },
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 테스트 날짜 생성
   */
  generateTestDates(lookbackDays, interval) {
    const dates = [];
    const today = new Date();

    for (let i = lookbackDays; i >= interval; i -= interval) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    return dates;
  }

  /**
   * 수익률 계산
   */
  async calculateReturns(stockCode, startDate, holdingDays) {
    try {
      const chartData = await kisApi.getDailyChart(stockCode, holdingDays + 10);

      if (!chartData || chartData.length < holdingDays) {
        return null;
      }

      const sellPrice = chartData[0]?.close;
      const buyPrice = chartData[holdingDays]?.close;

      if (!buyPrice || !sellPrice) {
        return null;
      }

      const returnRate = ((sellPrice - buyPrice) / buyPrice) * 100;
      const isWin = returnRate > 0;

      return {
        buyPrice,
        sellPrice,
        returnRate: parseFloat(returnRate.toFixed(2)),
        isWin,
        holdingDays
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 카테고리 감지
   */
  detectCategory(stock) {
    const categories = [];

    if (stock.advancedAnalysis.indicators.whale.length > 0) {
      categories.push('whale');
    }
    if (
      stock.volumeAnalysis.current.volumeMA20 &&
      stock.volumeAnalysis.current.volume / stock.volumeAnalysis.current.volumeMA20 >= 2.5
    ) {
      categories.push('volume-surge');
    }

    return categories;
  }

  /**
   * 통계 계산
   */
  calculateStatistics(results) {
    if (results.length === 0) {
      return null;
    }

    const totalCount = results.length;
    const winCount = results.filter(r => r.isWin).length;
    const winRate = parseFloat(((winCount / totalCount) * 100).toFixed(2));
    const avgReturn = parseFloat((results.reduce((sum, r) => sum + r.returnRate, 0) / totalCount).toFixed(2));
    const maxReturn = parseFloat(Math.max(...results.map(r => r.returnRate)).toFixed(2));
    const minReturn = parseFloat(Math.min(...results.map(r => r.returnRate)).toFixed(2));

    // 등급별 통계
    const gradeStats = {};
    const gradeGroups = this.groupBy(results, 'grade');

    for (const [grade, items] of Object.entries(gradeGroups)) {
      const wins = items.filter(r => r.isWin).length;
      const avgRet = items.reduce((sum, r) => sum + r.returnRate, 0) / items.length;

      gradeStats[grade] = {
        count: items.length,
        winRate: parseFloat(((wins / items.length) * 100).toFixed(2)),
        avgReturn: parseFloat(avgRet.toFixed(2))
      };
    }

    return {
      overall: {
        totalCount,
        winCount,
        lossCount: totalCount - winCount,
        winRate,
        avgReturn,
        maxReturn,
        minReturn
      },
      byGrade: gradeStats
    };
  }

  /**
   * 배열 그룹화
   */
  groupBy(array, key) {
    return array.reduce((result, item) => {
      const group = item[key] || 'unknown';
      if (!result[group]) {
        result[group] = [];
      }
      result[group].push(item);
      return result;
    }, {});
  }
}

/**
 * 메인 실행 함수
 */
async function main() {
  const tester = new ComprehensiveBacktest();

  try {
    // 180일, 3일 간격으로 포괄적 백테스트
    const results = await tester.runMultiPeriodBacktest(180, 3);

    console.log('\n' + '='.repeat(80));
    console.log('📊 포괄적 백테스팅 결과 요약');
    console.log('='.repeat(80));

    // 보유 기간별 결과 출력
    for (const [period, data] of Object.entries(results)) {
      const days = period.replace('days', '');
      const stats = data.statistics.overall;

      console.log(`\n📅 보유 기간 ${days}일:`);
      console.log('─'.repeat(80));
      console.log(`  총 샘플: ${stats.totalCount}개`);
      console.log(`  승률: ${stats.winRate}%`);
      console.log(`  평균 수익률: ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}%`);
      console.log(`  최고 수익: +${stats.maxReturn}% | 최대 손실: ${stats.minReturn}%`);

      // 등급별 성과
      if (data.statistics.byGrade) {
        console.log('\n  🏆 등급별 성과:');
        for (const [grade, gStats] of Object.entries(data.statistics.byGrade)) {
          console.log(`     ${grade}: 승률 ${gStats.winRate}% | 평균 ${gStats.avgReturn > 0 ? '+' : ''}${gStats.avgReturn}% | ${gStats.count}개`);
        }
      }
    }

    // 보유 기간 비교
    console.log('\n📊 보유 기간 비교 (과열등급 vs B등급)');
    console.log('='.repeat(80));

    const comparison = {};
    for (const [period, data] of Object.entries(results)) {
      const days = period.replace('days', '');
      comparison[days] = {};

      for (const [grade, gStats] of Object.entries(data.statistics.byGrade || {})) {
        if (grade === '과열' || grade === 'B') {
          comparison[days][grade] = {
            avgReturn: gStats.avgReturn,
            winRate: gStats.winRate,
            count: gStats.count
          };
        }
      }
    }

    console.log('\n보유기간 | 과열 평균 | 과열 승률 | B 평균 | B 승률');
    console.log('─'.repeat(80));
    for (const [days, grades] of Object.entries(comparison)) {
      const overheat = grades['과열'] || { avgReturn: 'N/A', winRate: 'N/A' };
      const gradeB = grades['B'] || { avgReturn: 'N/A', winRate: 'N/A' };

      console.log(`${days}일      | ${typeof overheat.avgReturn === 'number' ? (overheat.avgReturn > 0 ? '+' : '') + overheat.avgReturn.toFixed(2) + '%' : overheat.avgReturn}    | ${typeof overheat.winRate === 'number' ? overheat.winRate.toFixed(1) + '%' : overheat.winRate}   | ${typeof gradeB.avgReturn === 'number' ? (gradeB.avgReturn > 0 ? '+' : '') + gradeB.avgReturn.toFixed(2) + '%' : gradeB.avgReturn}  | ${typeof gradeB.winRate === 'number' ? gradeB.winRate.toFixed(1) + '%' : gradeB.winRate}`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ 포괄적 백테스팅 완료!\n');

    // 결과 저장
    const fs = require('fs');
    fs.writeFileSync(
      './comprehensive-backtest-results.json',
      JSON.stringify(results, null, 2)
    );
    console.log('💾 결과가 comprehensive-backtest-results.json에 저장되었습니다.\n');

  } catch (error) {
    console.error('\n❌ 백테스팅 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 실행
main();
