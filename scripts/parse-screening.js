const fs = require('fs');
const data = JSON.parse(fs.readFileSync(__dirname + '/screening_result.json', 'utf8'));

console.log('=== 스크리닝 결과 요약 ===');
console.log('성공:', data.success);
console.log('시각:', data.timestamp);
console.log('총 종목수:', data.totalStocks);
console.log('버전:', data.version);

const s = data.marketSentiment || {};
const kospi = s.kospi || {};
const kosdaq = s.kosdaq || {};
console.log('\n=== 시장 심리 ===');
console.log('KOSPI:', kospi.label, '변동:', kospi.change + '%');
console.log('KOSDAQ:', kosdaq.label, '변동:', kosdaq.change + '%');

console.log('\n=== 모멘텀 TOP 3 ===');
const recs = data.recommendations || [];
recs.slice(0, 3).forEach((r, i) => {
  const bd = r.scoreBreakdown || {};
  console.log((i + 1) + '.', r.name, '(' + r.code + ') | 등급:', r.grade, '| 점수:', r.score, '| 가격:', Number(r.currentPrice).toLocaleString() + '원 | 등락:', r.changeRate + '%');
  console.log('   Base:' + (bd.base || 0), 'Whale:' + (bd.whale || 0), 'Mom:' + (bd.momentum || 0), 'Trend:' + (bd.trend || 0), 'Signal:' + (bd.signal || 0));
});

console.log('\n=== 방어 TOP 3 ===');
const defense = data.defenseRecommendations || [];
if (defense.length === 0) {
  console.log('(방어 추천 없음 — 시장 심리가 불안 이하가 아닐 수 있음)');
} else {
  defense.slice(0, 3).forEach((r, i) => {
    const dbd = r.defenseBreakdown || {};
    console.log((i + 1) + '.', r.name, '(' + r.code + ') | 방어등급:', r.defenseGrade, '| 방어점수:', r.defenseScore);
    console.log('   Recovery:' + (dbd.recovery || 0), 'SmartMoney:' + (dbd.smartMoney || 0), 'Stability:' + (dbd.stability || 0), 'Safety:' + (dbd.safety || 0), 'Signal:' + (dbd.signal || 0));
    console.log('   가격:', Number(r.currentPrice).toLocaleString() + '원 | 등락:', r.changeRate + '%');
  });
}

console.log('\n=== 전체 종목 방어 점수 TOP 10 ===');
const all = data.allStocks || [];
const withDefense = all.filter(s => s.defenseScore > 0).sort((a, b) => b.defenseScore - a.defenseScore);
withDefense.slice(0, 10).forEach(s => {
  const sign = s.changeRate > 0 ? '+' : '';
  console.log('  ' + (s.defenseGrade || '?'), String(s.defenseScore || 0).padStart(5) + '점 |', sign + s.changeRate + '% |', s.name);
});
console.log('  방어 점수 보유 종목:', withDefense.length + '개 / 전체', all.length + '개');

// 방어 전략 트리거 조건 확인
console.log('\n=== 방어 전략 트리거 조건 ===');
console.log('KOSPI 심리:', kospi.label, '→', ['공포', '불안'].includes(kospi.label) ? '방어 트리거 ON' : '트리거 안됨');
console.log('KOSDAQ 심리:', kosdaq.label, '→', ['공포', '불안'].includes(kosdaq.label) ? '방어 트리거 ON' : '트리거 안됨');
const triggered = ['공포', '불안'].includes(kospi.label) || ['공포', '불안'].includes(kosdaq.label);
console.log('방어 전략 활성화:', triggered ? 'YES' : 'NO');
