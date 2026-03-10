require('dotenv').config();
const supabase = require('../backend/supabaseClient');

(async () => {
  const { data: recs } = await supabase
    .from('screening_recommendations')
    .select('id, stock_code, stock_name, recommendation_date, total_score, whale_detected, recommendation_grade')
    .order('recommendation_date', { ascending: true });

  const byDate = {};
  recs.forEach(r => {
    if (!byDate[r.recommendation_date]) byDate[r.recommendation_date] = [];
    byDate[r.recommendation_date].push(r);
  });

  const dates = Object.keys(byDate).sort();
  let fillStats = { p1only: 0, p1p2: 0, p1p2p3: 0, p1p2p3p4: 0, under3: 0, noWhale: 0 };
  let totalDays = 0;

  console.log('날짜'.padEnd(13) + '고래'.padStart(4) + ' 50-69'.padStart(6) + ' 80-89'.padStart(6) + '  90+'.padStart(5) + ' 70-79'.padStart(6) + ' | TOP3 구성');
  console.log('-'.repeat(75));

  for (const date of dates) {
    const stocks = byDate[date];
    const eligible = stocks.filter(s => s.whale_detected && s.recommendation_grade !== '과열');
    if (eligible.length === 0) { fillStats.noWhale++; continue; }
    totalDays++;

    const p1 = eligible.filter(s => s.total_score >= 50 && s.total_score <= 69);
    const p2 = eligible.filter(s => s.total_score >= 80 && s.total_score <= 89);
    const p3 = eligible.filter(s => s.total_score >= 90);
    const p4 = eligible.filter(s => s.total_score >= 70 && s.total_score <= 79);

    // 워터폴 채우기
    const top3 = [];
    const sources = [];

    const add = (pool, label) => {
      const sorted = pool.sort((a, b) => b.total_score - a.total_score);
      for (const s of sorted) {
        if (top3.length >= 3) break;
        if (!top3.some(t => t.stock_code === s.stock_code)) {
          top3.push(s);
          sources.push(label);
        }
      }
    };

    add(p1, '1순위(50-69)');
    add(p2, '2순위(80-89)');
    add(p3, '3순위(90+)');
    add(p4, '4순위(70-79)');

    // 통계
    const uniqueSources = [...new Set(sources)];
    if (top3.length < 3) fillStats.under3++;
    else if (uniqueSources.length === 1 && uniqueSources[0] === '1순위(50-69)') fillStats.p1only++;
    else if (!sources.includes('3순위(90+)') && !sources.includes('4순위(70-79)')) fillStats.p1p2++;
    else if (!sources.includes('4순위(70-79)')) fillStats.p1p2p3++;
    else fillStats.p1p2p3p4++;

    const sourceStr = sources.join(' + ');
    console.log(
      date.padEnd(13) +
      String(eligible.length).padStart(4) +
      String(p1.length).padStart(6) +
      String(p2.length).padStart(6) +
      String(p3.length).padStart(5) +
      String(p4.length).padStart(6) +
      ' | ' + top3.map((s, i) => s.stock_name + '(' + s.total_score + ')').join(', ') +
      ' ← ' + sourceStr
    );
  }

  console.log('\n=== TOP3 채움 통계 ===');
  console.log('전체 비교일:', totalDays);
  console.log('1순위만으로 3개 채움:', fillStats.p1only, '(' + (fillStats.p1only/totalDays*100).toFixed(0) + '%)');
  console.log('1+2순위로 채움:', fillStats.p1p2, '(' + (fillStats.p1p2/totalDays*100).toFixed(0) + '%)');
  console.log('1+2+3순위로 채움:', fillStats.p1p2p3, '(' + (fillStats.p1p2p3/totalDays*100).toFixed(0) + '%)');
  console.log('4순위까지 필요:', fillStats.p1p2p3p4, '(' + (fillStats.p1p2p3p4/totalDays*100).toFixed(0) + '%)');
  console.log('3개 미만:', fillStats.under3, '(' + (fillStats.under3/totalDays*100).toFixed(0) + '%)');
  console.log('고래 없는 날:', fillStats.noWhale);

  process.exit(0);
})();
