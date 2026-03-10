const data = require('./perf30.json');
const stocks = data.stocks || [];

console.log(`=== v1 vs v2 성과 비교 (${stocks.length}개 종목, 최근 30일) ===\n`);

// v2 데이터 있는 종목만
const withV2 = stocks.filter(s => s.total_score_v2 > 0);
const withoutV2 = stocks.filter(s => !s.total_score_v2 || s.total_score_v2 === 0);
console.log(`v2 점수 있음: ${withV2.length}개, 없음: ${withoutV2.length}개\n`);

// 기하평균 계산
function geoMean(returns) {
  if (!returns || returns.length === 0) return 0;
  const product = returns.reduce((acc, r) => acc * (1 + r / 100), 1);
  return (Math.pow(product, 1 / returns.length) - 1) * 100;
}

// ==========================================
// 1. TOP3 성과 비교 (날짜별)
// ==========================================
console.log('─'.repeat(70));
console.log('1. TOP3 성과 비교 (날짜별)');
console.log('─'.repeat(70));

const byDate = {};
stocks.forEach(s => {
  const d = s.recommendation_date;
  if (!byDate[d]) byDate[d] = [];
  byDate[d].push(s);
});

let v1Top3Returns = [];
let v2Top3Returns = [];
let v1Top3Wins = 0, v1Top3Total = 0;
let v2Top3Wins = 0, v2Top3Total = 0;

Object.entries(byDate).sort().forEach(([date, dateStocks]) => {
  const v1t3 = dateStocks.filter(s => s.is_top3);
  const v2t3 = dateStocks.filter(s => s.is_top3_v2);

  if (v1t3.length === 0 && v2t3.length === 0) return;

  const v1Avg = v1t3.length > 0 ? geoMean(v1t3.map(s => s.current_return)) : null;
  const v2Avg = v2t3.length > 0 ? geoMean(v2t3.map(s => s.current_return)) : null;
  const v1Win = v1t3.filter(s => s.current_return > 0).length;
  const v2Win = v2t3.filter(s => s.current_return > 0).length;

  v1t3.forEach(s => { v1Top3Returns.push(s.current_return); v1Top3Total++; if (s.current_return > 0) v1Top3Wins++; });
  v2t3.forEach(s => { v2Top3Returns.push(s.current_return); v2Top3Total++; if (s.current_return > 0) v2Top3Wins++; });

  const winner = v1Avg !== null && v2Avg !== null ? (v2Avg > v1Avg ? 'v2' : v1Avg > v2Avg ? 'v1' : 'tie') : '-';
  const winTag = winner === 'v2' ? ' << v2' : winner === 'v1' ? ' << v1' : '';

  console.log(`${date}: v1 TOP3 ${v1Avg !== null ? v1Avg.toFixed(2)+'%' : '-'} (${v1Win}/${v1t3.length}) | v2 TOP3 ${v2Avg !== null ? v2Avg.toFixed(2)+'%' : '-'} (${v2Win}/${v2t3.length})${winTag}`);

  // 종목 비교 (겹치는/다른 종목)
  const v1Codes = new Set(v1t3.map(s => s.stock_code));
  const v2Codes = new Set(v2t3.map(s => s.stock_code));
  const overlap = [...v1Codes].filter(c => v2Codes.has(c));
  const v1Only = [...v1Codes].filter(c => !v2Codes.has(c));
  const v2Only = [...v2Codes].filter(c => !v1Codes.has(c));

  if (v1Only.length > 0 || v2Only.length > 0) {
    const v1OnlyNames = v1t3.filter(s => v1Only.includes(s.stock_code)).map(s => `${s.stock_name}(${s.current_return.toFixed(1)}%)`);
    const v2OnlyNames = v2t3.filter(s => v2Only.includes(s.stock_code)).map(s => `${s.stock_name}(${s.current_return.toFixed(1)}%)`);
    if (v1OnlyNames.length) console.log(`    v1만: ${v1OnlyNames.join(', ')}`);
    if (v2OnlyNames.length) console.log(`    v2만: ${v2OnlyNames.join(', ')}`);
  }
});

console.log('\n--- TOP3 종합 ---');
console.log(`v1 TOP3: 승률 ${(v1Top3Wins/v1Top3Total*100).toFixed(1)}% (${v1Top3Wins}/${v1Top3Total}), 평균수익 ${geoMean(v1Top3Returns).toFixed(2)}%`);
console.log(`v2 TOP3: 승률 ${(v2Top3Wins/v2Top3Total*100).toFixed(1)}% (${v2Top3Wins}/${v2Top3Total}), 평균수익 ${geoMean(v2Top3Returns).toFixed(2)}%`);

// ==========================================
// 2. 점수 구간별 성과 비교
// ==========================================
console.log('\n' + '─'.repeat(70));
console.log('2. 점수 구간별 성과 비교 (v2 데이터 있는 종목만)');
console.log('─'.repeat(70));

function analyzeByRange(stockList, scoreKey, label) {
  const ranges = [
    { name: '40-49', lo: 40, hi: 49 },
    { name: '50-59', lo: 50, hi: 59 },
    { name: '60-69', lo: 60, hi: 69 },
    { name: '70-79', lo: 70, hi: 79 },
    { name: '80+', lo: 80, hi: 999 }
  ];

  console.log(`\n  [${label}]`);
  console.log(`  ${'구간'.padEnd(8)} ${'샘플'.padEnd(6)} ${'승률'.padEnd(10)} ${'평균수익'.padEnd(12)} ${'최고'.padEnd(10)} ${'최저'}`);

  ranges.forEach(r => {
    const group = stockList.filter(s => s[scoreKey] >= r.lo && s[scoreKey] <= r.hi);
    if (group.length === 0) return;
    const wins = group.filter(s => s.current_return > 0).length;
    const returns = group.map(s => s.current_return);
    const avg = geoMean(returns);
    const max = Math.max(...returns);
    const min = Math.min(...returns);
    console.log(`  ${r.name.padEnd(8)} ${String(group.length).padEnd(6)} ${(wins/group.length*100).toFixed(1).padEnd(10)}% ${avg.toFixed(2).padEnd(12)}% ${max.toFixed(1).padEnd(10)}% ${min.toFixed(1)}%`);
  });
}

analyzeByRange(withV2, 'total_score', 'v1 점수 기준');
analyzeByRange(withV2, 'total_score_v2', 'v2 점수 기준');

// ==========================================
// 3. 수급 기반 분석 (v2 핵심: Supply Score)
// ==========================================
console.log('\n' + '─'.repeat(70));
console.log('3. 수급 조건별 성과 (v2 Supply Score 핵심 가설 검증)');
console.log('─'.repeat(70));

const dualSupply = stocks.filter(s => (s.institution_buy_days || 0) >= 2 && (s.foreign_buy_days || 0) >= 2);
const instOnly = stocks.filter(s => (s.institution_buy_days || 0) >= 2 && (s.foreign_buy_days || 0) < 2);
const foreignOnly = stocks.filter(s => (s.foreign_buy_days || 0) >= 2 && (s.institution_buy_days || 0) < 2);
const noSupply = stocks.filter(s => (s.institution_buy_days || 0) < 1 && (s.foreign_buy_days || 0) < 1);

function printGroup(label, group) {
  if (group.length === 0) { console.log(`${label}: 0개`); return; }
  const wins = group.filter(s => s.current_return > 0).length;
  const avg = geoMean(group.map(s => s.current_return));
  console.log(`${label}: ${group.length}개, 승률 ${(wins/group.length*100).toFixed(1)}%, 평균 ${avg.toFixed(2)}%`);
}

printGroup('쌍방수급 (기관2+외국인2)', dualSupply);
printGroup('기관만 2일+', instOnly);
printGroup('외국인만 2일+', foreignOnly);
printGroup('수급 없음', noSupply);

// ==========================================
// 4. v1 고득점인데 v2 저득점 / 반대 케이스
// ==========================================
console.log('\n' + '─'.repeat(70));
console.log('4. v1 vs v2 점수 괴리 종목 (실제 수익률로 누가 맞았나)');
console.log('─'.repeat(70));

const divergent = withV2.map(s => ({
  ...s,
  diff: s.total_score_v2 - s.total_score,
  absDiff: Math.abs(s.total_score_v2 - s.total_score)
})).filter(s => s.absDiff >= 10).sort((a,b) => b.diff - a.diff);

if (divergent.length > 0) {
  console.log('\nv2가 v1보다 높게 평가 (v2-v1 >= 10):');
  divergent.filter(s => s.diff >= 10).forEach(s => {
    console.log(`  ${s.stock_name} (${s.stock_code}): v1=${s.total_score} v2=${s.total_score_v2} 차이=${s.diff>0?'+':''}${s.diff} → 실제 ${s.current_return.toFixed(1)}% ${s.current_return > 0 ? '(v2 맞음)' : '(v2 틀림)'}`);
  });

  console.log('\nv1이 v2보다 높게 평가 (v1-v2 >= 10):');
  divergent.filter(s => s.diff <= -10).forEach(s => {
    console.log(`  ${s.stock_name} (${s.stock_code}): v1=${s.total_score} v2=${s.total_score_v2} 차이=${s.diff>0?'+':''}${s.diff} → 실제 ${s.current_return.toFixed(1)}% ${s.current_return > 0 ? '(v1 맞음)' : '(v1 틀림)'}`);
  });
} else {
  console.log('10점 이상 괴리 종목 없음');
}
