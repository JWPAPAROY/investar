require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const V376_DATE = '2026-03-26';

function sortScoreFirst(a, b) {
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

function sortSupplyFirst(a, b) {
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

// 변형 A: v3.83 (현재) — tier1 우선 + 점수1차
function selectA(stocks) {
  const base = stocks.filter(s =>
    (s.whale_detected || (s.institution_buy_days || 0) >= 3 || (s.foreign_buy_days || 0) >= 3)
    && s.recommendation_grade !== '과열'
    && Math.abs(s.change_rate || 0) < 25
    && (s.disparity || 100) < 150
  );
  const top3 = [];
  const addFromPool = (pool) => {
    const ranges = [[50,59],[60,69],[80,89],[90,100],[70,79],[45,49]];
    for (const [lo, hi] of ranges) {
      const cands = pool.filter(s => s.total_score >= lo && s.total_score <= hi && !top3.some(t => t.stock_code === s.stock_code)).sort(sortScoreFirst);
      for (const s of cands) { if (top3.length >= 3) break; top3.push(s); }
    }
  };
  const mc = s => (s.market_cap || 0) / 100000000;
  addFromPool(base.filter(s => mc(s) <= 10000));
  if (top3.length < 3) addFromPool(base);
  return top3.slice(0, 3);
}

// 변형 B1: tier1 제거 (시총 무제한) + 점수1차
function selectB1(stocks) {
  const base = stocks.filter(s =>
    (s.whale_detected || (s.institution_buy_days || 0) >= 3 || (s.foreign_buy_days || 0) >= 3)
    && s.recommendation_grade !== '과열'
    && Math.abs(s.change_rate || 0) < 25
    && (s.disparity || 100) < 150
  );
  const top3 = [];
  const ranges = [[50,59],[60,69],[80,89],[90,100],[70,79],[45,49]];
  for (const [lo, hi] of ranges) {
    const cands = base.filter(s => s.total_score >= lo && s.total_score <= hi && !top3.some(t => t.stock_code === s.stock_code)).sort(sortScoreFirst);
    for (const s of cands) { if (top3.length >= 3) break; top3.push(s); }
  }
  return top3.slice(0, 3);
}

// 변형 B2: tier1 제거 + 점수 전체 내림차순 (구간 우선순위 무시)
function selectB2(stocks) {
  const base = stocks.filter(s =>
    (s.whale_detected || (s.institution_buy_days || 0) >= 3 || (s.foreign_buy_days || 0) >= 3)
    && s.recommendation_grade !== '과열'
    && Math.abs(s.change_rate || 0) < 25
    && (s.disparity || 100) < 150
    && s.total_score >= 45
  );
  return [...base].sort(sortScoreFirst).slice(0, 3);
}

// 변형 B3: tier1 우선순위 반전 — 전체 먼저 채우고 tier1은 fallback
function selectB3(stocks) {
  const base = stocks.filter(s =>
    (s.whale_detected || (s.institution_buy_days || 0) >= 3 || (s.foreign_buy_days || 0) >= 3)
    && s.recommendation_grade !== '과열'
    && Math.abs(s.change_rate || 0) < 25
    && (s.disparity || 100) < 150
  );
  const top3 = [];
  const addFromPool = (pool) => {
    const ranges = [[50,59],[60,69],[80,89],[90,100],[70,79],[45,49]];
    for (const [lo, hi] of ranges) {
      const cands = pool.filter(s => s.total_score >= lo && s.total_score <= hi && !top3.some(t => t.stock_code === s.stock_code)).sort(sortScoreFirst);
      for (const s of cands) { if (top3.length >= 3) break; top3.push(s); }
    }
  };
  addFromPool(base);
  return top3.slice(0, 3);
}

// 실제 저장된 TOP3 (is_top3=true를 수급1차로 정렬)
function selectActual(stocks) {
  return [...stocks].filter(s => s.is_top3).sort(sortSupplyFirst).slice(0, 3);
}

(async () => {
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

  const byDate = {};
  pool.forEach(s => { (byDate[s.recommendation_date] = byDate[s.recommendation_date] || []).push(s); });
  const dates = Object.keys(byDate).sort();
  console.log(`POST ${pool.length}건, ${dates.length}일 (${dates[0]} ~ ${dates[dates.length-1]})`);

  const ids = pool.map(s => s.id);
  let prices = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('recommendation_daily_prices')
      .select('recommendation_id,days_since_recommendation,cumulative_return')
      .in('recommendation_id', ids.slice(i, i + 100)).gte('days_since_recommendation', 1).lte('days_since_recommendation', 15);
    if (data) prices = prices.concat(data);
  }
  const priceMap = {};
  prices.forEach(p => { (priceMap[p.recommendation_id] = priceMap[p.recommendation_id] || {})[p.days_since_recommendation] = p.cumulative_return; });

  const variants = {
    '실제 (v3.76 수급1차+tier1우선)':                           selectActual,
    'A: v3.83 현재 (tier1우선+점수1차)':                        selectA,
    'B1: tier1 제거 + 점수1차 + 구간우선순위':                   selectB1,
    'B2: tier1 제거 + 전체 점수내림차순 (구간무시)':             selectB2,
    'B3: 전체풀 우선 (tier1 우선순위 제거, 구간우선순위 유지)':   selectB3,
  };

  const buckets = {};
  Object.keys(variants).forEach(k => buckets[k] = { 1: [], 2: [], 3: [] });

  const collect = (bucket, rank, s) => {
    const p = priceMap[s.id]; if (!p) return;
    const days = Object.keys(p).map(Number).filter(d => d >= 1 && d <= 15);
    if (days.length === 0) return;
    let maxR = -Infinity, maxD = 0;
    days.forEach(d => { if (p[d] > maxR) { maxR = p[d]; maxD = d; } });
    const lastD = Math.max(...days);
    bucket[rank].push({ name: s.stock_name, date: s.recommendation_date, score: s.total_score, maxReturn: maxR, maxDay: maxD, lastReturn: p[lastD], lastDay: lastD });
  };

  dates.forEach(date => {
    const stocks = byDate[date];
    Object.keys(variants).forEach(k => {
      const selected = variants[k](stocks);
      selected.forEach((s, i) => collect(buckets[k], i + 1, s));
    });
  });

  const fmt = (stats) => {
    const n = stats.length;
    if (n === 0) return 'N=0';
    const avgL = stats.reduce((a, r) => a + r.lastReturn, 0) / n;
    const avgM = stats.reduce((a, r) => a + r.maxReturn, 0) / n;
    const winL = stats.filter(r => r.lastReturn > 0).length;
    const g10 = stats.filter(r => r.maxReturn >= 10).length;
    const loss5 = stats.filter(r => r.lastReturn <= -5).length;
    return `N=${String(n).padStart(3)} | 최종 ${(avgL >= 0 ? '+' : '') + avgL.toFixed(2).padStart(6)}% | 최고 ${(avgM >= 0 ? '+' : '') + avgM.toFixed(2).padStart(6)}% | 승률 ${String(Math.round(winL/n*100)).padStart(3)}% | +10% ${String(Math.round(g10/n*100)).padStart(3)}% | -5% ${String(Math.round(loss5/n*100)).padStart(3)}%`;
  };

  console.log('\n=====================================================================');
  console.log('   변형별 TOP1/2/3 성과 비교');
  console.log('=====================================================================');
  Object.keys(variants).forEach(k => {
    console.log(`\n### ${k}`);
    [1, 2, 3].forEach(r => console.log(`  TOP${r}: ${fmt(buckets[k][r])}`));
    const all = [...buckets[k][1], ...buckets[k][2], ...buckets[k][3]];
    console.log(`  합산 : ${fmt(all)}`);
  });

  // 금메달 요약만
  console.log('\n\n===== 💎 금메달(TOP1) 랭킹 =====');
  const goldRank = Object.keys(variants).map(k => {
    const s = buckets[k][1]; const n = s.length;
    const avg = n ? s.reduce((a, r) => a + r.lastReturn, 0) / n : 0;
    const win = n ? s.filter(r => r.lastReturn > 0).length / n * 100 : 0;
    return { k, n, avg, win };
  }).sort((a, b) => b.avg - a.avg);
  goldRank.forEach((r, i) => {
    console.log(`  ${i+1}위  ${r.k.padEnd(48)} 최종 ${(r.avg >= 0 ? '+' : '') + r.avg.toFixed(2)}%  승률 ${r.win.toFixed(0)}% (N=${r.n})`);
  });

  // 금메달 날짜별 비교 (B3 vs 실제)
  console.log('\n\n===== 날짜별 금메달: 실제 vs 승자 변형 =====');
  const winner = goldRank[0].k;
  console.log(`(승자: ${winner})\n`);
  dates.forEach(date => {
    const stocks = byDate[date];
    const act = selectActual(stocks)[0];
    const win = variants[winner](stocks)[0];
    const same = act && win && act.stock_code === win.stock_code;
    const marker = same ? '  ' : '★ ';
    const aRet = act && priceMap[act.id] ? (() => { const p = priceMap[act.id]; const d = Object.keys(p).map(Number); if(!d.length) return ''; return `${(p[Math.max(...d)] >= 0 ? '+' : '') + p[Math.max(...d)].toFixed(1)}%`; })() : '';
    const wRet = win && priceMap[win.id] ? (() => { const p = priceMap[win.id]; const d = Object.keys(p).map(Number); if(!d.length) return ''; return `${(p[Math.max(...d)] >= 0 ? '+' : '') + p[Math.max(...d)].toFixed(1)}%`; })() : '';
    const aStr = act ? `${act.stock_name}(${act.total_score})` : '-';
    const wStr = win ? `${win.stock_name}(${win.total_score})` : '-';
    console.log(`${marker}${date} | 실제: ${aStr.padEnd(22)} ${aRet.padEnd(8)} | ${winner.split(':')[0]}: ${wStr.padEnd(22)} ${wRet}`);
  });
})();
