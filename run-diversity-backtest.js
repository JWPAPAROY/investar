/**
 * 종목 다양성 확보 백테스팅 스크립트
 * 목표: 6개 → 20+ 고유 종목 확보
 *
 * 전략:
 * - 180일 기간 (넉넉한 샘플링)
 * - 7일 샘플링 간격 (API 부하 감소)
 * - TOP 30 종목 (기존 15개에서 2배 확대)
 * - 7일 보유 기간 (검증된 최적 기간)
 */

const backtest = require('./backend/backtest');
const screener = require('./backend/screening');
const kisApi = require('./backend/kisApi');
const fs = require('fs');

/**
 * 종목 다양성 백테스팅 클래스
 */
class DiversityBacktest {
  /**
   * 메인 백테스트 실행
   */
  async runDiversityBacktest(lookbackDays = 180, samplingInterval = 7, topN = 30) {
    console.log('🚀 종목 다양성 백테스팅 시작...\n');
    console.log(`📅 기간: ${lookbackDays}일 전 ~ 현재`);
    console.log(`🔄 샘플링 간격: ${samplingInterval}일`);
    console.log(`📊 종목 수: TOP ${topN}개`);
    console.log(`⏱️  보유 기간: 7일 (검증된 최적 기간)\n`);
    console.log('='.repeat(80));

    const testDates = this.generateTestDates(lookbackDays, samplingInterval);
    const allResults = [];
    const stockSet = new Set();

    console.log(`\n📅 테스트 날짜: ${testDates.length}개 생성됨`);
    console.log(`예상 API 호출: ~${testDates.length * topN * 3} 회 (${Math.ceil(testDates.length * topN * 3 / 60)} 분 소요)\n`);

    for (let i = 0; i < testDates.length; i++) {
      const testDate = testDates[i];

      // 진행 상황 표시
      if ((i + 1) % 5 === 0 || i === 0) {
        console.log(`\n📍 진행: ${i + 1}/${testDates.length} (${Math.round((i + 1) / testDates.length * 100)}%)`);
        console.log(`  고유 종목: ${stockSet.size}개 확보됨`);
      }

      try {
        // 현재 시점의 TOP N 종목 추출
        console.log(`  🔍 [${testDate}] 스크리닝 시작...`);
        const result = await screener.screenAllStocks('ALL', topN);
        const topStocks = result.stocks || [];

        console.log(`  ✅ ${topStocks.length}개 종목 발견 (${topStocks.filter(s => s.totalScore >= 45).length}개가 B등급 이상)`);

        // 각 종목의 7일 후 수익률 계산
        let successCount = 0;
        for (const stock of topStocks) {
          try {
            const performance = await this.calculateReturns(stock.stockCode, testDate, 7);

            if (performance) {
              allResults.push({
                stockCode: stock.stockCode,
                stockName: stock.stockName,
                score: stock.totalScore,
                grade: stock.recommendation.grade,
                category: this.detectCategory(stock),
                ...performance,
                recommendDate: testDate
              });

              stockSet.add(stock.stockCode);
              successCount++;
            }

            // API 호출 간격 (200ms)
            await this.sleep(200);

          } catch (error) {
            console.log(`    ⚠️ [${stock.stockName}] 수익률 계산 실패: ${error.message}`);
          }
        }

        console.log(`  📊 ${successCount}/${topStocks.length}개 종목 데이터 수집 완료`);

        // 각 날짜 스크리닝 후 2초 대기 (API 부하 분산)
        await this.sleep(2000);

      } catch (error) {
        console.error(`  ❌ [${testDate}] 스크리닝 실패:`, error.message);
      }

      // 중간 저장 (10개 날짜마다)
      if ((i + 1) % 10 === 0) {
        this.saveIntermediateResults(allResults, stockSet, i + 1);
      }
    }

    // 통계 계산
    console.log('\n📊 통계 계산 중...');
    const statistics = this.calculateStatistics(allResults, stockSet);

    const finalResult = {
      results: allResults,
      statistics,
      parameters: { lookbackDays, samplingInterval, topN, holdingDays: 7 },
      generatedAt: new Date().toISOString()
    };

    // 최종 결과 저장
    this.saveFinalResults(finalResult);

    return finalResult;
  }

  /**
   * 테스트 날짜 생성 (7일 간격)
   */
  generateTestDates(lookbackDays, interval) {
    const dates = [];
    const today = new Date();

    for (let i = lookbackDays; i >= interval; i -= interval) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);

      // 주말 제외 (토요일=6, 일요일=0)
      const dayOfWeek = date.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        dates.push(date.toISOString().split('T')[0]);
      }
    }

    return dates;
  }

  /**
   * 수익률 계산 (7일 후)
   */
  async calculateReturns(stockCode, startDate, holdingDays) {
    try {
      const chartData = await kisApi.getDailyChart(stockCode, holdingDays + 10);

      if (!chartData || chartData.length < holdingDays) {
        return null;
      }

      // chartData[0] = 최신, chartData[holdingDays] = N일 전
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

    if (stock.advancedAnalysis?.indicators?.whale?.length > 0) {
      categories.push('whale');
    }
    if (
      stock.volumeAnalysis?.current?.volumeMA20 &&
      stock.volumeAnalysis.current.volume / stock.volumeAnalysis.current.volumeMA20 >= 2.5
    ) {
      categories.push('volume-surge');
    }

    return categories;
  }

  /**
   * 통계 계산
   */
  calculateStatistics(results, stockSet) {
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

    // 종목별 통계
    const stockStats = {};
    results.forEach(r => {
      if (!stockStats[r.stockCode]) {
        stockStats[r.stockCode] = {
          name: r.stockName,
          appearances: 0,
          wins: 0,
          returns: []
        };
      }
      stockStats[r.stockCode].appearances++;
      if (r.isWin) stockStats[r.stockCode].wins++;
      stockStats[r.stockCode].returns.push(r.returnRate);
    });

    // 종목별 평균 계산
    for (const code in stockStats) {
      const stock = stockStats[code];
      stock.avgReturn = parseFloat((stock.returns.reduce((sum, r) => sum + r, 0) / stock.returns.length).toFixed(2));
      stock.winRate = parseFloat(((stock.wins / stock.appearances) * 100).toFixed(2));
    }

    return {
      overall: {
        totalCount,
        winCount,
        lossCount: totalCount - winCount,
        winRate,
        avgReturn,
        maxReturn,
        minReturn,
        uniqueStocks: stockSet.size
      },
      byGrade: gradeStats,
      byStock: stockStats,
      diversity: {
        uniqueStocks: stockSet.size,
        totalSamples: totalCount,
        avgAppearancesPerStock: parseFloat((totalCount / stockSet.size).toFixed(2)),
        topStocks: Object.entries(stockStats)
          .sort((a, b) => b[1].appearances - a[1].appearances)
          .slice(0, 10)
          .map(([code, stats]) => ({
            code,
            name: stats.name,
            appearances: stats.appearances,
            avgReturn: stats.avgReturn,
            winRate: stats.winRate
          }))
      }
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

  /**
   * Sleep 함수
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 중간 결과 저장
   */
  saveIntermediateResults(results, stockSet, progress) {
    const intermediate = {
      progress: `${progress} dates processed`,
      samplesCollected: results.length,
      uniqueStocks: stockSet.size,
      timestamp: new Date().toISOString()
    };

    fs.writeFileSync(
      './diversity-backtest-progress.json',
      JSON.stringify(intermediate, null, 2)
    );

    console.log(`\n💾 중간 저장 완료: ${results.length}개 샘플, ${stockSet.size}개 고유 종목`);
  }

  /**
   * 최종 결과 저장
   */
  saveFinalResults(result) {
    fs.writeFileSync(
      './diversity-backtest-results.json',
      JSON.stringify(result, null, 2)
    );

    console.log('\n💾 최종 결과가 diversity-backtest-results.json에 저장되었습니다.');
  }
}

/**
 * 메인 실행 함수
 */
async function main() {
  const tester = new DiversityBacktest();

  try {
    // 180일, 7일 간격, TOP 30 종목
    const results = await tester.runDiversityBacktest(180, 7, 30);

    console.log('\n' + '='.repeat(80));
    console.log('📊 종목 다양성 백테스팅 결과');
    console.log('='.repeat(80));

    const stats = results.statistics.overall;
    const diversity = results.statistics.diversity;

    // 전체 성과
    console.log('\n📈 전체 성과');
    console.log('─'.repeat(80));
    console.log(`  총 샘플: ${stats.totalCount}개`);
    console.log(`  고유 종목: ${stats.uniqueStocks}개 (목표 20+ ${stats.uniqueStocks >= 20 ? '✅' : '❌'})`);
    console.log(`  종목당 평균 출현: ${diversity.avgAppearancesPerStock}회`);
    console.log(`  승률: ${stats.winRate}%`);
    console.log(`  평균 수익률: ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}%`);
    console.log(`  최고 수익: +${stats.maxReturn}% | 최대 손실: ${stats.minReturn}%`);

    // 등급별 성과
    if (results.statistics.byGrade) {
      console.log('\n🏆 등급별 성과');
      console.log('─'.repeat(80));
      for (const [grade, gStats] of Object.entries(results.statistics.byGrade)) {
        console.log(`  ${grade}: 승률 ${gStats.winRate}% | 평균 ${gStats.avgReturn > 0 ? '+' : ''}${gStats.avgReturn}% | ${gStats.count}개`);
      }
    }

    // TOP 10 종목
    console.log('\n🌟 TOP 10 종목 (출현 횟수)');
    console.log('─'.repeat(80));
    diversity.topStocks.forEach((stock, i) => {
      console.log(`  ${i + 1}. ${stock.name} (${stock.code})`);
      console.log(`     출현: ${stock.appearances}회 | 승률: ${stock.winRate}% | 평균: ${stock.avgReturn > 0 ? '+' : ''}${stock.avgReturn}%`);
    });

    // 종목 다양성 평가
    console.log('\n📊 종목 다양성 평가');
    console.log('─'.repeat(80));
    if (stats.uniqueStocks >= 20) {
      console.log('  ✅ 목표 달성! 20개 이상의 고유 종목 확보');
    } else {
      console.log(`  ⚠️ 목표 미달: ${stats.uniqueStocks}개 (목표: 20+개)`);
      console.log('  💡 제안: 더 긴 기간 또는 더 많은 종목(TOP 50) 필요');
    }

    if (diversity.avgAppearancesPerStock > 10) {
      console.log('  ⚠️ 종목 편중 높음: 특정 종목이 자주 반복됨');
    } else if (diversity.avgAppearancesPerStock < 3) {
      console.log('  ⚠️ 종목 분산 과다: 샘플 수 부족으로 통계 신뢰도 낮음');
    } else {
      console.log('  ✅ 적절한 종목 분산: 통계적 신뢰도 양호');
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ 종목 다양성 백테스팅 완료!\n');

  } catch (error) {
    console.error('\n❌ 백테스팅 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 실행
main();
