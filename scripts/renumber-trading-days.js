/**
 * days_since_recommendation 달력일 → 거래일 기준 재번호 (v3.94, 1회성 정비)
 *
 * 배경: update-prices.js가 D+N을 달력일로 세는 바람에 행이 생기는 거래일과 어긋났다.
 *   실측(2026-04-01~07-05, n=2131): 금요일 추천 D+1 존재율 0%, 수·목요일 추천 D+10 존재율 0%.
 *   weekly-diagnostic이 pIdx[recId][k]로 직접 인덱싱하므로 해당 건이 조용히 탈락,
 *   active_policy(D+1→D+10) 평가가 월·화 추천(≈39%)만으로 이뤄지고 있었다.
 *
 * 이 스크립트는 (recommendation_date, tracking_date)로부터 올바른 거래일 번호를 재계산해
 * 기존 행을 UPDATE한다. 멱등 — 몇 번 돌려도 결과 동일.
 *
 * 휴장일 행(예: 2026-06-03 지방선거일 703행)은 재번호 대상이 아니다. 장이 안 열린 날의
 * 유령 관측이므로 삭제돼야 하는데, anon 키는 RLS로 DELETE가 막혀 있다.
 *   → scratchpad/cleanup-0603.sql 을 Supabase SQL Editor에서 먼저 실행할 것.
 *   → 삭제 전에는 --allow-phantom 없이는 재번호를 거부한다 (휴장일 행이 직전 거래일과
 *     같은 번호로 충돌하기 때문).
 *
 * 실행:
 *   node scripts/renumber-trading-days.js --dry    # 변경 예정만 출력
 *   node scripts/renumber-trading-days.js          # 실제 UPDATE
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { isTradingDay, tradingDaysSince } = require('../backend/marketCalendar');

const DRY = process.argv.includes('--dry');
const ALLOW_PHANTOM = process.argv.includes('--allow-phantom');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function fetchAll(table, cols) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`📊 days_since_recommendation 거래일 재번호 ${DRY ? '(DRY RUN)' : '(실제 반영)'}\n`);

  const recs = await fetchAll('screening_recommendations', 'id,recommendation_date');
  const recDate = new Map(recs.map(r => [r.id, r.recommendation_date]));
  console.log(`추천 ${recs.length}건`);

  const prices = await fetchAll('recommendation_daily_prices',
    'id,recommendation_id,tracking_date,days_since_recommendation');
  console.log(`가격추적 ${prices.length}행\n`);

  const phantoms = prices.filter(p => !isTradingDay(p.tracking_date));
  if (phantoms.length) {
    const byDate = {};
    phantoms.forEach(p => { byDate[p.tracking_date] = (byDate[p.tracking_date] || 0) + 1; });
    console.log(`⚠️ 휴장일에 기록된 유령 행 ${phantoms.length}개:`);
    Object.entries(byDate).sort().forEach(([d, n]) => console.log(`   ${d}: ${n}행`));
    if (!ALLOW_PHANTOM) {
      console.log('\n❌ 중단. 유령 행은 재번호하면 직전 거래일과 번호가 충돌한다.');
      console.log('   scratchpad/cleanup-0603.sql 을 Supabase SQL Editor에서 먼저 실행한 뒤 재시도할 것.');
      console.log('   (그래도 강행하려면 --allow-phantom — 유령 행은 건너뛰고 나머지만 재번호)');
      process.exit(1);
    }
    console.log('   --allow-phantom: 유령 행은 건너뛰고 진행\n');
  }

  const targets = [];
  let orphan = 0;
  for (const p of prices) {
    if (!isTradingDay(p.tracking_date)) continue;
    const rd = recDate.get(p.recommendation_id);
    if (!rd) { orphan++; continue; }
    const correct = tradingDaysSince(rd, p.tracking_date);
    if (correct !== p.days_since_recommendation) {
      targets.push({ id: p.id, from: p.days_since_recommendation, to: correct });
    }
  }

  if (orphan) console.log(`ℹ️ 추천 원본이 없는 고아 행 ${orphan}개 — 건너뜀\n`);
  console.log(`재번호 대상: ${targets.length}행 / 검사 ${prices.length}행`);
  if (!targets.length) { console.log('✅ 이미 모두 거래일 기준. 변경 없음.'); return; }

  const sample = targets.slice(0, 8).map(t => `D+${t.from}→D+${t.to}`).join(', ');
  console.log(`  예시: ${sample}\n`);

  if (DRY) { console.log('DRY RUN — 실제 변경 없음.'); return; }

  let done = 0, failed = 0;
  for (const t of targets) {
    const { error } = await sb.from('recommendation_daily_prices')
      .update({ days_since_recommendation: t.to }).eq('id', t.id);
    if (error) { failed++; if (failed <= 3) console.warn(`  ⚠️ ${t.id}: ${error.message}`); }
    else done++;
    if ((done + failed) % 500 === 0) console.log(`  ... ${done + failed}/${targets.length}`);
  }
  console.log(`\n✅ 완료: ${done}행 반영, ${failed}행 실패`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
