/**
 * 심층 분석: 원인 파악 및 통계적 검증
 */

const fs = require('fs');

function deepAnalysis() {
  console.log('🔬 심층 분석 시작...\n');
  console.log('='.repeat(80));

  // 1. 데이터 로드
  const path = require('path');
  const dataPath = path.join(__dirname, 'backtest-results.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const stocks = data.stocks || [];

  console.log(`\n📊 총 ${stocks.length}개 추천 이력 분석\n`);

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
      // 과열 감지는 데이터에 없을 수 있음
      days: stock.days_since_recommendation || 0
    };
  });

  console.log('\n' + '='.repeat(80));
  console.log('1️⃣ 점수 구간별 세부 분석 (복합신호/일반 분리)');
  console.log('='.repeat(80));

  const scoreRanges = [
    { min: 50, max: 60, label: '50-59점' },
    { min: 60, max: 70, label: '60-69점' },
    { min: 70, max: 80, label: '70-79점' },
    { min: 80, max: 100, label: '80+점' }
  ];

  for (const range of scoreRanges) {
    const rangeStocks = results.filter(r => r.score >= range.min && r.score < range.max);

    if (rangeStocks.length === 0) continue;

    const composite = rangeStocks.filter(r => r.isComposite);
    const nonComposite = rangeStocks.filter(r => !r.isComposite);

    console.log(`\n📍 ${range.label} (총 ${rangeStocks.length}개)`);
    console.log('─'.repeat(80));

    // 전체 통계
    const allStats = calculateStats(rangeStocks);
    console.log(`  전체: 승률 ${allStats.winRate}% | 평균 ${allStats.avgReturn > 0 ? '+' : ''}${allStats.avgReturn}%`);

    // 복합신호 분리
    if (composite.length > 0) {
      const compStats = calculateStats(composite);
      console.log(`  └─ 복합신호 (${composite.length}개): 승률 ${compStats.winRate}% | 평균 ${compStats.avgReturn > 0 ? '+' : ''}${compStats.avgReturn}%`);
    }

    if (nonComposite.length > 0) {
      const nonCompStats = calculateStats(nonComposite);
      console.log(`  └─ 일반 (${nonComposite.length}개): 승률 ${nonCompStats.winRate}% | 평균 ${nonCompStats.avgReturn > 0 ? '+' : ''}${nonCompStats.avgReturn}%`);
    }

    // 통계적 유의성 검토
    if (rangeStocks.length >= 30) {
      console.log(`  ✅ 샘플 크기 충분 (${rangeStocks.length}개 ≥ 30)`);
    } else if (rangeStocks.length >= 15) {
      console.log(`  ⚠️ 샘플 크기 보통 (${rangeStocks.length}개, 최소 30개 권장)`);
    } else {
      console.log(`  ❌ 샘플 크기 부족 (${rangeStocks.length}개 < 15, 통계적 신뢰도 낮음)`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('2️⃣ 70-79점 "황금구간" 상세 분석');
  console.log('='.repeat(80));

  const golden = results.filter(r => r.score >= 70 && r.score < 80);
  console.log(`\n샘플 수: ${golden.length}개`);

  if (golden.length > 0) {
    console.log('\n개별 종목 상세:');
    console.log('─'.repeat(80));
    golden.sort((a, b) => b.return - a.return).forEach((stock, i) => {
      const composite = stock.isComposite ? '🔴 복합' : '';
      const whale = !stock.isComposite && stock.isWhale ? '🐋 고래' : '';
      const accum = !stock.isComposite && stock.isAccumulation ? '🤫 매집' : '';
      const signal = composite || whale || accum || '⚪ 일반';

      console.log(`  ${i + 1}. [${stock.name}] ${stock.score}점 | ${stock.return > 0 ? '+' : ''}${stock.return.toFixed(2)}% | ${signal}`);
    });

    // 패턴 분석
    const goldenComposite = golden.filter(r => r.isComposite);
    const goldenWhale = golden.filter(r => r.isWhale && !r.isAccumulation);
    const goldenAccum = golden.filter(r => r.isAccumulation && !r.isWhale);
    const goldenNormal = golden.filter(r => !r.isWhale && !r.isAccumulation);

    console.log('\n카테고리 분포:');
    console.log(`  복합신호: ${goldenComposite.length}개`);
    console.log(`  고래 단독: ${goldenWhale.length}개`);
    console.log(`  매집 단독: ${goldenAccum.length}개`);
    console.log(`  일반: ${goldenNormal.length}개`);

    // 통계적 검증
    console.log('\n통계적 검증:');
    if (golden.length < 15) {
      console.log(`  ❌ 샘플 부족: ${golden.length}개 < 15개`);
      console.log(`  → 최소 15개, 권장 30개 이상 필요`);
      console.log(`  → 현재는 "경향성"만 참고, "확정적 결론" 불가`);
    } else if (golden.length < 30) {
      console.log(`  ⚠️ 샘플 보통: ${golden.length}개 (최소 충족, 30개 권장)`);
      console.log(`  → 경향성은 보이지만, 더 많은 데이터로 재검증 필요`);
    } else {
      console.log(`  ✅ 샘플 충분: ${golden.length}개 ≥ 30개`);
    }

    const stats = calculateStats(golden);
    console.log(`\n평균 수익률: ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}%`);
    console.log(`표준편차: ${stats.stdDev}%`);
    console.log(`신뢰구간 (95%): ${(stats.avgReturn - 1.96 * stats.stdDev / Math.sqrt(golden.length)).toFixed(2)}% ~ ${(stats.avgReturn + 1.96 * stats.stdDev / Math.sqrt(golden.length)).toFixed(2)}%`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('3️⃣ A등급 vs B등급 비교 (변수 통제)');
  console.log('='.repeat(80));

  const gradeA = results.filter(r => r.grade === 'A');
  const gradeB = results.filter(r => r.grade === 'B');

  console.log(`\nA등급: ${gradeA.length}개 | B등급: ${gradeB.length}개`);

  if (gradeA.length > 0) {
    console.log('\n📊 A등급 세부 분석:');
    console.log('─'.repeat(80));

    const aComposite = gradeA.filter(r => r.isComposite);
    const aNonComposite = gradeA.filter(r => !r.isComposite);

    const aStats = calculateStats(gradeA);
    console.log(`  전체 (${gradeA.length}개): 승률 ${aStats.winRate}% | 평균 ${aStats.avgReturn > 0 ? '+' : ''}${aStats.avgReturn}%`);

    if (aComposite.length > 0) {
      const aCompStats = calculateStats(aComposite);
      console.log(`  └─ 복합신호 (${aComposite.length}개): 승률 ${aCompStats.winRate}% | 평균 ${aCompStats.avgReturn > 0 ? '+' : ''}${aCompStats.avgReturn}%`);
    }

    if (aNonComposite.length > 0) {
      const aNonCompStats = calculateStats(aNonComposite);
      console.log(`  └─ 일반 (${aNonComposite.length}개): 승률 ${aNonCompStats.winRate}% | 평균 ${aNonCompStats.avgReturn > 0 ? '+' : ''}${aNonCompStats.avgReturn}%`);
    }

    // A등급 손실 종목 분석
    const aLosers = gradeA.filter(r => !r.isWin).sort((a, b) => a.return - b.return);
    if (aLosers.length > 0) {
      console.log(`\n  최대 손실 TOP 5:`);
      aLosers.slice(0, 5).forEach((stock, i) => {
        const signal = stock.isComposite ? '🔴 복합' : stock.isWhale ? '🐋 고래' : stock.isAccumulation ? '🤫 매집' : '⚪ 일반';
        console.log(`    ${i + 1}. [${stock.name}] ${stock.return.toFixed(2)}% | ${signal}`);
      });
    }
  }

  if (gradeB.length > 0) {
    console.log('\n📊 B등급 세부 분석:');
    console.log('─'.repeat(80));

    const bComposite = gradeB.filter(r => r.isComposite);
    const bNonComposite = gradeB.filter(r => !r.isComposite);

    const bStats = calculateStats(gradeB);
    console.log(`  전체 (${gradeB.length}개): 승률 ${bStats.winRate}% | 평균 ${bStats.avgReturn > 0 ? '+' : ''}${bStats.avgReturn}%`);

    if (bComposite.length > 0) {
      const bCompStats = calculateStats(bComposite);
      console.log(`  └─ 복합신호 (${bComposite.length}개): 승률 ${bCompStats.winRate}% | 평균 ${bCompStats.avgReturn > 0 ? '+' : ''}${bCompStats.avgReturn}%`);
    }

    if (bNonComposite.length > 0) {
      const bNonCompStats = calculateStats(bNonComposite);
      console.log(`  └─ 일반 (${bNonComposite.length}개): 승률 ${bNonCompStats.winRate}% | 평균 ${bNonCompStats.avgReturn > 0 ? '+' : ''}${bNonCompStats.avgReturn}%`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('4️⃣ 복합 신호 영향력 분석');
  console.log('='.repeat(80));

  const allComposite = results.filter(r => r.isComposite);
  const allNonComposite = results.filter(r => !r.isComposite);

  console.log(`\n복합신호 있음: ${allComposite.length}개`);
  console.log(`복합신호 없음: ${allNonComposite.length}개`);

  if (allComposite.length > 0) {
    const compStats = calculateStats(allComposite);
    console.log(`\n복합신호 전체 성과: 승률 ${compStats.winRate}% | 평균 ${compStats.avgReturn > 0 ? '+' : ''}${compStats.avgReturn}%`);

    // 등급별 복합신호 비율
    console.log('\n등급별 복합신호 비율:');
    const grades = ['S', 'A', 'B', 'C', 'D', '과열'];
    for (const grade of grades) {
      const gradeStocks = results.filter(r => r.grade === grade);
      const gradeComposite = gradeStocks.filter(r => r.isComposite);
      if (gradeStocks.length > 0) {
        const ratio = (gradeComposite.length / gradeStocks.length * 100).toFixed(1);
        console.log(`  ${grade}등급: ${gradeComposite.length}/${gradeStocks.length} (${ratio}%)`);
      }
    }
  }

  if (allNonComposite.length > 0) {
    const nonCompStats = calculateStats(allNonComposite);
    console.log(`\n일반 전체 성과: 승률 ${nonCompStats.winRate}% | 평균 ${nonCompStats.avgReturn > 0 ? '+' : ''}${nonCompStats.avgReturn}%`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('5️⃣ 최종 결론 및 권장사항');
  console.log('='.repeat(80));

  // 결론 도출
  const conclusions = [];
  const recommendations = [];

  // 1. 복합신호 검증
  if (allComposite.length >= 15) {
    const compStats = calculateStats(allComposite);
    if (compStats.avgReturn < -5 || compStats.winRate < 30) {
      conclusions.push(`✅ 복합신호는 확실한 문제 (${allComposite.length}개 샘플, 승률 ${compStats.winRate}%, 평균 ${compStats.avgReturn.toFixed(2)}%)`);
      recommendations.push('복합 신호 페널티 강화 (-15점 → -30점) 또는 완전 차단');
    }
  } else {
    conclusions.push(`⚠️ 복합신호 샘플 부족 (${allComposite.length}개 < 15개, 재검증 필요)`);
  }

  // 2. 70-79점 검증
  if (golden.length >= 30) {
    const goldenStats = calculateStats(golden);
    conclusions.push(`✅ 70-79점 황금구간 검증됨 (${golden.length}개 샘플, 평균 ${goldenStats.avgReturn.toFixed(2)}%)`);
    recommendations.push('70-79점 구간에 특별 표시 추가');
  } else if (golden.length >= 15) {
    conclusions.push(`⚠️ 70-79점 경향성 있음 (${golden.length}개 샘플, 하지만 30개 미만으로 재검증 필요)`);
    recommendations.push('70-79점 데이터 더 축적 후 재평가 (현재 ${golden.length}/30개)');
  } else {
    conclusions.push(`❌ 70-79점 샘플 부족 (${golden.length}개 < 15개, 과적합 위험)`);
    recommendations.push('70-79점 "황금구간" 단정 보류, 데이터 더 수집');
  }

  // 3. 60-69점 검증
  const range6069 = results.filter(r => r.score >= 60 && r.score < 70);
  if (range6069.length > 0) {
    const comp6069 = range6069.filter(r => r.isComposite);
    const nonComp6069 = range6069.filter(r => !r.isComposite);

    if (comp6069.length > 0 && nonComp6069.length > 0) {
      const compStats = calculateStats(comp6069);
      const nonCompStats = calculateStats(nonComp6069);

      if (compStats.avgReturn < -5 && nonCompStats.avgReturn > 0) {
        conclusions.push(`✅ 60-69점 문제는 복합신호 때문 (복합: ${compStats.avgReturn.toFixed(2)}%, 일반: ${nonCompStats.avgReturn.toFixed(2)}%)`);
        recommendations.push('60-69점 제외가 아니라, 복합신호 페널티 강화가 해결책');
      } else {
        conclusions.push(`⚠️ 60-69점 문제는 복합신호 외 다른 요인도 있음`);
      }
    }
  }

  console.log('\n📋 도출된 결론:');
  conclusions.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));

  console.log('\n💡 권장사항:');
  recommendations.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

  console.log('\n' + '='.repeat(80));

  // 결과 저장
  const summary = {
    timestamp: new Date().toISOString(),
    totalSamples: results.length,
    scoreRangeAnalysis: {},
    goldenZone: {
      samples: golden.length,
      stocks: golden.map(g => ({
        name: g.name,
        score: g.score,
        return: g.return,
        isComposite: g.isComposite
      }))
    },
    compositeSignal: {
      total: allComposite.length,
      stats: allComposite.length > 0 ? calculateStats(allComposite) : null
    },
    conclusions,
    recommendations
  };

  const outputPath = path.join(__dirname, 'deep-analysis-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log('\n💾 상세 분석 결과가 deep-analysis-results.json에 저장되었습니다.\n');
}

function calculateStats(items) {
  if (items.length === 0) return null;

  const count = items.length;
  const winCount = items.filter(r => r.isWin).length;
  const winRate = (winCount / count) * 100;
  const returns = items.map(r => r.return);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / count;

  // 표준편차
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / count;
  const stdDev = Math.sqrt(variance);

  return {
    count,
    winCount,
    winRate: parseFloat(winRate.toFixed(2)),
    avgReturn: parseFloat(avgReturn.toFixed(2)),
    stdDev: parseFloat(stdDev.toFixed(2))
  };
}

// 실행
deepAnalysis();
