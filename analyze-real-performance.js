/**
 * 실제 Supabase 추천 이력 성과 분석
 * backtest-results.json 데이터 기반
 */

const fs = require('fs');

function analyzeRealPerformance() {
  console.log('📊 실제 추천 이력 성과 분석 시작...\n');
  console.log('='.repeat(80));

  // 1. 데이터 로드
  const data = JSON.parse(fs.readFileSync('./backtest-results.json', 'utf8'));
  const stocks = data.stocks || [];

  console.log(`\n📈 총 ${stocks.length}개 추천 이력 분석\n`);

  // 2. 현재 수익률 계산 (최신 daily_prices 기준)
  const results = stocks.map(stock => {
    const latestPrice = stock.daily_prices && stock.daily_prices.length > 0
      ? stock.daily_prices[stock.daily_prices.length - 1]
      : null;

    const currentReturn = latestPrice
      ? parseFloat(latestPrice.cumulativeReturn || latestPrice.return || 0)
      : stock.current_return || 0;

    const isWin = currentReturn > 0;

    return {
      ...stock,
      currentReturn,
      isWin,
      category: getCategory(stock),
      daysHeld: stock.days_since_recommendation || 0
    };
  });

  // 3. 전체 통계
  const overallStats = calculateStats(results, '전체');

  // 4. 등급별 통계
  console.log('\n🏆 등급별 성과 분석');
  console.log('─'.repeat(80));
  const byGrade = groupBy(results, 'recommendation_grade');
  const gradeStats = {};
  for (const [grade, items] of Object.entries(byGrade)) {
    const stats = calculateStats(items, grade);
    gradeStats[grade] = stats;
    console.log(`  ${grade}등급: 승률 ${stats.winRate}% | 평균 ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}% | 샘플 ${stats.count}개 | PF ${stats.profitFactor}`);
  }

  // 5. 카테고리별 통계
  console.log('\n📋 카테고리별 성과 분석');
  console.log('─'.repeat(80));
  const byCategory = groupBy(results, 'category');
  const categoryStats = {};
  for (const [category, items] of Object.entries(byCategory)) {
    const stats = calculateStats(items, category);
    categoryStats[category] = stats;
    console.log(`  ${category}: 승률 ${stats.winRate}% | 평균 ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}% | 샘플 ${stats.count}개`);
  }

  // 6. 점수 구간별 통계
  console.log('\n📊 점수 구간별 성과 분석');
  console.log('─'.repeat(80));
  const scoreRanges = [
    { min: 0, max: 25, label: '<25점' },
    { min: 25, max: 45, label: '25-44점' },
    { min: 45, max: 50, label: '45-49점' },
    { min: 50, max: 60, label: '50-59점' },
    { min: 60, max: 70, label: '60-69점' },
    { min: 70, max: 80, label: '70-79점' },
    { min: 80, max: 100, label: '80+점' }
  ];

  const scoreStats = {};
  for (const range of scoreRanges) {
    const items = results.filter(r => r.total_score >= range.min && r.total_score < range.max);
    if (items.length > 0) {
      const stats = calculateStats(items, range.label);
      scoreStats[range.label] = stats;
      console.log(`  ${range.label}: 승률 ${stats.winRate}% | 평균 ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}% | 샘플 ${stats.count}개`);
    }
  }

  // 7. 보유기간별 통계
  console.log('\n📅 보유기간별 성과 분석');
  console.log('─'.repeat(80));
  const dayRanges = [
    { min: 0, max: 3, label: '0-2일' },
    { min: 3, max: 7, label: '3-6일' },
    { min: 7, max: 14, label: '7-13일' },
    { min: 14, max: 30, label: '14-29일' },
    { min: 30, max: 999, label: '30일+' }
  ];

  for (const range of dayRanges) {
    const items = results.filter(r => r.daysHeld >= range.min && r.daysHeld < range.max);
    if (items.length > 0) {
      const stats = calculateStats(items, range.label);
      console.log(`  ${range.label}: 승률 ${stats.winRate}% | 평균 ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}% | 샘플 ${stats.count}개`);
    }
  }

  // 8. 최고/최저 성과 종목
  const winners = results.filter(r => r.isWin).sort((a, b) => b.currentReturn - a.currentReturn).slice(0, 10);
  const losers = results.filter(r => !r.isWin).sort((a, b) => a.currentReturn - b.currentReturn).slice(0, 10);

  console.log('\n🎯 최고 수익 TOP 10');
  console.log('─'.repeat(80));
  winners.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.stock_name}] ${r.recommendation_grade}등급 | ${r.category} | +${r.currentReturn.toFixed(2)}% (${r.daysHeld}일)`);
  });

  console.log('\n⚠️  최대 손실 TOP 10');
  console.log('─'.repeat(80));
  losers.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.stock_name}] ${r.recommendation_grade}등급 | ${r.category} | ${r.currentReturn.toFixed(2)}% (${r.daysHeld}일)`);
  });

  // 9. 문제점 분석
  console.log('\n\n' + '='.repeat(80));
  console.log('🔍 문제점 및 개선사항 분석');
  console.log('='.repeat(80));

  analyzeIssues(gradeStats, categoryStats, scoreStats);

  // 10. 결과 저장
  const summary = {
    timestamp: new Date().toISOString(),
    totalStocks: stocks.length,
    overall: overallStats,
    byGrade: gradeStats,
    byCategory: categoryStats,
    byScoreRange: scoreStats,
    topWinners: winners.slice(0, 5).map(r => ({
      name: r.stock_name,
      grade: r.recommendation_grade,
      category: r.category,
      return: r.currentReturn,
      days: r.daysHeld
    })),
    topLosers: losers.slice(0, 5).map(r => ({
      name: r.stock_name,
      grade: r.recommendation_grade,
      category: r.category,
      return: r.currentReturn,
      days: r.daysHeld
    }))
  };

  fs.writeFileSync(
    './real-performance-analysis.json',
    JSON.stringify(summary, null, 2)
  );

  console.log('\n💾 분석 결과가 real-performance-analysis.json에 저장되었습니다.\n');
}

/**
 * 카테고리 판단
 */
function getCategory(stock) {
  const isWhale = stock.whale_detected;
  const isAccumulation = stock.accumulation_detected;

  if (isWhale && isAccumulation) return '복합신호(고래+조용한매집)';
  if (isWhale) return '고래감지';
  if (isAccumulation) return '조용한매집';
  return '일반';
}

/**
 * 통계 계산
 */
function calculateStats(items, label) {
  if (items.length === 0) return null;

  const count = items.length;
  const winCount = items.filter(r => r.isWin).length;
  const winRate = (winCount / count) * 100;
  const returns = items.map(r => r.currentReturn);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / count;
  const maxReturn = Math.max(...returns);
  const minReturn = Math.min(...returns);

  // Profit Factor
  const wins = items.filter(r => r.isWin);
  const losses = items.filter(r => !r.isWin);
  const totalProfit = wins.reduce((sum, r) => sum + r.currentReturn, 0);
  const totalLoss = Math.abs(losses.reduce((sum, r) => sum + r.currentReturn, 0));
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;

  return {
    label,
    count,
    winCount,
    lossCount: count - winCount,
    winRate: parseFloat(winRate.toFixed(2)),
    avgReturn: parseFloat(avgReturn.toFixed(2)),
    maxReturn: parseFloat(maxReturn.toFixed(2)),
    minReturn: parseFloat(minReturn.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2))
  };
}

/**
 * 그룹화
 */
function groupBy(array, key) {
  return array.reduce((result, item) => {
    const groupKey = item[key];
    if (!result[groupKey]) {
      result[groupKey] = [];
    }
    result[groupKey].push(item);
    return result;
  }, {});
}

/**
 * 문제점 분석
 */
function analyzeIssues(gradeStats, categoryStats, scoreStats) {
  const issues = [];
  const recommendations = [];

  // 1. 등급 역전 문제 체크
  console.log('\n1️⃣ 등급 체계 검증');
  console.log('─'.repeat(80));

  const grades = ['S', 'A', 'B', 'C', 'D'];
  for (let i = 0; i < grades.length - 1; i++) {
    const higherGrade = gradeStats[grades[i]];
    const lowerGrade = gradeStats[grades[i + 1]];

    if (higherGrade && lowerGrade) {
      if (higherGrade.avgReturn < lowerGrade.avgReturn) {
        const issue = `❌ 등급 역전: ${grades[i]}등급(${higherGrade.avgReturn}%) < ${grades[i + 1]}등급(${lowerGrade.avgReturn}%)`;
        console.log(`  ${issue}`);
        issues.push(issue);
        recommendations.push(`${grades[i]}등급과 ${grades[i + 1]}등급의 점수 기준 또는 배점 재검토 필요`);
      } else {
        console.log(`  ✅ ${grades[i]}등급(${higherGrade.avgReturn}%) > ${grades[i + 1]}등급(${lowerGrade.avgReturn}%)`);
      }
    }
  }

  // 2. 복합 신호 문제 체크
  console.log('\n2️⃣ 카테고리별 성과 검증');
  console.log('─'.repeat(80));

  const composite = categoryStats['복합신호(고래+조용한매집)'];
  if (composite) {
    if (composite.avgReturn < 0 || composite.winRate < 30) {
      const issue = `❌ 복합 신호 저성과: 승률 ${composite.winRate}%, 평균 ${composite.avgReturn}%`;
      console.log(`  ${issue}`);
      issues.push(issue);
      recommendations.push('복합 신호 페널티 강화 또는 필터링 개선 필요');
    } else {
      console.log(`  ✅ 복합 신호: 승률 ${composite.winRate}%, 평균 ${composite.avgReturn}%`);
    }
  }

  const whale = categoryStats['고래감지'];
  if (whale) {
    console.log(`  ${whale.avgReturn > 10 ? '✅' : '⚠️'} 고래 감지: 승률 ${whale.winRate}%, 평균 ${whale.avgReturn}%`);
  }

  const accumulation = categoryStats['조용한매집'];
  if (accumulation) {
    console.log(`  ${accumulation.avgReturn > 5 ? '✅' : '⚠️'} 조용한 매집: 승률 ${accumulation.winRate}%, 평균 ${accumulation.avgReturn}%`);
  }

  // 3. 과열 등급 체크
  console.log('\n3️⃣ 과열 등급 성과 검증');
  console.log('─'.repeat(80));

  const overheat = gradeStats['과열'];
  if (overheat) {
    if (overheat.avgReturn < 0 || overheat.winRate < 40) {
      const issue = `⚠️ 과열 등급 저성과: 승률 ${overheat.winRate}%, 평균 ${overheat.avgReturn}%`;
      console.log(`  ${issue}`);
      issues.push(issue);
      recommendations.push('과열 감지 기준(RSI, 이격도) 재조정 고려');
    } else {
      console.log(`  ✅ 과열 등급: 승률 ${overheat.winRate}%, 평균 ${overheat.avgReturn}%`);
    }
  }

  // 4. 점수 구간별 검증
  console.log('\n4️⃣ 점수 구간 유효성 검증');
  console.log('─'.repeat(80));

  const scoreRangeOrder = ['70-79점', '60-69점', '50-59점', '45-49점'];
  for (let i = 0; i < scoreRangeOrder.length - 1; i++) {
    const higher = scoreStats[scoreRangeOrder[i]];
    const lower = scoreStats[scoreRangeOrder[i + 1]];

    if (higher && lower) {
      if (higher.avgReturn < lower.avgReturn) {
        const issue = `⚠️ 점수 구간 역전: ${scoreRangeOrder[i]}(${higher.avgReturn}%) < ${scoreRangeOrder[i + 1]}(${lower.avgReturn}%)`;
        console.log(`  ${issue}`);
        issues.push(issue);
      } else {
        console.log(`  ✅ ${scoreRangeOrder[i]}(${higher.avgReturn}%) > ${scoreRangeOrder[i + 1]}(${lower.avgReturn}%)`);
      }
    }
  }

  // 5. 황금 구간 확인
  const golden70s = scoreStats['70-79점'];
  if (golden70s && golden70s.avgReturn > 20) {
    console.log(`  ✨ 황금 구간 발견: 70-79점 (평균 ${golden70s.avgReturn}%)`);
  }

  // 6. 종합 평가
  console.log('\n5️⃣ 종합 평가 및 권장사항');
  console.log('─'.repeat(80));

  if (issues.length === 0) {
    console.log('  ✅ 주요 문제점 없음 - 시스템이 잘 작동하고 있습니다.');
  } else {
    console.log(`  ⚠️ 발견된 문제: ${issues.length}개\n`);
    issues.forEach((issue, i) => {
      console.log(`     ${i + 1}. ${issue}`);
    });
  }

  if (recommendations.length > 0) {
    console.log('\n  📋 권장 개선사항:');
    recommendations.forEach((rec, i) => {
      console.log(`     ${i + 1}. ${rec}`);
    });
  }

  console.log('\n' + '='.repeat(80));
}

// 실행
analyzeRealPerformance();
