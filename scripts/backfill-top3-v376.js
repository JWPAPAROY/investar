/**
 * backfill-top3-v376.js
 * 과거 screening_recommendations의 is_top3 플래그를 v376 로직으로 재계산 후 일괄 업데이트
 *
 * v376 선별 로직:
 *   gate: (whale OR inst≥3 OR fgn≥3) AND score≥45 AND 등급≠과열 AND |등락|<25 AND !(80-89+이격≥120)
 *   이격도 단계적 컷: <130 → <140 → <150
 *   tier1: 시총≤1조 우선 (3개 미만 시 전체)
 *   정렬: 스윗스팟구간 → 수급1차 → 점수
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;
const DRY_RUN = process.argv.includes('--dry-run');

async function fetchAll(table, select) {
  let all = [], from = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── v376 헬퍼 ───────────────────────────────────────────────────────
const bandRank = (score) => {
  if (score >= 50 && score <= 59) return 1;
  if (score >= 60 && score <= 69) return 2;
  if (score >= 80 && score <= 89) return 3;
  if (score >= 90) return 4;
  if (score >= 70 && score <= 79) return 5;
  return 6;
};

const supplyRank = (inst, fgn) => {
  if (fgn >= 2 && inst < 2) return 5;
  if (inst >= 2 && fgn >= 2) return 4;
  if (inst >= 2) return 3;
  if (fgn >= 1) return 2;
  return 1;
};

function selectTop3V376(stocks) {
  const isEligible = (s) => {
    const score = s.total_score || 0;
    const disparity = s.disparity || 100;
    const isS89Trap = score >= 80 && score <= 89 && disparity >= 120;
    const hasSupply = s.whale_detected || (s.institution_buy_days || 0) >= 3 || (s.foreign_buy_days || 0) >= 3;
    return hasSupply &&
      s.recommendation_grade !== '과열' &&
      Math.abs(s.change_rate || 0) < 25 &&
      score >= 45 &&
      !isS89Trap;
  };

  // 이격도 단계적 컷
  const tiers = [130, 140, 150];
  let baseEligible = [];
  for (const tier of tiers) {
    const filtered = stocks.filter(s => isEligible(s) && (s.disparity || 100) < tier);
    if (filtered.length >= 3) { baseEligible = filtered; break; }
    baseEligible = filtered;
  }
  if (!baseEligible.length) return [];

  // B1: tier1 없음 — 전체 풀에서 정렬
  return [...baseEligible].sort((a, b) => {
    const bd = bandRank(a.total_score || 0) - bandRank(b.total_score || 0);
    if (bd !== 0) return bd;
    const sd = supplyRank(b.institution_buy_days || 0, b.foreign_buy_days || 0)
             - supplyRank(a.institution_buy_days || 0, a.foreign_buy_days || 0);
    if (sd !== 0) return sd;
    return (b.total_score || 0) - (a.total_score || 0);
  }).slice(0, 3).map(s => s.id);
}

// ── 메인 ────────────────────────────────────────────────────────────
(async () => {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}데이터 로딩 중...`);

  const recs = await fetchAll(
    'screening_recommendations',
    'id,recommendation_date,stock_code,stock_name,total_score,recommendation_grade,' +
    'whale_detected,institution_buy_days,foreign_buy_days,change_rate,disparity,market_cap,is_top3'
  );
  console.log(`  총 ${recs.length}개 레코드\n`);

  // 날짜별 그룹
  const byDate = new Map();
  for (const r of recs) {
    if (!byDate.has(r.recommendation_date)) byDate.set(r.recommendation_date, []);
    byDate.get(r.recommendation_date).push(r);
  }
  const dates = [...byDate.keys()].sort();

  // v376으로 TOP3 재계산
  const setTrue = new Set();
  let changedDates = 0;

  for (const d of dates) {
    const pool = byDate.get(d);
    const newTop3Ids = new Set(selectTop3V376(pool));
    const oldTop3Ids = new Set(pool.filter(s => s.is_top3).map(s => s.id));

    // 변경 여부 확인
    const added = [...newTop3Ids].filter(id => !oldTop3Ids.has(id));
    const removed = [...oldTop3Ids].filter(id => !newTop3Ids.has(id));

    if (added.length || removed.length) {
      changedDates++;
      const getStock = id => pool.find(s => s.id === id);
      if (DRY_RUN) {
        console.log(`${d}:`);
        if (added.length) console.log(`  + 추가: ${added.map(id => `${getStock(id)?.stock_name}(${getStock(id)?.total_score}p)`).join(', ')}`);
        if (removed.length) console.log(`  - 제거: ${removed.map(id => `${getStock(id)?.stock_name}(${getStock(id)?.total_score}p)`).join(', ')}`);
      }
    }

    for (const id of newTop3Ids) setTrue.add(id);
  }

  const setFalseIds = recs.filter(r => r.is_top3 && !setTrue.has(r.id)).map(r => r.id);
  const setTrueNewIds = recs.filter(r => !r.is_top3 && setTrue.has(r.id)).map(r => r.id);

  console.log(`\n─────────────────────────────────`);
  console.log(`변경된 날짜: ${changedDates}/${dates.length}일`);
  console.log(`is_top3 true→false: ${setFalseIds.length}개`);
  console.log(`is_top3 false→true: ${setTrueNewIds.length}개`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] DB 업데이트 없음. --dry-run 없이 실행하면 적용됩니다.');
    return;
  }

  // DB 업데이트 (배치)
  const BATCH = 100;
  let updated = 0;

  // true→false (기존 top3 해제)
  for (let i = 0; i < setFalseIds.length; i += BATCH) {
    const batch = setFalseIds.slice(i, i + BATCH);
    const { error } = await sb.from('screening_recommendations')
      .update({ is_top3: false }).in('id', batch);
    if (error) { console.error('❌ false 업데이트 오류:', error.message); break; }
    updated += batch.length;
    process.stdout.write(`\r  업데이트 중... ${updated}/${setFalseIds.length + setTrueNewIds.length}`);
  }

  // false→true (신규 top3 설정)
  for (let i = 0; i < setTrueNewIds.length; i += BATCH) {
    const batch = setTrueNewIds.slice(i, i + BATCH);
    const { error } = await sb.from('screening_recommendations')
      .update({ is_top3: true }).in('id', batch);
    if (error) { console.error('❌ true 업데이트 오류:', error.message); break; }
    updated += batch.length;
    process.stdout.write(`\r  업데이트 중... ${updated}/${setFalseIds.length + setTrueNewIds.length}`);
  }

  console.log(`\n✅ 완료. ${updated}개 레코드 업데이트.`);
})();
