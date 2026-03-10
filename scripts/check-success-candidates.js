/**
 * +10% 달성 종목이 있는지 확인
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const supabase = require('../backend/supabaseClient');

async function check() {
  // 1. 전체 추천 수
  const { count: totalRecs } = await supabase
    .from('screening_recommendations')
    .select('id', { count: 'exact', head: true });
  console.log(`총 추천 종목: ${totalRecs}개`);

  // 2. 일별 가격 데이터 수
  const { count: totalPrices } = await supabase
    .from('recommendation_daily_prices')
    .select('id', { count: 'exact', head: true });
  console.log(`일별 가격 데이터: ${totalPrices}개`);

  // 3. +10% 달성 종목 확인
  const { data: highReturn, error } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id, cumulative_return, tracking_date')
    .gte('cumulative_return', 10)
    .order('cumulative_return', { ascending: false })
    .limit(20);

  if (error) {
    console.error('조회 실패:', error);
    return;
  }

  console.log(`\n+10% 달성 기록: ${highReturn?.length || 0}개`);
  if (highReturn?.length > 0) {
    for (const r of highReturn.slice(0, 10)) {
      // 종목명 조회
      const { data: rec } = await supabase
        .from('screening_recommendations')
        .select('stock_name, stock_code, recommendation_date, total_score')
        .eq('id', r.recommendation_id)
        .single();
      console.log(`  ${rec?.stock_name || '?'} (${rec?.stock_code}) | +${r.cumulative_return?.toFixed(1)}% | 추천: ${rec?.recommendation_date} | 달성: ${r.tracking_date} | 점수: ${rec?.total_score}`);
    }
  }

  // 4. 기존 success_patterns 수
  const { count: patternCount } = await supabase
    .from('success_patterns')
    .select('id', { count: 'exact', head: true });
  console.log(`\n기존 success_patterns: ${patternCount}개`);

  // 5. 최고 수익률 종목 (10% 미달이라도)
  const { data: topReturn } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id, cumulative_return, tracking_date')
    .order('cumulative_return', { ascending: false })
    .limit(5);

  console.log(`\n최고 수익률 TOP 5:`);
  for (const r of (topReturn || [])) {
    const { data: rec } = await supabase
      .from('screening_recommendations')
      .select('stock_name, stock_code')
      .eq('id', r.recommendation_id)
      .single();
    console.log(`  ${rec?.stock_name || '?'} | +${r.cumulative_return?.toFixed(1)}% | ${r.tracking_date}`);
  }
}

check().catch(console.error);
