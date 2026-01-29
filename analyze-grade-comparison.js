/**
 * 등급별/카테고리별 상세 비교 분석
 * 과열등급 vs B등급 심층 분석
 */

const fs = require('fs');

function analyzeGradeComparison() {
  console.log('📊 등급별 상세 비교 분석 시작...\n');
  console.log('='.repeat(80));

  // 30일 결과 로드
  const result30 = JSON.parse(fs.readFileSync('./backtest-latest-results.json', 'utf8'));

  // 90일 결과 로드
  const result90 = JSON.parse(fs.readFileSync('./backtest-90days-results.json', 'utf8'));

  console.log('\n📋 데이터 요약');
  console.log('─'.repeat(80));
  console.log(`  30일 백테스트: ${result30.results.length}개 샘플`);
  console.log(`  90일 백테스트: ${result90.results.length}개 샘플`);
  console.log(`  총 분석 대상: ${result30.results.length + result90.results.length}개 샘플`);

  // 90일 데이터 기준 상세 분석
  const overheat = result90.results.filter(r => r.grade === '과열');
  const gradeB = result90.results.filter(r => r.grade === 'B');

  console.log('\n🔥 과열등급 상세 분석 (90일)');
  console.log('─'.repeat(80));
  console.log(`  샘플 수: ${overheat.length}개`);
  console.log(`  승률: ${(overheat.filter(r => r.isWin).length / overheat.length * 100).toFixed(2)}%`);
  console.log(`  평균 수익률: +${(overheat.reduce((sum, r) => sum + r.returnRate, 0) / overheat.length).toFixed(2)}%`);
  console.log(`  최고 수익: +${Math.max(...overheat.map(r => r.returnRate)).toFixed(2)}%`);
  console.log(`  최저 수익: +${Math.min(...overheat.map(r => r.returnRate)).toFixed(2)}%`);

  // 과열등급 종목 리스트
  const overheatStocks = {};
  overheat.forEach(r => {
    if (!overheatStocks[r.stockName]) {
      overheatStocks[r.stockName] = [];
    }
    overheatStocks[r.stockName].push(r.returnRate);
  });

  console.log('\n  📈 과열등급 종목별 성과:');
  Object.entries(overheatStocks)
    .sort((a, b) => {
      const avgA = a[1].reduce((sum, val) => sum + val, 0) / a[1].length;
      const avgB = b[1].reduce((sum, val) => sum + val, 0) / b[1].length;
      return avgB - avgA;
    })
    .forEach(([name, returns]) => {
      const avg = (returns.reduce((sum, val) => sum + val, 0) / returns.length).toFixed(2);
      const count = returns.length;
      console.log(`     ${name}: 평균 +${avg}% (${count}회 출현)`);
    });

  console.log('\n🟦 B등급 상세 분석 (90일)');
  console.log('─'.repeat(80));
  console.log(`  샘플 수: ${gradeB.length}개`);
  console.log(`  승률: ${(gradeB.filter(r => r.isWin).length / gradeB.length * 100).toFixed(2)}%`);
  console.log(`  평균 수익률: +${(gradeB.reduce((sum, r) => sum + r.returnRate, 0) / gradeB.length).toFixed(2)}%`);
  console.log(`  최고 수익: +${Math.max(...gradeB.map(r => r.returnRate)).toFixed(2)}%`);
  console.log(`  최저 수익: +${Math.min(...gradeB.map(r => r.returnRate)).toFixed(2)}%`);

  // B등급 종목 리스트
  const gradeBStocks = {};
  gradeB.forEach(r => {
    if (!gradeBStocks[r.stockName]) {
      gradeBStocks[r.stockName] = [];
    }
    gradeBStocks[r.stockName].push(r.returnRate);
  });

  console.log('\n  📈 B등급 종목별 성과 (TOP 10):');
  Object.entries(gradeBStocks)
    .sort((a, b) => {
      const avgA = a[1].reduce((sum, val) => sum + val, 0) / a[1].length;
      const avgB = b[1].reduce((sum, val) => sum + val, 0) / b[1].length;
      return avgB - avgA;
    })
    .slice(0, 10)
    .forEach(([name, returns]) => {
      const avg = (returns.reduce((sum, val) => sum + val, 0) / returns.length).toFixed(2);
      const count = returns.length;
      console.log(`     ${name}: 평균 +${avg}% (${count}회 출현)`);
    });

  console.log('\n📊 등급 간 비교 분석');
  console.log('─'.repeat(80));

  const overheatAvg = overheat.reduce((sum, r) => sum + r.returnRate, 0) / overheat.length;
  const gradeBAvg = gradeB.reduce((sum, r) => sum + r.returnRate, 0) / gradeB.length;
  const difference = overheatAvg - gradeBAvg;
  const ratio = (overheatAvg / gradeBAvg).toFixed(2);

  console.log(`  과열등급 평균: +${overheatAvg.toFixed(2)}%`);
  console.log(`  B등급 평균: +${gradeBAvg.toFixed(2)}%`);
  console.log(`  차이: ${difference > 0 ? '+' : ''}${difference.toFixed(2)}%p`);
  console.log(`  배율: ${ratio}배`);

  console.log('\n💡 핵심 발견');
  console.log('─'.repeat(80));
  console.log(`  1. 과열등급이 B등급보다 ${ratio}배 높은 수익률`);
  console.log(`  2. 과열등급의 수익률 범위: +${Math.min(...overheat.map(r => r.returnRate)).toFixed(2)}% ~ +${Math.max(...overheat.map(r => r.returnRate)).toFixed(2)}%`);
  console.log(`  3. B등급의 수익률 범위: +${Math.min(...gradeB.map(r => r.returnRate)).toFixed(2)}% ~ +${Math.max(...gradeB.map(r => r.returnRate)).toFixed(2)}%`);
  console.log(`  4. 과열등급의 안정성: ${(overheat.filter(r => r.isWin).length / overheat.length * 100).toFixed(1)}% 승률`);
  console.log(`  5. B등급의 안정성: ${(gradeB.filter(r => r.isWin).length / gradeB.length * 100).toFixed(1)}% 승률`);

  // 카테고리별 분석
  console.log('\n📋 카테고리별 분석 (90일)');
  console.log('─'.repeat(80));

  const categoryStats = {};
  result90.results.forEach(r => {
    r.category.forEach(cat => {
      if (!categoryStats[cat]) {
        categoryStats[cat] = {
          count: 0,
          wins: 0,
          returns: []
        };
      }
      categoryStats[cat].count++;
      if (r.isWin) categoryStats[cat].wins++;
      categoryStats[cat].returns.push(r.returnRate);
    });
  });

  Object.entries(categoryStats)
    .sort((a, b) => {
      const avgA = a[1].returns.reduce((sum, val) => sum + val, 0) / a[1].returns.length;
      const avgB = b[1].returns.reduce((sum, val) => sum + val, 0) / b[1].returns.length;
      return avgB - avgA;
    })
    .forEach(([cat, stats]) => {
      const winRate = (stats.wins / stats.count * 100).toFixed(1);
      const avgReturn = (stats.returns.reduce((sum, val) => sum + val, 0) / stats.returns.length).toFixed(2);
      const catName = cat === 'whale' ? '🐋 고래 감지' : cat === 'volume-surge' ? '🔥 거래량 폭발' : cat;
      console.log(`  ${catName}: 승률 ${winRate}% | 평균 +${avgReturn}% | ${stats.count}개 샘플`);
    });

  // 점수 구간별 분석
  console.log('\n📊 점수 구간별 분석 (90일)');
  console.log('─'.repeat(80));

  const scoreRanges = {
    '80+': [],
    '70-79': [],
    '60-69': [],
    '50-59': [],
    '40-49': [],
    '30-39': [],
    '20-29': []
  };

  result90.results.forEach(r => {
    const score = r.score;
    if (score >= 80) scoreRanges['80+'].push(r);
    else if (score >= 70) scoreRanges['70-79'].push(r);
    else if (score >= 60) scoreRanges['60-69'].push(r);
    else if (score >= 50) scoreRanges['50-59'].push(r);
    else if (score >= 40) scoreRanges['40-49'].push(r);
    else if (score >= 30) scoreRanges['30-39'].push(r);
    else scoreRanges['20-29'].push(r);
  });

  Object.entries(scoreRanges)
    .filter(([_, data]) => data.length > 0)
    .forEach(([range, data]) => {
      const winRate = (data.filter(r => r.isWin).length / data.length * 100).toFixed(1);
      const avgReturn = (data.reduce((sum, r) => sum + r.returnRate, 0) / data.length).toFixed(2);
      console.log(`  ${range}점: 승률 ${winRate}% | 평균 +${avgReturn}% | ${data.length}개 샘플`);
    });

  console.log('\n' + '='.repeat(80));
  console.log('✅ 등급별 비교 분석 완료!\n');

  // JSON 파일로 저장
  const comparison = {
    overheat: {
      count: overheat.length,
      winRate: (overheat.filter(r => r.isWin).length / overheat.length * 100).toFixed(2),
      avgReturn: overheatAvg.toFixed(2),
      stocks: overheatStocks
    },
    gradeB: {
      count: gradeB.length,
      winRate: (gradeB.filter(r => r.isWin).length / gradeB.length * 100).toFixed(2),
      avgReturn: gradeBAvg.toFixed(2),
      stocks: gradeBStocks
    },
    comparison: {
      difference: difference.toFixed(2),
      ratio: ratio
    },
    categories: categoryStats,
    scoreRanges: Object.fromEntries(
      Object.entries(scoreRanges)
        .filter(([_, data]) => data.length > 0)
        .map(([range, data]) => [
          range,
          {
            count: data.length,
            winRate: (data.filter(r => r.isWin).length / data.length * 100).toFixed(2),
            avgReturn: (data.reduce((sum, r) => sum + r.returnRate, 0) / data.length).toFixed(2)
          }
        ])
    )
  };

  fs.writeFileSync('./grade-comparison-results.json', JSON.stringify(comparison, null, 2));
  console.log('💾 상세 분석 결과가 grade-comparison-results.json에 저장되었습니다.\n');
}

// 실행
analyzeGradeComparison();
