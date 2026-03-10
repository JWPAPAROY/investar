require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  // 2/14~2/23 TOP3 종목의 가격 데이터 확인
  const { data: recs } = await supabase
    .from('screening_recommendations')
    .select('id, recommendation_date, stock_code, stock_name, total_score, recommended_price, is_top3')
    .gte('recommendation_date', '2026-02-14')
    .eq('is_active', true)
    .eq('is_top3', true)
    .order('recommendation_date', { ascending: true });

  console.log('=== 2/14~2/23 TOP3 종목 가격 데이터 ===\n');
  for (const r of recs) {
    const { data: prices } = await supabase
      .from('recommendation_daily_prices')
      .select('tracking_date, closing_price')
      .eq('recommendation_id', r.id)
      .order('tracking_date', { ascending: true });

    console.log(`${r.recommendation_date} | ${r.stock_name.padEnd(12)} | 점수:${r.total_score} | 추천가:${r.recommended_price} | 가격데이터: ${prices?.length || 0}건`);
    if (prices && prices.length > 0) {
      prices.forEach(p => console.log(`    ${p.tracking_date} → ${p.closing_price}`));
    }
  }

  // 가격 추적 최신 날짜
  const { data: latestPrice } = await supabase
    .from('recommendation_daily_prices')
    .select('tracking_date')
    .order('tracking_date', { ascending: false })
    .limit(1);
  console.log('\n가격 추적 최신 날짜:', latestPrice?.[0]?.tracking_date);

  // 스크립트의 simulateTop3로 뽑힌 종목도 확인 (is_top3=false지만 적격인 경우)
  const { data: allRecs } = await supabase
    .from('screening_recommendations')
    .select('id, recommendation_date, stock_code, stock_name, total_score, recommended_price, whale_detected, recommendation_grade, change_rate, disparity')
    .gte('recommendation_date', '2026-02-14')
    .eq('is_active', true)
    .order('recommendation_date', { ascending: true });

  // 날짜별 그룹핑 후 simulateTop3 재현
  const dateMap = new Map();
  for (const r of allRecs) {
    if (!dateMap.has(r.recommendation_date)) dateMap.set(r.recommendation_date, []);
    dateMap.get(r.recommendation_date).push(r);
  }

  console.log('\n=== simulateTop3 결과 vs 가격 데이터 ===\n');
  for (const [date, stocks] of [...dateMap.entries()].sort()) {
    const eligible = stocks.filter(s =>
      s.whale_detected &&
      s.recommendation_grade !== '과열' &&
      Math.abs(s.change_rate || 0) < 25 &&
      (s.disparity || 100) < 150
    );

    const top3 = [];
    const addFromRange = (lo, hi) => {
      const pool = eligible
        .filter(s => s.total_score >= lo && s.total_score <= hi && !top3.some(t => t.stock_code === s.stock_code))
        .sort((a, b) => b.total_score - a.total_score);
      for (const s of pool) {
        if (top3.length >= 3) break;
        top3.push(s);
      }
    };
    addFromRange(50, 69);
    addFromRange(80, 89);
    addFromRange(90, 100);
    addFromRange(70, 79);

    if (top3.length === 0) {
      console.log(`${date} | TOP3 없음 (적격: ${eligible.length}개)`);
      continue;
    }

    const top1 = top3[0];
    const { data: prices } = await supabase
      .from('recommendation_daily_prices')
      .select('tracking_date, closing_price')
      .eq('recommendation_id', top1.id)
      .order('tracking_date', { ascending: true });

    console.log(`${date} | TOP1: ${top1.stock_name.padEnd(12)} (${top1.total_score}점) | 추천가:${top1.recommended_price} | 가격: ${prices?.length || 0}건`);
  }
})().catch(console.error).finally(() => process.exit(0));
