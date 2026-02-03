const j = require('./tmp-screening.json');
const stocks = j.recommendations || j.stocks || [];

const hynix = stocks.find(s => s.stockCode === '000660' || (s.stockName && s.stockName.includes('하이닉스')));
if (hynix) {
  console.log('=== SK하이닉스 발견 ===');
  console.log('점수:', hynix.totalScore);
  console.log('등급:', hynix.grade);
  console.log('가격:', hynix.currentPrice);
  console.log('거래량비율:', hynix.volumeAnalysis?.current?.volumeRatio);
  console.log('고래:', hynix.advancedAnalysis?.indicators?.whale?.length > 0);
  console.log(JSON.stringify(hynix, null, 2).slice(0, 3000));
} else {
  console.log('SK하이닉스가 스크리닝 결과에 없음\n');
  console.log('이유: 종목 풀(~50개)에 포함되지 않았거나, 30점 미만이라 제외됨');
  console.log('\n현재 종목 풀 (' + stocks.length + '개):');
  stocks.forEach(s => {
    console.log(`  ${s.stockName} (${s.stockCode}) | ${s.totalScore}점 | ${s.grade}`);
  });
}
