require('dotenv').config();
const supabase = require('../backend/supabaseClient');

(async () => {
  // 1. 전체 추천
  const { data: allRecs } = await supabase
    .from('screening_recommendations')
    .select('id, recommendation_date, whale_detected, total_score, recommendation_grade')
    .order('recommendation_date', { ascending: true });

  // 2. 가격 추적 데이터
  const { data: prices } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id, tracking_date, cumulative_return')
    .order('tracking_date', { ascending: false });

  // 추천별 수익률 매핑
  const retMap = {};
  const trackedIds = new Set();
  prices.forEach(p => {
    trackedIds.add(p.recommendation_id);
    if (!retMap[p.recommendation_id]) retMap[p.recommendation_id] = p.cumulative_return;
  });

  // 날짜별 집계
  const byDate = {};
  allRecs.forEach(r => {
    const d = r.recommendation_date;
    if (!byDate[d]) byDate[d] = { total: 0, whale: 0, tracked: 0, whaleTracked: 0 };
    byDate[d].total++;
    if (r.whale_detected) byDate[d].whale++;
    if (trackedIds.has(r.id)) {
      byDate[d].tracked++;
      if (r.whale_detected) byDate[d].whaleTracked++;
    }
  });

  console.log('=== 데이터 현황 ===');
  console.log('전체 추천:', allRecs.length);
  console.log('가격추적 있음:', trackedIds.size, '(' + (trackedIds.size / allRecs.length * 100).toFixed(0) + '%)');
  console.log('고래 종목:', allRecs.filter(r => r.whale_detected).length);
  console.log('고래+추적:', allRecs.filter(r => r.whale_detected && trackedIds.has(r.id)).length);

  console.log('\n=== 날짜별 현황 ===');
  console.log('날짜'.padEnd(13) + '전체'.padStart(4) + '고래'.padStart(5) + '추적'.padStart(5) + '고래+추적'.padStart(8));
  console.log('-'.repeat(37));

  const dates = Object.keys(byDate).sort();
  dates.forEach(d => {
    const b = byDate[d];
    console.log(d.padEnd(13) + String(b.total).padStart(4) + String(b.whale).padStart(5) + String(b.tracked).padStart(5) + String(b.whaleTracked).padStart(8));
  });

  // 가격 추적이 없는 날짜
  const noTrack = dates.filter(d => byDate[d].tracked === 0);
  console.log('\n추적 데이터 없는 날짜:', noTrack.length + '일');
  if (noTrack.length > 0) console.log('  ', noTrack.join(', '));

  process.exit(0);
})();
