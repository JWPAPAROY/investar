/**
 * 개선 전/후 백테스트 비교 분석
 * v3.12.1 (복합신호 -15점 페널티) vs v3.12.2 (복합신호 완전 차단)
 */

const fs = require('fs');
const path = require('path');

function compareBeforeAfter() {
  console.log('📊 개선 전/후 백테스트 비교 분석\n');
  console.log('='.repeat(80));

  // 1. 데이터 로드
  const dataPath = path.join(__dirname, 'backtest-results.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const stocks = data.stocks || [];

  console.log(`\n총 ${stocks.length}개 추천 이력 분석\n`);

  // 2. 각 종목 데이터 정규화
  const results = stocks.map(stock => {
    const latestPrice = stock.daily_prices && stock.daily_prices.length > 0
      ? stock.daily_prices[stock.daily_prices.length - 1]
      : null;

    const currentReturn = latestPrice
      ? parseFloat(latestPrice.cumulativeReturn || latestPrice.return || 0)
      : stock.current_return || 0;

    return {
      code: stock.stock_code,
      name: stock.stock_name,
      grade: stock.recommendation_grade,
      score: stock.total_score,
      return: currentReturn,
      isWin: currentReturn > 0,
      isWhale: stock.whale_detected,
      isAccumulation: stock.accumulation_detected,
      isComposite: stock.whale_detected && stock.accumulation_detected,
      days: stock.days_since_recommendation || 0
    };
  });

  // 3. 개선 전 (v3.12.1): 전체 175개 종목
  const before = results;
  const beforeStats = calculateStats(before, '개선 전 (v3.12.1)');

  // 4. 개선 후 (v3.12.2): 복합신호 제외 157개 종목
  const after = results.filter(r => !r.isComposite);
  const afterStats = calculateStats(after, '개선 후 (v3.12.2)');

  // 5. 제외된 복합신호 종목
  const excluded = results.filter(r => r.isComposite);
  const excludedStats = calculateStats(excluded, '제외된 복합신호');

  console.log('\n' + '='.repeat(80));
  console.log('📊 개선 전/후 비교');
  console.log('='.repeat(80));

  console.log('\n🔴 개선 전 (v3.12.1 - 복합신호 -15점 페널티)');
  console.log('─'.repeat(80));
  printStats(beforeStats);

  console.log('\n🟢 개선 후 (v3.12.2 - 복합신호 완전 차단)');
  console.log('─'.repeat(80));
  printStats(afterStats);

  console.log('\n❌ 제외된 복합신호 종목');
  console.log('─'.repeat(80));
  printStats(excludedStats);

  // 6. 개선 효과 계산
  console.log('\n' + '='.repeat(80));
  console.log('📈 개선 효과');
  console.log('='.repeat(80));

  const improvements = {
    avgReturn: afterStats.avgReturn - beforeStats.avgReturn,
    winRate: afterStats.winRate - beforeStats.winRate,
    profitFactor: afterStats.profitFactor - beforeStats.profitFactor,
    stocksExcluded: excluded.length,
    percentExcluded: (excluded.length / before.length * 100).toFixed(1)
  };

  console.log(`\n평균 수익률: ${beforeStats.avgReturn > 0 ? '+' : ''}${beforeStats.avgReturn}% → ${afterStats.avgReturn > 0 ? '+' : ''}${afterStats.avgReturn}% (${improvements.avgReturn > 0 ? '+' : ''}${improvements.avgReturn.toFixed(2)}%p)`);
  console.log(`승률: ${beforeStats.winRate}% → ${afterStats.winRate}% (${improvements.winRate > 0 ? '+' : ''}${improvements.winRate.toFixed(2)}%p)`);
  console.log(`Profit Factor: ${beforeStats.profitFactor} → ${afterStats.profitFactor} (${improvements.profitFactor > 0 ? '+' : ''}${improvements.profitFactor.toFixed(2)})`);
  console.log(`\n제외된 종목: ${improvements.stocksExcluded}개 (전체의 ${improvements.percentExcluded}%)`);

  // 7. 등급별 개선 효과
  console.log('\n' + '='.repeat(80));
  console.log('📊 등급별 개선 효과');
  console.log('='.repeat(80));

  const grades = ['S', 'A', 'B', 'C', 'D', '과열'];
  const gradeComparison = [];

  for (const grade of grades) {
    const beforeGrade = before.filter(r => r.grade === grade);
    const afterGrade = after.filter(r => r.grade === grade);
    const excludedGrade = excluded.filter(r => r.grade === grade);

    if (beforeGrade.length > 0) {
      const beforeGradeStats = calculateStats(beforeGrade);
      const afterGradeStats = afterGrade.length > 0 ? calculateStats(afterGrade) : null;

      console.log(`\n${grade}등급:`);
      console.log(`  개선 전: ${beforeGrade.length}개 | 승률 ${beforeGradeStats.winRate}% | 평균 ${beforeGradeStats.avgReturn > 0 ? '+' : ''}${beforeGradeStats.avgReturn}%`);

      if (afterGradeStats) {
        const improvement = afterGradeStats.avgReturn - beforeGradeStats.avgReturn;
        console.log(`  개선 후: ${afterGrade.length}개 | 승률 ${afterGradeStats.winRate}% | 평균 ${afterGradeStats.avgReturn > 0 ? '+' : ''}${afterGradeStats.avgReturn}%`);
        console.log(`  효과: ${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}%p | 제외 ${excludedGrade.length}개`);

        gradeComparison.push({
          grade,
          before: beforeGradeStats,
          after: afterGradeStats,
          excluded: excludedGrade.length,
          improvement
        });
      } else {
        console.log(`  개선 후: 0개 (전체 제외)`);
      }
    }
  }

  // 8. 제외된 복합신호 종목 상세
  console.log('\n' + '='.repeat(80));
  console.log('❌ 제외된 복합신호 종목 상세 (${excluded.length}개)');
  console.log('='.repeat(80));

  if (excluded.length > 0) {
    console.log('\n최대 손실 TOP 5:');
    const losers = excluded.filter(r => !r.isWin).sort((a, b) => a.return - b.return).slice(0, 5);
    losers.forEach((stock, i) => {
      console.log(`  ${i + 1}. [${stock.name}] ${stock.grade}등급 | ${stock.score}점 | ${stock.return.toFixed(2)}%`);
    });

    if (excluded.filter(r => r.isWin).length > 0) {
      console.log('\n수익 종목 (아쉬움):');
      const winners = excluded.filter(r => r.isWin).sort((a, b) => b.return - a.return);
      winners.forEach((stock, i) => {
        console.log(`  ${i + 1}. [${stock.name}] ${stock.grade}등급 | ${stock.score}점 | +${stock.return.toFixed(2)}%`);
      });
    }
  }

  // 9. 최종 판정
  console.log('\n' + '='.repeat(80));
  console.log('🎯 최종 판정');
  console.log('='.repeat(80));

  const verdict = [];

  if (improvements.avgReturn > 2) {
    verdict.push('✅ 평균 수익률 개선 효과 큼 (>2%p)');
  } else if (improvements.avgReturn > 0) {
    verdict.push('✅ 평균 수익률 개선 (양수)');
  } else {
    verdict.push('⚠️ 평균 수익률 개선 미흡');
  }

  if (improvements.winRate > 3) {
    verdict.push('✅ 승률 개선 효과 큼 (>3%p)');
  } else if (improvements.winRate > 0) {
    verdict.push('✅ 승률 개선 (양수)');
  } else {
    verdict.push('⚠️ 승률 개선 미흡');
  }

  if (excludedStats.avgReturn < -5) {
    verdict.push('✅ 제외된 종목이 확실히 나쁨 (<-5%)');
  } else if (excludedStats.avgReturn < 0) {
    verdict.push('✅ 제외된 종목이 손실 (음수)');
  } else {
    verdict.push('⚠️ 제외된 종목 중 수익 종목도 있음');
  }

  const winnersExcluded = excluded.filter(r => r.isWin).length;
  if (winnersExcluded === 0) {
    verdict.push('✅ 수익 종목 손실 없음 (0개 제외)');
  } else if (winnersExcluded <= 2) {
    verdict.push(`⚠️ 수익 종목 ${winnersExcluded}개 제외됨 (트레이드오프 허용 가능)`);
  } else {
    verdict.push(`❌ 수익 종목 ${winnersExcluded}개 제외됨 (트레이드오프 검토 필요)`);
  }

  console.log('');
  verdict.forEach(v => console.log(`  ${v}`));

  // 10. 권장사항
  console.log('\n💡 권장사항:');
  if (improvements.avgReturn > 0 && improvements.winRate > 0) {
    console.log('  ✅ v3.12.2 복합신호 완전 차단 로직 배포 권장');
    console.log('  ✅ Vercel에 배포 후 1-2주간 실전 성과 모니터링');
  } else {
    console.log('  ⚠️ 추가 검토 필요 - 개선 효과가 명확하지 않음');
  }

  console.log('\n' + '='.repeat(80));

  // 11. 결과 저장
  const summary = {
    timestamp: new Date().toISOString(),
    version: {
      before: 'v3.12.1 (복합신호 -15점 페널티)',
      after: 'v3.12.2 (복합신호 완전 차단)'
    },
    before: beforeStats,
    after: afterStats,
    excluded: excludedStats,
    improvements,
    gradeComparison,
    verdict,
    excludedStocks: excluded.map(e => ({
      name: e.name,
      grade: e.grade,
      score: e.score,
      return: e.return
    }))
  };

  const outputPath = path.join(__dirname, 'comparison-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log('\n💾 비교 결과가 comparison-results.json에 저장되었습니다.\n');
}

function calculateStats(items, label) {
  if (items.length === 0) return null;

  const count = items.length;
  const winCount = items.filter(r => r.isWin).length;
  const winRate = (winCount / count) * 100;
  const returns = items.map(r => r.return);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / count;
  const maxReturn = Math.max(...returns);
  const minReturn = Math.min(...returns);

  // Profit Factor
  const wins = items.filter(r => r.isWin);
  const losses = items.filter(r => !r.isWin);
  const totalProfit = wins.reduce((sum, r) => sum + r.return, 0);
  const totalLoss = Math.abs(losses.reduce((sum, r) => sum + r.return, 0));
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;

  return {
    label: label || '',
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

function printStats(stats) {
  if (!stats) {
    console.log('  (데이터 없음)');
    return;
  }

  console.log(`  총 ${stats.count}개`);
  console.log(`  승/패: ${stats.winCount}승 ${stats.lossCount}패`);
  console.log(`  승률: ${stats.winRate}%`);
  console.log(`  평균 수익률: ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}%`);
  console.log(`  최고/최저: +${stats.maxReturn}% / ${stats.minReturn}%`);
  console.log(`  Profit Factor: ${stats.profitFactor}`);
}

// 실행
compareBeforeAfter();
