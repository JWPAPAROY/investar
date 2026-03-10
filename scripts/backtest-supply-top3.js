/**
 * v1 + Supply(0-15) 변경안 백테스트
 * 기존 TOP3 vs Supply 반영 TOP3 수익률 비교
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
  // 1. 전체 추천 데이터
  const { data: recs, error } = await supabase
    .from('screening_recommendations')
    .select('id, stock_code, stock_name, recommendation_date, total_score, institution_buy_days, foreign_buy_days, whale_detected, is_top3, recommendation_grade')
    .gte('recommendation_date', '2025-01-01')
    .order('recommendation_date', { ascending: false });

  if (error) { console.error(error); return; }
  console.log('Total recs:', recs.length);

  // 2. 수익률 데이터 (각 추천의 최신 cumulative_return)
  const { data: prices, error: e2 } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id, tracking_date, cumulative_return, days_since_recommendation')
    .order('tracking_date', { ascending: false });

  if (e2) { console.error(e2); return; }
  console.log('Price records:', prices.length);

  // 각 추천별 최신 수익률
  const returnMap = {};
  prices.forEach(p => {
    if (!returnMap[p.recommendation_id]) {
      returnMap[p.recommendation_id] = {
        ret: p.cumulative_return,
        days: p.days_since_recommendation
      };
    }
  });

  const getReturn = (id) => {
    const r = returnMap[id];
    return r ? r.ret : null;
  };

  // 3. 날짜별 그룹핑
  const byDate = {};
  recs.forEach(r => {
    if (!byDate[r.recommendation_date]) byDate[r.recommendation_date] = [];
    byDate[r.recommendation_date].push(r);
  });

  const dates = Object.keys(byDate).sort();
  console.log('Dates:', dates.length, '(' + dates[0] + ' ~ ' + dates[dates.length - 1] + ')');

  // 4. 날짜별 비교
  let oldReturns = [], newReturns = [];
  let totalOverlap = 0, totalDays = 0;
  const swapDetails = [];

  for (const date of dates) {
    const stocks = byDate[date];
    const oldTop3 = stocks.filter(s => s.is_top3);
    if (oldTop3.length === 0) continue;

    // 변경안 TOP3
    const ranked = stocks
      .filter(s => s.whale_detected && s.recommendation_grade !== '과열')
      .map(s => {
        const inst = s.institution_buy_days || 0;
        const fgn = s.foreign_buy_days || 0;
        const supply = calcSupplyBonus(inst, fgn);
        return { ...s, supply, adjusted: s.total_score + supply };
      })
      .sort((a, b) => b.adjusted - a.adjusted);
    const newTop3 = ranked.slice(0, 3);

    totalDays++;
    const oldCodes = new Set(oldTop3.map(s => s.stock_code));
    const newCodes = new Set(newTop3.map(s => s.stock_code));
    const overlap = [...oldCodes].filter(c => newCodes.has(c)).length;
    totalOverlap += overlap;

    // 수익률 수집
    oldTop3.forEach(s => {
      const ret = getReturn(s.id);
      if (ret !== null) oldReturns.push({ date, name: s.stock_name, ret, inst: s.institution_buy_days || 0, fgn: s.foreign_buy_days || 0 });
    });
    newTop3.forEach(s => {
      const ret = getReturn(s.id);
      if (ret !== null) newReturns.push({ date, name: s.stock_name, ret, supply: s.supply, adjusted: s.adjusted, inst: s.institution_buy_days || 0, fgn: s.foreign_buy_days || 0 });
    });

    // 교체 상세
    const dropped = oldTop3.filter(s => !newCodes.has(s.stock_code));
    const added = newTop3.filter(s => !oldCodes.has(s.stock_code));
    if (dropped.length > 0 || added.length > 0) {
      swapDetails.push({ date, dropped, added, returnMap: returnMap });
    }
  }

  // 5. 결과 출력
  const avg = arr => arr.length ? arr.reduce((s, r) => s + r.ret, 0) / arr.length : 0;
  const winRate = arr => arr.length ? arr.filter(r => r.ret > 0).length / arr.length * 100 : 0;
  const winCount = arr => arr.filter(r => r.ret > 0).length;
  const lossAvg = arr => { const l = arr.filter(r => r.ret <= 0); return l.length ? l.reduce((s,r) => s + r.ret, 0) / l.length : 0; };
  const gainAvg = arr => { const g = arr.filter(r => r.ret > 0); return g.length ? g.reduce((s,r) => s + r.ret, 0) / g.length : 0; };

  console.log('\n' + '='.repeat(60));
  console.log('  기존 TOP3 vs 변경안(v1+Supply) TOP3 백테스트');
  console.log('='.repeat(60));
  console.log('비교 일수:', totalDays, '일');
  console.log('수익률 기준: 추천일 대비 3일차 종가\n');

  console.log('[기존 TOP3]');
  console.log('  종목 수:', oldReturns.length);
  console.log('  평균 수익률:', avg(oldReturns).toFixed(2) + '%');
  console.log('  승률:', winRate(oldReturns).toFixed(1) + '% (' + winCount(oldReturns) + '/' + oldReturns.length + ')');
  console.log('  수익 평균:', gainAvg(oldReturns).toFixed(2) + '% | 손실 평균:', lossAvg(oldReturns).toFixed(2) + '%');

  console.log('\n[변경안 TOP3] (v1 + Supply 0-15)');
  console.log('  종목 수:', newReturns.length);
  console.log('  평균 수익률:', avg(newReturns).toFixed(2) + '%');
  console.log('  승률:', winRate(newReturns).toFixed(1) + '% (' + winCount(newReturns) + '/' + newReturns.length + ')');
  console.log('  수익 평균:', gainAvg(newReturns).toFixed(2) + '% | 손실 평균:', lossAvg(newReturns).toFixed(2) + '%');

  console.log('\n[변화량]');
  console.log('  수익률:', (avg(newReturns) - avg(oldReturns) >= 0 ? '+' : '') + (avg(newReturns) - avg(oldReturns)).toFixed(2) + '%p');
  console.log('  승률:', (winRate(newReturns) - winRate(oldReturns) >= 0 ? '+' : '') + (winRate(newReturns) - winRate(oldReturns)).toFixed(1) + '%p');
  console.log('  TOP3 겹침률:', (totalOverlap / (totalDays * 3) * 100).toFixed(1) + '%');

  // 6. 교체 종목 상세 (최근 10건)
  console.log('\n' + '='.repeat(60));
  console.log('  종목 교체 상세 (교체 발생일)');
  console.log('='.repeat(60));

  swapDetails.slice(-15).forEach(({ date, dropped, added }) => {
    console.log('\n' + date + ':');
    dropped.forEach(s => {
      const ret = getReturn(s.id);
      console.log('  OUT ' + s.stock_name.padEnd(12) + ' v1=' + String(s.total_score).padStart(3) + ' inst=' + (s.institution_buy_days||0) + ' fgn=' + (s.foreign_buy_days||0) + ' → ret=' + (ret !== null ? ret.toFixed(1) + '%' : '?'));
    });
    added.forEach(s => {
      const ret = getReturn(s.id);
      console.log('  IN  ' + s.stock_name.padEnd(12) + ' v1=' + String(s.total_score).padStart(3) + ' +supply=' + String(s.supply).padStart(2) + ' adj=' + String(s.adjusted).padStart(3) + ' inst=' + (s.institution_buy_days||0) + ' fgn=' + (s.foreign_buy_days||0) + ' → ret=' + (ret !== null ? ret.toFixed(1) + '%' : '?'));
    });
  });

  // 7. 날짜별 수익률 비교
  console.log('\n' + '='.repeat(60));
  console.log('  날짜별 TOP3 평균 수익률 비교');
  console.log('='.repeat(60));
  console.log('날짜'.padEnd(12) + '기존TOP3'.padStart(10) + '변경안TOP3'.padStart(10) + '차이'.padStart(8));
  console.log('-'.repeat(42));

  for (const date of dates) {
    const oldD = oldReturns.filter(r => r.date === date);
    const newD = newReturns.filter(r => r.date === date);
    if (oldD.length === 0 && newD.length === 0) continue;
    const avgO = oldD.length ? avg(oldD) : 0;
    const avgN = newD.length ? avg(newD) : 0;
    const diff = avgN - avgO;
    const marker = diff > 2 ? ' ✦' : diff < -2 ? ' ✧' : '';
    console.log(date.padEnd(12) + (avgO.toFixed(1) + '%').padStart(10) + (avgN.toFixed(1) + '%').padStart(10) + ((diff >= 0 ? '+' : '') + diff.toFixed(1) + '%p').padStart(8) + marker);
  }
}

main().catch(e => console.error('Fatal:', e.message));
