/**
 * backfill-activate-cd-grades.js
 * 최근 30일 이내 C/D 등급 레코드(is_active=false)를 is_active=true로 업데이트
 * → update-prices cron이 다음 실행 시 가격 추적 시작
 *
 * 실행: node scripts/backfill-activate-cd-grades.js [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`📋 C/D 등급 is_active 백필 (${cutoffStr} 이후)`);
  if (DRY_RUN) console.log('🔍 DRY RUN 모드 — DB 변경 없음');

  // 조회: total_score < 45, is_active = false, 최근 30일 이내
  let all = [], from = 0;
  while (true) {
    const { data, error } = await sb
      .from('screening_recommendations')
      .select('id, recommendation_date, stock_code, stock_name, recommendation_grade, total_score')
      .lt('total_score', 45)
      .eq('is_active', false)
      .neq('recommendation_grade', '과열')
      .gte('recommendation_date', cutoffStr)
      .range(from, from + 999);
    if (error) { console.error('❌ 조회 실패:', error.message); break; }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`\n📊 대상 레코드: ${all.length}건`);

  // 등급별 통계
  const byGrade = {};
  all.forEach(r => { byGrade[r.recommendation_grade] = (byGrade[r.recommendation_grade] || 0) + 1; });
  Object.entries(byGrade).sort().forEach(([g, n]) => console.log(`   ${g}: ${n}건`));

  if (all.length === 0) {
    console.log('\n✅ 업데이트할 레코드 없음');
    return;
  }

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN — 실제 업데이트 없음');
    return;
  }

  // 업데이트: is_active = true
  const ids = all.map(r => r.id);
  let updated = 0;
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { error } = await sb
      .from('screening_recommendations')
      .update({ is_active: true })
      .in('id', batch);
    if (error) {
      console.error(`❌ 배치 ${i}~${i + BATCH} 실패:`, error.message);
    } else {
      updated += batch.length;
      process.stdout.write(`\r✅ ${updated}/${ids.length} 업데이트 완료`);
    }
  }

  console.log(`\n\n🎉 완료: ${updated}건 is_active = true 설정`);
}

main().catch(console.error);
