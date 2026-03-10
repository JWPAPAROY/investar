/**
 * 고래 필터 영향 분석 스크립트
 *
 * TOP3 선별 시 매수고래(whale_detected) 조건 완화 여부 평가
 *
 * 시뮬레이션 옵션:
 *   Current: whale_detected = true 필수
 *   Option A: whale_detected OR whale_confirmed (동일 효과)
 *   Option B: 고래 조건 완전 제거 (score + 비과열 + disparity<150 + changeRate<25만)
 *   Option C: whale_detected OR volume_ratio >= 1.5 (볼륨 기준 완화)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── TOP3 선별 로직 (whale 조건 주입) ──
function simulateTop3(stocks, whaleFilter) {
  // whaleFilter: function(stock) => boolean - 고래 자격 조건
  const eligible = stocks.filter(s => {
    return (
      whaleFilter(s) &&
      s.recommendation_grade !== '과열' &&
      Math.abs(s.change_rate || 0) < 25 &&
      (s.disparity || 100) < 150
    );
  });

  const top3 = [];
  const addFromRange = (lo, hi) => {
    const pool = eligible
      .filter(s => s.total_score >= lo && s.total_score <= hi && !top3.some(t => t.stock_code === s.stock_code))
      .sort((a, b) => b.total_score - a.total_score);
    for (const s of pool) {
      if (top3.length >= 3) break;
      top3.push(s);
    }
  };

  addFromRange(50, 69);   // 1순위: 스윗스팟
  addFromRange(80, 89);   // 2순위
  addFromRange(90, 100);  // 3순위
  addFromRange(70, 79);   // 4순위: 최후 보충

  return top3;
}

// ── 수익률 계산 ──
function calcReturns(rec, priceMap) {
  const prices = priceMap.get(rec.id) || [];
  if (prices.length === 0) return null;

  const basePrice = rec.recommended_price;
  if (!basePrice || basePrice <= 0) return null;

  const returns = prices.map(p => ((p.closing_price - basePrice) / basePrice) * 100);
  const maxReturn = Math.max(...returns);
  const day3Return = returns.length >= 3 ? returns[2] : returns[returns.length - 1];
  const lastReturn = returns[returns.length - 1];
  const minReturn = Math.min(...returns);

  return { maxReturn, day3Return, lastReturn, minReturn, trackDays: prices.length };
}

// ── 통계 헬퍼 ──
function calcStats(items) {
  if (items.length === 0) return null;
  const n = items.length;
  const wins5 = items.filter(d => d.maxReturn >= 5).length;
  const wins3 = items.filter(d => d.maxReturn >= 3).length;
  const wins0 = items.filter(d => d.maxReturn >= 0).length;
  const avgMax = items.reduce((s, d) => s + d.maxReturn, 0) / n;
  const avgD3 = items.reduce((s, d) => s + d.day3Return, 0) / n;
  const avgLast = items.reduce((s, d) => s + d.lastReturn, 0) / n;
  const medMax = items.map(d => d.maxReturn).sort((a, b) => a - b)[Math.floor(n / 2)];
  const avgMin = items.reduce((s, d) => s + d.minReturn, 0) / n;
  return {
    count: n,
    winRate5: (wins5 / n * 100),
    winRate3: (wins3 / n * 100),
    winRate0: (wins0 / n * 100),
    avgMax, avgD3, avgLast, medMax, avgMin,
  };
}

function fmtPct(v, sign = true) {
  if (v == null || isNaN(v)) return 'N/A';
  const s = sign && v >= 0 ? '+' : '';
  return s + v.toFixed(2) + '%';
}

// ── Whale filter functions for each option ──
const WHALE_OPTIONS = {
  current: {
    label: 'Current: whale_detected required',
    filter: s => s.whale_detected === true,
  },
  optionA: {
    label: 'Option A: whale_detected OR whale_confirmed',
    filter: s => s.whale_detected === true || s.whale_confirmed === true,
  },
  optionB: {
    label: 'Option B: NO whale requirement (score-only)',
    filter: s => true,  // no whale filter
  },
  optionC: {
    label: 'Option C: whale_detected OR volume_ratio >= 1.5',
    filter: s => s.whale_detected === true || (s.volume_ratio || 0) >= 1.5,
  },
};

async function main() {
  console.log('='.repeat(90));
  console.log('  WHALE FILTER IMPACT ANALYSIS');
  console.log('  Should TOP3 whale_detected requirement be relaxed?');
  console.log('='.repeat(90));

  // ══════════════════════════════════════════════════════════════
  // 1. 전체 추천 데이터 조회 (페이지네이션)
  // ══════════════════════════════════════════════════════════════
  let allRecs = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('screening_recommendations')
      .select('*')
      .eq('is_active', true)
      .order('recommendation_date', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) { console.error('DB error:', error.message); return; }
    if (!data || data.length === 0) break;
    allRecs.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  console.log(`\nTotal recommendations loaded: ${allRecs.length}`);

  // ══════════════════════════════════════════════════════════════
  // 2. 일별 가격 데이터 조회 (배치)
  // ══════════════════════════════════════════════════════════════
  const recIds = allRecs.map(r => r.id);
  let allPrices = [];
  const BATCH = 300;
  for (let b = 0; b < recIds.length; b += BATCH) {
    const batchIds = recIds.slice(b, b + BATCH);
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('recommendation_daily_prices')
        .select('recommendation_id, tracking_date, closing_price')
        .in('recommendation_id', batchIds)
        .order('tracking_date', { ascending: true })
        .range(offset, offset + 999);
      if (error) { console.error('Price DB error:', error.message); break; }
      if (data) allPrices.push(...data);
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
  }
  console.log(`Daily prices loaded: ${allPrices.length}`);

  // 가격 데이터 그룹핑
  const priceMap = new Map();
  for (const p of allPrices) {
    if (!priceMap.has(p.recommendation_id)) priceMap.set(p.recommendation_id, []);
    priceMap.get(p.recommendation_id).push(p);
  }

  // 날짜별 그룹핑
  const dateMap = new Map();
  for (const rec of allRecs) {
    const d = rec.recommendation_date;
    if (!dateMap.has(d)) dateMap.set(d, []);
    dateMap.get(d).push(rec);
  }
  const dates = [...dateMap.keys()].sort();
  console.log(`Date range: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length} days)`);

  // ══════════════════════════════════════════════════════════════
  // 3. 고래 현황 개요
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 1] Whale Detection Overview');
  console.log('='.repeat(90));

  const whaleStocks = allRecs.filter(r => r.whale_detected);
  const confirmedWhale = allRecs.filter(r => r.whale_confirmed);
  const noWhaleStocks = allRecs.filter(r => !r.whale_detected);
  const highVolNoWhale = noWhaleStocks.filter(r => (r.volume_ratio || 0) >= 1.5);

  console.log(`\n  Total stocks: ${allRecs.length}`);
  console.log(`  Whale detected: ${whaleStocks.length} (${(whaleStocks.length / allRecs.length * 100).toFixed(1)}%)`);
  console.log(`  Whale confirmed: ${confirmedWhale.length} (${(confirmedWhale.length / allRecs.length * 100).toFixed(1)}%)`);
  console.log(`  No whale: ${noWhaleStocks.length} (${(noWhaleStocks.length / allRecs.length * 100).toFixed(1)}%)`);
  console.log(`  No whale but volume_ratio >= 1.5: ${highVolNoWhale.length}`);

  // Score distribution for whale vs no-whale
  const whaleScore50 = whaleStocks.filter(r => (r.total_score || 0) >= 50);
  const noWhaleScore50 = noWhaleStocks.filter(r => (r.total_score || 0) >= 50);
  console.log(`\n  Whale + score>=50: ${whaleScore50.length}`);
  console.log(`  No whale + score>=50: ${noWhaleScore50.length}`);

  // ══════════════════════════════════════════════════════════════
  // 4. 고래 vs 비고래 성과 비교
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 2] Performance: Whale vs Non-Whale (all stocks)');
  console.log('='.repeat(90));

  const whaleReturns = whaleStocks.map(r => {
    const ret = calcReturns(r, priceMap);
    return ret ? { ...ret, ...r } : null;
  }).filter(Boolean);

  const noWhaleReturns = noWhaleStocks.map(r => {
    const ret = calcReturns(r, priceMap);
    return ret ? { ...ret, ...r } : null;
  }).filter(Boolean);

  const header = `  ${'Category'.padEnd(35)} | ${'Count'.padStart(6)} | ${'WR(+5%)'.padStart(8)} | ${'WR(+3%)'.padStart(8)} | ${'WR(+0%)'.padStart(8)} | ${'AvgMax'.padStart(8)} | ${'MedMax'.padStart(8)} | ${'AvgD3'.padStart(8)} | ${'AvgLast'.padStart(8)} | ${'AvgMin'.padStart(8)}`;
  const sep = `  ${'-'.repeat(35)}-+-${'-'.repeat(6)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}`;

  function printRow(label, st) {
    if (!st) { console.log(`  ${label.padEnd(35)} | no data`); return; }
    console.log(`  ${label.padEnd(35)} | ${String(st.count).padStart(6)} | ${(st.winRate5.toFixed(1) + '%').padStart(8)} | ${(st.winRate3.toFixed(1) + '%').padStart(8)} | ${(st.winRate0.toFixed(1) + '%').padStart(8)} | ${fmtPct(st.avgMax).padStart(8)} | ${fmtPct(st.medMax).padStart(8)} | ${fmtPct(st.avgD3).padStart(8)} | ${fmtPct(st.avgLast).padStart(8)} | ${fmtPct(st.avgMin).padStart(8)}`);
  }

  console.log(`\n${header}`);
  console.log(sep);
  printRow('Whale detected', calcStats(whaleReturns));
  printRow('No whale', calcStats(noWhaleReturns));
  printRow('Whale confirmed', calcStats(whaleReturns.filter(r => r.whale_confirmed)));
  printRow('ALL', calcStats([...whaleReturns, ...noWhaleReturns]));

  // ══════════════════════════════════════════════════════════════
  // 5. 비고래 + score>=50 종목 분석 (핵심: 우리가 놓치고 있는 종목)
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 3] Non-whale stocks with score >= 50 (are we missing good stocks?)');
  console.log('='.repeat(90));

  const noWhale50Returns = noWhaleReturns.filter(r => (r.total_score || 0) >= 50);
  const whale50Returns = whaleReturns.filter(r => (r.total_score || 0) >= 50);

  console.log(`\n${header}`);
  console.log(sep);
  printRow('Whale + score>=50', calcStats(whale50Returns));
  printRow('No whale + score>=50', calcStats(noWhale50Returns));
  printRow('No whale + score>=50 + non-overheat', calcStats(noWhale50Returns.filter(r => r.recommendation_grade !== '과열')));

  // Score band breakdown for non-whale score>=50
  console.log(`\n  --- Non-whale score>=50 by score band ---`);
  console.log(header);
  console.log(sep);

  const bands = [
    { label: 'No whale 50-59', lo: 50, hi: 59 },
    { label: 'No whale 60-69', lo: 60, hi: 69 },
    { label: 'No whale 70-79', lo: 70, hi: 79 },
    { label: 'No whale 80-89', lo: 80, hi: 89 },
    { label: 'No whale 90+', lo: 90, hi: 100 },
  ];

  for (const band of bands) {
    const items = noWhale50Returns.filter(r => r.total_score >= band.lo && r.total_score <= band.hi);
    printRow(band.label, calcStats(items));
  }

  // Compare to whale stocks in same bands
  console.log(`\n  --- Whale stocks by same score band (for comparison) ---`);
  console.log(header);
  console.log(sep);
  for (const band of bands) {
    const items = whale50Returns.filter(r => r.total_score >= band.lo && r.total_score <= band.hi);
    printRow(`Whale ${band.lo}-${band.hi}`, calcStats(items));
  }

  // ══════════════════════════════════════════════════════════════
  // 6. Non-whale high-volume stocks
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 4] Non-whale but high volume_ratio stocks');
  console.log('  (Would Option C capture good stocks?)');
  console.log('='.repeat(90));

  const volBuckets = [
    { label: 'No whale, volRatio >= 2.5', filter: r => (r.volume_ratio || 0) >= 2.5 },
    { label: 'No whale, volRatio 2.0-2.5', filter: r => (r.volume_ratio || 0) >= 2.0 && (r.volume_ratio || 0) < 2.5 },
    { label: 'No whale, volRatio 1.5-2.0', filter: r => (r.volume_ratio || 0) >= 1.5 && (r.volume_ratio || 0) < 2.0 },
    { label: 'No whale, volRatio 1.0-1.5', filter: r => (r.volume_ratio || 0) >= 1.0 && (r.volume_ratio || 0) < 1.5 },
    { label: 'No whale, volRatio < 1.0', filter: r => (r.volume_ratio || 0) < 1.0 },
  ];

  console.log(`\n${header}`);
  console.log(sep);
  for (const bucket of volBuckets) {
    const items = noWhaleReturns.filter(bucket.filter);
    printRow(bucket.label, calcStats(items));
  }

  // ══════════════════════════════════════════════════════════════
  // 7. 날짜별 TOP3 시뮬레이션 비교
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 5] TOP3 Simulation: Current vs Relaxed Whale Rules');
  console.log('='.repeat(90));

  const simResults = {};
  for (const key of Object.keys(WHALE_OPTIONS)) {
    simResults[key] = {
      totalDays: 0,
      daysLt3: 0,
      daysLt2: 0,
      daysLt1: 0,
      top3Returns: [],
      label: WHALE_OPTIONS[key].label,
    };
  }

  for (const date of dates) {
    const stocks = dateMap.get(date);

    for (const [key, opt] of Object.entries(WHALE_OPTIONS)) {
      const top3 = simulateTop3(stocks, opt.filter);

      simResults[key].totalDays++;
      if (top3.length < 3) simResults[key].daysLt3++;
      if (top3.length < 2) simResults[key].daysLt2++;
      if (top3.length < 1) simResults[key].daysLt1++;

      for (const s of top3) {
        const ret = calcReturns(s, priceMap);
        if (ret) {
          simResults[key].top3Returns.push({
            ...ret,
            date,
            stock_code: s.stock_code,
            stock_name: s.stock_name,
            total_score: s.total_score,
            whale_detected: s.whale_detected,
            volume_ratio: s.volume_ratio,
          });
        }
      }
    }
  }

  // Print simulation summary
  console.log(`\n  ${'Option'.padEnd(50)} | ${'Days'.padStart(5)} | ${'<3'.padStart(4)} | ${'<2'.padStart(4)} | ${'<1'.padStart(4)} | ${'TOP3 N'.padStart(7)} | ${'WR(+5%)'.padStart(8)} | ${'WR(+3%)'.padStart(8)} | ${'AvgMax'.padStart(8)} | ${'MedMax'.padStart(8)} | ${'AvgD3'.padStart(8)} | ${'AvgLast'.padStart(8)}`);
  console.log(`  ${'-'.repeat(50)}-+-${'-'.repeat(5)}-+-${'-'.repeat(4)}-+-${'-'.repeat(4)}-+-${'-'.repeat(4)}-+-${'-'.repeat(7)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}`);

  for (const [key, res] of Object.entries(simResults)) {
    const st = calcStats(res.top3Returns);
    const n = st ? st.count : 0;
    const wr5 = st ? st.winRate5.toFixed(1) + '%' : 'N/A';
    const wr3 = st ? st.winRate3.toFixed(1) + '%' : 'N/A';
    const am = st ? fmtPct(st.avgMax) : 'N/A';
    const mm = st ? fmtPct(st.medMax) : 'N/A';
    const ad3 = st ? fmtPct(st.avgD3) : 'N/A';
    const al = st ? fmtPct(st.avgLast) : 'N/A';

    console.log(`  ${res.label.padEnd(50)} | ${String(res.totalDays).padStart(5)} | ${String(res.daysLt3).padStart(4)} | ${String(res.daysLt2).padStart(4)} | ${String(res.daysLt1).padStart(4)} | ${String(n).padStart(7)} | ${wr5.padStart(8)} | ${wr3.padStart(8)} | ${am.padStart(8)} | ${mm.padStart(8)} | ${ad3.padStart(8)} | ${al.padStart(8)}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 8. 옵션별 TOP3에 새로 추가된 종목의 성과
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 6] Newly added stocks in each option (vs current)');
  console.log('  Stocks that enter TOP3 only because of relaxed whale rule');
  console.log('='.repeat(90));

  for (const key of ['optionA', 'optionB', 'optionC']) {
    const opt = WHALE_OPTIONS[key];
    let newlyAdded = [];
    let keptSame = [];

    for (const date of dates) {
      const stocks = dateMap.get(date);
      const currentTop3 = simulateTop3(stocks, WHALE_OPTIONS.current.filter);
      const newTop3 = simulateTop3(stocks, opt.filter);

      const currentCodes = new Set(currentTop3.map(s => s.stock_code));

      for (const s of newTop3) {
        const ret = calcReturns(s, priceMap);
        if (!ret) continue;
        if (!currentCodes.has(s.stock_code)) {
          newlyAdded.push({ ...ret, date, stock_code: s.stock_code, stock_name: s.stock_name, total_score: s.total_score, whale_detected: s.whale_detected, volume_ratio: s.volume_ratio });
        } else {
          keptSame.push({ ...ret, date, stock_code: s.stock_code, stock_name: s.stock_name, total_score: s.total_score, whale_detected: s.whale_detected });
        }
      }
    }

    console.log(`\n  --- ${opt.label} ---`);
    console.log(`  Newly added to TOP3: ${newlyAdded.length} stock-days`);
    console.log(`  Kept same from current: ${keptSame.length} stock-days`);

    const newStats = calcStats(newlyAdded);
    const keptStats = calcStats(keptSame);
    console.log(`\n${header}`);
    console.log(sep);
    printRow(`Newly added (${key})`, newStats);
    printRow(`Kept same (${key})`, keptStats);

    // Show some sample newly added
    if (newlyAdded.length > 0) {
      const sorted = newlyAdded.sort((a, b) => b.maxReturn - a.maxReturn);
      const topN = sorted.slice(0, 10);
      const bottomN = sorted.slice(-5);

      console.log(`\n  Top 10 newly added (best maxReturn):`);
      console.log(`  ${'Date'.padEnd(12)} | ${'Stock'.padEnd(14)} | ${'Score'.padStart(5)} | ${'Whale'.padStart(5)} | ${'VolRat'.padStart(6)} | ${'MaxRet'.padStart(8)} | ${'D3Ret'.padStart(8)} | ${'LastRet'.padStart(8)}`);
      console.log(`  ${'-'.repeat(12)}-+-${'-'.repeat(14)}-+-${'-'.repeat(5)}-+-${'-'.repeat(5)}-+-${'-'.repeat(6)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}`);
      for (const r of topN) {
        const name = (r.stock_name || r.stock_code).slice(0, 10);
        console.log(`  ${(r.date || '').padEnd(12)} | ${name.padEnd(14)} | ${String(r.total_score?.toFixed(0) || '?').padStart(5)} | ${(r.whale_detected ? 'Y' : 'N').padStart(5)} | ${(r.volume_ratio?.toFixed(1) || '?').padStart(6)} | ${fmtPct(r.maxReturn).padStart(8)} | ${fmtPct(r.day3Return).padStart(8)} | ${fmtPct(r.lastReturn).padStart(8)}`);
      }

      if (bottomN.length > 0 && newlyAdded.length > 10) {
        console.log(`\n  Bottom 5 newly added (worst maxReturn):`);
        for (const r of bottomN) {
          const name = (r.stock_name || r.stock_code).slice(0, 10);
          console.log(`  ${(r.date || '').padEnd(12)} | ${name.padEnd(14)} | ${String(r.total_score?.toFixed(0) || '?').padStart(5)} | ${(r.whale_detected ? 'Y' : 'N').padStart(5)} | ${(r.volume_ratio?.toFixed(1) || '?').padStart(6)} | ${fmtPct(r.maxReturn).padStart(8)} | ${fmtPct(r.day3Return).padStart(8)} | ${fmtPct(r.lastReturn).padStart(8)}`);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 9. 날짜별 상세: TOP3 < 3인 날 비교
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 7] Days with TOP3 < 3: How each option fills slots');
  console.log('='.repeat(90));

  let detailCount = 0;
  for (const date of dates) {
    const stocks = dateMap.get(date);
    const currentTop3 = simulateTop3(stocks, WHALE_OPTIONS.current.filter);
    if (currentTop3.length >= 3) continue;

    detailCount++;
    const totalOnDay = stocks.length;
    const whaleOnDay = stocks.filter(s => s.whale_detected).length;
    const eligibleOnDay = stocks.filter(s =>
      s.recommendation_grade !== '과열' &&
      Math.abs(s.change_rate || 0) < 25 &&
      (s.disparity || 100) < 150 &&
      (s.total_score || 0) >= 50
    ).length;

    console.log(`\n  [${date}] Current TOP3: ${currentTop3.length}/3 | Total: ${totalOnDay}, Whale: ${whaleOnDay}, Eligible(score>=50): ${eligibleOnDay}`);

    if (currentTop3.length > 0) {
      for (const s of currentTop3) {
        const ret = calcReturns(s, priceMap);
        console.log(`    Current: ${(s.stock_name || s.stock_code).slice(0, 12).padEnd(14)} score=${s.total_score} ${ret ? `maxRet=${fmtPct(ret.maxReturn)}` : 'no price'}`);
      }
    }

    for (const key of ['optionB', 'optionC']) {
      const opt = WHALE_OPTIONS[key];
      const newTop3 = simulateTop3(stocks, opt.filter);
      if (newTop3.length > currentTop3.length) {
        const currentCodes = new Set(currentTop3.map(s => s.stock_code));
        const newStocks = newTop3.filter(s => !currentCodes.has(s.stock_code));
        console.log(`    ${key}: TOP3=${newTop3.length}/3 (+${newTop3.length - currentTop3.length}) new: ${newStocks.map(s => {
          const ret = calcReturns(s, priceMap);
          return `${(s.stock_name || '').slice(0, 8)}(score=${s.total_score},whale=${s.whale_detected ? 'Y' : 'N'},vol=${(s.volume_ratio || 0).toFixed(1)}${ret ? ',maxRet=' + fmtPct(ret.maxReturn) : ''})`;
        }).join(', ')}`);
      } else {
        console.log(`    ${key}: TOP3=${newTop3.length}/3 (no change)`);
      }
    }
  }

  if (detailCount === 0) {
    console.log(`\n  No days with TOP3 < 3 found under current rules.`);
  }
  console.log(`\n  Total days with TOP3 < 3 (current): ${detailCount} / ${dates.length}`);

  // ══════════════════════════════════════════════════════════════
  // 10. actual is_top3 vs simulated comparison
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 8] Actual is_top3 stocks performance vs simulated options');
  console.log('='.repeat(90));

  const actualTop3 = allRecs.filter(r => r.is_top3);
  const actualTop3Returns = actualTop3.map(r => {
    const ret = calcReturns(r, priceMap);
    return ret ? { ...ret, ...r } : null;
  }).filter(Boolean);

  console.log(`\n${header}`);
  console.log(sep);
  printRow('Actual is_top3 (DB)', calcStats(actualTop3Returns));
  for (const [key, res] of Object.entries(simResults)) {
    printRow(`Simulated ${key} TOP3`, calcStats(res.top3Returns));
  }

  // ══════════════════════════════════════════════════════════════
  // 11. 요약 및 권고
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [SUMMARY] Key Findings & Recommendation');
  console.log('='.repeat(90));

  const curSt = calcStats(simResults.current.top3Returns);
  const optBSt = calcStats(simResults.optionB.top3Returns);
  const optCSt = calcStats(simResults.optionC.top3Returns);

  console.log(`\n  1. Whale coverage: ${whaleStocks.length}/${allRecs.length} (${(whaleStocks.length / allRecs.length * 100).toFixed(1)}%) have whale_detected`);
  console.log(`  2. Days with TOP3 < 3:`);
  for (const [key, res] of Object.entries(simResults)) {
    console.log(`     - ${res.label}: ${res.daysLt3}/${res.totalDays} days (${(res.daysLt3 / res.totalDays * 100).toFixed(1)}%)`);
  }

  console.log(`\n  3. TOP3 performance comparison:`);
  if (curSt) console.log(`     - Current:  WR(+5%)=${curSt.winRate5.toFixed(1)}%, AvgMax=${fmtPct(curSt.avgMax)}, MedMax=${fmtPct(curSt.medMax)}, AvgD3=${fmtPct(curSt.avgD3)}, N=${curSt.count}`);
  if (optBSt) console.log(`     - Option B: WR(+5%)=${optBSt.winRate5.toFixed(1)}%, AvgMax=${fmtPct(optBSt.avgMax)}, MedMax=${fmtPct(optBSt.medMax)}, AvgD3=${fmtPct(optBSt.avgD3)}, N=${optBSt.count}`);
  if (optCSt) console.log(`     - Option C: WR(+5%)=${optCSt.winRate5.toFixed(1)}%, AvgMax=${fmtPct(optCSt.avgMax)}, MedMax=${fmtPct(optCSt.medMax)}, AvgD3=${fmtPct(optCSt.avgD3)}, N=${optCSt.count}`);

  const noWhale50St = calcStats(noWhale50Returns);
  if (noWhale50St) {
    console.log(`\n  4. Non-whale score>=50 stocks performance:`);
    console.log(`     WR(+5%)=${noWhale50St.winRate5.toFixed(1)}%, AvgMax=${fmtPct(noWhale50St.avgMax)}, N=${noWhale50St.count}`);
    console.log(`     → ${noWhale50St.winRate5 >= 40 ? 'DECENT performance: whale filter may be excluding good stocks' : 'WEAK performance: whale filter is justified'}`);
  }

  if (curSt && optBSt) {
    const wrDiff = optBSt.winRate5 - curSt.winRate5;
    const avgDiff = optBSt.avgMax - curSt.avgMax;
    console.log(`\n  5. Removing whale filter entirely (Option B):`);
    console.log(`     Win rate change: ${wrDiff >= 0 ? '+' : ''}${wrDiff.toFixed(1)}pp`);
    console.log(`     Avg max return change: ${avgDiff >= 0 ? '+' : ''}${avgDiff.toFixed(2)}pp`);
    console.log(`     Days <3 fixed: ${simResults.current.daysLt3 - simResults.optionB.daysLt3} additional days now have 3 TOP3`);
    if (wrDiff < -5) {
      console.log(`     → RECOMMENDATION: Keep whale filter (significant win rate drop)`);
    } else if (wrDiff < -2) {
      console.log(`     → RECOMMENDATION: Consider Option C as compromise (moderate win rate drop)`);
    } else {
      console.log(`     → RECOMMENDATION: Whale filter can be safely relaxed (minimal performance impact)`);
    }
  }

  console.log('\n' + '='.repeat(90));
  console.log('  Analysis complete.');
  console.log('='.repeat(90));
}

main().catch(console.error).finally(() => process.exit(0));
