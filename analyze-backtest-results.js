/**
 * backtest-results.json 분석 스크립트
 * 등급별 성과 분석
 */
const fs = require('fs');

try {
  const rawData = JSON.parse(fs.readFileSync('backtest-results.json', 'utf8'));
  const data = rawData.stocks || rawData;

  console.log('\n📊 백테스트 결과 종합 분석\n');
  console.log('='.repeat(80));
  console.log(`총 종목: ${data.length}개\n`);

  // 등급별 분류
  const byGrade = {};
  data.forEach(stock => {
    const grade = stock.grade || 'UNKNOWN';
    if (!byGrade[grade]) {
      byGrade[grade] = [];
    }
    byGrade[grade].push(stock);
  });

  console.log('📈 등급별 성과 분석\n');

  // 등급 순서
  const gradeOrder = ['과열', 'S+', 'S', 'A', 'B', 'C', 'D', 'UNKNOWN'];

  gradeOrder.forEach(grade => {
    if (!byGrade[grade] || byGrade[grade].length === 0) return;

    const stocks = byGrade[grade];
    const returns = stocks.map(s => s.returnRate);
    const wins = returns.filter(r => r > 0).length;
    const losses = returns.filter(r => r < 0).length;
    const draws = returns.filter(r => r === 0).length;
    const winRate = stocks.length > 0 ? (wins / stocks.length * 100).toFixed(1) : '0.0';
    const avgReturn = returns.length > 0 ? (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2) : '0.00';
    const maxReturn = returns.length > 0 ? Math.max(...returns).toFixed(2) : '0.00';
    const minReturn = returns.length > 0 ? Math.min(...returns).toFixed(2) : '0.00';

    // 수익/손실 합계
    const totalProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    const profitFactor = totalLoss > 0 ? (totalProfit / totalLoss).toFixed(2) : 'N/A';

    console.log(`${grade}등급:`);
    console.log(`  종목수: ${stocks.length}개`);
    console.log(`  승률: ${winRate}% (${wins}승 ${losses}패 ${draws}무)`);
    console.log(`  평균 수익률: ${avgReturn}%`);
    console.log(`  최고/최저: ${maxReturn}% / ${minReturn}%`);
    console.log(`  Profit Factor: ${profitFactor}`);
    console.log('');
  });

  console.log('='.repeat(80));
  console.log('\n💰 점수 구간별 성과 분석\n');

  // 점수 구간별 분류
  const scoreRanges = [
    { min: 0, max: 25, label: '<25점 (D등급)' },
    { min: 25, max: 30, label: '25-29점' },
    { min: 30, max: 45, label: '30-44점 (C등급)' },
    { min: 45, max: 50, label: '45-49점' },
    { min: 50, max: 60, label: '50-59점 (안정 구간)' },
    { min: 60, max: 70, label: '60-69점 (혼재)' },
    { min: 70, max: 80, label: '70-79점 (대박 구간)' },
    { min: 80, max: 90, label: '80-89점' },
    { min: 90, max: 100, label: '90+점 (S+등급)' }
  ];

  scoreRanges.forEach(range => {
    const stocks = data.filter(s => s.totalScore >= range.min && s.totalScore < range.max);
    if (stocks.length === 0) return;

    const returns = stocks.map(s => s.returnRate);
    const wins = returns.filter(r => r > 0).length;
    const winRate = (wins / stocks.length * 100).toFixed(1);
    const avgReturn = (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);

    console.log(`${range.label}:`);
    console.log(`  종목수: ${stocks.length}개 | 승률: ${winRate}% | 평균: ${avgReturn}%`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('\n🏆 TOP 10 수익 종목\n');

  const top10 = [...data].sort((a, b) => b.returnRate - a.returnRate).slice(0, 10);
  top10.forEach((s, i) => {
    console.log(`${i + 1}. ${s.stockName} (${s.stockCode})`);
    console.log(`   등급: ${s.grade} | 점수: ${s.totalScore}점 | 수익률: ${s.returnRate.toFixed(2)}%`);
    console.log(`   보유: ${s.holdingDays}일 (${s.buyDate} → ${s.sellDate})`);
    console.log('');
  });

  console.log('='.repeat(80));
  console.log('\n📉 WORST 10 손실 종목\n');

  const worst10 = [...data].sort((a, b) => a.returnRate - b.returnRate).slice(0, 10);
  worst10.forEach((s, i) => {
    console.log(`${i + 1}. ${s.stockName} (${s.stockCode})`);
    console.log(`   등급: ${s.grade} | 점수: ${s.totalScore}점 | 수익률: ${s.returnRate.toFixed(2)}%`);
    console.log(`   보유: ${s.holdingDays}일 (${s.buyDate} → ${s.sellDate})`);
    console.log('');
  });

  console.log('='.repeat(80));

  // 카테고리별 분석
  console.log('\n📊 카테고리별 성과\n');

  const byCategory = {};
  data.forEach(stock => {
    const cat = stock.category || 'UNKNOWN';
    if (!byCategory[cat]) {
      byCategory[cat] = [];
    }
    byCategory[cat].push(stock);
  });

  Object.keys(byCategory).sort().forEach(category => {
    const stocks = byCategory[category];
    const returns = stocks.map(s => s.returnRate);
    const wins = returns.filter(r => r > 0).length;
    const winRate = (wins / stocks.length * 100).toFixed(1);
    const avgReturn = (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);

    console.log(`${category}:`);
    console.log(`  종목수: ${stocks.length}개 | 승률: ${winRate}% | 평균: ${avgReturn}%`);
  });

  console.log('\n' + '='.repeat(80));

} catch (error) {
  console.error('❌ 분석 실패:', error.message);
}
