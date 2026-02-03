const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // 1. Supabase 성과 데이터 (구 로직 점수 + 실제 수익률)
  const perf = await fetch('https://investar-xi.vercel.app/api/recommendations/performance?days=7');
  const perfStocks = perf.stocks || [];

  // 2. 현재 v3.17 스크리닝 결과
  const screen = await fetch('https://investar-xi.vercel.app/api/screening/recommend?market=ALL');
  const screenStocks = screen.recommendations || screen.stocks || [];

  // v3.17 점수 맵 (stockCode -> score, grade)
  const newScoreMap = {};
  screenStocks.forEach(s => {
    newScoreMap[s.stockCode] = { score: s.totalScore, grade: s.grade };
  });

  // 중복 제거 (같은 종목 여러 날짜 추천 → 최근 것만)
  const seen = {};
  const unique = [];
  perfStocks.forEach(s => {
    const key = s.stock_code;
    if (!seen[key]) {
      seen[key] = true;
      unique.push(s);
    }
  });

  console.log('=== v3.17 재평가 비교 ===');
  console.log('Supabase 종목:', unique.length + '개 (중복 제거)');
  console.log('v3.17 스크리닝:', screenStocks.length + '개');
  console.log();

  // 비교 테이블
  console.log('종목명'.padEnd(14) + '구점수'.padStart(6) + ' 구등급'.padEnd(6) + '  신점수'.padStart(6) + ' 신등급'.padEnd(6) + '  변동'.padStart(6) + '  수익률'.padStart(8));
  console.log('-'.repeat(70));

  const comparisons = [];
  unique.forEach(s => {
    const oldScore = s.total_score;
    const oldGrade = s.recommendation_grade || '?';
    const ret = s.current_return != null ? s.current_return : null;
    const newData = newScoreMap[s.stock_code];
    const newScore = newData ? newData.score : null;
    const newGrade = newData ? (newData.grade || '?') : '풀외';
    const diff = newScore != null ? (newScore - oldScore).toFixed(1) : 'N/A';
    const retStr = ret != null ? ret.toFixed(2) + '%' : 'N/A';

    comparisons.push({ name: s.stock_name, oldScore, oldGrade, newScore, newGrade, diff, ret, retStr });

    console.log(
      (s.stock_name || '?').padEnd(14) +
      String(oldScore).padStart(6) + '  ' + oldGrade.padEnd(6) +
      (newScore != null ? String(newScore).padStart(6) : '  N/A ') + '  ' + newGrade.padEnd(6) +
      String(diff).padStart(6) + '  ' + retStr.padStart(8)
    );
  });

  // 통계
  const matched = comparisons.filter(c => c.newScore != null);
  if (matched.length > 0) {
    const avgDiff = matched.reduce((a, c) => a + (c.newScore - c.oldScore), 0) / matched.length;
    const increased = matched.filter(c => c.newScore > c.oldScore).length;
    const decreased = matched.filter(c => c.newScore < c.oldScore).length;
    const same = matched.filter(c => c.newScore === c.oldScore).length;

    console.log('\n=== 점수 변동 통계 ===');
    console.log('매칭된 종목:', matched.length + '개');
    console.log('평균 변동:', avgDiff.toFixed(1) + '점');
    console.log('점수 상승:', increased + '개');
    console.log('점수 하락:', decreased + '개');
    console.log('변동 없음:', same + '개');
  }

  const notInPool = comparisons.filter(c => c.newScore == null);
  if (notInPool.length > 0) {
    console.log('\n=== 현재 종목 풀에 없는 종목 ===');
    notInPool.forEach(c => {
      console.log('  ' + c.name + ' (구: ' + c.oldScore + '점 ' + c.oldGrade + ') -> 수익률: ' + c.retStr);
    });
  }

  // 신규 점수 기준 점수 분포별 수익률
  console.log('\n=== v3.17 점수 기준 수익률 분포 ===');
  const rangeKeys = ['70+', '60-69', '50-59', '40-49', '30-39', '<30', '풀외'];
  const rangeMap = {};
  rangeKeys.forEach(k => rangeMap[k] = []);
  comparisons.forEach(c => {
    if (c.ret == null) return;
    const sc = c.newScore;
    if (sc == null) rangeMap['풀외'].push(c);
    else if (sc >= 70) rangeMap['70+'].push(c);
    else if (sc >= 60) rangeMap['60-69'].push(c);
    else if (sc >= 50) rangeMap['50-59'].push(c);
    else if (sc >= 40) rangeMap['40-49'].push(c);
    else if (sc >= 30) rangeMap['30-39'].push(c);
    else rangeMap['<30'].push(c);
  });

  console.log('v3.17구간  개수   승률      평균수익률');
  console.log('-'.repeat(48));
  rangeKeys.forEach(k => {
    const arr = rangeMap[k];
    if (arr.length === 0) { console.log(k.padEnd(10) + '  0개'); return; }
    const wins = arr.filter(c => c.ret > 0).length;
    const wr = (wins / arr.length * 100).toFixed(1);
    const avgRet = (arr.reduce((a, c) => a + c.ret, 0) / arr.length).toFixed(2);
    console.log(k.padEnd(10) + String(arr.length).padStart(3) + '개  ' + wr.padStart(6) + '%   ' + avgRet.padStart(7) + '%');
  });
}

main().catch(e => console.error(e));
