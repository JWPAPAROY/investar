const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

(async () => {
  // 1. calc-expectations 결과 확인
  console.log('=== calc-expectations 실행 결과 ===');
  const calc = await fetch('https://investar-xi.vercel.app/api/cron/save-daily-recommendations?mode=calc-expectations');
  console.log('추천 종목:', calc.totalRecs, '건');
  console.log('일별 가격:', calc.totalPrices, '건');
  console.log('산출 조합:', calc.stats, '개');
  console.log();

  // 2. recommend API에서 매칭 현황 확인
  console.log('=== recommend API 매칭 현황 ===');
  const rec = await fetch('https://investar-xi.vercel.app/api/screening/recommend?limit=3');
  console.log('총 종목:', rec.count);

  const grades = {};
  rec.recommendations.forEach(s => {
    const g = s.recommendation?.grade || '?';
    if (!grades[g]) grades[g] = { total: 0, hasER: 0 };
    grades[g].total++;
    if (s.expectedReturn) grades[g].hasER++;
  });

  console.log();
  console.log('등급별 기대수익 매칭:');
  Object.keys(grades).sort().forEach(g => {
    const v = grades[g];
    console.log('  ' + g + '등급: ' + v.total + '개 중 ' + v.hasER + '개 매칭');
  });

  console.log();
  console.log('=== TOP3 ===');
  (rec.top3 || []).forEach((s, i) => {
    const er = s.expectedReturn;
    const name = s.stockName || '?';
    const grade = s.recommendation?.grade || '?';
    if (er) {
      console.log((i+1) + '. ' + name + ' (' + grade + ') => ' + er.days + '일, median +' + er.median + '%, winRate ' + er.winRate + '%, N=' + er.sampleCount);
    } else {
      console.log((i+1) + '. ' + name + ' (' + grade + ') => 기대수익 없음');
    }
  });
})();
