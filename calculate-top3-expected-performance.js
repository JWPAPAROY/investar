/**
 * 탑3 선정 기준별 예상 성과 계산
 * 백테스트 데이터 기반
 */
const fs = require('fs');

try {
  const rawData = JSON.parse(fs.readFileSync('backtest-results.json', 'utf8'));
  const data = rawData.stocks || [];

  console.log('\n📊 탑3 선정 기준별 예상 성과 분석\n');
  console.log('='.repeat(80));

  // 필터링: 복합 신호, 과열, 혼재 구간 제외
  const filtered = data.filter(stock => {
    const score = stock.total_score;
    const isComposite = stock.whale_detected && stock.accumulation_detected;
    const isOverheated = stock.recommendation_grade === '과열';
    const isMixedZone = score >= 60 && score < 70;

    return !isComposite && !isOverheated && !isMixedZone && score >= 50;
  });

  console.log(`필터링 후 종목: ${filtered.length}개\n`);

  // Priority 1: 대박 구간 (70-79점) + 고래 감지
  const priority1 = filtered.filter(s =>
    s.total_score >= 70 && s.total_score < 80 &&
    s.whale_detected && !s.accumulation_detected
  );

  // Priority 2: S등급 (75-89점) + 조용한 매집
  const priority2 = filtered.filter(s =>
    s.total_score >= 75 && s.total_score < 90 &&
    !s.whale_detected && s.accumulation_detected
  );

  // Priority 3: 안정 구간 (50-79점) + 일반
  const priority3 = filtered.filter(s =>
    s.total_score >= 50 && s.total_score < 80 &&
    !s.whale_detected && !s.accumulation_detected
  );

  // 각 Priority별 성과 계산
  function calculatePerformance(stocks, label) {
    const returns = stocks.map(s => s.current_return || 0).filter(r => r !== 0);

    if (returns.length === 0) {
      console.log(`${label}: 데이터 없음\n`);
      return null;
    }

    const wins = returns.filter(r => r > 0).length;
    const losses = returns.filter(r => r < 0).length;
    const winRate = (wins / returns.length * 100).toFixed(1);
    const avgReturn = (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);
    const maxReturn = Math.max(...returns).toFixed(2);
    const minReturn = Math.min(...returns).toFixed(2);
    const medianReturn = returns.sort((a, b) => a - b)[Math.floor(returns.length / 2)].toFixed(2);

    console.log(`${label}:`);
    console.log(`  종목수: ${stocks.length}개 (데이터: ${returns.length}개)`);
    console.log(`  승률: ${winRate}% (${wins}승 ${losses}패)`);
    console.log(`  평균 수익률: ${avgReturn}%`);
    console.log(`  중앙값 수익률: ${medianReturn}%`);
    console.log(`  최고/최저: ${maxReturn}% / ${minReturn}%`);

    // TOP 3 샘플 표시
    const top3Samples = [...stocks]
      .filter(s => s.current_return)
      .sort((a, b) => b.current_return - a.current_return)
      .slice(0, 3);

    if (top3Samples.length > 0) {
      console.log(`  샘플 TOP 3:`);
      top3Samples.forEach((s, i) => {
        console.log(`    ${i + 1}. ${s.stock_name} (${s.recommendation_grade}등급, ${s.total_score}점): ${s.current_return.toFixed(2)}%`);
      });
    }

    console.log('');

    return {
      count: stocks.length,
      dataCount: returns.length,
      winRate: parseFloat(winRate),
      avgReturn: parseFloat(avgReturn),
      medianReturn: parseFloat(medianReturn),
      maxReturn: parseFloat(maxReturn),
      minReturn: parseFloat(minReturn)
    };
  }

  const perf1 = calculatePerformance(priority1, '👑 Priority 1: 대박구간(70-79점) + 고래 감지');
  const perf2 = calculatePerformance(priority2, '🥈 Priority 2: S등급(75-89점) + 조용한 매집');
  const perf3 = calculatePerformance(priority3, '🥉 Priority 3: 안정구간(50-79점) + 일반');

  console.log('='.repeat(80));
  console.log('\n🎯 탑3 통합 예상 성과\n');

  // 탑3 통합 계산
  const allPerfs = [perf1, perf2, perf3].filter(p => p !== null);

  if (allPerfs.length > 0) {
    const totalDataCount = allPerfs.reduce((sum, p) => sum + p.dataCount, 0);
    const weightedWinRate = allPerfs.reduce((sum, p) => sum + (p.winRate * p.dataCount), 0) / totalDataCount;
    const weightedAvgReturn = allPerfs.reduce((sum, p) => sum + (p.avgReturn * p.dataCount), 0) / totalDataCount;

    console.log('통합 통계 (데이터 가중 평균):');
    console.log(`  예상 승률: ${weightedWinRate.toFixed(1)}%`);
    console.log(`  예상 평균 수익률: ${weightedAvgReturn.toFixed(2)}%`);
    console.log(`  총 데이터: ${totalDataCount}개 종목 분석\n`);

    // 단순 평균
    const simpleAvgWinRate = allPerfs.reduce((sum, p) => sum + p.winRate, 0) / allPerfs.length;
    const simpleAvgReturn = allPerfs.reduce((sum, p) => sum + p.avgReturn, 0) / allPerfs.length;

    console.log('단순 평균 (각 Priority 동일 가중):');
    console.log(`  예상 승률: ${simpleAvgWinRate.toFixed(1)}%`);
    console.log(`  예상 평균 수익률: ${simpleAvgReturn.toFixed(2)}%\n`);
  }

  console.log('='.repeat(80));
  console.log('\n📈 전체 성과와 비교\n');

  // 전체 성과 (참고용)
  const allReturns = data.map(s => s.current_return || 0).filter(r => r !== 0);
  const allWins = allReturns.filter(r => r > 0).length;
  const allWinRate = (allWins / allReturns.length * 100).toFixed(1);
  const allAvgReturn = (allReturns.reduce((a, b) => a + b, 0) / allReturns.length).toFixed(2);

  console.log(`전체 추천 (175개):`)
  console.log(`  승률: ${allWinRate}%`);
  console.log(`  평균 수익률: ${allAvgReturn}%\n`);

  if (allPerfs.length > 0) {
    const totalDataCount = allPerfs.reduce((sum, p) => sum + p.dataCount, 0);
    const weightedWinRate = allPerfs.reduce((sum, p) => sum + (p.winRate * p.dataCount), 0) / totalDataCount;
    const weightedAvgReturn = allPerfs.reduce((sum, p) => sum + (p.avgReturn * p.dataCount), 0) / totalDataCount;

    console.log(`탑3 vs 전체 차이:`);
    console.log(`  승률: +${(weightedWinRate - parseFloat(allWinRate)).toFixed(1)}%p`);
    console.log(`  평균 수익률: +${(weightedAvgReturn - parseFloat(allAvgReturn)).toFixed(2)}%p`);
  }

  console.log('\n' + '='.repeat(80));

  console.log('\n💡 결론\n');
  console.log('탑3 선정 시:');
  if (allPerfs.length > 0) {
    const totalDataCount = allPerfs.reduce((sum, p) => sum + p.dataCount, 0);
    const weightedWinRate = allPerfs.reduce((sum, p) => sum + (p.winRate * p.dataCount), 0) / totalDataCount;
    const weightedAvgReturn = allPerfs.reduce((sum, p) => sum + (p.avgReturn * p.dataCount), 0) / totalDataCount;

    console.log(`  ✅ 예상 승률: ${weightedWinRate.toFixed(1)}% (전체 대비 +${(weightedWinRate - parseFloat(allWinRate)).toFixed(1)}%p)`);
    console.log(`  ✅ 예상 수익률: ${weightedAvgReturn.toFixed(2)}% (전체 대비 +${(weightedAvgReturn - parseFloat(allAvgReturn)).toFixed(2)}%p)`);
  }
  console.log('  ✅ 복합 신호, 과열, 혼재 구간 제외로 리스크 감소');
  console.log('  ✅ 카테고리 다양성으로 안정성 확보\n');

  console.log('⚠️  주의: 과거 데이터 기반 예상치이므로 실제 성과는 다를 수 있습니다.');

  console.log('\n' + '='.repeat(80));

} catch (error) {
  console.error('❌ 분석 실패:', error.message);
  console.error(error.stack);
}
