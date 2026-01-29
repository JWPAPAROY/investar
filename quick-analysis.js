const fs = require('fs');
const data = JSON.parse(fs.readFileSync('performance-raw.json', 'utf8'));

console.log('📊 투자 성과 종합 분석\n');
console.log('━'.repeat(80));
console.log('총 종목 수:', data.count, '개\n');

// 등급별 분류
const byGrade = {};
data.stocks.forEach(s => {
  const g = s.grade || 'UNKNOWN';
  if (!byGrade[g]) byGrade[g] = [];
  byGrade[g].push(s);
});

console.log('📈 등급별 성과 분석\n');

// 등급 순서 정의
const gradeOrder = ['과열', 'S+', 'S', 'A', 'B', 'C', 'D', 'UNKNOWN'];

gradeOrder.forEach(grade => {
  if (!byGrade[grade] || byGrade[grade].length === 0) return;

  const stocks = byGrade[grade];
  const returns = stocks.map(s => s.current_return).filter(r => r !== 0);

  if (returns.length === 0) {
    console.log(`${grade}등급: ${stocks.length}개 (수익률 데이터 없음)`);
    return;
  }

  const wins = returns.filter(r => r > 0).length;
  const losses = returns.filter(r => r < 0).length;
  const winRate = (wins / returns.length * 100).toFixed(1);
  const avgReturn = (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);
  const maxReturn = Math.max(...returns).toFixed(2);
  const minReturn = Math.min(...returns).toFixed(2);

  console.log(`${grade}등급:`);
  console.log(`  종목수: ${stocks.length}개 (데이터 ${returns.length}개)`);
  console.log(`  승률: ${winRate}% (${wins}승 ${losses}패)`);
  console.log(`  평균 수익률: ${avgReturn}%`);
  console.log(`  최고/최저: ${maxReturn}% / ${minReturn}%`);
  console.log('');
});

console.log('━'.repeat(80));
console.log('\n💰 TOP 5 수익 종목\n');

const withReturns = data.stocks.filter(s => s.current_return > 0);
const top5 = withReturns.sort((a, b) => b.current_return - a.current_return).slice(0, 5);

top5.forEach((s, i) => {
  console.log(`${i + 1}. ${s.stock_name} (${s.stock_code})`);
  console.log(`   등급: ${s.grade} | 수익률: ${s.current_return.toFixed(2)}%`);
  console.log(`   추천일: ${s.recommendation_date} | 경과: ${s.days_since_recommendation}일`);
  console.log('');
});

console.log('━'.repeat(80));
console.log('\n📉 TOP 5 손실 종목\n');

const withLosses = data.stocks.filter(s => s.current_return < 0);
const bottom5 = withLosses.sort((a, b) => a.current_return - b.current_return).slice(0, 5);

bottom5.forEach((s, i) => {
  console.log(`${i + 1}. ${s.stock_name} (${s.stock_code})`);
  console.log(`   등급: ${s.grade} | 수익률: ${s.current_return.toFixed(2)}%`);
  console.log(`   추천일: ${s.recommendation_date} | 경과: ${s.days_since_recommendation}일`);
  console.log('');
});

console.log('━'.repeat(80));
