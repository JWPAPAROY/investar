/**
 * 종목 풀 구성 변경 백테스트
 *
 * 목적: 등락률 상승 소스 제거 시 TOP3 구성 및 성과 변화 분석
 *
 * 프록시 기준:
 *   - change_rate ≥ 10%  → 등락률 상승 랭킹 소스일 확률 높음
 *   - volume_ratio ≥ 2.0 → 거래량 증가율/거래량 랭킹 소스
 *   - change_rate < 10%  → 등락률 상승 제외 후에도 풀에 남는 종목
 *
 * 분석:
 *   1. 등락률 상승 프록시 종목의 성과 vs 나머지
 *   2. 등락률 상승 프록시 제거 시 TOP3 재시뮬레이션
 *   3. 기존 TOP3 vs 재시뮬레이션 TOP3 성과 비교
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// TOP3 선별 로직 (screening.js selectTop3 재현)
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

  addFromRange(50, 69);
  addFromRange(80, 89);
  addFromRange(90, 100);
  addFromRange(70, 79);

  return top3;
}

// 등락률 상승 소스 프록시 판별
function isPriceChangeSource(rec) {
  return (rec.change_rate || 0) >= 10;
}

async function main() {
  console.log('='.repeat(80));
  console.log('📊 종목 풀 구성 변경 백테스트: 등락률 상승 제거 시뮬레이션');
  console.log('='.repeat(80));
  console.log(`\n프록시 기준: change_rate ≥ 10% → 등락률 상승 소스로 간주\n`);

  // 1. 전체 추천 데이터 조회
  let allRecs = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('screening_recommendations')
      .select('*')
      .order('recommendation_date', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) { console.error('DB 오류:', error.message); return; }
    if (!data || data.length === 0) break;
    allRecs.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  console.log(`📦 전체 추천 데이터: ${allRecs.length}건`);

  // 2. 일별 가격 데이터 조회
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
      if (error) { console.error('가격 DB 오류:', error.message); break; }
      if (data) allPrices.push(...data);
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
  }
  console.log(`📦 일별 가격 데이터: ${allPrices.length}건`);

  // 가격 데이터 그룹핑
  const priceMap = new Map();
  for (const p of allPrices) {
    if (!priceMap.has(p.recommendation_id)) priceMap.set(p.recommendation_id, []);
    priceMap.get(p.recommendation_id).push(p);
  }

  // 수익률 계산
  function calcReturns(rec) {
    const prices = priceMap.get(rec.id) || [];
    if (prices.length === 0 || !rec.recommended_price || rec.recommended_price <= 0) return null;
    const base = rec.recommended_price;
    const returns = prices.map(p => ((p.closing_price - base) / base) * 100);
    return {
      maxReturn: Math.max(...returns),
      day3Return: returns.length >= 3 ? returns[2] : returns[returns.length - 1],
      lastReturn: returns[returns.length - 1],
      minReturn: Math.min(...returns),
      trackDays: prices.length
    };
  }

  // ============================================================
  // 분석 1: 등락률 상승 프록시 종목 vs 나머지 - 전체 성과 비교
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('📈 분석 1: 등락률 상승 프록시 종목 vs 나머지 (전체 성과)');
  console.log('='.repeat(80));

  const priceChangeStocks = allRecs.filter(isPriceChangeSource);
  const otherStocks = allRecs.filter(r => !isPriceChangeSource(r));

  function analyzeGroup(group, label) {
    let wins = 0, losses = 0, totalReturn = 0, count = 0;
    const returns = [];
    for (const rec of group) {
      const r = calcReturns(rec);
      if (!r) continue;
      count++;
      returns.push(r.maxReturn);
      totalReturn += r.maxReturn;
      if (r.maxReturn > 0) wins++;
      else losses++;
    }
    const winRate = count > 0 ? (wins / count * 100).toFixed(1) : 'N/A';
    const avgReturn = count > 0 ? (totalReturn / count).toFixed(2) : 'N/A';
    const median = returns.length > 0 ? returns.sort((a, b) => a - b)[Math.floor(returns.length / 2)].toFixed(2) : 'N/A';

    console.log(`\n  [${label}]`);
    console.log(`    종목 수: ${group.length}건 (수익률 추적 가능: ${count}건)`);
    console.log(`    승률 (최고수익 > 0): ${winRate}%`);
    console.log(`    평균 최고수익률: ${avgReturn}%`);
    console.log(`    중앙값 최고수익률: ${median}%`);
    return { count, wins, winRate, avgReturn };
  }

  analyzeGroup(priceChangeStocks, '등락률 상승 프록시 (change_rate ≥ 10%)');
  analyzeGroup(otherStocks, '나머지 종목 (change_rate < 10%)');

  // 등급별 분포 비교
  console.log('\n  [등급 분포]');
  const gradeCount = (group) => {
    const grades = {};
    for (const r of group) {
      const g = r.recommendation_grade || '?';
      grades[g] = (grades[g] || 0) + 1;
    }
    return grades;
  };
  console.log(`    등락률 상승 프록시:`, gradeCount(priceChangeStocks));
  console.log(`    나머지:`, gradeCount(otherStocks));

  // 점수 분포
  const avgScore = (group) => group.length > 0
    ? (group.reduce((s, r) => s + (r.total_score || 0), 0) / group.length).toFixed(1)
    : 'N/A';
  console.log(`\n    평균 점수 - 등락률 상승 프록시: ${avgScore(priceChangeStocks)}점`);
  console.log(`    평균 점수 - 나머지: ${avgScore(otherStocks)}점`);

  // ============================================================
  // 분석 2: change_rate 구간별 성과
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('📈 분석 2: change_rate 구간별 성과');
  console.log('='.repeat(80));

  const bands = [
    { label: '< -5%', filter: r => (r.change_rate || 0) < -5 },
    { label: '-5% ~ 0%', filter: r => (r.change_rate || 0) >= -5 && (r.change_rate || 0) < 0 },
    { label: '0% ~ 5%', filter: r => (r.change_rate || 0) >= 0 && (r.change_rate || 0) < 5 },
    { label: '5% ~ 10%', filter: r => (r.change_rate || 0) >= 5 && (r.change_rate || 0) < 10 },
    { label: '10% ~ 15%', filter: r => (r.change_rate || 0) >= 10 && (r.change_rate || 0) < 15 },
    { label: '15% ~ 20%', filter: r => (r.change_rate || 0) >= 15 && (r.change_rate || 0) < 20 },
    { label: '≥ 20%', filter: r => (r.change_rate || 0) >= 20 },
  ];

  for (const band of bands) {
    const group = allRecs.filter(band.filter);
    if (group.length === 0) continue;
    let wins = 0, count = 0, totalReturn = 0;
    for (const rec of group) {
      const r = calcReturns(rec);
      if (!r) continue;
      count++;
      totalReturn += r.maxReturn;
      if (r.maxReturn > 0) wins++;
    }
    const winRate = count > 0 ? (wins / count * 100).toFixed(1) : '-';
    const avg = count > 0 ? (totalReturn / count).toFixed(2) : '-';
    console.log(`  ${band.label.padEnd(12)} | ${String(group.length).padStart(4)}건 | 추적 ${String(count).padStart(3)}건 | 승률 ${winRate.padStart(5)}% | 평균최고 ${avg.padStart(7)}%`);
  }

  // ============================================================
  // 분석 3: 날짜별 TOP3 재시뮬레이션 (등락률 상승 제거)
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('📈 분석 3: 등락률 상승 제거 후 TOP3 재시뮬레이션');
  console.log('='.repeat(80));

  const dateMap = new Map();
  for (const rec of allRecs) {
    const d = rec.recommendation_date;
    if (!dateMap.has(d)) dateMap.set(d, []);
    dateMap.get(d).push(rec);
  }
  const dates = [...dateMap.keys()].sort();

  let originalTop3All = [], filteredTop3All = [];
  let changedDays = 0, totalDays = 0;

  for (const date of dates) {
    const dayStocks = dateMap.get(date);

    // 기존 TOP3
    const originalTop3 = simulateTop3(dayStocks);
    // 등락률 상승 프록시 제거 후 TOP3
    const filteredStocks = dayStocks.filter(r => !isPriceChangeSource(r));
    const filteredTop3 = simulateTop3(filteredStocks);

    if (originalTop3.length === 0 && filteredTop3.length === 0) continue;
    totalDays++;

    const origCodes = new Set(originalTop3.map(s => s.stock_code));
    const filtCodes = new Set(filteredTop3.map(s => s.stock_code));
    const isSame = origCodes.size === filtCodes.size && [...origCodes].every(c => filtCodes.has(c));
    if (!isSame) changedDays++;

    originalTop3All.push(...originalTop3);
    filteredTop3All.push(...filteredTop3);

    // 변경된 날짜 상세 출력
    if (!isSame) {
      const removed = [...origCodes].filter(c => !filtCodes.has(c));
      const added = [...filtCodes].filter(c => !origCodes.has(c));
      const removedNames = removed.map(c => {
        const s = originalTop3.find(s => s.stock_code === c);
        return `${s.stock_name}(${c}, cr=${(s.change_rate||0).toFixed(1)}%, score=${(s.total_score||0).toFixed(1)})`;
      });
      const addedNames = added.map(c => {
        const s = filteredTop3.find(s => s.stock_code === c);
        return `${s.stock_name}(${c}, cr=${(s.change_rate||0).toFixed(1)}%, score=${(s.total_score||0).toFixed(1)})`;
      });
      console.log(`\n  📅 ${date} — TOP3 변경됨`);
      if (removedNames.length) console.log(`    ❌ 제거: ${removedNames.join(', ')}`);
      if (addedNames.length) console.log(`    ✅ 대체: ${addedNames.join(', ')}`);
    }
  }

  console.log(`\n  📊 요약: ${totalDays}일 중 ${changedDays}일 TOP3 변경 (${(changedDays/totalDays*100).toFixed(1)}%)`);

  // ============================================================
  // 분석 4: 기존 TOP3 vs 재시뮬레이션 TOP3 성과 비교
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('📈 분석 4: 기존 TOP3 vs 필터링 TOP3 성과 비교');
  console.log('='.repeat(80));

  function analyzeTop3Performance(top3List, label) {
    let wins = 0, count = 0, totalMax = 0, totalDay3 = 0;
    for (const rec of top3List) {
      const r = calcReturns(rec);
      if (!r) continue;
      count++;
      totalMax += r.maxReturn;
      totalDay3 += r.day3Return;
      if (r.maxReturn > 0) wins++;
    }
    console.log(`\n  [${label}] (${top3List.length}건, 추적 가능 ${count}건)`);
    if (count > 0) {
      console.log(`    승률 (최고 > 0%): ${(wins / count * 100).toFixed(1)}%`);
      console.log(`    평균 최고수익률: ${(totalMax / count).toFixed(2)}%`);
      console.log(`    평균 D+3 수익률: ${(totalDay3 / count).toFixed(2)}%`);
    } else {
      console.log(`    추적 데이터 없음`);
    }
  }

  analyzeTop3Performance(originalTop3All, '기존 TOP3 (50-50-50-50)');
  analyzeTop3Performance(filteredTop3All, '필터링 TOP3 (등락률 상승 제거)');

  // ============================================================
  // 분석 5: 등락률 상승 프록시 종목이 실제 TOP3에 포함된 빈도
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('📈 분석 5: 등락률 상승 프록시 종목의 TOP3 포함 빈도');
  console.log('='.repeat(80));

  const top3WithPriceChange = originalTop3All.filter(isPriceChangeSource);
  console.log(`\n  기존 TOP3 전체: ${originalTop3All.length}건`);
  console.log(`  그 중 등락률 상승 프록시: ${top3WithPriceChange.length}건 (${(top3WithPriceChange.length / originalTop3All.length * 100).toFixed(1)}%)`);

  if (top3WithPriceChange.length > 0) {
    console.log(`\n  해당 종목 상세:`);
    for (const rec of top3WithPriceChange) {
      const r = calcReturns(rec);
      const retStr = r ? `최고 ${r.maxReturn.toFixed(1)}%, D3 ${r.day3Return.toFixed(1)}%` : '추적없음';
      console.log(`    ${rec.recommendation_date} | ${rec.stock_name} (${rec.stock_code}) | change_rate=${(rec.change_rate||0).toFixed(1)}% | score=${(rec.total_score||0).toFixed(1)} | ${retStr}`);
    }
  }

  // ============================================================
  // 분석 6: 풀에서 제거되는 종목 수 영향
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('📈 분석 6: 등락률 상승 제거 시 풀 크기 변화');
  console.log('='.repeat(80));

  for (const date of dates) {
    const dayStocks = dateMap.get(date);
    const filtered = dayStocks.filter(r => !isPriceChangeSource(r));
    const removed = dayStocks.length - filtered.length;
    if (removed > 0) {
      console.log(`  ${date}: ${dayStocks.length}개 → ${filtered.length}개 (${removed}개 제거, -${(removed/dayStocks.length*100).toFixed(0)}%)`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ 백테스트 완료');
  console.log('='.repeat(80));
}

main().catch(console.error);
