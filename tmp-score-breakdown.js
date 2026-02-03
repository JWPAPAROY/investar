const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 90000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 300))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const screen = await fetch('https://investar-xi.vercel.app/api/screening/recommend?market=ALL');
  const stocks = screen.recommendations || screen.stocks || [];

  console.log('=== v3.17 점수 상세 분해 (전체 ' + stocks.length + '개) ===\n');

  // 점수 분해
  const sorted = [...stocks].sort((a, b) => b.totalScore - a.totalScore);

  console.log(
    '종목명'.padEnd(14) +
    'Total'.padStart(6) +
    ' Base'.padStart(5) +
    '  Mom'.padStart(5) +
    ' Trend'.padStart(6) +
    ' Multi'.padStart(6) +
    ' Penalty'.padStart(8) +
    '  등급'.padStart(5)
  );
  console.log('-'.repeat(70));

  let totalBase = 0, totalMom = 0, totalTrend = 0, totalMulti = 0;

  sorted.forEach(s => {
    const rb = s.radarScore || s.scoreBreakdown || {};
    const base = rb.base || rb.baseScore || 0;
    const mom = rb.momentum || rb.momentumScore || 0;
    const trend = rb.trend || rb.trendScore || 0;
    const multi = rb.multiSignalBonus || 0;
    const penalty = rb.dailyRisePenalty || 0;
    const grade = s.grade || s.recommendation?.grade || '?';

    totalBase += base;
    totalMom += mom;
    totalTrend += trend;
    totalMulti += multi;

    console.log(
      (s.stockName || '?').padEnd(14) +
      String(s.totalScore).padStart(6) +
      String(base).padStart(5) +
      String(mom).padStart(5) +
      String(trend).padStart(6) +
      String(multi).padStart(6) +
      (penalty ? String(penalty).padStart(8) : '       0') +
      ('  ' + grade)
    );
  });

  const n = sorted.length;
  console.log('-'.repeat(70));
  console.log(
    '평균'.padEnd(14) +
    (sorted.reduce((a,s) => a+s.totalScore, 0)/n).toFixed(1).padStart(6) +
    (totalBase/n).toFixed(1).padStart(5) +
    (totalMom/n).toFixed(1).padStart(5) +
    (totalTrend/n).toFixed(1).padStart(6) +
    (totalMulti/n).toFixed(1).padStart(6)
  );

  // 각 컴포넌트 분포
  console.log('\n=== 컴포넌트별 분포 ===');

  const baseScores = sorted.map(s => (s.radarScore || s.scoreBreakdown || {}).base || (s.radarScore || s.scoreBreakdown || {}).baseScore || 0);
  const momScores = sorted.map(s => (s.radarScore || s.scoreBreakdown || {}).momentum || (s.radarScore || s.scoreBreakdown || {}).momentumScore || 0);
  const trendScores = sorted.map(s => (s.radarScore || s.scoreBreakdown || {}).trend || (s.radarScore || s.scoreBreakdown || {}).trendScore || 0);

  console.log('Base  (0-15): 평균 ' + (baseScores.reduce((a,b)=>a+b,0)/n).toFixed(1) + ', 최대 ' + Math.max(...baseScores) + ', 최소 ' + Math.min(...baseScores));
  console.log('Mom   (0-45): 평균 ' + (momScores.reduce((a,b)=>a+b,0)/n).toFixed(1) + ', 최대 ' + Math.max(...momScores) + ', 최소 ' + Math.min(...momScores));
  console.log('Trend (0-40): 평균 ' + (trendScores.reduce((a,b)=>a+b,0)/n).toFixed(1) + ', 최대 ' + Math.max(...trendScores) + ', 최소 ' + Math.min(...trendScores));

  // 현재 등급 분포 vs 제안 등급 분포
  const scores = sorted.map(s => s.totalScore);
  console.log('\n=== 현재 등급 임계값 적용 ===');
  console.log('S+(90+):  ' + scores.filter(s => s >= 90).length + '개');
  console.log('S(75-89): ' + scores.filter(s => s >= 75 && s < 90).length + '개');
  console.log('A(60-74): ' + scores.filter(s => s >= 60 && s < 75).length + '개');
  console.log('B(45-59): ' + scores.filter(s => s >= 45 && s < 60).length + '개');
  console.log('C(30-44): ' + scores.filter(s => s >= 30 && s < 45).length + '개');
  console.log('D(<30):   ' + scores.filter(s => s < 30).length + '개');

  // 비율 기반 제안
  console.log('\n=== 비율 기반 등급 제안 (상위 %) ===');
  const sortedScores = [...scores].sort((a,b) => b - a);
  const p10 = sortedScores[Math.floor(n * 0.1)] || sortedScores[0];
  const p25 = sortedScores[Math.floor(n * 0.25)] || sortedScores[0];
  const p50 = sortedScores[Math.floor(n * 0.50)] || sortedScores[0];
  const p75 = sortedScores[Math.floor(n * 0.75)] || sortedScores[0];
  console.log('상위 10% 컷라인: ' + p10.toFixed(1) + '점');
  console.log('상위 25% 컷라인: ' + p25.toFixed(1) + '점');
  console.log('상위 50% 컷라인: ' + p50.toFixed(1) + '점');
  console.log('상위 75% 컷라인: ' + p75.toFixed(1) + '점');

  // scoreBreakdown 상세 확인 (첫 3개)
  console.log('\n=== 상위 3개 종목 scoreBreakdown 원본 ===');
  sorted.slice(0, 3).forEach(s => {
    console.log('\n' + s.stockName + ' (' + s.totalScore + '점):');
    if (s.radarScore) console.log('  radarScore:', JSON.stringify(s.radarScore));
    if (s.scoreBreakdown) console.log('  scoreBreakdown:', JSON.stringify(s.scoreBreakdown));
    if (s.momentumScore) console.log('  momentumScore:', typeof s.momentumScore === 'object' ? JSON.stringify(s.momentumScore) : s.momentumScore);
    if (s.trendScore) console.log('  trendScore:', typeof s.trendScore === 'object' ? JSON.stringify(s.trendScore) : s.trendScore);
    // 가능한 모든 점수 관련 필드
    const keys = Object.keys(s).filter(k => k.toLowerCase().includes('score') || k.toLowerCase().includes('radar') || k.toLowerCase().includes('grade') || k.toLowerCase().includes('break'));
    console.log('  점수 관련 키:', keys.join(', '));
  });
}

main().catch(e => console.error(e));
