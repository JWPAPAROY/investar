const data = require('./tmp-perf-data.json');
const stocks = data.stocks || [];

console.log('14일 조회 결과 총 종목:', stocks.length);

// 추천일별 분포
const dates = {};
stocks.forEach(s => {
  const d = s.recommendation_date;
  if (!dates[d]) dates[d] = 0;
  dates[d]++;
});
console.log('\n추천일별 분포:');
Object.entries(dates).sort().forEach(([d, c]) => {
  console.log('  ' + d + ': ' + c + '개');
});

// daily_prices 마지막 날짜 확인
console.log('\n일별 가격 추적 마지막 날짜 (종목별):');
stocks.forEach(s => {
  const dp = s.daily_prices || [];
  const lastDate = dp.length > 0 ? dp[dp.length - 1].date : 'N/A';
  const count = dp.length;
  console.log('  ' + s.stock_name + ' (' + s.recommendation_date + '): 마지막 ' + lastDate + ' (' + count + '일 추적)');
});
