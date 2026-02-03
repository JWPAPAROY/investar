/**
 * 급등 종목 공통점 분석
 * "실제로 급등한 종목은 추천 당시 어떤 특징이 있었는가?"
 */
const data = require('./tmp-perf-30d.json');
const stocks = data.stocks || [];

console.log('=== 급등 종목 vs 부진 종목 비교 분석 ===');
console.log('총 추천:', stocks.length, '개\n');

// 수익률 기준 분류
const surge = stocks.filter(s => s.current_return >= 10);   // +10% 이상 급등
const good = stocks.filter(s => s.current_return >= 0 && s.current_return < 10);  // 0~10% 소폭 수익
const loss = stocks.filter(s => s.current_return < 0);      // 손실

console.log(`급등(+10%↑): ${surge.length}개`);
console.log(`소폭수익(0~10%): ${good.length}개`);
console.log(`손실(<0%): ${loss.length}개\n`);

// 지표별 평균 비교
function analyzeGroup(group, label) {
  if (group.length === 0) return null;

  const avg = (arr, fn) => arr.reduce((s, x) => s + (fn(x) || 0), 0) / arr.length;
  const pct = (arr, fn) => (arr.filter(fn).length / arr.length * 100).toFixed(1);

  return {
    label,
    count: group.length,
    avgReturn: avg(group, s => s.current_return).toFixed(2),
    avgScore: avg(group, s => s.total_score).toFixed(1),
    avgMFI: avg(group, s => s.mfi).toFixed(1),
    avgVolumeRatio: avg(group, s => s.volume_ratio).toFixed(2),
    avgChangeRate: avg(group, s => s.change_rate).toFixed(2),
    whaleRate: pct(group, s => s.whale_detected),
    accumRate: pct(group, s => s.accumulation_detected),
    avgVolume: avg(group, s => s.volume).toFixed(0),
    avgMarketCap: (avg(group, s => s.market_cap) / 100000000).toFixed(0) + '억',
  };
}

const results = [
  analyzeGroup(surge, '급등(+10%↑)'),
  analyzeGroup(good, '소폭수익(0~10%)'),
  analyzeGroup(loss, '손실(<0%)')
].filter(Boolean);

// 표 출력
console.log('지표              | ' + results.map(r => r.label.padEnd(16)).join('| '));
console.log('-'.repeat(80));

const metrics = [
  ['종목 수', 'count'],
  ['평균 수익률', 'avgReturn'],
  ['평균 점수', 'avgScore'],
  ['MFI (14일)', 'avgMFI'],
  ['거래량 비율', 'avgVolumeRatio'],
  ['당일 등락률', 'avgChangeRate'],
  ['고래 감지율', 'whaleRate'],
  ['매집 감지율', 'accumRate'],
  ['평균 거래량', 'avgVolume'],
  ['평균 시총', 'avgMarketCap'],
];

metrics.forEach(([label, key]) => {
  const vals = results.map(r => {
    let v = r[key];
    if (key === 'whaleRate' || key === 'accumRate') v += '%';
    if (key === 'avgReturn' || key === 'avgChangeRate') v += '%';
    return String(v).padEnd(16);
  });
  console.log(label.padEnd(18) + '| ' + vals.join('| '));
});

// 급등 종목 상세 리스트
console.log('\n\n=== 급등 종목 상세 (+10% 이상) ===\n');
surge
  .sort((a, b) => b.current_return - a.current_return)
  .forEach((s, i) => {
    console.log(`${i+1}. ${s.stock_name} (${s.stock_code})`);
    console.log(`   수익률: +${s.current_return.toFixed(1)}% | 점수: ${s.total_score} | 등급: ${s.recommendation_grade}`);
    console.log(`   MFI: ${s.mfi} | 거래량비율: ${(s.volume_ratio||0).toFixed(2)} | 등락률: ${(s.change_rate||0).toFixed(2)}%`);
    console.log(`   고래: ${s.whale_detected ? 'O' : 'X'} | 매집: ${s.accumulation_detected ? 'O' : 'X'} | 시총: ${(s.market_cap/100000000).toFixed(0)}억`);
    console.log(`   추천일: ${s.recommendation_date} | 경과: ${s.days_since_recommendation}일`);
    console.log('');
  });

// 핵심: 지표별 상관관계
console.log('\n=== 지표별 수익률 상관관계 ===\n');

function correlate(arr, getX, getY) {
  const n = arr.length;
  const xs = arr.map(getX);
  const ys = arr.map(getY);
  const xMean = xs.reduce((a,b) => a+b, 0) / n;
  const yMean = ys.reduce((a,b) => a+b, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

const validStocks = stocks.filter(s => s.current_return !== undefined && s.current_return !== null);

const correlations = [
  ['total_score', s => s.total_score || 0],
  ['mfi', s => s.mfi || 0],
  ['volume_ratio', s => s.volume_ratio || 0],
  ['change_rate', s => s.change_rate || 0],
  ['whale_detected', s => s.whale_detected ? 1 : 0],
  ['accumulation_detected', s => s.accumulation_detected ? 1 : 0],
  ['market_cap', s => s.market_cap || 0],
  ['volume', s => s.volume || 0],
].map(([name, getter]) => ({
  name,
  corr: correlate(validStocks, getter, s => s.current_return).toFixed(3)
})).sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));

correlations.forEach(c => {
  const dir = c.corr > 0.1 ? '↑ 양의 상관' : c.corr < -0.1 ? '↓ 음의 상관' : '— 무상관';
  console.log(`  ${c.name.padEnd(25)} r=${c.corr}  ${dir}`);
});

// 고래 감지 여부별 성과
console.log('\n\n=== 고래 감지 여부별 실제 성과 ===\n');
const whaleYes = validStocks.filter(s => s.whale_detected);
const whaleNo = validStocks.filter(s => !s.whale_detected);
const wAvg = arr => arr.length ? (arr.reduce((s,x) => s + x.current_return, 0) / arr.length).toFixed(2) : 'N/A';
const wWr = arr => arr.length ? (arr.filter(s => s.current_return > 0).length / arr.length * 100).toFixed(1) : 'N/A';

console.log(`고래 감지 O: ${whaleYes.length}개 | 승률 ${wWr(whaleYes)}% | 평균 ${wAvg(whaleYes)}%`);
console.log(`고래 감지 X: ${whaleNo.length}개 | 승률 ${wWr(whaleNo)}% | 평균 ${wAvg(whaleNo)}%`);

// MFI 구간별 성과
console.log('\n\n=== MFI 구간별 실제 성과 ===\n');
const mfiRanges = [
  {min: 0, max: 30, label: 'MFI 0-30 (과매도)'},
  {min: 30, max: 50, label: 'MFI 30-50'},
  {min: 50, max: 70, label: 'MFI 50-70'},
  {min: 70, max: 100, label: 'MFI 70-100 (과매수)'},
];
mfiRanges.forEach(r => {
  const items = validStocks.filter(s => (s.mfi||50) >= r.min && (s.mfi||50) < r.max);
  if (items.length === 0) return;
  console.log(`${r.label}: ${items.length}개 | 승률 ${wWr(items)}% | 평균 ${wAvg(items)}%`);
});

// 거래량 비율 구간별 성과
console.log('\n\n=== 거래량 비율 구간별 실제 성과 ===\n');
const vrRanges = [
  {min: 0, max: 1, label: '거래량 <1배 (평균 이하)'},
  {min: 1, max: 2, label: '거래량 1-2배'},
  {min: 2, max: 5, label: '거래량 2-5배'},
  {min: 5, max: 100, label: '거래량 5배+'},
];
vrRanges.forEach(r => {
  const items = validStocks.filter(s => (s.volume_ratio||0) >= r.min && (s.volume_ratio||0) < r.max);
  if (items.length === 0) return;
  console.log(`${r.label}: ${items.length}개 | 승률 ${wWr(items)}% | 평균 ${wAvg(items)}%`);
});

// 시총 구간별 성과
console.log('\n\n=== 시총 구간별 실제 성과 ===\n');
const mcRanges = [
  {min: 0, max: 1000e8, label: '시총 <1000억 (소형)'},
  {min: 1000e8, max: 5000e8, label: '시총 1000-5000억 (중형)'},
  {min: 5000e8, max: 1e13, label: '시총 5000억-1조'},
  {min: 1e13, max: Infinity, label: '시총 1조+ (대형)'},
];
mcRanges.forEach(r => {
  const items = validStocks.filter(s => (s.market_cap||0) >= r.min && (s.market_cap||0) < r.max);
  if (items.length === 0) return;
  console.log(`${r.label}: ${items.length}개 | 승률 ${wWr(items)}% | 평균 ${wAvg(items)}%`);
});
