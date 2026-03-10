const data = require('./perf.json');
const stocks = data.stocks || [];
console.log('Total stocks:', stocks.length);
const v2Pop = stocks.filter(s => s.total_score_v2 && s.total_score_v2 > 0);
const v2Zero = stocks.filter(s => !s.total_score_v2 || s.total_score_v2 === 0);
const v2Top3 = stocks.filter(s => s.is_top3_v2);
console.log('v2 score populated:', v2Pop.length);
console.log('v2 score zero/null:', v2Zero.length);
console.log('v2 top3 marked:', v2Top3.length);
if (v2Pop.length > 0) {
  const scores = v2Pop.map(s => s.total_score_v2);
  console.log('v2 score range:', Math.min(...scores).toFixed(1), '~', Math.max(...scores).toFixed(1));
  console.log('v2 score avg:', (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1));
  console.log('\n--- v2 TOP 5 종목 ---');
  v2Pop.sort((a,b) => b.total_score_v2 - a.total_score_v2).slice(0,5).forEach(s => {
    console.log(`  ${s.stock_name||'?'} (${s.stock_code}): v1=${s.total_score||0} v2=${s.total_score_v2} top3_v2=${s.is_top3_v2||false}`);
  });
}

// v1 vs v2 TOP3 비교
console.log('\n--- v1 vs v2 TOP3 비교 ---');
const v1Top3 = stocks.filter(s => s.is_top3);
console.log('v1 TOP3:', v1Top3.map(s => `${s.stock_name}(${s.total_score})`).join(', ') || 'none');
console.log('v2 TOP3:', v2Top3.map(s => `${s.stock_name}(${s.total_score_v2})`).join(', ') || 'none');

// 날짜별 분포
const byDate = {};
stocks.forEach(s => {
  const d = s.recommendation_date;
  if (!byDate[d]) byDate[d] = { total: 0, v2Pop: 0, v2Top3: 0 };
  byDate[d].total++;
  if (s.total_score_v2 > 0) byDate[d].v2Pop++;
  if (s.is_top3_v2) byDate[d].v2Top3++;
});
console.log('\n--- 날짜별 v2 데이터 현황 ---');
Object.entries(byDate).sort().forEach(([date, d]) => {
  console.log(`  ${date}: 전체 ${d.total}개, v2점수 ${d.v2Pop}개, v2 TOP3 ${d.v2Top3}개`);
});
