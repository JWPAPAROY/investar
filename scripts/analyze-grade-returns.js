require('dotenv').config();
const supabase = require('../backend/supabaseClient');

(async () => {
  const { data: recs } = await supabase
    .from('screening_recommendations')
    .select('id, stock_name, total_score, recommendation_grade, whale_detected, recommendation_date')
    .order('recommendation_date', { ascending: true });

  // 페이지네이션으로 전체 가격 데이터 로드
  let allPrices = [];
  let page = 0;
  while (true) {
    const { data } = await supabase
      .from('recommendation_daily_prices')
      .select('recommendation_id, cumulative_return')
      .order('tracking_date', { ascending: false })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data || data.length === 0) break;
    allPrices.push(...data);
    if (data.length < 1000) break;
    page++;
  }

  // 각 추천의 최신 수익률
  const retMap = {};
  allPrices.forEach(p => {
    if (!retMap[p.recommendation_id]) retMap[p.recommendation_id] = p.cumulative_return;
  });

  console.log('전체 추천:', recs.length, '| 수익률 매핑:', Object.keys(retMap).length);

  // 전체 등급별
  console.log('\n=== 전체 종목 등급별 수익률 ===');
  printGradeTable(recs, retMap, false);

  // 고래 종목만
  console.log('\n=== 고래 종목 등급별 수익률 ===');
  printGradeTable(recs, retMap, true);

  // 고래 종목 점수 구간별
  console.log('\n=== 고래 종목 점수 구간별 수익률 ===');
  const whaleWithRet = recs.filter(r => r.whale_detected && retMap[r.id] !== undefined);
  console.log('구간'.padEnd(10) + '종목수'.padStart(6) + '평균수익'.padStart(10) + '승률'.padStart(8) + '중앙값'.padStart(8));
  console.log('-'.repeat(44));

  const ranges = [[90,100,'90-100'],[80,89,'80-89'],[70,79,'70-79'],[60,69,'60-69'],[50,59,'50-59'],[40,49,'40-49'],[30,39,'30-39'],[0,29,'0-29']];
  ranges.forEach(([lo, hi, label]) => {
    const matched = whaleWithRet.filter(r => r.total_score >= lo && r.total_score <= hi);
    if (matched.length === 0) return;
    const rets = matched.map(r => retMap[r.id]).sort((a, b) => a - b);
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const win = rets.filter(r => r > 0).length;
    const median = rets[Math.floor(rets.length / 2)];
    console.log(
      label.padEnd(10) +
      String(rets.length).padStart(6) +
      (avg.toFixed(1) + '%').padStart(10) +
      ((win / rets.length * 100).toFixed(0) + '%').padStart(8) +
      (median.toFixed(1) + '%').padStart(8)
    );
  });

  // 황금구간(50-69) vs 고점수(70-89) 직접 비교
  const golden = whaleWithRet.filter(r => r.total_score >= 50 && r.total_score <= 69);
  const high = whaleWithRet.filter(r => r.total_score >= 70 && r.total_score <= 89);
  const goldenRets = golden.map(r => retMap[r.id]);
  const highRets = high.map(r => retMap[r.id]);

  console.log('\n=== 직접 비교: 50-69점 vs 70-89점 (고래) ===');
  console.log('50-69점:', goldenRets.length + '개',
    '평균 ' + (goldenRets.reduce((a,b)=>a+b,0)/goldenRets.length).toFixed(1) + '%',
    '승률 ' + (goldenRets.filter(r=>r>0).length/goldenRets.length*100).toFixed(0) + '%');
  console.log('70-89점:', highRets.length + '개',
    '평균 ' + (highRets.reduce((a,b)=>a+b,0)/highRets.length).toFixed(1) + '%',
    '승률 ' + (highRets.filter(r=>r>0).length/highRets.length*100).toFixed(0) + '%');

  process.exit(0);
})();

function printGradeTable(recs, retMap, whaleOnly) {
  const filtered = whaleOnly ? recs.filter(r => r.whale_detected) : recs;
  const grades = {};
  filtered.forEach(r => {
    const ret = retMap[r.id];
    if (ret === undefined) return;
    const g = r.recommendation_grade || '?';
    if (!grades[g]) grades[g] = [];
    grades[g].push({ ret, score: r.total_score });
  });

  console.log('등급'.padEnd(8) + '종목수'.padStart(6) + '평균수익'.padStart(10) + '승률'.padStart(8) + '점수범위'.padStart(12));
  console.log('-'.repeat(46));

  ['S+', 'S', 'A', 'B', 'C', 'D', '과열'].forEach(g => {
    const d = grades[g];
    if (!d || d.length === 0) return;
    const avg = d.reduce((a, b) => a + b.ret, 0) / d.length;
    const win = d.filter(r => r.ret > 0).length;
    const scores = d.map(r => r.score);
    console.log(
      g.padEnd(8) +
      String(d.length).padStart(6) +
      (avg.toFixed(1) + '%').padStart(10) +
      ((win / d.length * 100).toFixed(0) + '%').padStart(8) +
      (Math.min(...scores).toFixed(0) + '-' + Math.max(...scores).toFixed(0)).padStart(12)
    );
  });
}
