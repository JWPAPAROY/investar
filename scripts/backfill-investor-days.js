/**
 * 기관/외국인 연속 매수일 백필 스크립트
 *
 * DB에 저장된 institution_buy_days, foreign_buy_days가 필드명 불일치로
 * 전부 0이었던 문제를 수정한 후, 과거 데이터를 역산하여 업데이트.
 *
 * 로직:
 * 1. DB에서 최근 30일 추천 종목 조회
 * 2. 종목별로 KIS API에서 투자자 데이터(30일) 가져오기
 * 3. 각 추천일 기준으로 연속 매수일 역산
 * 4. DB 업데이트
 *
 * 실행: node scripts/backfill-investor-days.js
 */

require('dotenv').config();
const supabase = require('../backend/supabaseClient');
const kisApi = require('../backend/kisApi');

async function main() {
  console.log('📊 기관/외국인 매수일 백필 시작\n');

  // 1. DB에서 최근 30일 추천 종목 조회
  const { data: recs, error } = await supabase
    .from('screening_recommendations')
    .select('id, stock_code, stock_name, recommendation_date')
    .gte('recommendation_date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
    .order('recommendation_date', { ascending: false });

  if (error) {
    console.error('DB 조회 실패:', error.message);
    return;
  }

  console.log(`DB 레코드: ${recs.length}개\n`);

  // 2. 종목별로 그룹핑
  const byStock = {};
  recs.forEach(r => {
    if (!byStock[r.stock_code]) byStock[r.stock_code] = [];
    byStock[r.stock_code].push(r);
  });

  const stockCodes = Object.keys(byStock);
  console.log(`고유 종목: ${stockCodes.length}개\n`);

  let updated = 0;
  let failed = 0;

  // 3. 종목별 투자자 데이터 가져와서 역산
  for (let i = 0; i < stockCodes.length; i++) {
    const code = stockCodes[i];
    const stockRecs = byStock[code];
    const name = stockRecs[0].stock_name;

    process.stdout.write(`[${i + 1}/${stockCodes.length}] ${name} (${code})... `);

    try {
      // KIS API에서 30일 투자자 데이터 가져오기
      const investorData = await kisApi.getInvestorData(code, 30);

      if (!investorData || investorData.length < 3) {
        console.log('데이터 부족 (skip)');
        failed += stockRecs.length;
        continue;
      }

      // 각 추천일에 대해 연속 매수일 계산
      const updates = [];

      for (const rec of stockRecs) {
        const recDate = rec.recommendation_date;

        // 추천일 위치 찾기 (투자자 데이터에서)
        const dateIdx = investorData.findIndex(d => d.date === recDate.replace(/-/g, ''));

        if (dateIdx === -1) {
          // 정확한 날짜가 없으면 가장 가까운 날짜 찾기
          const recDateNum = parseInt(recDate.replace(/-/g, ''));
          let closestIdx = -1;
          let closestDiff = Infinity;
          investorData.forEach((d, idx) => {
            const diff = Math.abs(parseInt(d.date) - recDateNum);
            if (diff < closestDiff) { closestDiff = diff; closestIdx = idx; }
          });

          if (closestIdx === -1 || closestDiff > 3) {
            // 3일 이상 차이나면 스킵
            continue;
          }

          // closestIdx부터 과거로 연속 매수일 계산
          const { instDays, foreignDays } = countConsecutiveBuyDays(investorData, closestIdx);
          updates.push({ id: rec.id, instDays, foreignDays, date: recDate });
        } else {
          const { instDays, foreignDays } = countConsecutiveBuyDays(investorData, dateIdx);
          updates.push({ id: rec.id, instDays, foreignDays, date: recDate });
        }
      }

      // DB 업데이트
      for (const u of updates) {
        const { error: updateError } = await supabase
          .from('screening_recommendations')
          .update({
            institution_buy_days: u.instDays,
            foreign_buy_days: u.foreignDays
          })
          .eq('id', u.id);

        if (updateError) {
          console.log(`  ⚠️ ${u.date} 업데이트 실패: ${updateError.message}`);
          failed++;
        } else {
          updated++;
        }
      }

      const sample = updates[0];
      console.log(`${updates.length}개 업데이트 (예: 기관${sample?.instDays || 0}일, 외국인${sample?.foreignDays || 0}일)`);

    } catch (e) {
      console.log(`에러: ${e.message}`);
      failed += stockRecs.length;
    }
  }

  console.log(`\n✅ 완료: ${updated}개 업데이트, ${failed}개 실패`);
}

/**
 * 특정 인덱스부터 과거로 연속 매수일 계산
 * investorData[startIdx]가 해당일, startIdx+1이 하루 전
 */
function countConsecutiveBuyDays(investorData, startIdx) {
  let instDays = 0;
  let foreignDays = 0;

  // 기관 연속 매수일
  for (let i = startIdx; i < investorData.length; i++) {
    const instNet = investorData[i].institution?.netBuyQty || 0;
    if (instNet > 0) instDays++;
    else break;
  }

  // 외국인 연속 매수일
  for (let i = startIdx; i < investorData.length; i++) {
    const foreignNet = investorData[i].foreign?.netBuyQty || 0;
    if (foreignNet > 0) foreignDays++;
    else break;
  }

  return { instDays, foreignDays };
}

main().catch(e => console.error('Fatal:', e.message));
