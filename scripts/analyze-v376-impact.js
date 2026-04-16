require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// v3.76 배포일 (2026-03-26). 이 날짜 이후 저장된 TOP3는 '수급 1차' 정렬, 이전은 '점수 1차' 정렬.
const V376_DATE = '2026-03-26';

// v3.76 이후 production 정렬 (수급 1차 → 점수 2차)
function supplyFirstSort(a, b) {
  const rank = (s) => {
    const inst = s.institution_buy_days || 0;
    const frgn = s.foreign_buy_days || 0;
    if (frgn >= 2 && inst < 2) return 5;
    if (inst >= 2 && frgn >= 2) return 4;
    if (inst >= 2) return 3;
    if (frgn >= 1) return 2;
    return 1;
  };
  const diff = rank(b) - rank(a);
  if (diff !== 0) return diff;
  return (b.total_score || 0) - (a.total_score || 0);
}

// v3.76 이전 production 정렬 (점수 1차 → 수급 tiebreak)
function scoreFirstSort(a, b) {
  if ((b.total_score || 0) !== (a.total_score || 0)) return (b.total_score || 0) - (a.total_score || 0);
  const rank = (s) => {
    const inst = s.institution_buy_days || 0;
    const frgn = s.foreign_buy_days || 0;
    if (inst >= 2 && frgn >= 2) return 4;
    if (inst >= 3) return 3;
    if (frgn >= 3) return 2;
    return 1;
  };
  return rank(b) - rank(a);
}

function summarize(label, stats) {
  if (stats.length === 0) { console.log(`\n--- ${label} (N=0) ---`); return; }
  const n = stats.length;
  const avgMax = stats.reduce((s, r) => s + r.maxReturn, 0) / n;
  const avgLast = stats.reduce((s, r) => s + r.lastReturn, 0) / n;
  const winMax = stats.filter(r => r.maxReturn > 0).length;
  const winLast = stats.filter(r => r.lastReturn > 0).length;
  const gain10 = stats.filter(r => r.maxReturn >= 10).length;
  const loss5 = stats.filter(r => r.lastReturn <= -5).length;
  const sortedMax = [...stats.map(r => r.maxReturn)].sort((a, b) => a - b);
  const medMax = sortedMax[Math.floor(n / 2)];
  const sortedLast = [...stats.map(r => r.lastReturn)].sort((a, b) => a - b);
  const medLast = sortedLast[Math.floor(n / 2)];
  console.log(`\n--- ${label} (N=${n}) ---`);
  console.log(`  최고수익  평균 ${avgMax >= 0 ? '+' : ''}${avgMax.toFixed(2)}%  중앙값 ${medMax >= 0 ? '+' : ''}${medMax.toFixed(2)}%`);
  console.log(`  최종수익  평균 ${avgLast >= 0 ? '+' : ''}${avgLast.toFixed(2)}%  중앙값 ${medLast >= 0 ? '+' : ''}${medLast.toFixed(2)}%`);
  console.log(`  최종 승률 ${(winLast/n*100).toFixed(0)}% (${winLast}/${n})   최고 승률 ${(winMax/n*100).toFixed(0)}%`);
  console.log(`  +10% 도달 ${(gain10/n*100).toFixed(0)}%   -5% 손실 ${(loss5/n*100).toFixed(0)}%`);
}

(async () => {
  // is_top3 종목 전체 조회
  let allTop3 = [], from = 0;
  while (true) {
    const { data } = await supabase.from('screening_recommendations')
      .select('id,stock_code,stock_name,recommendation_date,total_score,recommendation_grade,institution_buy_days,foreign_buy_days,whale_detected,is_top3')
      .eq('is_top3', true)
      .order('recommendation_date', { ascending: false })
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allTop3 = allTop3.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`총 is_top3 레코드: ${allTop3.length}`);

  // 날짜별 그룹핑
  const byDate = {};
  allTop3.forEach(s => {
    (byDate[s.recommendation_date] = byDate[s.recommendation_date] || []).push(s);
  });
  const dates = Object.keys(byDate).sort();
  console.log(`추천일 수: ${dates.length}  (기간: ${dates[0]} ~ ${dates[dates.length-1]})`);

  // 가격 배치 조회
  const ids = allTop3.map(r => r.id);
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

  // 각 날짜 → 두 정렬 방식으로 각각 1/2/3 매기고 성과 수집
  // period: pre (~v3.76 전) vs post (v3.76 이후 실제)
  // 추가로 post 기간에서 "가상: 점수1차였다면" 시뮬레이션
  const buckets = {
    'PRE_실제(점수1차)':  { 1: [], 2: [], 3: [] },
    'POST_실제(수급1차)': { 1: [], 2: [], 3: [] },
    'POST_가상(점수1차 유지 시)': { 1: [], 2: [], 3: [] },
  };

  const collect = (bucket, rank, s) => {
    const p = priceMap[s.id];
    if (!p) return;
    const days = Object.keys(p).map(Number).filter(d => d >= 1 && d <= 15);
    if (days.length === 0) return;
    let maxRet = -Infinity, maxDay = 0;
    days.forEach(d => { if (p[d] > maxRet) { maxRet = p[d]; maxDay = d; } });
    const lastDay = Math.max(...days);
    bucket[rank].push({
      name: s.stock_name, date: s.recommendation_date, score: s.total_score,
      maxReturn: maxRet, maxDay, lastReturn: p[lastDay], lastDay
    });
  };

  dates.forEach(date => {
    const stocks = byDate[date];
    if (stocks.length < 1) return;
    const isPost = date >= V376_DATE;

    // 실제 production 정렬
    const actualSorted = [...stocks].sort(isPost ? supplyFirstSort : scoreFirstSort);
    const actualBucket = isPost ? buckets['POST_실제(수급1차)'] : buckets['PRE_실제(점수1차)'];
    actualSorted.slice(0, 3).forEach((s, i) => collect(actualBucket, i + 1, s));

    // post 기간에만 가상 시뮬레이션 (점수1차였다면)
    if (isPost) {
      const virtSorted = [...stocks].sort(scoreFirstSort);
      virtSorted.slice(0, 3).forEach((s, i) => collect(buckets['POST_가상(점수1차 유지 시)'], i + 1, s));
    }
  });

  console.log('\n=============================================================');
  console.log('          v3.76 전후 TOP1/2/3 성과 비교');
  console.log(`          (기준일: ${V376_DATE} — 이 날짜부터 수급 1차 정렬)`);
  console.log('=============================================================');

  Object.keys(buckets).forEach(label => {
    console.log(`\n\n########## ${label} ##########`);
    [1, 2, 3].forEach(r => summarize(`TOP${r}`, buckets[label][r]));
  });

  // 핵심 비교: 금메달 성과만 나란히
  console.log('\n\n=============================================================');
  console.log('          💎 금메달(TOP1) 성과 요약');
  console.log('=============================================================');
  const gold = {
    'PRE 실제 (점수1차)':  buckets['PRE_실제(점수1차)'][1],
    'POST 실제 (수급1차)': buckets['POST_실제(수급1차)'][1],
    'POST 가상 (점수1차)': buckets['POST_가상(점수1차 유지 시)'][1],
  };
  Object.keys(gold).forEach(k => {
    const s = gold[k];
    if (s.length === 0) { console.log(`${k.padEnd(24)} N=0`); return; }
    const n = s.length;
    const avgL = s.reduce((a, r) => a + r.lastReturn, 0) / n;
    const winL = s.filter(r => r.lastReturn > 0).length;
    console.log(`${k.padEnd(24)} N=${n.toString().padStart(3)}  최종평균 ${avgL >= 0 ? '+' : ''}${avgL.toFixed(2).padStart(6)}%  승률 ${(winL/n*100).toFixed(0).padStart(3)}%`);
  });

  // POST 기간 금메달 상세 (최근 20건)
  console.log('\n\n=============================================================');
  console.log('          POST 기간 금메달 상세 (최근 20건, 실제 수급1차 기준)');
  console.log('=============================================================');
  const recent = [...buckets['POST_실제(수급1차)'][1]].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  recent.forEach(r => {
    const icon = r.lastReturn >= 0 ? 'O' : 'X';
    console.log(`  ${r.date} | ${(r.name || '').padEnd(12)} | 점수 ${String(r.score).padStart(3)} | 최고 +${r.maxReturn.toFixed(1)}%(d${r.maxDay}) | 최종 ${r.lastReturn >= 0 ? '+' : ''}${r.lastReturn.toFixed(1)}%(d${r.lastDay}) ${icon}`);
  });
})();
