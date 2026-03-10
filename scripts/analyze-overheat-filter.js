/**
 * 과열 필터 영향 분석 스크립트
 *
 * 분석 항목:
 * 1. 과열(RSI>80 AND disparity>115) 종목 현황 및 성과
 * 2. 과열 vs 비과열 종목 성과 비교
 * 3. 완화된 과열 기준 시뮬레이션 (Option A/B/C)
 * 4. TOP3 재선별 시뮬레이션 - 완화 기준 적용 시 빈 슬롯 채움 효과
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── TOP3 선별 로직 재현 (screening.js와 동일) ──
function simulateTop3(stocks, overrideGrades) {
  // overrideGrades: Map<id, newGrade> - 과열 기준 변경 시 등급 오버라이드
  const eligible = stocks.filter(s => {
    const grade = overrideGrades ? (overrideGrades.get(s.id) || s.recommendation_grade) : s.recommendation_grade;
    return (
      s.whale_detected &&
      grade !== '과열' &&
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
  const wins0 = items.filter(d => d.maxReturn >= 0).length;
  const avgMax = items.reduce((s, d) => s + d.maxReturn, 0) / n;
  const avgD3 = items.reduce((s, d) => s + d.day3Return, 0) / n;
  const avgLast = items.reduce((s, d) => s + d.lastReturn, 0) / n;
  const medMax = items.map(d => d.maxReturn).sort((a, b) => a - b)[Math.floor(n / 2)];
  const avgMin = items.reduce((s, d) => s + d.minReturn, 0) / n;
  return {
    count: n,
    winRate5: (wins5 / n * 100),
    winRate0: (wins0 / n * 100),
    avgMax, avgD3, avgLast, medMax, avgMin,
  };
}

function fmtPct(v, sign = true) {
  if (v == null || isNaN(v)) return 'N/A';
  const s = sign && v >= 0 ? '+' : '';
  return s + v.toFixed(2) + '%';
}

// ── 과열 판정 함수들 ──
const OVERHEAT_CRITERIA = {
  current: { rsi: 80, disparity: 115, label: '현재 기준 (RSI>80 AND disp>115)' },
  optionA: { rsi: 85, disparity: 120, label: 'Option A: RSI>85 AND disp>120 (양쪽 완화)' },
  optionB: { rsi: 80, disparity: 125, label: 'Option B: RSI>80 AND disp>125 (이격도만 완화)' },
  optionC: { rsi: 85, disparity: 115, label: 'Option C: RSI>85 AND disp>115 (RSI만 완화)' },
};

function isOverheated(rec, criteria) {
  const rsi = rec.rsi;
  const disp = rec.disparity;
  if (rsi == null || disp == null) return false;
  return rsi > criteria.rsi && disp > criteria.disparity;
}


async function main() {
  console.log('='.repeat(90));
  console.log('  OVERHEAT FILTER IMPACT ANALYSIS');
  console.log('  Current criteria: RSI(14) > 80 AND disparity(20) > 115');
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
  // 2. 일별 가격 데이터 조회 (배치 + 페이지네이션)
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
  // 3. 과열 종목 현황 및 성과 분석
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 1] Overheat Stocks Overview');
  console.log('='.repeat(90));

  const overheatStocks = allRecs.filter(r => r.recommendation_grade === '과열');
  const nonOverheatStocks = allRecs.filter(r => r.recommendation_grade !== '과열');

  console.log(`\n  Total stocks: ${allRecs.length}`);
  console.log(`  Overheated (grade='과열'): ${overheatStocks.length} (${(overheatStocks.length / allRecs.length * 100).toFixed(1)}%)`);
  console.log(`  Non-overheated: ${nonOverheatStocks.length}`);

  // 과열 종목의 RSI/disparity 분포
  const ohWithData = overheatStocks.filter(r => r.rsi != null && r.disparity != null);
  if (ohWithData.length > 0) {
    const avgRsi = ohWithData.reduce((s, r) => s + r.rsi, 0) / ohWithData.length;
    const avgDisp = ohWithData.reduce((s, r) => s + r.disparity, 0) / ohWithData.length;
    const maxRsi = Math.max(...ohWithData.map(r => r.rsi));
    const minRsi = Math.min(...ohWithData.map(r => r.rsi));
    const maxDisp = Math.max(...ohWithData.map(r => r.disparity));
    const minDisp = Math.min(...ohWithData.map(r => r.disparity));
    console.log(`\n  Overheated stocks RSI range: ${minRsi.toFixed(1)} ~ ${maxRsi.toFixed(1)} (avg: ${avgRsi.toFixed(1)})`);
    console.log(`  Overheated stocks Disparity range: ${minDisp.toFixed(1)} ~ ${maxDisp.toFixed(1)} (avg: ${avgDisp.toFixed(1)})`);
  }

  // 과열 종목 중 고래 보유 비율
  const ohWhale = overheatStocks.filter(r => r.whale_detected);
  console.log(`\n  Overheated + Whale detected: ${ohWhale.length} (${overheatStocks.length > 0 ? (ohWhale.length / overheatStocks.length * 100).toFixed(1) : 0}%)`);
  const ohWhaleConfirmed = overheatStocks.filter(r => r.whale_confirmed);
  console.log(`  Overheated + Whale confirmed: ${ohWhaleConfirmed.length}`);

  // 과열 종목의 총점 분포
  const ohScores = overheatStocks.filter(r => r.total_score != null);
  if (ohScores.length > 0) {
    const avgScore = ohScores.reduce((s, r) => s + r.total_score, 0) / ohScores.length;
    const maxScore = Math.max(...ohScores.map(r => r.total_score));
    const minScore = Math.min(...ohScores.map(r => r.total_score));
    console.log(`\n  Overheated total_score range: ${minScore} ~ ${maxScore} (avg: ${avgScore.toFixed(1)})`);

    // 점수대별 분포
    const scoreBands = { '90+': 0, '80-89': 0, '70-79': 0, '60-69': 0, '50-59': 0, '<50': 0 };
    for (const r of ohScores) {
      if (r.total_score >= 90) scoreBands['90+']++;
      else if (r.total_score >= 80) scoreBands['80-89']++;
      else if (r.total_score >= 70) scoreBands['70-79']++;
      else if (r.total_score >= 60) scoreBands['60-69']++;
      else if (r.total_score >= 50) scoreBands['50-59']++;
      else scoreBands['<50']++;
    }
    console.log(`  Score distribution:`);
    for (const [band, cnt] of Object.entries(scoreBands)) {
      console.log(`    ${band.padEnd(8)}: ${cnt} (${(cnt / ohScores.length * 100).toFixed(1)}%)`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 4. 과열 vs 비과열 성과 비교
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 2] Performance: Overheated vs Non-Overheated');
  console.log('='.repeat(90));

  const ohReturns = overheatStocks.map(r => {
    const ret = calcReturns(r, priceMap);
    return ret ? { ...ret, ...r } : null;
  }).filter(Boolean);

  const nonOhReturns = nonOverheatStocks.map(r => {
    const ret = calcReturns(r, priceMap);
    return ret ? { ...ret, ...r } : null;
  }).filter(Boolean);

  const ohStats = calcStats(ohReturns);
  const nonOhStats = calcStats(nonOhReturns);

  const header = `  ${'Category'.padEnd(22)} | ${'Count'.padStart(6)} | ${'WinRate(+5%)'.padStart(12)} | ${'WinRate(+0%)'.padStart(12)} | ${'AvgMaxRet'.padStart(10)} | ${'MedMaxRet'.padStart(10)} | ${'AvgD3Ret'.padStart(10)} | ${'AvgLastRet'.padStart(11)} | ${'AvgMinRet'.padStart(10)}`;
  const sep = `  ${'-'.repeat(22)}-+-${'-'.repeat(6)}-+-${'-'.repeat(12)}-+-${'-'.repeat(12)}-+-${'-'.repeat(10)}-+-${'-'.repeat(10)}-+-${'-'.repeat(10)}-+-${'-'.repeat(11)}-+-${'-'.repeat(10)}`;

  function printRow(label, st) {
    if (!st) { console.log(`  ${label.padEnd(22)} | no data`); return; }
    console.log(`  ${label.padEnd(22)} | ${String(st.count).padStart(6)} | ${(st.winRate5.toFixed(1) + '%').padStart(12)} | ${(st.winRate0.toFixed(1) + '%').padStart(12)} | ${fmtPct(st.avgMax).padStart(10)} | ${fmtPct(st.medMax).padStart(10)} | ${fmtPct(st.avgD3).padStart(10)} | ${fmtPct(st.avgLast).padStart(11)} | ${fmtPct(st.avgMin).padStart(10)}`);
  }

  console.log(`\n${header}`);
  console.log(sep);
  printRow('Overheated (과열)', ohStats);
  printRow('Non-overheated', nonOhStats);
  printRow('ALL', calcStats([...ohReturns, ...nonOhReturns]));

  // 과열 종목 중 고래 있는 것만 별도 분석
  const ohWhaleReturns = ohReturns.filter(r => r.whale_detected);
  const ohNoWhaleReturns = ohReturns.filter(r => !r.whale_detected);
  console.log(`\n  --- Overheated sub-groups ---`);
  console.log(header);
  console.log(sep);
  printRow('OH + Whale', calcStats(ohWhaleReturns));
  printRow('OH + No Whale', calcStats(ohNoWhaleReturns));
  printRow('OH + Whale Confirmed', calcStats(ohReturns.filter(r => r.whale_confirmed)));

  // 비과열 + 고래 비교용
  console.log(`\n  --- Non-overheated sub-groups (for comparison) ---`);
  console.log(header);
  console.log(sep);
  printRow('NonOH + Whale', calcStats(nonOhReturns.filter(r => r.whale_detected)));
  printRow('NonOH + No Whale', calcStats(nonOhReturns.filter(r => !r.whale_detected)));

  // ══════════════════════════════════════════════════════════════
  // 5. 과열 종목 상위 성과 목록
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 3] Top-performing Overheated Stocks (sorted by maxReturn)');
  console.log('='.repeat(90));

  const ohSorted = ohReturns.sort((a, b) => b.maxReturn - a.maxReturn).slice(0, 30);
  console.log(`\n  ${'Date'.padEnd(12)} | ${'Stock'.padEnd(16)} | ${'Score'.padStart(5)} | ${'RSI'.padStart(5)} | ${'Disp'.padStart(6)} | ${'Whale'.padStart(5)} | ${'MaxRet'.padStart(8)} | ${'D3Ret'.padStart(8)} | ${'LastRet'.padStart(8)}`);
  console.log(`  ${'-'.repeat(12)}-+-${'-'.repeat(16)}-+-${'-'.repeat(5)}-+-${'-'.repeat(5)}-+-${'-'.repeat(6)}-+-${'-'.repeat(5)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}`);

  for (const r of ohSorted) {
    const name = (r.stock_name || r.stock_code).slice(0, 8);
    console.log(`  ${(r.recommendation_date || '').padEnd(12)} | ${name.padEnd(16)} | ${String(r.total_score?.toFixed(0) || '?').padStart(5)} | ${(r.rsi?.toFixed(0) || '?').padStart(5)} | ${(r.disparity?.toFixed(1) || '?').padStart(6)} | ${(r.whale_detected ? 'Y' : 'N').padStart(5)} | ${fmtPct(r.maxReturn).padStart(8)} | ${fmtPct(r.day3Return).padStart(8)} | ${fmtPct(r.lastReturn).padStart(8)}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 6. 완화된 과열 기준 시뮬레이션
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 4] Relaxed Overheat Criteria Simulation');
  console.log('  Which previously-overheated stocks would become eligible?');
  console.log('='.repeat(90));

  for (const [key, criteria] of Object.entries(OVERHEAT_CRITERIA)) {
    if (key === 'current') continue;

    // 현재 기준으로 과열이지만, 완화된 기준으로는 과열이 아닌 종목
    const rescued = overheatStocks.filter(r => !isOverheated(r, criteria));
    const rescuedReturns = rescued.map(r => {
      const ret = calcReturns(r, priceMap);
      return ret ? { ...ret, ...r } : null;
    }).filter(Boolean);

    const rescStats = calcStats(rescuedReturns);
    const stillOh = overheatStocks.filter(r => isOverheated(r, criteria));

    console.log(`\n  --- ${criteria.label} ---`);
    console.log(`  Rescued from overheat: ${rescued.length} / ${overheatStocks.length}`);
    console.log(`  Still overheated: ${stillOh.length}`);

    if (rescStats) {
      console.log(`  Rescued stocks performance:`);
      console.log(`    Count with prices: ${rescStats.count}`);
      console.log(`    Win rate (+5%): ${rescStats.winRate5.toFixed(1)}%`);
      console.log(`    Win rate (+0%): ${rescStats.winRate0.toFixed(1)}%`);
      console.log(`    Avg max return: ${fmtPct(rescStats.avgMax)}`);
      console.log(`    Median max return: ${fmtPct(rescStats.medMax)}`);
      console.log(`    Avg D+3 return: ${fmtPct(rescStats.avgD3)}`);
      console.log(`    Avg last return: ${fmtPct(rescStats.avgLast)}`);
      console.log(`    Avg min return (worst drawdown): ${fmtPct(rescStats.avgMin)}`);
    } else {
      console.log(`  No price data available for rescued stocks.`);
    }

    // Rescued 중 고래 있고 TOP3 eligible한 것
    const rescWhale = rescued.filter(r => r.whale_detected);
    const rescWhaleReturns = rescuedReturns.filter(r => r.whale_detected);
    console.log(`\n  Rescued + Whale detected: ${rescWhale.length}`);
    if (rescWhaleReturns.length > 0) {
      const rwStats = calcStats(rescWhaleReturns);
      console.log(`    Win rate (+5%): ${rwStats.winRate5.toFixed(1)}%, Avg max: ${fmtPct(rwStats.avgMax)}, Avg D3: ${fmtPct(rwStats.avgD3)}`);
    }

    // 상위 성과 rescued 종목
    if (rescuedReturns.length > 0) {
      const topRescued = rescuedReturns.sort((a, b) => b.maxReturn - a.maxReturn).slice(0, 10);
      console.log(`\n  Top rescued stocks:`);
      console.log(`  ${'Date'.padEnd(12)} | ${'Stock'.padEnd(14)} | ${'Score'.padStart(5)} | ${'RSI'.padStart(5)} | ${'Disp'.padStart(6)} | ${'Whale'.padStart(5)} | ${'MaxRet'.padStart(8)} | ${'D3Ret'.padStart(8)}`);
      for (const r of topRescued) {
        const name = (r.stock_name || r.stock_code).slice(0, 8);
        console.log(`  ${(r.recommendation_date || '').padEnd(12)} | ${name.padEnd(14)} | ${String(r.total_score?.toFixed(0) || '?').padStart(5)} | ${(r.rsi?.toFixed(0) || '?').padStart(5)} | ${(r.disparity?.toFixed(1) || '?').padStart(6)} | ${(r.whale_detected ? 'Y' : 'N').padStart(5)} | ${fmtPct(r.maxReturn).padStart(8)} | ${fmtPct(r.day3Return).padStart(8)}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 7. 날짜별 TOP3 재선별 시뮬레이션
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 5] TOP3 Re-selection Simulation per Day');
  console.log('  Does relaxing overheat filter fill empty TOP3 slots?');
  console.log('='.repeat(90));

  const simResults = {};
  for (const key of Object.keys(OVERHEAT_CRITERIA)) {
    simResults[key] = {
      totalDays: 0,
      daysLt3: 0,          // days with < 3 TOP3
      top3Returns: [],      // returns of all TOP3 stocks
      filledSlots: 0,       // additional slots filled vs current
      daysNowFull: 0,       // days that went from <3 to 3
      label: OVERHEAT_CRITERIA[key].label,
    };
  }

  for (const date of dates) {
    const stocks = dateMap.get(date);

    for (const [key, criteria] of Object.entries(OVERHEAT_CRITERIA)) {
      // Build grade override map: re-evaluate overheat with this criteria
      const overrideGrades = new Map();
      for (const s of stocks) {
        if (s.recommendation_grade === '과열') {
          // Was marked as overheated - check if still overheated under new criteria
          if (!isOverheated(s, criteria)) {
            // No longer overheated - assign grade based on score
            let grade;
            if (s.total_score >= 90) grade = 'S+';
            else if (s.total_score >= 75) grade = 'S';
            else if (s.total_score >= 60) grade = 'A';
            else if (s.total_score >= 45) grade = 'B';
            else if (s.total_score >= 30) grade = 'C';
            else grade = 'D';
            overrideGrades.set(s.id, grade);
          }
          // else still overheated, keep '과열'
        }
      }

      const top3 = key === 'current'
        ? simulateTop3(stocks, null)
        : simulateTop3(stocks, overrideGrades);

      simResults[key].totalDays++;
      if (top3.length < 3) simResults[key].daysLt3++;

      for (const s of top3) {
        const ret = calcReturns(s, priceMap);
        if (ret) {
          simResults[key].top3Returns.push({ ...ret, date, stock_code: s.stock_code, stock_name: s.stock_name, total_score: s.total_score });
        }
      }
    }
  }

  // Compare each option against current
  const currentDaysLt3Set = new Set();
  for (const date of dates) {
    const stocks = dateMap.get(date);
    const top3 = simulateTop3(stocks, null);
    if (top3.length < 3) currentDaysLt3Set.add(date);
  }

  // For each relaxed option, count how many previously-unfilled days are now filled
  for (const key of Object.keys(OVERHEAT_CRITERIA)) {
    if (key === 'current') continue;
    const criteria = OVERHEAT_CRITERIA[key];
    let filledMore = 0;
    let nowFull = 0;

    for (const date of dates) {
      const stocks = dateMap.get(date);
      const currentTop3 = simulateTop3(stocks, null);

      // Build override grades
      const overrideGrades = new Map();
      for (const s of stocks) {
        if (s.recommendation_grade === '과열' && !isOverheated(s, criteria)) {
          let grade;
          if (s.total_score >= 90) grade = 'S+';
          else if (s.total_score >= 75) grade = 'S';
          else if (s.total_score >= 60) grade = 'A';
          else if (s.total_score >= 45) grade = 'B';
          else if (s.total_score >= 30) grade = 'C';
          else grade = 'D';
          overrideGrades.set(s.id, grade);
        }
      }
      const newTop3 = simulateTop3(stocks, overrideGrades);

      if (newTop3.length > currentTop3.length) {
        filledMore += (newTop3.length - currentTop3.length);
      }
      if (currentTop3.length < 3 && newTop3.length >= 3) {
        nowFull++;
      }
    }

    simResults[key].filledSlots = filledMore;
    simResults[key].daysNowFull = nowFull;
  }

  // Print simulation results
  console.log(`\n  ${'Criteria'.padEnd(52)} | ${'Days'.padStart(5)} | ${'<3 Days'.padStart(7)} | ${'TOP3 N'.padStart(6)} | ${'WR(+5%)'.padStart(8)} | ${'AvgMax'.padStart(8)} | ${'AvgD3'.padStart(8)} | ${'AvgLast'.padStart(8)} | ${'Extra'.padStart(6)} | ${'Fixed'.padStart(6)}`);
  console.log(`  ${'-'.repeat(52)}-+-${'-'.repeat(5)}-+-${'-'.repeat(7)}-+-${'-'.repeat(6)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}`);

  for (const [key, res] of Object.entries(simResults)) {
    const st = calcStats(res.top3Returns);
    const n = st ? st.count : 0;
    const wr = st ? st.winRate5.toFixed(1) + '%' : 'N/A';
    const am = st ? fmtPct(st.avgMax) : 'N/A';
    const ad3 = st ? fmtPct(st.avgD3) : 'N/A';
    const al = st ? fmtPct(st.avgLast) : 'N/A';
    const extra = key === 'current' ? '-' : String(res.filledSlots);
    const fixed = key === 'current' ? '-' : String(res.daysNowFull);

    console.log(`  ${res.label.padEnd(52)} | ${String(res.totalDays).padStart(5)} | ${String(res.daysLt3).padStart(7)} | ${String(n).padStart(6)} | ${wr.padStart(8)} | ${am.padStart(8)} | ${ad3.padStart(8)} | ${al.padStart(8)} | ${extra.padStart(6)} | ${fixed.padStart(6)}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 8. 날짜별 상세 비교 (TOP3 < 3인 날만)
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 6] Days where TOP3 < 3: Detailed comparison');
  console.log('='.repeat(90));

  let detailCount = 0;
  for (const date of dates) {
    const stocks = dateMap.get(date);
    const currentTop3 = simulateTop3(stocks, null);
    if (currentTop3.length >= 3) continue;

    detailCount++;
    const ohOnDay = stocks.filter(r => r.recommendation_grade === '과열');

    console.log(`\n  [${date}] Current TOP3: ${currentTop3.length}/3, Overheated stocks: ${ohOnDay.length}`);

    if (currentTop3.length > 0) {
      for (const s of currentTop3) {
        const ret = calcReturns(s, priceMap);
        console.log(`    TOP3: ${(s.stock_name || s.stock_code).slice(0, 10).padEnd(12)} score=${s.total_score} ${ret ? `maxRet=${fmtPct(ret.maxReturn)}` : 'no price data'}`);
      }
    }

    if (ohOnDay.length > 0) {
      for (const s of ohOnDay) {
        const ret = calcReturns(s, priceMap);
        const wouldBeEligible = s.whale_detected && Math.abs(s.change_rate || 0) < 25 && (s.disparity || 100) < 150;
        console.log(`    OH: ${(s.stock_name || s.stock_code).slice(0, 10).padEnd(12)} score=${s.total_score} RSI=${s.rsi?.toFixed(0)} disp=${s.disparity?.toFixed(1)} whale=${s.whale_detected ? 'Y' : 'N'} eligible(if not OH)=${wouldBeEligible ? 'Y' : 'N'} ${ret ? `maxRet=${fmtPct(ret.maxReturn)}` : ''}`);
      }
    }

    // Show what each option would produce
    for (const [key, criteria] of Object.entries(OVERHEAT_CRITERIA)) {
      if (key === 'current') continue;
      const overrideGrades = new Map();
      for (const s of stocks) {
        if (s.recommendation_grade === '과열' && !isOverheated(s, criteria)) {
          let grade;
          if (s.total_score >= 90) grade = 'S+';
          else if (s.total_score >= 75) grade = 'S';
          else if (s.total_score >= 60) grade = 'A';
          else if (s.total_score >= 45) grade = 'B';
          else if (s.total_score >= 30) grade = 'C';
          else grade = 'D';
          overrideGrades.set(s.id, grade);
        }
      }
      const newTop3 = simulateTop3(stocks, overrideGrades);
      if (newTop3.length > currentTop3.length) {
        const newStocks = newTop3.filter(s => !currentTop3.some(c => c.stock_code === s.stock_code));
        console.log(`    ${key}: TOP3=${newTop3.length}/3 (+${newTop3.length - currentTop3.length}) new: ${newStocks.map(s => `${(s.stock_name || '').slice(0, 8)}(${s.total_score})`).join(', ')}`);
      } else {
        console.log(`    ${key}: TOP3=${newTop3.length}/3 (no change)`);
      }
    }
  }

  if (detailCount === 0) {
    console.log(`\n  No days with TOP3 < 3 found.`);
  }

  // ══════════════════════════════════════════════════════════════
  // 9. RSI/Disparity 경계값 분석
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [ANALYSIS 7] RSI & Disparity boundary analysis for overheated stocks');
  console.log('  How many overheated stocks fall near the boundary?');
  console.log('='.repeat(90));

  const ohWithRsiDisp = overheatStocks.filter(r => r.rsi != null && r.disparity != null);

  // RSI buckets
  const rsiBuckets = [
    { label: 'RSI 80-82', lo: 80, hi: 82 },
    { label: 'RSI 82-85', lo: 82, hi: 85 },
    { label: 'RSI 85-88', lo: 85, hi: 88 },
    { label: 'RSI 88-90', lo: 88, hi: 90 },
    { label: 'RSI 90+', lo: 90, hi: 999 },
  ];

  console.log(`\n  RSI distribution of overheated stocks (${ohWithRsiDisp.length} with data):`);
  for (const bucket of rsiBuckets) {
    const inBucket = ohWithRsiDisp.filter(r => r.rsi > bucket.lo && r.rsi <= bucket.hi);
    const bucketReturns = inBucket.map(r => {
      const ret = calcReturns(r, priceMap);
      return ret ? { ...ret } : null;
    }).filter(Boolean);
    const st = calcStats(bucketReturns);
    console.log(`  ${bucket.label.padEnd(14)}: ${String(inBucket.length).padStart(4)} stocks | ${st ? `WR(+5%)=${st.winRate5.toFixed(1)}%, AvgMax=${fmtPct(st.avgMax)}, AvgD3=${fmtPct(st.avgD3)}` : 'no price data'}`);
  }

  // Disparity buckets
  const dispBuckets = [
    { label: 'Disp 115-118', lo: 115, hi: 118 },
    { label: 'Disp 118-120', lo: 118, hi: 120 },
    { label: 'Disp 120-125', lo: 120, hi: 125 },
    { label: 'Disp 125-130', lo: 125, hi: 130 },
    { label: 'Disp 130+', lo: 130, hi: 999 },
  ];

  console.log(`\n  Disparity distribution of overheated stocks:`);
  for (const bucket of dispBuckets) {
    const inBucket = ohWithRsiDisp.filter(r => r.disparity > bucket.lo && r.disparity <= bucket.hi);
    const bucketReturns = inBucket.map(r => {
      const ret = calcReturns(r, priceMap);
      return ret ? { ...ret } : null;
    }).filter(Boolean);
    const st = calcStats(bucketReturns);
    console.log(`  ${bucket.label.padEnd(14)}: ${String(inBucket.length).padStart(4)} stocks | ${st ? `WR(+5%)=${st.winRate5.toFixed(1)}%, AvgMax=${fmtPct(st.avgMax)}, AvgD3=${fmtPct(st.avgD3)}` : 'no price data'}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 10. 요약 및 권고
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log('  [SUMMARY] Key Findings');
  console.log('='.repeat(90));

  console.log(`\n  1. Overheated stocks: ${overheatStocks.length} / ${allRecs.length} (${(overheatStocks.length / allRecs.length * 100).toFixed(1)}%)`);

  if (ohStats && nonOhStats) {
    console.log(`  2. Performance comparison:`);
    console.log(`     - Overheated WR(+5%): ${ohStats.winRate5.toFixed(1)}%, Avg max: ${fmtPct(ohStats.avgMax)}, Avg D3: ${fmtPct(ohStats.avgD3)}`);
    console.log(`     - Non-overheated WR(+5%): ${nonOhStats.winRate5.toFixed(1)}%, Avg max: ${fmtPct(nonOhStats.avgMax)}, Avg D3: ${fmtPct(nonOhStats.avgD3)}`);
    const diff = ohStats.avgMax - nonOhStats.avgMax;
    console.log(`     - Difference in avg max return: ${fmtPct(diff)}`);
  }

  console.log(`  3. Days with TOP3 < 3 (current): ${simResults.current.daysLt3} / ${simResults.current.totalDays}`);

  for (const key of ['optionA', 'optionB', 'optionC']) {
    const res = simResults[key];
    console.log(`  4. ${res.label}:`);
    console.log(`     - Days with TOP3 < 3: ${res.daysLt3} (was ${simResults.current.daysLt3})`);
    console.log(`     - Additional slots filled: ${res.filledSlots}`);
    console.log(`     - Days fixed (<3 -> 3): ${res.daysNowFull}`);
  }

  console.log('\n' + '='.repeat(90));
  console.log('  Analysis complete.');
  console.log('='.repeat(90));
}

main().catch(console.error).finally(() => process.exit(0));
