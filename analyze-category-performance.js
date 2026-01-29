/**
 * 카테고리별 성과 분석 스크립트
 * backtest-results.json의 whale_detected, accumulation_detected 필드를 기준으로 성과 분석
 */

const fs = require('fs');

// backtest-results.json 읽기
const rawData = JSON.parse(fs.readFileSync('backtest-results.json', 'utf8'));
const backtestData = rawData.stocks || rawData; // API 응답 형식 대응

console.log('\n📊 카테고리별 성과 분석\n');
console.log('━'.repeat(80));
console.log(`총 ${backtestData.length}개 종목 분석\n`);

// 카테고리별 데이터 그룹핑
const byCategory = {};

backtestData.forEach(stock => {
  // 카테고리 결정
  let cat = '종합집계 (일반)'; // 기본값
  if (stock.whale_detected && stock.accumulation_detected) {
    cat = '고래+조용한매집 (복합)';
  } else if (stock.whale_detected) {
    cat = '고래 감지';
  } else if (stock.accumulation_detected) {
    cat = '조용한 매집';
  }

  if (!byCategory[cat]) {
    byCategory[cat] = {
      stocks: [],
      totalReturn: 0,
      wins: 0,
      losses: 0,
      neutral: 0
    };
  }

  byCategory[cat].stocks.push(stock);
  byCategory[cat].totalReturn += stock.current_return;

  if (stock.current_return > 0) {
    byCategory[cat].wins++;
  } else if (stock.current_return < 0) {
    byCategory[cat].losses++;
  } else {
    byCategory[cat].neutral++;
  }
});

// 결과 출력
console.log('📈 카테고리별 성과 요약\n');

Object.keys(byCategory).sort().forEach(category => {
  const data = byCategory[category];
  const count = data.stocks.length;
  const avgReturn = (data.totalReturn / count).toFixed(2);
  const winRate = (data.wins / count * 100).toFixed(2);

  console.log(`\n${category}:`);
  console.log(`  종목 수: ${count}개`);
  console.log(`  승률: ${winRate}% (${data.wins}승 / ${data.losses}패 / ${data.neutral}무)`);
  console.log(`  평균 수익률: ${avgReturn}%`);

  // 상위 3개 종목
  const topStocks = data.stocks
    .sort((a, b) => b.current_return - a.current_return)
    .slice(0, 3);

  console.log(`  상위 3개:`);
  topStocks.forEach((stock, idx) => {
    console.log(`    ${idx + 1}. ${stock.stock_name} (${stock.stock_code}): ${stock.current_return.toFixed(2)}% [${stock.recommendation_grade}등급]`);
  });

  // 하위 3개 종목
  const bottomStocks = data.stocks
    .sort((a, b) => a.current_return - b.current_return)
    .slice(0, 3);

  console.log(`  하위 3개:`);
  bottomStocks.forEach((stock, idx) => {
    console.log(`    ${idx + 1}. ${stock.stock_name} (${stock.stock_code}): ${stock.current_return.toFixed(2)}% [${stock.recommendation_grade}등급]`);
  });
});

// 비교 요약 테이블
console.log('\n' + '━'.repeat(80));
console.log('\n📊 카테고리 비교 요약 (평균 수익률 내림차순)\n');

const summary = Object.keys(byCategory).map(cat => ({
  category: cat,
  count: byCategory[cat].stocks.length,
  winRate: (byCategory[cat].wins / byCategory[cat].stocks.length * 100).toFixed(2),
  avgReturn: (byCategory[cat].totalReturn / byCategory[cat].stocks.length).toFixed(2)
})).sort((a, b) => parseFloat(b.avgReturn) - parseFloat(a.avgReturn));

console.log('카테고리'.padEnd(30) + ' | ' + '종목수'.padStart(7) + ' | ' + '승률'.padStart(8) + ' | ' + '평균수익'.padStart(10));
console.log('─'.repeat(80));
summary.forEach(s => {
  console.log(
    s.category.padEnd(30) + ' | ' +
    String(s.count).padStart(5) + '개 | ' +
    String(s.winRate).padStart(6) + '% | ' +
    String(s.avgReturn).padStart(8) + '%'
  );
});

// 인사이트 도출
console.log('\n' + '━'.repeat(80));
console.log('\n💡 핵심 인사이트\n');

const whaleData = byCategory['고래 감지'];
const accumulationData = byCategory['조용한 매집'];
const generalData = byCategory['종합집계 (일반)'];

if (whaleData && accumulationData) {
  const whaleReturn = (whaleData.totalReturn / whaleData.stocks.length).toFixed(2);
  const accumulationReturn = (accumulationData.totalReturn / accumulationData.stocks.length).toFixed(2);

  console.log(`🐋 고래 감지 평균: ${whaleReturn}%`);
  console.log(`🤫 조용한 매집 평균: ${accumulationReturn}%`);

  if (generalData) {
    const generalReturn = (generalData.totalReturn / generalData.stocks.length).toFixed(2);
    console.log(`📊 종합집계 평균: ${generalReturn}%`);
  }

  console.log();

  if (parseFloat(whaleReturn) > parseFloat(accumulationReturn)) {
    console.log('✅ "고래 감지" 카테고리가 "조용한 매집"보다 평균 수익률이 높습니다.');
    console.log('   → 고래 감지 카테고리 유지 권장');
  } else {
    console.log('✅ "조용한 매집" 카테고리가 "고래 감지"보다 평균 수익률이 높습니다.');
    console.log('   → 조용한 매집 카테고리 유지 권장');
  }

  // 종합집계와의 비교
  if (generalData) {
    const generalReturn = parseFloat((generalData.totalReturn / generalData.stocks.length).toFixed(2));
    const whaleReturnNum = parseFloat(whaleReturn);
    const accumulationReturnNum = parseFloat(accumulationReturn);

    console.log();
    if (whaleReturnNum > generalReturn || accumulationReturnNum > generalReturn) {
      console.log('✅ 특수 카테고리(고래/조용한매집)가 일반 종목보다 성과가 좋습니다.');
      console.log('   → 카테고리 분리 표시가 유용함');
    } else {
      console.log('⚠️  특수 카테고리가 일반 종목 대비 유의미한 차이가 없습니다.');
      console.log('   → 카테고리 통합 검토 필요');
    }
  }
}

console.log('\n' + '━'.repeat(80) + '\n');
