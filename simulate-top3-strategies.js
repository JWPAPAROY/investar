/**
 * 탑3 선정 전략 시뮬레이션
 * 여러 조합을 테스트하여 최고 성과 전략 찾기
 */
const fs = require('fs');

try {
  const rawData = JSON.parse(fs.readFileSync('backtest-results.json', 'utf8'));
  const data = rawData.stocks || [];

  console.log('\n🔬 탑3 선정 전략 시뮬레이션 (175개 종목)\n');
  console.log('='.repeat(80));

  // 성과 계산 함수
  function calculatePerformance(stocks, strategyName) {
    const returns = stocks.map(s => s.current_return || 0).filter(r => r !== 0);

    if (returns.length === 0) {
      return null;
    }

    const wins = returns.filter(r => r > 0).length;
    const losses = returns.filter(r => r < 0).length;
    const winRate = (wins / returns.length * 100);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const maxReturn = Math.max(...returns);
    const minReturn = Math.min(...returns);

    return {
      name: strategyName,
      count: returns.length,
      winRate: winRate,
      avgReturn: avgReturn,
      maxReturn: maxReturn,
      minReturn: minReturn,
      wins: wins,
      losses: losses
    };
  }

  // 전략들
  const strategies = [];

  // ========================================
  // 1. 카테고리 단독 전략
  // ========================================

  // 1-1. 고래 감지만
  const whaleOnly = data.filter(s =>
    s.whale_detected &&
    !s.accumulation_detected &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(whaleOnly, '1. 고래 감지 단독'));

  // 1-2. 조용한 매집만
  const accumOnly = data.filter(s =>
    !s.whale_detected &&
    s.accumulation_detected &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(accumOnly, '2. 조용한 매집 단독'));

  // 1-3. 일반만
  const normalOnly = data.filter(s =>
    !s.whale_detected &&
    !s.accumulation_detected &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(normalOnly, '3. 일반 단독'));

  // ========================================
  // 2. 점수 구간 전략
  // ========================================

  // 2-1. 70-79점 (대박 구간)
  const score70_79 = data.filter(s =>
    s.total_score >= 70 && s.total_score < 80 &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(score70_79, '4. 점수 70-79점 (대박구간)'));

  // 2-2. 50-59점 (안정 구간)
  const score50_59 = data.filter(s =>
    s.total_score >= 50 && s.total_score < 60 &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(score50_59, '5. 점수 50-59점 (안정구간)'));

  // 2-3. 60-69점 (혼재 구간)
  const score60_69 = data.filter(s =>
    s.total_score >= 60 && s.total_score < 70 &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(score60_69, '6. 점수 60-69점 (혼재구간)'));

  // ========================================
  // 3. 카테고리 + 점수 조합
  // ========================================

  // 3-1. 고래 + 70-79점
  const whale_70_79 = data.filter(s =>
    s.whale_detected && !s.accumulation_detected &&
    s.total_score >= 70 && s.total_score < 80 &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(whale_70_79, '7. 고래 + 대박구간(70-79점)'));

  // 3-2. 고래 + 50-79점
  const whale_50_79 = data.filter(s =>
    s.whale_detected && !s.accumulation_detected &&
    s.total_score >= 50 && s.total_score < 80 &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(whale_50_79, '8. 고래 + 황금구간(50-79점)'));

  // 3-3. 고래 + 60점 이상
  const whale_60plus = data.filter(s =>
    s.whale_detected && !s.accumulation_detected &&
    s.total_score >= 60 &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(whale_60plus, '9. 고래 + 60점 이상'));

  // ========================================
  // 4. 등급 기반 전략
  // ========================================

  // 4-1. S등급만
  const sGrade = data.filter(s =>
    s.recommendation_grade === 'S'
  );
  strategies.push(calculatePerformance(sGrade, '10. S등급 단독'));

  // 4-2. B등급만
  const bGrade = data.filter(s =>
    s.recommendation_grade === 'B'
  );
  strategies.push(calculatePerformance(bGrade, '11. B등급 단독'));

  // 4-3. S+B등급
  const sbGrade = data.filter(s =>
    s.recommendation_grade === 'S' || s.recommendation_grade === 'B'
  );
  strategies.push(calculatePerformance(sbGrade, '12. S+B등급 조합'));

  // ========================================
  // 5. 복합 전략
  // ========================================

  // 5-1. 고래 + S등급
  const whale_s = data.filter(s =>
    s.whale_detected && !s.accumulation_detected &&
    s.recommendation_grade === 'S'
  );
  strategies.push(calculatePerformance(whale_s, '13. 고래 + S등급'));

  // 5-2. 고래 + B등급
  const whale_b = data.filter(s =>
    s.whale_detected && !s.accumulation_detected &&
    s.recommendation_grade === 'B'
  );
  strategies.push(calculatePerformance(whale_b, '14. 고래 + B등급'));

  // 5-3. 황금구간(50-79) + 고래 제외
  const golden_no_whale = data.filter(s =>
    !s.whale_detected &&
    s.total_score >= 50 && s.total_score < 80 &&
    s.recommendation_grade !== '과열'
  );
  strategies.push(calculatePerformance(golden_no_whale, '15. 황금구간(50-79) 고래제외'));

  // 5-4. 대박구간(70-79) + 카테고리 무관
  const jackpot_any = data.filter(s =>
    s.total_score >= 70 && s.total_score < 80 &&
    !s.accumulation_detected && !s.whale_detected || // 복합 제외
    (s.whale_detected && !s.accumulation_detected) ||
    (s.accumulation_detected && !s.whale_detected)
  );
  strategies.push(calculatePerformance(jackpot_any, '16. 대박구간(70-79) 카테고리무관'));

  // ========================================
  // 결과 정렬 및 출력
  // ========================================

  const validStrategies = strategies.filter(s => s !== null);

  // 승률 순 정렬
  const byWinRate = [...validStrategies].sort((a, b) => b.winRate - a.winRate);
  console.log('\n📊 승률 순위 (TOP 10)\n');
  byWinRate.slice(0, 10).forEach((s, i) => {
    console.log(`${i + 1}. ${s.name}`);
    console.log(`   승률: ${s.winRate.toFixed(1)}% (${s.wins}승 ${s.losses}패)`);
    console.log(`   평균: ${s.avgReturn.toFixed(2)}% | 종목수: ${s.count}개`);
    console.log('');
  });

  // 평균 수익률 순 정렬
  const byAvgReturn = [...validStrategies].sort((a, b) => b.avgReturn - a.avgReturn);
  console.log('='.repeat(80));
  console.log('\n💰 평균 수익률 순위 (TOP 10)\n');
  byAvgReturn.slice(0, 10).forEach((s, i) => {
    console.log(`${i + 1}. ${s.name}`);
    console.log(`   평균: ${s.avgReturn.toFixed(2)}%`);
    console.log(`   승률: ${s.winRate.toFixed(1)}% | 종목수: ${s.count}개`);
    console.log('');
  });

  // 종합 점수 (승률 * 평균수익률)
  const composite = validStrategies.map(s => ({
    ...s,
    composite: s.winRate * s.avgReturn / 100
  })).sort((a, b) => b.composite - a.composite);

  console.log('='.repeat(80));
  console.log('\n🏆 종합 점수 순위 (승률 × 평균수익률) TOP 10\n');
  composite.slice(0, 10).forEach((s, i) => {
    console.log(`${i + 1}. ${s.name}`);
    console.log(`   종합: ${s.composite.toFixed(2)}점`);
    console.log(`   승률: ${s.winRate.toFixed(1)}% | 평균: ${s.avgReturn.toFixed(2)}% | 종목수: ${s.count}개`);
    console.log('');
  });

  // 샘플 수 고려 (10개 이상만)
  const withSample = validStrategies.filter(s => s.count >= 10);
  const bySample = [...withSample].sort((a, b) => b.winRate - a.winRate);

  console.log('='.repeat(80));
  console.log('\n📈 신뢰도 높은 전략 (샘플 10개 이상) 승률 순\n');
  bySample.slice(0, 5).forEach((s, i) => {
    console.log(`${i + 1}. ${s.name}`);
    console.log(`   승률: ${s.winRate.toFixed(1)}% (${s.wins}승 ${s.losses}패)`);
    console.log(`   평균: ${s.avgReturn.toFixed(2)}% | 종목수: ${s.count}개`);
    console.log('');
  });

  console.log('='.repeat(80));
  console.log('\n💡 결론\n');

  const best = composite[0];
  console.log(`최고 종합 성과 전략: ${best.name}`);
  console.log(`  승률: ${best.winRate.toFixed(1)}%`);
  console.log(`  평균 수익률: ${best.avgReturn.toFixed(2)}%`);
  console.log(`  종목수: ${best.count}개`);
  console.log(`  종합 점수: ${best.composite.toFixed(2)}점\n`);

  if (bySample.length > 0) {
    const reliable = bySample[0];
    console.log(`가장 신뢰도 높은 전략 (샘플 10개+): ${reliable.name}`);
    console.log(`  승률: ${reliable.winRate.toFixed(1)}%`);
    console.log(`  평균 수익률: ${reliable.avgReturn.toFixed(2)}%`);
    console.log(`  종목수: ${reliable.count}개\n`);
  }

  console.log('='.repeat(80));

} catch (error) {
  console.error('❌ 시뮬레이션 실패:', error.message);
  console.error(error.stack);
}
