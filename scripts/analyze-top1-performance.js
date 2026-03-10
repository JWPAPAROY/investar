/**
 * TOP1 몰빵 전략 분석 스크립트
 *
 * 목적: TOP3 중 1순위 종목의 승률/수익률을 극대화할 수 있는 지표 조합 탐색
 *
 * 분석 항목:
 * 1. TOP3 순위별(1위/2위/3위) 성과 비교
 * 2. 성공한 TOP1 vs 실패한 TOP1의 지표 차이
 * 3. 지표별 상관관계 분석
 * 4. 최적 필터 조합 탐색
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// TOP3 선별 로직 재현 (screening.js selectTop3과 동일)
function simulateTop3(stocks) {
  const eligible = stocks.filter(s =>
    s.whale_detected &&
    s.recommendation_grade !== '과열' &&
    Math.abs(s.change_rate || 0) < 25 &&
    (s.disparity || 100) < 150
  );

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

async function main() {
  console.log('='.repeat(80));
  console.log('📊 TOP1 몰빵 전략 분석');
  console.log('='.repeat(80));

  // 1. 전체 추천 데이터 조회
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
    if (error) { console.error('DB 오류:', error.message); return; }
    if (!data || data.length === 0) break;
    allRecs.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  console.log(`\n📦 전체 추천 데이터: ${allRecs.length}건`);

  // 2. 일별 가격 데이터 조회 (ID 배치 × 페이지네이션)
  const recIds = allRecs.map(r => r.id);
  let allPrices = [];
  const BATCH = 300; // .in() 배치 크기
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
      if (error) { console.error('가격 DB 오류:', error.message); break; }
      if (data) allPrices.push(...data);
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
  }
  console.log(`📦 일별 가격 데이터: ${allPrices.length}건`);

  // 가격 데이터를 recommendation_id별로 그룹핑
  const priceMap = new Map();
  for (const p of allPrices) {
    if (!priceMap.has(p.recommendation_id)) priceMap.set(p.recommendation_id, []);
    priceMap.get(p.recommendation_id).push(p);
  }

  // 3. 날짜별 종목 그룹핑 후 TOP3 시뮬레이션
  const dateMap = new Map();
  for (const rec of allRecs) {
    const d = rec.recommendation_date;
    if (!dateMap.has(d)) dateMap.set(d, []);
    dateMap.get(d).push(rec);
  }

  const dates = [...dateMap.keys()].sort();
  console.log(`📅 분석 기간: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length}일)`);

  // 각 종목의 수익률 계산 (최고 수익률, 3일 후 수익률)
  function calcReturns(rec) {
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

  // 4. TOP3 순위별 성과 분석
  console.log('\n' + '='.repeat(80));
  console.log('📈 [분석 1] TOP3 순위별 성과 비교');
  console.log('='.repeat(80));

  const rankStats = { 1: [], 2: [], 3: [] };
  const top1Details = []; // TOP1 상세 데이터 (지표 분석용)

  for (const date of dates) {
    const stocks = dateMap.get(date).sort((a, b) => b.total_score - a.total_score);
    const top3 = simulateTop3(stocks);

    top3.forEach((stock, i) => {
      const rank = i + 1;
      const ret = calcReturns(stock);
      if (!ret) return;

      rankStats[rank].push({
        ...ret,
        stock_code: stock.stock_code,
        stock_name: stock.stock_name,
        date,
        total_score: stock.total_score,
        // 지표들
        whale_confirmed: stock.whale_confirmed,
        institution_buy_days: stock.institution_buy_days || 0,
        foreign_buy_days: stock.foreign_buy_days || 0,
        rsi: stock.rsi,
        mfi: stock.mfi,
        disparity: stock.disparity,
        volume_ratio: stock.volume_ratio,
        market_cap: stock.market_cap,
        consecutive_rise_days: stock.consecutive_rise_days || 0,
        escape_velocity: stock.escape_velocity,
        asymmetric_ratio: stock.asymmetric_ratio,
        base_score: stock.base_score,
        whale_bonus: stock.whale_bonus,
        momentum_score: stock.momentum_score,
        trend_score: stock.trend_score,
        signal_adjustment: stock.signal_adjustment || 0,
        change_rate: stock.change_rate,
        vpd_raw: stock.vpd_raw,
        volume_acceleration_score: stock.volume_acceleration_score,
        upper_shadow_ratio: stock.upper_shadow_ratio,
      });

      if (rank === 1) {
        top1Details.push({
          date,
          stock_code: stock.stock_code,
          stock_name: stock.stock_name,
          ...ret,
          // 전체 지표
          total_score: stock.total_score,
          whale_confirmed: stock.whale_confirmed,
          institution_buy_days: stock.institution_buy_days || 0,
          foreign_buy_days: stock.foreign_buy_days || 0,
          dual_supply: (stock.institution_buy_days || 0) >= 2 && (stock.foreign_buy_days || 0) >= 2,
          rsi: stock.rsi,
          mfi: stock.mfi,
          disparity: stock.disparity,
          volume_ratio: stock.volume_ratio,
          market_cap: stock.market_cap,
          consecutive_rise_days: stock.consecutive_rise_days || 0,
          escape_velocity: stock.escape_velocity,
          asymmetric_ratio: stock.asymmetric_ratio,
          base_score: stock.base_score,
          whale_bonus: stock.whale_bonus,
          momentum_score: stock.momentum_score,
          trend_score: stock.trend_score,
          signal_adjustment: stock.signal_adjustment || 0,
          change_rate: stock.change_rate,
          vpd_raw: stock.vpd_raw,
          volume_acceleration_score: stock.volume_acceleration_score,
          upper_shadow_ratio: stock.upper_shadow_ratio,
        });
      }
    });
  }

  for (const rank of [1, 2, 3]) {
    const data = rankStats[rank];
    if (data.length === 0) { console.log(`  ${rank}순위: 데이터 없음`); continue; }

    const wins = data.filter(d => d.maxReturn >= 5);
    const losses = data.filter(d => d.lastReturn < 0);
    const avgMax = (data.reduce((s, d) => s + d.maxReturn, 0) / data.length).toFixed(2);
    const avgDay3 = (data.reduce((s, d) => s + d.day3Return, 0) / data.length).toFixed(2);
    const avgLast = (data.reduce((s, d) => s + d.lastReturn, 0) / data.length).toFixed(2);
    const medianMax = data.map(d => d.maxReturn).sort((a, b) => a - b)[Math.floor(data.length / 2)].toFixed(2);

    console.log(`\n  📌 ${rank}순위 (${data.length}건)`);
    console.log(`     승률(최고+5%): ${(wins.length / data.length * 100).toFixed(1)}% (${wins.length}/${data.length})`);
    console.log(`     손실률(최종<0): ${(losses.length / data.length * 100).toFixed(1)}%`);
    console.log(`     평균 최고수익: +${avgMax}%`);
    console.log(`     중앙값 최고수익: +${medianMax}%`);
    console.log(`     평균 3일후수익: ${avgDay3}%`);
    console.log(`     평균 최종수익: ${avgLast}%`);
  }

  // 5. TOP1 성공/실패 지표 비교
  console.log('\n' + '='.repeat(80));
  console.log('📈 [분석 2] TOP1 성공 vs 실패 지표 비교');
  console.log('   (성공 = 최고수익 +5% 이상, 실패 = 최고수익 +5% 미만)');
  console.log('='.repeat(80));

  const success = top1Details.filter(d => d.maxReturn >= 5);
  const fail = top1Details.filter(d => d.maxReturn < 5);

  console.log(`\n  성공: ${success.length}건, 실패: ${fail.length}건`);

  const indicators = [
    { key: 'total_score', label: '총점' },
    { key: 'base_score', label: 'Base점수' },
    { key: 'whale_bonus', label: 'Whale보너스' },
    { key: 'momentum_score', label: 'Momentum점수' },
    { key: 'trend_score', label: 'Trend점수' },
    { key: 'signal_adjustment', label: 'Signal가감' },
    { key: 'volume_ratio', label: '거래량비율' },
    { key: 'rsi', label: 'RSI' },
    { key: 'mfi', label: 'MFI' },
    { key: 'disparity', label: '이격도' },
    { key: 'institution_buy_days', label: '기관매수일' },
    { key: 'foreign_buy_days', label: '외국인매수일' },
    { key: 'consecutive_rise_days', label: '연속상승일' },
    { key: 'change_rate', label: '당일등락률' },
    { key: 'volume_acceleration_score', label: '거래량가속점수' },
    { key: 'asymmetric_ratio', label: '비대칭비율' },
    { key: 'vpd_raw', label: 'VPD원시값' },
    { key: 'upper_shadow_ratio', label: '윗꼬리비율' },
  ];

  function avg(arr, key) {
    const vals = arr.map(d => d[key]).filter(v => v != null && !isNaN(v));
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  function median(arr, key) {
    const vals = arr.map(d => d[key]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    if (vals.length === 0) return null;
    return vals[Math.floor(vals.length / 2)];
  }

  console.log(`\n  ${'지표'.padEnd(18)} | ${'성공 평균'.padStart(10)} | ${'실패 평균'.padStart(10)} | ${'차이'.padStart(8)} | ${'성공 중앙'.padStart(10)} | ${'실패 중앙'.padStart(10)}`);
  console.log(`  ${'-'.repeat(18)}-+-${'-'.repeat(10)}-+-${'-'.repeat(10)}-+-${'-'.repeat(8)}-+-${'-'.repeat(10)}-+-${'-'.repeat(10)}`);

  for (const ind of indicators) {
    const sAvg = avg(success, ind.key);
    const fAvg = avg(fail, ind.key);
    const sMed = median(success, ind.key);
    const fMed = median(fail, ind.key);
    const diff = (sAvg != null && fAvg != null) ? sAvg - fAvg : null;

    console.log(`  ${ind.label.padEnd(18)} | ${sAvg != null ? sAvg.toFixed(2).padStart(10) : 'N/A'.padStart(10)} | ${fAvg != null ? fAvg.toFixed(2).padStart(10) : 'N/A'.padStart(10)} | ${diff != null ? (diff >= 0 ? '+' : '') + diff.toFixed(2) : 'N/A'.padStart(7)}  | ${sMed != null ? sMed.toFixed(2).padStart(10) : 'N/A'.padStart(10)} | ${fMed != null ? fMed.toFixed(2).padStart(10) : 'N/A'.padStart(10)}`);
  }

  // boolean 지표 비교
  console.log(`\n  --- Boolean 지표 ---`);
  const boolIndicators = [
    { key: 'whale_confirmed', label: '확인된 고래' },
    { key: 'escape_velocity', label: '탈출속도 달성' },
    { key: 'dual_supply', label: '쌍방수급(기관2+외국인2)' },
  ];

  for (const ind of boolIndicators) {
    const sRate = success.length > 0 ? (success.filter(d => d[ind.key]).length / success.length * 100).toFixed(1) : 'N/A';
    const fRate = fail.length > 0 ? (fail.filter(d => d[ind.key]).length / fail.length * 100).toFixed(1) : 'N/A';
    console.log(`  ${ind.label.padEnd(28)} | 성공: ${sRate}% | 실패: ${fRate}%`);
  }

  // 6. 필터 조합별 TOP1 성과 시뮬레이션
  console.log('\n' + '='.repeat(80));
  console.log('📈 [분석 3] 필터 조합별 TOP1 성과 시뮬레이션');
  console.log('   (기존 TOP1에 추가 필터를 적용하면 성과가 어떻게 변하는가?)');
  console.log('='.repeat(80));

  const filters = [
    { name: '기본 (현재 로직)', fn: () => true },
    { name: '확인된 고래만', fn: d => d.whale_confirmed },
    { name: '기관 ≥ 1일', fn: d => d.institution_buy_days >= 1 },
    { name: '기관 ≥ 2일', fn: d => d.institution_buy_days >= 2 },
    { name: '기관 ≥ 3일', fn: d => d.institution_buy_days >= 3 },
    { name: '외국인 ≥ 1일', fn: d => d.foreign_buy_days >= 1 },
    { name: '외국인 ≥ 2일', fn: d => d.foreign_buy_days >= 2 },
    { name: '쌍방수급 (기관2+외국인2)', fn: d => d.institution_buy_days >= 2 && d.foreign_buy_days >= 2 },
    { name: '탈출속도 달성', fn: d => d.escape_velocity },
    { name: '확인된 고래 + 기관≥1', fn: d => d.whale_confirmed && d.institution_buy_days >= 1 },
    { name: '확인된 고래 + 쌍방수급', fn: d => d.whale_confirmed && d.institution_buy_days >= 2 && d.foreign_buy_days >= 2 },
    { name: 'RSI 40-65', fn: d => d.rsi >= 40 && d.rsi <= 65 },
    { name: 'RSI 50-70', fn: d => d.rsi >= 50 && d.rsi <= 70 },
    { name: '이격도 100-110', fn: d => d.disparity >= 100 && d.disparity <= 110 },
    { name: '이격도 100-115', fn: d => d.disparity >= 100 && d.disparity <= 115 },
    { name: '당일등락률 0-5%', fn: d => d.change_rate >= 0 && d.change_rate <= 5 },
    { name: '당일등락률 0-10%', fn: d => d.change_rate >= 0 && d.change_rate <= 10 },
    { name: '거래량비율 1.0-2.0', fn: d => d.volume_ratio >= 1.0 && d.volume_ratio <= 2.0 },
    { name: '거래량비율 1.0-3.0', fn: d => d.volume_ratio >= 1.0 && d.volume_ratio <= 3.0 },
    { name: '시총 ≥ 5000억', fn: d => d.market_cap >= 500000000000 },
    { name: '시총 ≥ 1조', fn: d => d.market_cap >= 1000000000000 },
    { name: '연속상승 ≥ 2일', fn: d => d.consecutive_rise_days >= 2 },
    { name: '연속상승 ≥ 3일', fn: d => d.consecutive_rise_days >= 3 },
    // 복합 필터
    { name: '★ 확인고래+기관≥1+RSI50-70', fn: d => d.whale_confirmed && d.institution_buy_days >= 1 && d.rsi >= 50 && d.rsi <= 70 },
    { name: '★ 확인고래+기관≥1+이격도100-110', fn: d => d.whale_confirmed && d.institution_buy_days >= 1 && d.disparity >= 100 && d.disparity <= 110 },
    { name: '★ 기관≥2+외국인≥1+RSI<70', fn: d => d.institution_buy_days >= 2 && d.foreign_buy_days >= 1 && d.rsi < 70 },
    { name: '★ 확인고래+시총≥5000억', fn: d => d.whale_confirmed && d.market_cap >= 500000000000 },
    { name: '★ 확인고래+등락률0-5%+기관≥1', fn: d => d.whale_confirmed && d.change_rate >= 0 && d.change_rate <= 5 && d.institution_buy_days >= 1 },
  ];

  console.log(`\n  ${'필터'.padEnd(40)} | ${'건수'.padStart(4)} | ${'승률+5%'.padStart(8)} | ${'평균최고'.padStart(8)} | ${'중앙최고'.padStart(8)} | ${'평균3일'.padStart(8)} | ${'평균최종'.padStart(8)}`);
  console.log(`  ${'-'.repeat(40)}-+-${'-'.repeat(4)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}`);

  for (const f of filters) {
    const filtered = top1Details.filter(f.fn);
    if (filtered.length === 0) {
      console.log(`  ${f.name.padEnd(40)} |    0 |      N/A |      N/A |      N/A |      N/A |      N/A`);
      continue;
    }

    const wins = filtered.filter(d => d.maxReturn >= 5);
    const winRate = (wins.length / filtered.length * 100).toFixed(1);
    const avgMax = (filtered.reduce((s, d) => s + d.maxReturn, 0) / filtered.length).toFixed(2);
    const medMax = filtered.map(d => d.maxReturn).sort((a, b) => a - b)[Math.floor(filtered.length / 2)].toFixed(2);
    const avgD3 = (filtered.reduce((s, d) => s + d.day3Return, 0) / filtered.length).toFixed(2);
    const avgLast = (filtered.reduce((s, d) => s + d.lastReturn, 0) / filtered.length).toFixed(2);

    console.log(`  ${f.name.padEnd(40)} | ${String(filtered.length).padStart(4)} | ${(winRate + '%').padStart(8)} | ${('+' + avgMax + '%').padStart(8)} | ${('+' + medMax + '%').padStart(8)} | ${(avgD3 >= 0 ? '+' : '') + avgD3 + '%'} | ${(avgLast >= 0 ? '+' : '') + avgLast + '%'}`);
  }

  // 7. TOP1 개별 종목 목록 (최근 20건)
  console.log('\n' + '='.repeat(80));
  console.log('📈 [분석 4] 최근 TOP1 종목 상세 (최근 20건)');
  console.log('='.repeat(80));

  const recent = top1Details.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  console.log(`\n  ${'날짜'.padEnd(12)} | ${'종목'.padEnd(14)} | ${'점수'.padStart(5)} | ${'확인'.padStart(4)} | ${'기관'.padStart(4)} | ${'외인'.padStart(4)} | ${'RSI'.padStart(5)} | ${'이격'.padStart(6)} | ${'최고%'.padStart(7)} | ${'3일%'.padStart(7)} | ${'최종%'.padStart(7)}`);
  console.log(`  ${'-'.repeat(12)}-+-${'-'.repeat(14)}-+-${'-'.repeat(5)}-+-${'-'.repeat(4)}-+-${'-'.repeat(4)}-+-${'-'.repeat(4)}-+-${'-'.repeat(5)}-+-${'-'.repeat(6)}-+-${'-'.repeat(7)}-+-${'-'.repeat(7)}-+-${'-'.repeat(7)}`);

  for (const d of recent) {
    const name = (d.stock_name || d.stock_code).slice(0, 7);
    console.log(`  ${d.date.padEnd(12)} | ${name.padEnd(14)} | ${String(d.total_score?.toFixed(0) || '?').padStart(5)} | ${(d.whale_confirmed ? 'Y' : 'N').padStart(4)} | ${String(d.institution_buy_days).padStart(4)} | ${String(d.foreign_buy_days).padStart(4)} | ${(d.rsi?.toFixed(0) || '?').padStart(5)} | ${(d.disparity?.toFixed(1) || '?').padStart(6)} | ${(d.maxReturn >= 0 ? '+' : '') + d.maxReturn.toFixed(1) + '%'} | ${(d.day3Return >= 0 ? '+' : '') + d.day3Return.toFixed(1) + '%'} | ${(d.lastReturn >= 0 ? '+' : '') + d.lastReturn.toFixed(1) + '%'}`);
  }

  // 8. 상관계수 분석
  console.log('\n' + '='.repeat(80));
  console.log('📈 [분석 5] TOP1 지표-수익률 상관계수 (피어슨)');
  console.log('='.repeat(80));

  function pearson(arr, keyX, keyY) {
    const pairs = arr.filter(d => d[keyX] != null && d[keyY] != null && !isNaN(d[keyX]) && !isNaN(d[keyY]));
    if (pairs.length < 5) return null;
    const n = pairs.length;
    const sumX = pairs.reduce((s, d) => s + d[keyX], 0);
    const sumY = pairs.reduce((s, d) => s + d[keyY], 0);
    const sumXY = pairs.reduce((s, d) => s + d[keyX] * d[keyY], 0);
    const sumX2 = pairs.reduce((s, d) => s + d[keyX] * d[keyX], 0);
    const sumY2 = pairs.reduce((s, d) => s + d[keyY] * d[keyY], 0);
    const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (denom === 0) return null;
    return (n * sumXY - sumX * sumY) / denom;
  }

  const corrResults = [];
  for (const ind of indicators) {
    const rMax = pearson(top1Details, ind.key, 'maxReturn');
    const rD3 = pearson(top1Details, ind.key, 'day3Return');
    const rLast = pearson(top1Details, ind.key, 'lastReturn');
    corrResults.push({ label: ind.label, rMax, rD3, rLast });
  }

  // 상관계수 절대값 기준 정렬
  corrResults.sort((a, b) => Math.abs(b.rMax || 0) - Math.abs(a.rMax || 0));

  console.log(`\n  ${'지표'.padEnd(18)} | ${'최고수익 r'.padStart(10)} | ${'3일수익 r'.padStart(10)} | ${'최종수익 r'.padStart(10)} | N=${top1Details.length}`);
  console.log(`  ${'-'.repeat(18)}-+-${'-'.repeat(10)}-+-${'-'.repeat(10)}-+-${'-'.repeat(10)}`);

  for (const c of corrResults) {
    const fmt = (v) => v != null ? (v >= 0 ? '+' : '') + v.toFixed(3) : 'N/A';
    console.log(`  ${c.label.padEnd(18)} | ${fmt(c.rMax).padStart(10)} | ${fmt(c.rD3).padStart(10)} | ${fmt(c.rLast).padStart(10)}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ 분석 완료');
  console.log('='.repeat(80));
}

main().catch(console.error).finally(() => process.exit(0));
