// v3.84 로직으로 오늘 TOP3 재선별 + DB 반영
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 대상 날짜: --date=YYYY-MM-DD 인자 우선, 없으면 가장 최근 저장일(장중 추적 대상)
const dateArg = (process.argv.find(a => a.startsWith('--date=')) || '').split('=')[1];
let TODAY = dateArg || null; // 아래 main에서 동적으로 결정

function selectTop3V384(stocks) {
  const base = stocks.filter(s => {
    const hasSupply = s.whale_detected || (s.institution_buy_days || 0) >= 3 || (s.foreign_buy_days || 0) >= 3;
    return hasSupply
      && s.recommendation_grade !== '과열'
      && Math.abs(s.change_rate || 0) < 25
      && (s.disparity || 100) < 150
      && (s.total_score || 0) >= 45;
  });
  return [...base].sort((a, b) => {
    const sd = (b.total_score || 0) - (a.total_score || 0);
    if (sd !== 0) return sd;
    const rank = (s) => {
      const inst = s.institution_buy_days || 0, frgn = s.foreign_buy_days || 0;
      if (frgn >= 2 && inst < 2) return 5;
      if (inst >= 2 && frgn >= 2) return 4;
      if (inst >= 2) return 3;
      if (frgn >= 1) return 2;
      return 1;
    };
    return rank(b) - rank(a);
  }).slice(0, 3);
}

(async () => {
  // 대상 날짜 동적 결정: 가장 최근 저장일
  if (!TODAY) {
    const { data: latest } = await supabase
      .from('screening_recommendations')
      .select('recommendation_date')
      .order('recommendation_date', { ascending: false })
      .limit(1);
    TODAY = latest?.[0]?.recommendation_date;
    if (!TODAY) { console.error('저장 데이터 없음'); process.exit(1); }
  }
  console.log(`대상 추천일: ${TODAY} (오늘 장중 추적 대상)`);

  const { data: stocks, error } = await supabase
    .from('screening_recommendations')
    .select('id,stock_code,stock_name,recommendation_date,total_score,recommendation_grade,whale_detected,institution_buy_days,foreign_buy_days,change_rate,disparity,market_cap,is_top3,is_active,market_regime')
    .eq('recommendation_date', TODAY);

  if (error) { console.error('조회 실패:', error); process.exit(1); }
  if (!stocks || stocks.length === 0) { console.error(`${TODAY} 저장 데이터 없음`); process.exit(1); }

  console.log(`전체 풀: ${stocks.length}개`);
  const regime = stocks.find(s => s.market_regime)?.market_regime || 'momentum';
  console.log(`오늘 레짐: ${regime}`);

  if (regime !== 'momentum') {
    console.log(`\n⚠️  오늘 레짐이 momentum이 아님 (${regime}). 모멘텀 TOP3(is_top3) 갱신만 수행.`);
  }

  const currentTop3 = stocks.filter(s => s.is_top3);
  console.log(`\n=== 현재(기존 로직) 모멘텀 TOP3 ===`);
  currentTop3.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.stock_name} (${s.total_score}점, 기${s.institution_buy_days||0}외${s.foreign_buy_days||0}, 시총 ${Math.round((s.market_cap||0)/100000000)}억)`);
  });

  const newTop3 = selectTop3V384(stocks);
  console.log(`\n=== v3.84 로직 모멘텀 TOP3 ===`);
  newTop3.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.stock_name} (${s.total_score}점, 기${s.institution_buy_days||0}외${s.foreign_buy_days||0}, 시총 ${Math.round((s.market_cap||0)/100000000)}억)`);
  });

  const currentCodes = new Set(currentTop3.map(s => s.stock_code));
  const newCodes = new Set(newTop3.map(s => s.stock_code));
  const removed = [...currentCodes].filter(c => !newCodes.has(c));
  const added = [...newCodes].filter(c => !currentCodes.has(c));

  if (removed.length === 0 && added.length === 0) {
    console.log(`\n✅ 변경 없음 — 기존 TOP3와 v3.84 결과 동일`);
    process.exit(0);
  }

  console.log(`\n=== 변경 사항 ===`);
  console.log(`  제외: ${removed.map(c => stocks.find(s => s.stock_code === c)?.stock_name).join(', ') || '없음'}`);
  console.log(`  추가: ${added.map(c => stocks.find(s => s.stock_code === c)?.stock_name).join(', ') || '없음'}`);

  // --dry 플래그가 없으면 실제 반영
  if (process.argv.includes('--dry')) {
    console.log(`\n[dry-run] 실제 DB 갱신 생략. 실제 반영하려면 --dry 없이 재실행.`);
    process.exit(0);
  }

  console.log(`\nDB 갱신 중...`);

  // 1) 오늘 제외 대상 is_top3 해제
  if (removed.length > 0) {
    const { error: e1 } = await supabase
      .from('screening_recommendations')
      .update({ is_top3: false })
      .eq('recommendation_date', TODAY)
      .in('stock_code', removed);
    if (e1) { console.error('제외 갱신 실패:', e1); process.exit(1); }
    console.log(`  제외 ${removed.length}건 is_top3=false 반영`);
  }

  // 2) 신규 TOP3 is_top3=true + is_active=true
  if (added.length > 0) {
    const { error: e2 } = await supabase
      .from('screening_recommendations')
      .update({ is_top3: true, is_active: true })
      .eq('recommendation_date', TODAY)
      .in('stock_code', added);
    if (e2) { console.error('추가 갱신 실패:', e2); process.exit(1); }
    console.log(`  추가 ${added.length}건 is_top3=true, is_active=true 반영`);
  }

  // 3) 유지 종목도 is_active=true 보장
  const keptCodes = [...newCodes].filter(c => currentCodes.has(c));
  if (keptCodes.length > 0) {
    await supabase
      .from('screening_recommendations')
      .update({ is_active: true })
      .eq('recommendation_date', TODAY)
      .in('stock_code', keptCodes);
  }

  console.log(`\n✅ 완료. 오늘(${TODAY}) TOP3가 v3.84 로직으로 갱신됨.`);

  // 최종 확인
  const { data: verify } = await supabase
    .from('screening_recommendations')
    .select('stock_name,total_score,institution_buy_days,foreign_buy_days,is_top3,is_active')
    .eq('recommendation_date', TODAY)
    .eq('is_top3', true);
  console.log(`\n=== DB 최종 상태 (is_top3=true, N=${verify?.length}) ===`);
  verify?.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.stock_name} (${s.total_score}점, 기${s.institution_buy_days||0}외${s.foreign_buy_days||0}, active=${s.is_active})`);
  });
})();
