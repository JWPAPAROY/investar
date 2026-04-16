require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const V376_DATE = '2026-03-26'; // v3.76 배포일 (POST 기간 시작)

// ===== 정렬 로직 3종 =====
// v3.83 신규: 점수 1차 → 수급 tiebreak
function sortV383(a, b) {
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
}

// v3.76: 수급 1차 → 점수 2차
function sortV376(a, b) {
  const rank = (s) => {
    const inst = s.institution_buy_days || 0, frgn = s.foreign_buy_days || 0;
    if (frgn >= 2 && inst < 2) return 5;
    if (inst >= 2 && frgn >= 2) return 4;
    if (inst >= 2) return 3;
    if (frgn >= 1) return 2;
    return 1;
  };
  const rd = rank(b) - rank(a);
  if (rd !== 0) return rd;
  return (b.total_score || 0) - (a.total_score || 0);
}

// ===== production TOP3 선별 로직 재현 =====
function selectTop3(stocks, sortFn) {
  // 필터: 수급 조건 + 비과열 + |change_rate|<25 + disparity<150
  const baseEligible = stocks.filter(s => {
    const hasSupply = s.whale_detected || (s.institution_buy_days || 0) >= 3 || (s.foreign_buy_days || 0) >= 3;
    return hasSupply
      && s.recommendation_grade !== '과열'
      && Math.abs(s.change_rate || 0) < 25
      && (s.disparity || 100) < 150;
  });

  const top3 = [];
  const addFromPool = (pool) => {
    const addFromRange = (lo, hi) => {
      const cands = pool
        .filter(s => s.total_score >= lo && s.total_score <= hi && !top3.some(t => t.stock_code === s.stock_code))
        .sort(sortFn);
      for (const s of cands) { if (top3.length >= 3) break; top3.push(s); }
    };
    addFromRange(50, 59);
    addFromRange(60, 69);
    addFromRange(80, 89);
    addFromRange(90, 100);
    addFromRange(70, 79);
    addFromRange(45, 49);
  };

  const mcCap = s => (s.market_cap || 0) / 100000000;
  const tier1 = baseEligible.filter(s => mcCap(s) <= 10000);
  addFromPool(tier1);
  if (top3.length < 3) addFromPool(baseEligible);

  return top3.slice(0, 3);
}

// ===== 메인 =====
(async () => {
  // 전체 B등급+ 저장 풀 조회 (POST 기간)
  let pool = [], from = 0;
  while (true) {
    const { data } = await supabase.from('screening_recommendations')
      .select('id,stock_code,stock_name,recommendation_date,total_score,recommendation_grade,whale_detected,institution_buy_days,foreign_buy_days,change_rate,disparity,market_cap,is_top3')
      .gte('recommendation_date', V376_DATE)
      .order('recommendation_date', { ascending: false })
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    pool = pool.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`POST 기간 저장 풀: ${pool.length}건`);

  const byDate = {};
  pool.forEach(s => { (byDate[s.recommendation_date] = byDate[s.recommendation_date] || []).push(s); });
  const dates = Object.keys(byDate).sort();
  console.log(`추천일: ${dates.length}일  (${dates[0]} ~ ${dates[dates.length-1]})`);

  // 가격 배치 조회
  const ids = pool.map(s => s.id);
  let prices = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('recommendation_daily_prices')
      .select('recommendation_id,days_since_recommendation,cumulative_return')
      .in('recommendation_id', ids.slice(i, i + 100))
      .gte('days_since_recommendation', 1)
      .lte('days_since_recommendation', 15);
    if (data) prices = prices.concat(data);
  }
  const priceMap = {};
  prices.forEach(p => {
    (priceMap[p.recommendation_id] = priceMap[p.recommendation_id] || {})[p.days_since_recommendation] = p.cumulative_return;
  });

  // 실제 저장된 TOP3 정렬: 저장 시점에 쓰였던 sortV376 순서 추정
  const selectActual = (stocks) => [...stocks].filter(s => s.is_top3).sort(sortV376).slice(0, 3);

  // 세 전략으로 TOP3 선정 및 성과 수집
  const scenarios = {
    '실제 v3.76~v3.82 (수급1차)': { 1: [], 2: [], 3: [] },
    '백테스트 v3.83 (점수1차+tiebreak)': { 1: [], 2: [], 3: [] },
    '참고: 수급1차 재선별': { 1: [], 2: [], 3: [] },
  };

  const collect = (bucket, rank, s) => {
    const p = priceMap[s.id];
    if (!p) return;
    const days = Object.keys(p).map(Number).filter(d => d >= 1 && d <= 15);
    if (days.length === 0) return;
    let maxR = -Infinity, maxD = 0;
    days.forEach(d => { if (p[d] > maxR) { maxR = p[d]; maxD = d; } });
    const lastD = Math.max(...days);
    bucket[rank].push({
      name: s.stock_name, date: s.recommendation_date, score: s.total_score,
      inst: s.institution_buy_days, frgn: s.foreign_buy_days,
      maxReturn: maxR, maxDay: maxD, lastReturn: p[lastD], lastDay: lastD
    });
  };

  dates.forEach(date => {
    const stocks = byDate[date];

    // 실제 (저장된 is_top3를 수급1차 순)
    const actual = selectActual(stocks);
    actual.forEach((s, i) => collect(scenarios['실제 v3.76~v3.82 (수급1차)'], i + 1, s));

    // 백테스트 v3.83: 전체 풀에서 새 로직으로 재선별
    const v383 = selectTop3(stocks, sortV383);
    v383.forEach((s, i) => collect(scenarios['백테스트 v3.83 (점수1차+tiebreak)'], i + 1, s));

    // 참고: 전체 풀에서 수급1차로 재선별
    const v376re = selectTop3(stocks, sortV376);
    v376re.forEach((s, i) => collect(scenarios['참고: 수급1차 재선별'], i + 1, s));
  });

  // 요약
  const summarize = (stats) => {
    const n = stats.length;
    if (n === 0) return 'N=0';
    const avgL = stats.reduce((a, r) => a + r.lastReturn, 0) / n;
    const avgM = stats.reduce((a, r) => a + r.maxReturn, 0) / n;
    const winL = stats.filter(r => r.lastReturn > 0).length;
    const g10 = stats.filter(r => r.maxReturn >= 10).length;
    const loss5 = stats.filter(r => r.lastReturn <= -5).length;
    return `N=${String(n).padStart(3)} | 최종 ${avgL >= 0 ? '+' : ''}${avgL.toFixed(2).padStart(6)}% | 최고 ${avgM >= 0 ? '+' : ''}${avgM.toFixed(2).padStart(6)}% | 승률 ${String(Math.round(winL/n*100)).padStart(3)}% | +10% ${String(Math.round(g10/n*100)).padStart(3)}% | -5% ${String(Math.round(loss5/n*100)).padStart(3)}%`;
  };

  console.log('\n====================================================================================');
  console.log('   v3.83 백테스트 (POST 기간 ' + dates[0] + ' ~ ' + dates[dates.length-1] + ')');
  console.log('====================================================================================');
  Object.keys(scenarios).forEach(label => {
    console.log(`\n### ${label}`);
    [1, 2, 3].forEach(r => console.log(`  TOP${r}: ${summarize(scenarios[label][r])}`));
    // 전체(TOP1+2+3 합산)
    const all = [...scenarios[label][1], ...scenarios[label][2], ...scenarios[label][3]];
    console.log(`  합산: ${summarize(all)}`);
  });

  // 날짜별 금메달 변화 확인 (v3.83 vs 실제)
  console.log('\n\n========== 날짜별 금메달 비교 (실제 → v3.83 백테스트) ==========');
  dates.forEach(date => {
    const stocks = byDate[date];
    const actualT1 = selectActual(stocks)[0];
    const v383T1 = selectTop3(stocks, sortV383)[0];
    const same = actualT1 && v383T1 && actualT1.stock_code === v383T1.stock_code;
    const aLine = actualT1 ? `${actualT1.stock_name}(${actualT1.total_score}, 기${actualT1.institution_buy_days||0}외${actualT1.foreign_buy_days||0})` : '없음';
    const bLine = v383T1 ? `${v383T1.stock_name}(${v383T1.total_score}, 기${v383T1.institution_buy_days||0}외${v383T1.foreign_buy_days||0})` : '없음';
    const aRet = actualT1 && priceMap[actualT1.id] ? (() => {
      const p = priceMap[actualT1.id]; const days = Object.keys(p).map(Number); if (days.length === 0) return '';
      const ld = Math.max(...days); return `최종 ${p[ld] >= 0 ? '+' : ''}${p[ld].toFixed(1)}%`;
    })() : '';
    const bRet = v383T1 && priceMap[v383T1.id] ? (() => {
      const p = priceMap[v383T1.id]; const days = Object.keys(p).map(Number); if (days.length === 0) return '';
      const ld = Math.max(...days); return `최종 ${p[ld] >= 0 ? '+' : ''}${p[ld].toFixed(1)}%`;
    })() : '';
    const marker = same ? '  ' : '★ ';
    console.log(`${marker}${date} | 실제: ${aLine.padEnd(40)} ${aRet.padEnd(14)} | v3.83: ${bLine} ${bRet}`);
  });
})();
