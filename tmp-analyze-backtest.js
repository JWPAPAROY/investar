const https = require('https');

// 7일 성과 데이터 조회
https.get('https://investar-xi.vercel.app/api/recommendations/performance?days=7', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    let j;
    try { j = JSON.parse(data); } catch(e) { console.log('Parse error:', data.slice(0, 200)); return; }
    const stocks = j.stocks || [];
    console.log('=== Supabase 성과 추적 (최근 7일 추천) ===');
    console.log('총 추천 종목:', stocks.length);
    console.log();

    if (stocks.length === 0) { console.log('데이터 없음'); return; }

    const rangeKeys = ['90+','80-89','70-79','60-69','50-59','40-49','30-39','20-29','<20'];
    const ranges = {};
    rangeKeys.forEach(k => ranges[k] = []);
    stocks.forEach(s => {
      const sc = s.total_score;
      if (sc >= 90) ranges['90+'].push(s);
      else if (sc >= 80) ranges['80-89'].push(s);
      else if (sc >= 70) ranges['70-79'].push(s);
      else if (sc >= 60) ranges['60-69'].push(s);
      else if (sc >= 50) ranges['50-59'].push(s);
      else if (sc >= 40) ranges['40-49'].push(s);
      else if (sc >= 30) ranges['30-39'].push(s);
      else if (sc >= 20) ranges['20-29'].push(s);
      else ranges['<20'].push(s);
    });

    console.log('점수구간   개수   승률      평균수익률');
    console.log('-'.repeat(48));
    rangeKeys.forEach(k => {
      const arr = ranges[k];
      if (arr.length === 0) { console.log(k.padEnd(10) + '  0개'); return; }
      const withReturn = arr.filter(r => r.current_return != null);
      if (withReturn.length === 0) { console.log(k.padEnd(10) + String(arr.length).padStart(3) + '개  (수익률 미계산)'); return; }
      const wins = withReturn.filter(r => r.current_return > 0).length;
      const wr = (wins / withReturn.length * 100).toFixed(1);
      const avgRet = (withReturn.reduce((a, r) => a + r.current_return, 0) / withReturn.length).toFixed(2);
      console.log(k.padEnd(10) + String(arr.length).padStart(3) + '개  ' + wr.padStart(6) + '%   ' + avgRet.padStart(7) + '%');
    });

    // 등급별
    console.log('\n등급별 성과:');
    const grades = {};
    stocks.forEach(s => {
      const g = s.recommendation_grade || '?';
      if (!grades[g]) grades[g] = [];
      grades[g].push(s);
    });
    Object.entries(grades).forEach(([g, arr]) => {
      const withReturn = arr.filter(r => r.current_return != null);
      if (withReturn.length === 0) { console.log('  ' + g + ': ' + arr.length + '개 (수익률 미계산)'); return; }
      const wins = withReturn.filter(r => r.current_return > 0).length;
      const wr = (wins / withReturn.length * 100).toFixed(1);
      const avgRet = (withReturn.reduce((a, r) => a + r.current_return, 0) / withReturn.length).toFixed(2);
      console.log('  ' + g + ': ' + arr.length + '개, 승률 ' + wr + '%, 평균 ' + avgRet + '%');
    });

    // 전체 통계
    const withReturn = stocks.filter(r => r.current_return != null);
    if (withReturn.length > 0) {
      const wins = withReturn.filter(r => r.current_return > 0).length;
      const avgRet = withReturn.reduce((a, r) => a + r.current_return, 0) / withReturn.length;
      const returns = withReturn.map(r => r.current_return).sort((a,b) => a-b);
      console.log('\n전체 통계:');
      console.log('  승률:', (wins/withReturn.length*100).toFixed(1) + '%');
      console.log('  평균수익률:', avgRet.toFixed(2) + '%');
      console.log('  최고:', Math.max(...returns).toFixed(2) + '%');
      console.log('  최저:', Math.min(...returns).toFixed(2) + '%');
      console.log('  중앙값:', returns[Math.floor(returns.length/2)].toFixed(2) + '%');
    }

    // 전체 종목 리스트
    console.log('\n=== 전체 종목 상세 ===');
    const sorted = [...stocks].sort((a,b) => b.total_score - a.total_score);
    sorted.forEach((r, i) => {
      const ret = r.current_return != null ? r.current_return.toFixed(2) + '%' : 'N/A';
      const whale = r.whale_detected ? ' [고래]' : '';
      const accum = r.accumulation_detected ? ' [매집]' : '';
      console.log(
        String(i+1).padStart(2) + '. ' +
        (r.stock_name || '?').padEnd(12) +
        String(r.total_score).padStart(6) + '점 ' +
        (r.recommendation_grade || '?').padEnd(4) +
        ' 수익률:' + ret.padStart(8) +
        whale + accum +
        ' (' + r.recommendation_date + ')'
      );
    });

    // 날짜별 추천 개수
    const byDate = {};
    stocks.forEach(s => {
      const d = s.recommendation_date;
      if (!byDate[d]) byDate[d] = 0;
      byDate[d]++;
    });
    console.log('\n날짜별 추천 수:');
    Object.entries(byDate).sort().forEach(([d,c]) => console.log('  ' + d + ': ' + c + '개'));
  });
}).on('error', e => console.error(e));
