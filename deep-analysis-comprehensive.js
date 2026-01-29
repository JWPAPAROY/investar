/**
 * 종합 심층 분석
 * 1. 보유 기간별 수익률 비교 (다양한 보유 기간 시뮬레이션)
 * 2. 종목 다양성 분석 (종목별 특성, 집중도 분석)
 * 3. 과열 vs B등급 최적 타이밍 분석
 */

const fs = require('fs');
const kisApi = require('./backend/kisApi');

class DeepAnalysis {
  constructor() {
    this.result90 = JSON.parse(fs.readFileSync('./backtest-90days-results.json', 'utf8'));
  }

  /**
   * 1. 보유 기간별 수익률 비교
   * 기존 데이터에서 다양한 보유 기간 시뮬레이션
   */
  async analyzeHoldingPeriods() {
    console.log('\n📊 1. 보유 기간별 수익률 비교 분석');
    console.log('='.repeat(80));
    console.log('기존 데이터: 7일 보유 기준');
    console.log('분석 방법: 실제 일봉 데이터로 1일, 3일, 5일, 14일 수익률 재계산\n');

    const holdingPeriods = [1, 3, 5, 7, 14];
    const uniqueStocks = [...new Set(this.result90.results.map(r => ({
      code: r.stockCode,
      name: r.stockName,
      grade: r.grade
    })).map(s => JSON.stringify(s)))].map(s => JSON.parse(s));

    console.log(`샘플 종목: ${uniqueStocks.length}개 (중복 제거)\n`);

    const periodResults = {};

    for (const period of holdingPeriods) {
      console.log(`🔍 ${period}일 보유 기간 분석 중...`);

      const results = [];
      let processed = 0;

      for (const stock of uniqueStocks.slice(0, 30)) { // 상위 30개만 분석 (API 제한)
        try {
          const chartData = await kisApi.getDailyChart(stock.code, period + 5);

          if (!chartData || chartData.length < period) {
            continue;
          }

          const sellPrice = chartData[0]?.close;
          const buyPrice = chartData[period]?.close;

          if (!buyPrice || !sellPrice) {
            continue;
          }

          const returnRate = ((sellPrice - buyPrice) / buyPrice) * 100;

          results.push({
            stockCode: stock.code,
            stockName: stock.name,
            grade: stock.grade,
            buyPrice,
            sellPrice,
            returnRate: parseFloat(returnRate.toFixed(2)),
            isWin: returnRate > 0
          });

          processed++;

          // API 호출 간격
          await new Promise(resolve => setTimeout(resolve, 150));

        } catch (error) {
          // 에러 무시하고 계속
        }
      }

      periodResults[period] = this.calculatePeriodStats(results);
      console.log(`  ✅ 완료: ${processed}개 종목 분석\n`);
    }

    // 결과 출력
    console.log('\n📈 보유 기간별 성과 비교');
    console.log('─'.repeat(80));
    console.log('기간 | 평균수익률 | 승률 | 최고수익 | 최대손실 | 샘플수');
    console.log('─'.repeat(80));

    for (const [period, stats] of Object.entries(periodResults)) {
      if (!stats) continue;
      console.log(`${period}일  | ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn.toFixed(2)}%     | ${stats.winRate.toFixed(1)}% | +${stats.maxReturn.toFixed(2)}%   | ${stats.minReturn.toFixed(2)}%   | ${stats.count}개`);
    }

    // 등급별 최적 보유 기간
    console.log('\n🏆 등급별 최적 보유 기간');
    console.log('─'.repeat(80));

    const gradeOptimal = {};
    for (const [period, stats] of Object.entries(periodResults)) {
      if (!stats || !stats.byGrade) continue;

      for (const [grade, gStats] of Object.entries(stats.byGrade)) {
        if (!gradeOptimal[grade] || gStats.avgReturn > gradeOptimal[grade].avgReturn) {
          gradeOptimal[grade] = {
            period: parseInt(period),
            avgReturn: gStats.avgReturn,
            winRate: gStats.winRate
          };
        }
      }
    }

    for (const [grade, optimal] of Object.entries(gradeOptimal)) {
      console.log(`  ${grade}등급: ${optimal.period}일 보유 (평균 +${optimal.avgReturn.toFixed(2)}%, 승률 ${optimal.winRate.toFixed(1)}%)`);
    }

    return periodResults;
  }

  /**
   * 2. 종목 다양성 분석
   */
  analyzeStockDiversity() {
    console.log('\n\n📊 2. 종목 다양성 및 특성 분석');
    console.log('='.repeat(80));

    const stockCounts = {};
    const stockGrades = {};
    const stockReturns = {};

    this.result90.results.forEach(r => {
      // 출현 횟수
      stockCounts[r.stockName] = (stockCounts[r.stockName] || 0) + 1;

      // 등급 분포
      if (!stockGrades[r.stockName]) {
        stockGrades[r.stockName] = {};
      }
      stockGrades[r.stockName][r.grade] = (stockGrades[r.stockName][r.grade] || 0) + 1;

      // 수익률 기록
      if (!stockReturns[r.stockName]) {
        stockReturns[r.stockName] = [];
      }
      stockReturns[r.stockName].push(r.returnRate);
    });

    // 집중도 분석
    console.log('\n📍 종목 집중도 분석');
    console.log('─'.repeat(80));

    const totalSamples = this.result90.results.length;
    const uniqueStocks = Object.keys(stockCounts).length;
    const top10Samples = Object.values(stockCounts)
      .sort((a, b) => b - a)
      .slice(0, 10)
      .reduce((sum, count) => sum + count, 0);

    console.log(`  총 샘플: ${totalSamples}개`);
    console.log(`  고유 종목: ${uniqueStocks}개`);
    console.log(`  TOP 10 종목 비중: ${(top10Samples / totalSamples * 100).toFixed(1)}%`);
    console.log(`  종목당 평균 출현: ${(totalSamples / uniqueStocks).toFixed(1)}회`);

    // TOP 10 종목 상세
    console.log('\n📈 TOP 10 출현 종목 (출현 횟수순)');
    console.log('─'.repeat(80));
    console.log('순위 | 종목명 | 출현횟수 | 주요등급 | 평균수익률 | 승률');
    console.log('─'.repeat(80));

    const sortedStocks = Object.entries(stockCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    sortedStocks.forEach(([name, count], idx) => {
      const returns = stockReturns[name];
      const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const winRate = returns.filter(r => r > 0).length / returns.length * 100;
      const mainGrade = Object.entries(stockGrades[name])
        .sort((a, b) => b[1] - a[1])[0][0];

      console.log(`${idx + 1}위  | ${name.padEnd(20)} | ${count}회      | ${mainGrade.padEnd(4)} | ${avgReturn > 0 ? '+' : ''}${avgReturn.toFixed(2)}%    | ${winRate.toFixed(1)}%`);
    });

    // 수익률 TOP 10
    console.log('\n💰 수익률 TOP 10 종목');
    console.log('─'.repeat(80));
    console.log('순위 | 종목명 | 평균수익률 | 출현횟수 | 주요등급');
    console.log('─'.repeat(80));

    const byReturn = Object.entries(stockReturns)
      .map(([name, returns]) => ({
        name,
        avgReturn: returns.reduce((sum, r) => sum + r, 0) / returns.length,
        count: returns.length,
        mainGrade: Object.entries(stockGrades[name])
          .sort((a, b) => b[1] - a[1])[0][0]
      }))
      .sort((a, b) => b.avgReturn - a.avgReturn)
      .slice(0, 10);

    byReturn.forEach((stock, idx) => {
      console.log(`${idx + 1}위  | ${stock.name.padEnd(20)} | +${stock.avgReturn.toFixed(2)}%     | ${stock.count}회      | ${stock.mainGrade}`);
    });

    // 과열 vs B등급 종목 비교
    console.log('\n🔥 과열등급 vs 🟦 B등급 종목 비교');
    console.log('─'.repeat(80));

    const overheatStocks = new Set();
    const gradeBStocks = new Set();

    this.result90.results.forEach(r => {
      if (r.grade === '과열') overheatStocks.add(r.stockName);
      if (r.grade === 'B') gradeBStocks.add(r.stockName);
    });

    const onlyOverheat = [...overheatStocks].filter(s => !gradeBStocks.has(s));
    const onlyB = [...gradeBStocks].filter(s => !overheatStocks.has(s));
    const both = [...overheatStocks].filter(s => gradeBStocks.has(s));

    console.log(`  과열만 출현: ${onlyOverheat.length}개 종목`);
    console.log(`  B등급만 출현: ${onlyB.length}개 종목`);
    console.log(`  둘 다 출현: ${both.length}개 종목`);

    if (both.length > 0) {
      console.log('\n  📍 양쪽 모두 출현한 종목:');
      both.slice(0, 5).forEach(name => {
        const grades = stockGrades[name];
        const returns = stockReturns[name];
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        console.log(`     ${name}: 과열 ${grades['과열'] || 0}회, B ${grades['B'] || 0}회 (평균 +${avgReturn.toFixed(2)}%)`);
      });
    }

    return {
      diversity: {
        totalSamples,
        uniqueStocks,
        top10Ratio: (top10Samples / totalSamples * 100).toFixed(1),
        avgPerStock: (totalSamples / uniqueStocks).toFixed(1)
      },
      topStocks: sortedStocks.map(([name, count]) => ({
        name,
        count,
        avgReturn: (stockReturns[name].reduce((sum, r) => sum + r, 0) / stockReturns[name].length).toFixed(2)
      })),
      gradeOverlap: {
        onlyOverheat: onlyOverheat.length,
        onlyB: onlyB.length,
        both: both.length
      }
    };
  }

  /**
   * 3. 과열 vs B등급 최적 타이밍 분석
   */
  analyzeOptimalTiming() {
    console.log('\n\n📊 3. 과열 vs B등급 최적 매수 타이밍 분석');
    console.log('='.repeat(80));

    const overheat = this.result90.results.filter(r => r.grade === '과열');
    const gradeB = this.result90.results.filter(r => r.grade === 'B');

    console.log('\n🔥 과열등급 타이밍 분석');
    console.log('─'.repeat(80));
    console.log('  철학: "모멘텀 지속" - 이미 상승 중 → 추세 따라가기');
    console.log(`  샘플 수: ${overheat.length}개`);
    console.log(`  평균 수익률: +${(overheat.reduce((sum, r) => sum + r.returnRate, 0) / overheat.length).toFixed(2)}%`);
    console.log(`  승률: ${(overheat.filter(r => r.isWin).length / overheat.length * 100).toFixed(1)}%`);

    // 과열등급의 수익률 분포
    const overheatReturns = overheat.map(r => r.returnRate).sort((a, b) => b - a);
    console.log(`\n  수익률 분포:`);
    console.log(`    상위 25%: +${overheatReturns[Math.floor(overheatReturns.length * 0.25)].toFixed(2)}% 이상`);
    console.log(`    중간값: +${overheatReturns[Math.floor(overheatReturns.length * 0.5)].toFixed(2)}%`);
    console.log(`    하위 25%: +${overheatReturns[Math.floor(overheatReturns.length * 0.75)].toFixed(2)}% 이하`);

    console.log('\n  💡 최적 전략:');
    console.log('     1. 과열 판정 즉시 매수 (모멘텀 활용)');
    console.log('     2. 단기 보유 (3-7일) 추천');
    console.log('     3. 손절 기준: -5% (빠른 손절)');
    console.log('     4. 목표 수익: +15~25% (데이터 기반)');

    console.log('\n🟦 B등급 타이밍 분석');
    console.log('─'.repeat(80));
    console.log('  철학: "선행 포착" - 아직 상승 전 → 기다리기');
    console.log(`  샘플 수: ${gradeB.length}개`);
    console.log(`  평균 수익률: +${(gradeB.reduce((sum, r) => sum + r.returnRate, 0) / gradeB.length).toFixed(2)}%`);
    console.log(`  승률: ${(gradeB.filter(r => r.isWin).length / gradeB.length * 100).toFixed(1)}%`);

    // B등급의 수익률 분포
    const gradeBReturns = gradeB.map(r => r.returnRate).sort((a, b) => b - a);
    console.log(`\n  수익률 분포:`);
    console.log(`    상위 25%: +${gradeBReturns[Math.floor(gradeBReturns.length * 0.25)].toFixed(2)}% 이상`);
    console.log(`    중간값: +${gradeBReturns[Math.floor(gradeBReturns.length * 0.5)].toFixed(2)}%`);
    console.log(`    하위 25%: +${gradeBReturns[Math.floor(gradeBReturns.length * 0.75)].toFixed(2)}% 이하`);

    console.log('\n  💡 최적 전략:');
    console.log('     1. B등급 판정 후 추가 확인 필요 (선행 지표 검증)');
    console.log('     2. 중장기 보유 (7-14일) 권장');
    console.log('     3. 손절 기준: -7% (여유 있게)');
    console.log('     4. 목표 수익: +5~15% (보수적)');

    // 비교 요약
    console.log('\n📊 과열 vs B등급 비교 요약');
    console.log('='.repeat(80));

    const overheatAvg = overheat.reduce((sum, r) => sum + r.returnRate, 0) / overheat.length;
    const gradeBAvg = gradeB.reduce((sum, r) => sum + r.returnRate, 0) / gradeB.length;

    console.log(`\n구분        | 평균수익률 | 승률   | 권장보유 | 손절기준 | 전략`);
    console.log('─'.repeat(80));
    console.log(`과열등급    | +${overheatAvg.toFixed(2)}%    | ${(overheat.filter(r => r.isWin).length / overheat.length * 100).toFixed(1)}% | 3-7일   | -5%     | 모멘텀`);
    console.log(`B등급      | +${gradeBAvg.toFixed(2)}%     | ${(gradeB.filter(r => r.isWin).length / gradeB.length * 100).toFixed(1)}% | 7-14일  | -7%     | 선행`);
    console.log(`차이       | +${(overheatAvg - gradeBAvg).toFixed(2)}%p   |        |         |         |`);

    console.log('\n💡 핵심 인사이트:');
    console.log('─'.repeat(80));
    console.log('  1. 과열등급은 "즉시 매수 + 단기 보유" 전략');
    console.log('  2. B등급은 "검증 후 매수 + 중장기 보유" 전략');
    console.log(`  3. 과열이 ${(overheatAvg / gradeBAvg).toFixed(2)}배 높은 수익률 → 모멘텀이 효과적`);
    console.log('  4. 하이브리드 전략: 등급별로 다른 보유 기간 적용');

    return {
      overheat: {
        avgReturn: overheatAvg.toFixed(2),
        winRate: (overheat.filter(r => r.isWin).length / overheat.length * 100).toFixed(1),
        strategy: '즉시 매수 + 단기 보유 (3-7일)',
        stopLoss: '-5%',
        target: '+15~25%'
      },
      gradeB: {
        avgReturn: gradeBAvg.toFixed(2),
        winRate: (gradeB.filter(r => r.isWin).length / gradeB.length * 100).toFixed(1),
        strategy: '검증 후 매수 + 중장기 보유 (7-14일)',
        stopLoss: '-7%',
        target: '+5~15%'
      }
    };
  }

  /**
   * 기간별 통계 계산
   */
  calculatePeriodStats(results) {
    if (results.length === 0) return null;

    const totalCount = results.length;
    const winCount = results.filter(r => r.isWin).length;
    const avgReturn = results.reduce((sum, r) => sum + r.returnRate, 0) / totalCount;
    const maxReturn = Math.max(...results.map(r => r.returnRate));
    const minReturn = Math.min(...results.map(r => r.returnRate));

    // 등급별
    const byGrade = {};
    const gradeGroups = this.groupBy(results, 'grade');

    for (const [grade, items] of Object.entries(gradeGroups)) {
      const wins = items.filter(r => r.isWin).length;
      const avg = items.reduce((sum, r) => sum + r.returnRate, 0) / items.length;

      byGrade[grade] = {
        count: items.length,
        winRate: (wins / items.length) * 100,
        avgReturn: avg
      };
    }

    return {
      count: totalCount,
      winRate: (winCount / totalCount) * 100,
      avgReturn,
      maxReturn,
      minReturn,
      byGrade
    };
  }

  /**
   * 그룹화 헬퍼
   */
  groupBy(array, key) {
    return array.reduce((result, item) => {
      const group = item[key] || 'unknown';
      if (!result[group]) result[group] = [];
      result[group].push(item);
      return result;
    }, {});
  }
}

/**
 * 메인 실행
 */
async function main() {
  const analyzer = new DeepAnalysis();

  try {
    // 1. 보유 기간별 분석
    const periodResults = await analyzer.analyzeHoldingPeriods();

    // 2. 종목 다양성 분석
    const diversityResults = analyzer.analyzeStockDiversity();

    // 3. 최적 타이밍 분석
    const timingResults = analyzer.analyzeOptimalTiming();

    // 결과 저장
    const comprehensive = {
      holdingPeriods: periodResults,
      diversity: diversityResults,
      timing: timingResults,
      generatedAt: new Date().toISOString()
    };

    fs.writeFileSync(
      './deep-analysis-results.json',
      JSON.stringify(comprehensive, null, 2)
    );

    console.log('\n' + '='.repeat(80));
    console.log('✅ 종합 심층 분석 완료!');
    console.log('💾 결과가 deep-analysis-results.json에 저장되었습니다.');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ 분석 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 실행
main();
