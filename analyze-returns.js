const fs = require('fs');
const data = JSON.parse(fs.readFileSync('performance-raw.json', 'utf8'));

console.log('\n📊 수익률 업데이트 상태 분석\n');
console.log('총 종목 수:', data.count, '개\n');

// 수익률 0인 종목 찾기
const zeroReturn = data.stocks.filter(s => s.current_return === 0);
const hasReturn = data.stocks.filter(s => s.current_return !== 0);

console.log('✅ 수익률 있음:', hasReturn.length, '개');
console.log('❌ 수익률 0%:', zeroReturn.length, '개\n');

// 날짜별 분석
const byDate = {};
data.stocks.forEach(s => {
  const date = s.recommendation_date;
  if (!byDate[date]) {
    byDate[date] = { total: 0, zero: 0, hasData: 0 };
  }
  byDate[date].total++;
  if (s.current_return === 0) byDate[date].zero++;
  else byDate[date].hasData++;
});

console.log('📅 날짜별 업데이트 현황:\n');
Object.keys(byDate).sort().forEach(date => {
  const stats = byDate[date];
  const zeroRate = (stats.zero / stats.total * 100).toFixed(1);
  console.log(date + ':', stats.total + '개 종목');
  console.log('  - 수익률 있음:', stats.hasData + '개');
  console.log('  - 수익률 0%:', stats.zero + '개 (' + zeroRate + '%)');
  console.log('');
});

// 수익률 0인 종목 샘플 출력
if (zeroReturn.length > 0) {
  console.log('❌ 수익률 0% 종목 샘플 (최대 10개):\n');
  zeroReturn.slice(0, 10).forEach(s => {
    console.log('-', s.stock_name, '(' + s.stock_code + ')');
    console.log('  추천일:', s.recommendation_date, '| 추천가:', s.recommended_price + '원');
    console.log('  현재가:', s.current_price + '원 | 수익률:', s.current_return + '%');
    console.log('  경과일:', s.days_since_recommendation + '일');
    console.log('  daily_prices 개수:', s.daily_prices ? s.daily_prices.length + '개' : '없음');
    console.log('');
  });
}

// 수익률 있는 종목 샘플
if (hasReturn.length > 0) {
  console.log('✅ 수익률 있는 종목 샘플 (최대 5개):\n');
  hasReturn.slice(0, 5).forEach(s => {
    console.log('-', s.stock_name, '(' + s.stock_code + ')');
    console.log('  추천일:', s.recommendation_date, '| 추천가:', s.recommended_price + '원');
    console.log('  현재가:', s.current_price + '원 | 수익률:', s.current_return.toFixed(2) + '%');
    console.log('  경과일:', s.days_since_recommendation + '일');
    console.log('  daily_prices 개수:', s.daily_prices ? s.daily_prices.length + '개' : '없음');
    console.log('');
  });
}
