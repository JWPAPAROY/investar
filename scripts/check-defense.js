process.env.NODE_PATH = 'c:/Users/knoww/investar/node_modules';
require('module').Module._initPaths();
require('dotenv').config({ path: 'c:/Users/knoww/investar/.env' });
const s = require('c:/Users/knoww/investar/backend/supabaseClient');

(async () => {
  // 1. Recent prediction scores
  const { data: preds } = await s
    .from('overnight_predictions')
    .select('prediction_date, score, signal')
    .in('prediction_date', ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'])
    .order('prediction_date');

  console.log('=== 최근 예측 스코어 ===');
  preds?.forEach(d => console.log(`  ${d.prediction_date} | signal: ${d.signal} | score: ${d.score}`));

  // 2. Defense top3 records
  const { data: defRecs } = await s
    .from('screening_recommendations')
    .select('recommendation_date, stock_code, stock_name, is_top3, is_defense_top3')
    .in('recommendation_date', ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'])
    .eq('is_defense_top3', true);

  console.log('\n=== 방어 TOP3 DB 기록 ===');
  console.log(`총 ${defRecs?.length || 0}건`);
  defRecs?.forEach(r => console.log(`  ${r.recommendation_date} | ${r.stock_name} (${r.stock_code})`));

  // 3. Normal top3 records
  const { data: topRecs } = await s
    .from('screening_recommendations')
    .select('recommendation_date, stock_code, stock_name, is_top3, is_defense_top3')
    .in('recommendation_date', ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'])
    .eq('is_top3', true);

  console.log('\n=== 일반 TOP3 DB 기록 ===');
  console.log(`총 ${topRecs?.length || 0}건`);
  topRecs?.forEach(r => console.log(`  ${r.recommendation_date} | ${r.stock_name} (${r.stock_code}) | defense: ${r.is_defense_top3}`));

  // 4. Check columns exist
  const { data: cols } = await s
    .from('screening_recommendations')
    .select('is_defense_top3')
    .not('is_defense_top3', 'is', null)
    .limit(5);
  console.log('\n=== is_defense_top3 칼럼 데이터 존재 여부 ===');
  console.log(`is_defense_top3 != null인 행: ${cols?.length || 0}건`);
})();
