const j = require('./tmp-perf.json');
const stocks = j.stocks || [];
const grades = {};

stocks.forEach(s => {
  const g = s.recommendation_grade || '?';
  if (!grades[g]) grades[g] = { count: 0, wins: 0, rets: [] };
  grades[g].count++;
  const r = s.current_return || 0;
  grades[g].rets.push(r);
  if (r > 0) grades[g].wins++;
});

console.log('=== 등급별 실제 성과 (최근 90일) ===');
console.log('총 종목:', stocks.length);
console.log('');

const order = ['S+', 'S', 'A', 'B', 'C', 'D', '과열'];
order.forEach(g => {
  const d = grades[g];
  if (!d) return;
  const avg = d.rets.reduce((a, b) => a + b, 0) / d.rets.length;
  const wr = (d.wins / d.count) * 100;
  const maxR = Math.max(...d.rets);
  const minR = Math.min(...d.rets);
  console.log(`${g}: ${d.count}개 | 승률 ${wr.toFixed(1)}% | 평균 ${avg.toFixed(2)}% | 최대 ${maxR.toFixed(1)}% | 최소 ${minR.toFixed(1)}%`);
});
