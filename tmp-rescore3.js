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
  console.log('1. v3.17 스크리닝 결과 조회...');
  const screen = await fetch('https://investar-xi.vercel.app/api/screening/recommend?market=ALL');
  const v17stocks = screen.recommendations || screen.stocks || [];
  console.log('   v3.17 종목:', v17stocks.length + '개\n');

  console.log('2. Supabase 성과 데이터 조회...');
  const perf = await fetch('https://investar-xi.vercel.app/api/recommendations/performance?days=7');
  const perfStocks = perf.stocks || [];
  console.log('   성과 종목:', perfStocks.length + '개\n');

  // === PART A: v3.17 전체 점수 분포 (현재 스크리닝) ===
  console.log('=== PART A: v3.17 전체 스크리닝 점수 분포 ===\n');

  const sorted = [...v17stocks].sort((a, b) => b.totalScore - a.totalScore);
  sorted.forEach((s, i) => {
    const whale = (s.advancedAnalysis && s.advancedAnalysis.indicators &&
                   s.advancedAnalysis.indicators.whale &&
                   s.advancedAnalysis.indicators.whale.length > 0) ? ' [고래]' : '';
    const accum = (s.advancedAnalysis && s.advancedAnalysis.indicators &&
                   s.advancedAnalysis.indicators.silentAccumulation &&
                   s.advancedAnalysis.indicators.silentAccumulation.signal &&
                   s.advancedAnalysis.indicators.silentAccumulation.signal.includes('매집')) ? ' [매집]' : '';
    console.log(
      String(i+1).padStart(2) + '. ' +
      (s.stockName || '?').padEnd(14) +
      String(s.totalScore).padStart(6) + '점 ' +
      (s.grade || '?').padEnd(5) +
      whale + accum
    );
  });

  // 점수 분포
  const ranges = {'70+':0,'60-69':0,'50-59':0,'40-49':0,'30-39':0,'20-29':0,'<20':0};
  v17stocks.forEach(s => {
    const sc = s.totalScore;
    if (sc >= 70) ranges['70+']++;
    else if (sc >= 60) ranges['60-69']++;
    else if (sc >= 50) ranges['50-59']++;
    else if (sc >= 40) ranges['40-49']++;
    else if (sc >= 30) ranges['30-39']++;
    else if (sc >= 20) ranges['20-29']++;
    else ranges['<20']++;
  });

  const scores = v17stocks.map(s => s.totalScore);
  console.log('\n점수 분포:');
  Object.entries(ranges).forEach(([k,v]) => {
    console.log('  ' + k.padEnd(6) + ': ' + String(v).padStart(2) + '개 ' + '█'.repeat(v));
  });
  console.log('\n평균:', (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) + '점');
  console.log('최고:', Math.max(...scores).toFixed(1) + '점');
  console.log('최저:', Math.min(...scores).toFixed(1) + '점');

  // === PART B: 과거 추천 종목 중 현재 풀에 겹치는 종목 비교 ===
  console.log('\n=== PART B: 구점수 vs v3.17 신점수 비교 ===\n');

  // v3.17 점수 맵
  const v17map = {};
  v17stocks.forEach(s => { v17map[s.stockCode] = s; });

  // 중복 제거
  const seen = {};
  const uniqPerf = [];
  perfStocks.forEach(s => {
    if (!seen[s.stock_code]) {
      seen[s.stock_code] = true;
      uniqPerf.push(s);
    }
  });

  console.log(
    '종목명'.padEnd(14) +
    '구점수'.padStart(6) + ' ' +
    '구등급'.padEnd(5) +
    'v3.17'.padStart(6) + ' ' +
    '신등급'.padEnd(5) +
    '변동'.padStart(7) +
    '수익률'.padStart(9)
  );
  console.log('-'.repeat(70));

  let matchCount = 0;
  let totalOld = 0, totalNew = 0;

  uniqPerf.sort((a,b) => b.total_score - a.total_score);
  uniqPerf.forEach(s => {
    const v17 = v17map[s.stock_code];
    const newScore = v17 ? v17.totalScore : null;
    const newGrade = v17 ? (v17.grade || '?') : '풀외';
    const diff = newScore != null ? newScore - s.total_score : null;
    const diffStr = diff != null ? (diff >= 0 ? '+' + diff.toFixed(1) : diff.toFixed(1)) : '  N/A';
    const retStr = s.current_return != null ? s.current_return.toFixed(2) + '%' : '  N/A';

    if (newScore != null) { matchCount++; totalOld += s.total_score; totalNew += newScore; }

    console.log(
      (s.stock_name || '?').padEnd(14) +
      String(s.total_score).padStart(6) + ' ' +
      (s.recommendation_grade || '?').padEnd(5) +
      (newScore != null ? String(newScore).padStart(6) : '   N/A') + ' ' +
      newGrade.padEnd(5) +
      diffStr.padStart(7) +
      retStr.padStart(9)
    );
  });

  if (matchCount > 0) {
    console.log('\n매칭 종목 ' + matchCount + '개:');
    console.log('  평균 구점수: ' + (totalOld/matchCount).toFixed(1));
    console.log('  평균 v3.17: ' + (totalNew/matchCount).toFixed(1));
    console.log('  평균 변동: ' + ((totalNew - totalOld)/matchCount).toFixed(1));
  }

  const notMatched = uniqPerf.filter(s => !v17map[s.stock_code]);
  console.log('\n현재 풀에 없는 종목 ' + notMatched.length + '개 (오늘 순위 API에 안 잡힘):');
  notMatched.forEach(s => {
    const retStr = s.current_return != null ? s.current_return.toFixed(2) + '%' : 'N/A';
    console.log('  ' + s.stock_name + ' (' + s.total_score + '점 ' + s.recommendation_grade + ') -> ' + retStr);
  });
}

main().catch(e => console.error(e));
