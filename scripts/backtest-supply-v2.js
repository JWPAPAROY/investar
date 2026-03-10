/**
 * 전체 기간 백테스트: 기존 v1 TOP3 vs Supply 반영 TOP3
 * is_top3 마킹 무관하게, 전체 추천에서 TOP3를 직접 재구성
 */
require('dotenv').config();
const supabase = require('../backend/supabaseClient');

function calcSupplyBonus(instDays, foreignDays) {
  let score = 0;
  if (instDays >= 5) score += 6;
  else if (instDays >= 4) score += 5;
  else if (instDays >= 3) score += 4;
  else if (instDays >= 2) score += 2;
  else if (instDays >= 1) score += 1;

  if (foreignDays >= 5) score += 4;
  else if (foreignDays >= 4) score += 3;
  else if (foreignDays >= 3) score += 3;
  else if (foreignDays >= 2) score += 2;
  else if (foreignDays >= 1) score += 1;

  if (instDays >= 3 && foreignDays >= 3) score += 5;
  else if (instDays >= 2 && foreignDays >= 2) score += 3;
  else if ((instDays >= 3 && foreignDays >= 1) || (foreignDays >= 3 && instDays >= 1)) score += 2;

  return Math.min(score, 15);
}

async function main() {
  // 1. 전체 추천
  const { data: recs, error } = await supabase
    .from('screening_recommendations')
    .select('id, stock_code, stock_name, recommendation_date, total_score, institution_buy_days, foreign_buy_days, whale_detected, recommendation_grade, recommended_price')
    .gte('recommendation_date', '2025-01-01')
    .order('recommendation_date', { ascending: true });

  if (error) { console.error(error); return; }

  // 2. 수익률
  const { data: prices, error: e2 } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id, cumulative_return, days_since_recommendation')
    .order('tracking_date', { ascending: false });

  if (e2) { console.error(e2); return; }

  const returnMap = {};
  prices.forEach(p => {
    if (!returnMap[p.recommendation_id]) {
      returnMap[p.recommendation_id] = p.cumulative_return;
    }
  });

  // 3. 날짜별 그룹핑
  const byDate = {};
  recs.forEach(r => {
    if (!byDate[r.recommendation_date]) byDate[r.recommendation_date] = [];
    byDate[r.recommendation_date].push(r);
  });

  const dates = Object.keys(byDate).sort();
  console.log('전체 추천:', recs.length, '| 날짜:', dates.length, '| 수익률 매핑:', Object.keys(returnMap).length);
  console.log('기간:', dates[0], '~', dates[dates.length - 1]);

  // 4. 날짜별 TOP3 선별 (두 가지 방식)
  let v1Returns = [], supplyReturns = [];
  let overlapTotal = 0, comparedDays = 0;
  const dailyComparison = [];

  for (const date of dates) {
    const stocks = byDate[date];

    // 고래 필터 적용 (v1 기준)
    const whaleStocks = stocks
      .filter(s => s.whale_detected && s.recommendation_grade !== '과열');

    if (whaleStocks.length === 0) continue;

    // [기존] v1 총점 기준 TOP3
    const v1Top3 = [...whaleStocks]
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 3);

    // [변경안] v1 + Supply 보너스 기준 TOP3
    const supplyRanked = whaleStocks.map(s => {
      const inst = s.institution_buy_days || 0;
      const fgn = s.foreign_buy_days || 0;
      return { ...s, supply: calcSupplyBonus(inst, fgn), adjusted: s.total_score + calcSupplyBonus(inst, fgn) };
    }).sort((a, b) => b.adjusted - a.adjusted);
    const supplyTop3 = supplyRanked.slice(0, 3);

    // 수익률 수집
    const v1Rets = v1Top3.map(s => returnMap[s.id]).filter(r => r !== undefined);
    const supRets = supplyTop3.map(s => returnMap[s.id]).filter(r => r !== undefined);

    if (v1Rets.length === 0 && supRets.length === 0) continue;
    comparedDays++;

    v1Rets.forEach(r => v1Returns.push(r));
    supRets.forEach(r => supplyReturns.push(r));

    // 겹침
    const v1Codes = new Set(v1Top3.map(s => s.stock_code));
    const supCodes = new Set(supplyTop3.map(s => s.stock_code));
    const overlap = [...v1Codes].filter(c => supCodes.has(c)).length;
    overlapTotal += overlap;

    const avgV1 = v1Rets.length ? v1Rets.reduce((a, b) => a + b, 0) / v1Rets.length : null;
    const avgSup = supRets.length ? supRets.reduce((a, b) => a + b, 0) / supRets.length : null;

    dailyComparison.push({
      date,
      v1Avg: avgV1,
      supAvg: avgSup,
      diff: (avgSup !== null && avgV1 !== null) ? avgSup - avgV1 : null,
      overlap,
      v1Top3: v1Top3.map(s => ({ name: s.stock_name, score: s.total_score, ret: returnMap[s.id], inst: s.institution_buy_days || 0, fgn: s.foreign_buy_days || 0 })),
      supTop3: supplyTop3.map(s => ({ name: s.stock_name, score: s.total_score, adjusted: s.adjusted, supply: s.supply, ret: returnMap[s.id], inst: s.institution_buy_days || 0, fgn: s.foreign_buy_days || 0 }))
    });
  }

  // 5. 결과 출력
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const winRate = arr => arr.length ? arr.filter(r => r > 0).length / arr.length * 100 : 0;
  const winCnt = arr => arr.filter(r => r > 0).length;

  console.log('\n' + '='.repeat(65));
  console.log('  전체 기간 백테스트: 기존 v1 TOP3 vs Supply 반영 TOP3');
  console.log('='.repeat(65));
  console.log('비교 일수:', comparedDays);

  console.log('\n[기존 v1 TOP3] (고래 + v1 총점 순)');
  console.log('  종목 수:', v1Returns.length);
  console.log('  평균 수익률:', avg(v1Returns).toFixed(2) + '%');
  console.log('  승률:', winRate(v1Returns).toFixed(1) + '% (' + winCnt(v1Returns) + '/' + v1Returns.length + ')');

  console.log('\n[변경안 TOP3] (고래 + v1총점+Supply 순)');
  console.log('  종목 수:', supplyReturns.length);
  console.log('  평균 수익률:', avg(supplyReturns).toFixed(2) + '%');
  console.log('  승률:', winRate(supplyReturns).toFixed(1) + '% (' + winCnt(supplyReturns) + '/' + supplyReturns.length + ')');

  console.log('\n[변화량]');
  const retDiff = avg(supplyReturns) - avg(v1Returns);
  const wrDiff = winRate(supplyReturns) - winRate(v1Returns);
  console.log('  수익률:', (retDiff >= 0 ? '+' : '') + retDiff.toFixed(2) + '%p');
  console.log('  승률:', (wrDiff >= 0 ? '+' : '') + wrDiff.toFixed(1) + '%p');
  console.log('  겹침률:', (overlapTotal / (comparedDays * 3) * 100).toFixed(1) + '%');

  // 6. 날짜별 비교표
  console.log('\n' + '='.repeat(65));
  console.log('  날짜별 비교');
  console.log('='.repeat(65));
  console.log('날짜         v1평균  Supply평균   차이   겹침');
  console.log('-'.repeat(55));

  let v1WinDays = 0, supWinDays = 0, tieDays = 0;
  dailyComparison.forEach(d => {
    if (d.v1Avg === null || d.supAvg === null) return;
    const diff = d.diff;
    if (diff > 0.1) supWinDays++;
    else if (diff < -0.1) v1WinDays++;
    else tieDays++;
    const marker = diff > 2 ? ' <<' : diff < -2 ? ' >>' : '';
    console.log(
      d.date.padEnd(13) +
      (d.v1Avg.toFixed(1) + '%').padStart(7) +
      (d.supAvg.toFixed(1) + '%').padStart(10) +
      ((diff >= 0 ? '+' : '') + diff.toFixed(1) + '%p').padStart(9) +
      ('  ' + d.overlap + '/3') +
      marker
    );
  });

  console.log('\n일별 승패: v1 우세 ' + v1WinDays + '일 | Supply 우세 ' + supWinDays + '일 | 동일 ' + tieDays + '일');

  // 7. 교체 종목 상세 (차이가 큰 날)
  console.log('\n' + '='.repeat(65));
  console.log('  교체로 인한 차이가 큰 날 상세');
  console.log('='.repeat(65));

  const bigDiffs = dailyComparison
    .filter(d => d.diff !== null && Math.abs(d.diff) > 1)
    .sort((a, b) => b.diff - a.diff);

  bigDiffs.slice(0, 10).forEach(d => {
    console.log('\n' + d.date + ' (차이: ' + (d.diff >= 0 ? '+' : '') + d.diff.toFixed(1) + '%p)');
    console.log('  v1 TOP3:');
    d.v1Top3.forEach(s => console.log('    ' + s.name.padEnd(12) + ' v1=' + String(s.score).padStart(3) + ' inst=' + s.inst + ' fgn=' + s.fgn + ' ret=' + (s.ret !== undefined ? s.ret.toFixed(1) + '%' : '?')));
    console.log('  Supply TOP3:');
    d.supTop3.forEach(s => console.log('    ' + s.name.padEnd(12) + ' adj=' + String(s.adjusted).padStart(3) + '(+' + s.supply + ') inst=' + s.inst + ' fgn=' + s.fgn + ' ret=' + (s.ret !== undefined ? s.ret.toFixed(1) + '%' : '?')));
  });
}

main().catch(e => console.error('Fatal:', e.message));
