/**
 * 점수 체계 역설 분석
 * "과열 = 감점"인데 왜 과열등급이 가장 높은 수익률?
 */

const fs = require('fs');

function analyzeScoringParadox() {
  console.log('🔍 점수 체계 역설 분석 시작...\n');
  console.log('전략 철학: "선행 지표 우선 → 과열은 이미 늦음 → 감점"');
  console.log('실제 결과: "과열등급이 3배 높은 수익률"\n');
  console.log('='.repeat(80));

  // 90일 결과 로드
  const result90 = JSON.parse(fs.readFileSync('./backtest-90days-results.json', 'utf8'));

  console.log('\n📊 1. 등급별 점수 분포 분석');
  console.log('─'.repeat(80));

  const overheat = result90.results.filter(r => r.grade === '과열');
  const gradeB = result90.results.filter(r => r.grade === 'B');

  // 과열등급 점수 분포
  const overheatScores = overheat.map(r => r.score);
  const overheatAvgScore = overheatScores.reduce((sum, s) => sum + s, 0) / overheatScores.length;
  const overheatMaxScore = Math.max(...overheatScores);
  const overheatMinScore = Math.min(...overheatScores);

  console.log('\n🔥 과열등급:');
  console.log(`  평균 점수: ${overheatAvgScore.toFixed(2)}점`);
  console.log(`  점수 범위: ${overheatMinScore.toFixed(2)}점 ~ ${overheatMaxScore.toFixed(2)}점`);
  console.log(`  평균 수익률: +${(overheat.reduce((sum, r) => sum + r.returnRate, 0) / overheat.length).toFixed(2)}%`);

  // B등급 점수 분포
  const gradeBScores = gradeB.map(r => r.score);
  const gradeBAvgScore = gradeBScores.reduce((sum, s) => sum + s, 0) / gradeBScores.length;
  const gradeBMaxScore = Math.max(...gradeBScores);
  const gradeBMinScore = Math.min(...gradeBScores);

  console.log('\n🟦 B등급:');
  console.log(`  평균 점수: ${gradeBAvgScore.toFixed(2)}점`);
  console.log(`  점수 범위: ${gradeBMinScore.toFixed(2)}점 ~ ${gradeBMaxScore.toFixed(2)}점`);
  console.log(`  평균 수익률: +${(gradeB.reduce((sum, r) => sum + r.returnRate, 0) / gradeB.length).toFixed(2)}%`);

  console.log('\n💡 발견:');
  console.log(`  과열등급이 B등급보다 점수는 ${(overheatAvgScore - gradeBAvgScore).toFixed(2)}점 높음`);
  console.log(`  하지만 수익률은 ${((overheat.reduce((sum, r) => sum + r.returnRate, 0) / overheat.length) - (gradeB.reduce((sum, r) => sum + r.returnRate, 0) / gradeB.length)).toFixed(2)}%p 더 높음`);

  console.log('\n📊 2. 점수-수익률 상관관계 분석');
  console.log('─'.repeat(80));

  // 점수 구간별 상세 분석
  const scoreData = result90.results.map(r => ({
    score: r.score,
    returnRate: r.returnRate,
    grade: r.grade,
    stockName: r.stockName,
    category: r.category
  }));

  // 점수순 정렬
  scoreData.sort((a, b) => b.score - a.score);

  console.log('\n📈 점수 TOP 10 vs 수익률:');
  console.log('  순위 | 종목명 | 점수 | 수익률 | 등급');
  scoreData.slice(0, 10).forEach((d, i) => {
    console.log(`  ${i + 1}위 | ${d.stockName.padEnd(20)} | ${d.score.toFixed(1)}점 | +${d.returnRate.toFixed(2)}% | ${d.grade}`);
  });

  // 수익률순 정렬
  scoreData.sort((a, b) => b.returnRate - a.returnRate);

  console.log('\n💰 수익률 TOP 10 vs 점수:');
  console.log('  순위 | 종목명 | 수익률 | 점수 | 등급');
  scoreData.slice(0, 10).forEach((d, i) => {
    console.log(`  ${i + 1}위 | ${d.stockName.padEnd(20)} | +${d.returnRate.toFixed(2)}% | ${d.score.toFixed(1)}점 | ${d.grade}`);
  });

  console.log('\n📊 3. 과열 판정 기준 분석');
  console.log('─'.repeat(80));
  console.log('\n⚠️ 주의: 백테스트는 과거 데이터를 현재 시점에서 분석하는 것이므로');
  console.log('         실제 "과열 판정 시점"의 데이터는 알 수 없습니다.');
  console.log('         하지만 "7일 후 수익률"을 통해 추세를 유추할 수 있습니다.\n');

  // 과열등급 종목별 상세
  console.log('🔥 과열등급 종목 상세 분석:');
  const overheatByStock = {};
  overheat.forEach(r => {
    if (!overheatByStock[r.stockName]) {
      overheatByStock[r.stockName] = {
        count: 0,
        scores: [],
        returns: [],
        buyPrices: [],
        sellPrices: []
      };
    }
    overheatByStock[r.stockName].count++;
    overheatByStock[r.stockName].scores.push(r.score);
    overheatByStock[r.stockName].returns.push(r.returnRate);
    overheatByStock[r.stockName].buyPrices.push(r.buyPrice);
    overheatByStock[r.stockName].sellPrices.push(r.sellPrice);
  });

  Object.entries(overheatByStock).forEach(([name, data]) => {
    const avgScore = data.scores.reduce((sum, s) => sum + s, 0) / data.count;
    const avgReturn = data.returns.reduce((sum, r) => sum + r, 0) / data.count;
    const avgBuyPrice = data.buyPrices.reduce((sum, p) => sum + p, 0) / data.count;
    const avgSellPrice = data.sellPrices.reduce((sum, p) => sum + p, 0) / data.count;

    console.log(`\n  📍 ${name}:`);
    console.log(`     출현 횟수: ${data.count}회`);
    console.log(`     평균 점수: ${avgScore.toFixed(2)}점`);
    console.log(`     평균 수익률: +${avgReturn.toFixed(2)}%`);
    console.log(`     평균 매수가: ${avgBuyPrice.toLocaleString()}원`);
    console.log(`     평균 매도가: ${avgSellPrice.toLocaleString()}원`);
    console.log(`     → "과열" 판정 후에도 7일간 평균 ${avgReturn.toFixed(2)}% 추가 상승!`);
  });

  console.log('\n📊 4. B등급 vs 과열등급: 왜 역전?');
  console.log('─'.repeat(80));

  console.log('\n💡 가설 1: "모멘텀 지속"');
  console.log('   과열 = 이미 상승 중 → 추세 지속 → 7일 후에도 상승');
  console.log('   B등급 = 아직 상승 전 → 7일 내에 상승 시작 안 함');

  console.log('\n💡 가설 2: "선행 지표 부정확"');
  console.log('   현재 선행 지표가 "곧 오를 종목"을 정확히 찾지 못함');
  console.log('   실제로는 "이미 오르는 종목"이 더 확실한 수익');

  console.log('\n💡 가설 3: "보유 기간 문제"');
  console.log('   7일 보유는 모멘텀 전략에 유리');
  console.log('   선행 전략은 더 긴 보유 기간(14일, 30일)이 필요할 수도');

  console.log('\n📊 5. 점수 구간별 상세 분석');
  console.log('─'.repeat(80));

  const scoreRanges = {
    '60-69': [],
    '50-59': [],
    '40-49': []
  };

  result90.results.forEach(r => {
    const score = r.score;
    if (score >= 60 && score < 70) scoreRanges['60-69'].push(r);
    else if (score >= 50 && score < 60) scoreRanges['50-59'].push(r);
    else if (score >= 40 && score < 50) scoreRanges['40-49'].push(r);
  });

  Object.entries(scoreRanges).forEach(([range, data]) => {
    if (data.length === 0) return;

    const avgReturn = data.reduce((sum, r) => sum + r.returnRate, 0) / data.length;
    const stockCounts = {};
    data.forEach(r => {
      stockCounts[r.stockName] = (stockCounts[r.stockName] || 0) + 1;
    });

    console.log(`\n  ${range}점 구간: 평균 +${avgReturn.toFixed(2)}% (${data.length}개 샘플)`);
    console.log('  주요 종목:');
    Object.entries(stockCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([name, count]) => {
        const stockData = data.filter(r => r.stockName === name);
        const stockAvgReturn = stockData.reduce((sum, r) => sum + r.returnRate, 0) / stockData.length;
        console.log(`    - ${name}: ${count}회, 평균 +${stockAvgReturn.toFixed(2)}%`);
      });
  });

  console.log('\n📊 6. 핵심 질문에 대한 답');
  console.log('─'.repeat(80));

  console.log('\n❓ Q1: 왜 40점대(대한광통신)가 60점대(한국항공우주)보다 수익률이 높나?');

  const range40 = scoreRanges['40-49'];
  const range60 = scoreRanges['60-69'];

  if (range40.length > 0 && range60.length > 0) {
    const avg40 = range40.reduce((sum, r) => sum + r.returnRate, 0) / range40.length;
    const avg60 = range60.reduce((sum, r) => sum + r.returnRate, 0) / range60.length;

    console.log(`\n   📊 데이터:`);
    console.log(`      40-49점: 평균 +${avg40.toFixed(2)}% (${range40.length}개)`);
    console.log(`      60-69점: 평균 +${avg60.toFixed(2)}% (${range60.length}개)`);
    console.log(`\n   💡 답변:`);
    console.log(`      점수는 "종목 선정 기준"이지 "수익률 예측치"가 아님`);
    console.log(`      대한광통신은 40점대지만 "고래 감지" 카테고리 → 강력한 모멘텀`);
    console.log(`      한국항공우주는 60점대지만 "거래량 폭발" → 상대적으로 약한 모멘텀`);
  }

  console.log('\n❓ Q2: "과열 = 감점" 전략이 잘못된 건가?');
  console.log('\n   💡 답변:');
  console.log('      현재 백테스트 결과로는 "과열 = 기회"로 보임');
  console.log('      하지만 주의할 점:');
  console.log('      1. 샘플 수가 적음 (과열 13개, B 46개)');
  console.log('      2. 특정 종목(대한광통신, 한국항공우주)에 편중');
  console.log('      3. 백테스트는 과거 데이터 → 실시간과 다를 수 있음');
  console.log('      4. 7일 보유 기간이 모멘텀 전략에 유리할 수 있음');

  console.log('\n❓ Q3: 전략을 바꿔야 하나?');
  console.log('\n   💡 제안:');
  console.log('      Option A: "과열 = 기회" 전략으로 전환');
  console.log('        - 과열등급에 가점 부여');
  console.log('        - 모멘텀 전략 강화');
  console.log('        - 단기 보유(3-7일) 유지');
  console.log('\n      Option B: "하이브리드" 전략');
  console.log('        - 과열등급: 단기(3-7일) 모멘텀 전략');
  console.log('        - B등급: 장기(14-30일) 선행 전략');
  console.log('        - 보유 기간을 등급별로 차별화');
  console.log('\n      Option C: "선행 지표 개선" (원래 철학 유지)');
  console.log('        - 더 정확한 선행 지표 개발');
  console.log('        - B등급의 보유 기간 연장 테스트');
  console.log('        - "곧 오를 종목" 감지 로직 개선');

  console.log('\n' + '='.repeat(80));
  console.log('✅ 점수 체계 역설 분석 완료!\n');

  // 결과 저장
  const analysis = {
    paradox: {
      philosophy: "선행 지표 우선 → 과열은 감점",
      reality: "과열등급이 3배 높은 수익률",
      question: "전략 철학과 실제 결과의 불일치"
    },
    overheat: {
      avgScore: overheatAvgScore.toFixed(2),
      avgReturn: (overheat.reduce((sum, r) => sum + r.returnRate, 0) / overheat.length).toFixed(2),
      count: overheat.length,
      stocks: overheatByStock
    },
    gradeB: {
      avgScore: gradeBAvgScore.toFixed(2),
      avgReturn: (gradeB.reduce((sum, r) => sum + r.returnRate, 0) / gradeB.length).toFixed(2),
      count: gradeB.length
    },
    hypotheses: [
      {
        name: "모멘텀 지속",
        description: "과열 = 이미 상승 중 → 추세 지속 → 7일 후에도 상승"
      },
      {
        name: "선행 지표 부정확",
        description: "현재 선행 지표가 곧 오를 종목을 정확히 찾지 못함"
      },
      {
        name: "보유 기간 문제",
        description: "7일은 모멘텀 전략에 유리, 선행 전략은 더 긴 기간 필요"
      }
    ],
    recommendations: [
      "Option A: 과열 = 기회 전략으로 전환",
      "Option B: 하이브리드 전략 (등급별 보유 기간 차별화)",
      "Option C: 선행 지표 개선 (원래 철학 유지)"
    ]
  };

  fs.writeFileSync('./scoring-paradox-analysis.json', JSON.stringify(analysis, null, 2));
  console.log('💾 상세 분석 결과가 scoring-paradox-analysis.json에 저장되었습니다.\n');
}

// 실행
analyzeScoringParadox();
