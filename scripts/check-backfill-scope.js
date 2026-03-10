require('dotenv').config();
const supabase = require('../backend/supabaseClient');

(async () => {
  // 추적 데이터 있는 recommendation_id 집합
  const { data: tracked } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id');
  const trackedIds = new Set(tracked.map(p => p.recommendation_id));

  // 추적 없는 추천
  const { data: recs } = await supabase
    .from('screening_recommendations')
    .select('id, stock_code, stock_name, recommendation_date, recommended_price, whale_detected, total_score')
    .order('recommendation_date', { ascending: true });

  const untracked = recs.filter(r => !trackedIds.has(r.id));

  console.log('=== 복구 대상 ===');
  console.log('전체 추천:', recs.length);
  console.log('추적 있음:', trackedIds.size);
  console.log('추적 없음 (복구 대상):', untracked.length);

  // 고유 종목 수
  const uniqueStocks = new Set(untracked.map(r => r.stock_code));
  console.log('고유 종목 수:', uniqueStocks.size, '(API 호출 필요)');

  // 기간
  const dates = untracked.map(r => r.recommendation_date).sort();
  console.log('기간:', dates[0], '~', dates[dates.length - 1]);

  // 추천가 유무
  const noPrice = untracked.filter(r => !r.recommended_price || r.recommended_price === 0);
  console.log('추천가 없음:', noPrice.length);

  // 고래 종목
  const whaleUntracked = untracked.filter(r => r.whale_detected);
  console.log('고래 종목:', whaleUntracked.length);

  // 종목별 추천 수
  const byStock = {};
  untracked.forEach(r => {
    if (!byStock[r.stock_code]) byStock[r.stock_code] = { name: r.stock_name, count: 0, dates: [] };
    byStock[r.stock_code].count++;
    byStock[r.stock_code].dates.push(r.recommendation_date);
  });

  console.log('\n=== 종목별 추천 수 (상위 15개) ===');
  Object.entries(byStock)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .forEach(([code, info]) => {
      console.log(code, info.name.padEnd(12), info.count + '건', info.dates[0] + '~' + info.dates[info.dates.length - 1]);
    });

  // API 호출 예상
  console.log('\n=== 복구 예상 ===');
  console.log('KIS API 호출:', uniqueStocks.size + '건 (종목당 1회, 일봉 조회)');
  console.log('예상 소요 시간:', Math.ceil(uniqueStocks.size * 0.3) + '초');
  console.log('생성될 가격 레코드: ~' + (untracked.length * 15) + '건 (추천당 평균 15일 추적 가정)');

  process.exit(0);
})();
