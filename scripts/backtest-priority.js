require('dotenv').config();
const supabase = require('../backend/supabaseClient');

async function main() {
  const { data: recs } = await supabase
    .from('screening_recommendations')
    .select('id, stock_code, stock_name, recommendation_date, total_score, whale_detected, recommendation_grade')
    .order('recommendation_date', { ascending: true });

  // 페이지네이션으로 전체 가격 데이터
  let allPrices = [];
  let page = 0;
  while (true) {
    const { data } = await supabase
      .from('recommendation_daily_prices')
      .select('recommendation_id, cumulative_return')
      .order('tracking_date', { ascending: false })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data || data.length === 0) break;
    allPrices.push(...data);
    if (data.length < 1000) break;
    page++;
  }

  const retMap = {};
  allPrices.forEach(p => { if (!retMap[p.recommendation_id]) retMap[p.recommendation_id] = p.cumulative_return; });

  const byDate = {};
  recs.forEach(r => {
    if (!byDate[r.recommendation_date]) byDate[r.recommendation_date] = [];
    byDate[r.recommendation_date].push(r);
  });

  const dates = Object.keys(byDate).sort();

  // 3가지 방식 비교
  const methods = {
    'A) 현재(단순내림차순)': (stocks) => {
      return stocks
        .filter(s => s.whale_detected && s.recommendation_grade !== '과열')
        .sort((a, b) => b.total_score - a.total_score)
        .slice(0, 3);
    },
    'B) 이전(50-89 우선)': (stocks) => {
      const eligible = stocks.filter(s => s.whale_detected && s.recommendation_grade !== '과열');
      const top3 = [];
      // 1순위: 50-89
      const p1 = eligible.filter(s => s.total_score >= 50 && s.total_score < 90).sort((a, b) => b.total_score - a.total_score);
      top3.push(...p1.slice(0, 3));
      // 2순위: 70+
      if (top3.length < 3) {
        const p2 = eligible.filter(s => s.total_score >= 70 && !top3.some(t => t.stock_code === s.stock_code)).sort((a, b) => b.total_score - a.total_score);
        top3.push(...p2.slice(0, 3 - top3.length));
      }
      // 3순위: 40+
      if (top3.length < 3) {
        const p3 = eligible.filter(s => s.total_score >= 40 && !top3.some(t => t.stock_code === s.stock_code)).sort((a, b) => b.total_score - a.total_score);
        top3.push(...p3.slice(0, 3 - top3.length));
      }
      return top3;
    },
    'C) 제안(50-69→80-89→90+)': (stocks) => {
      const eligible = stocks.filter(s => s.whale_detected && s.recommendation_grade !== '과열');
      const top3 = [];
      // 1순위: 50-69 (스윗스팟)
      const p1 = eligible.filter(s => s.total_score >= 50 && s.total_score <= 69).sort((a, b) => b.total_score - a.total_score);
      top3.push(...p1.slice(0, 3));
      // 2순위: 80-89
      if (top3.length < 3) {
        const p2 = eligible.filter(s => s.total_score >= 80 && s.total_score <= 89 && !top3.some(t => t.stock_code === s.stock_code)).sort((a, b) => b.total_score - a.total_score);
        top3.push(...p2.slice(0, 3 - top3.length));
      }
      // 3순위: 90+
      if (top3.length < 3) {
        const p3 = eligible.filter(s => s.total_score >= 90 && !top3.some(t => t.stock_code === s.stock_code)).sort((a, b) => b.total_score - a.total_score);
        top3.push(...p3.slice(0, 3 - top3.length));
      }
      return top3;
    }
  };

  const results = {};
  for (const name of Object.keys(methods)) {
    results[name] = { returns: [], wins: 0, dailyAvgs: [] };
  }

  const dailyRows = [];

  for (const date of dates) {
    const stocks = byDate[date];
    const dayResult = { date };

    for (const [name, fn] of Object.entries(methods)) {
      const top3 = fn(stocks);
      const rets = top3.map(s => retMap[s.id]).filter(r => r !== undefined);
      if (rets.length === 0) { dayResult[name] = null; continue; }

      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      rets.forEach(r => results[name].returns.push(r));
      results[name].dailyAvgs.push(avg);
      dayResult[name] = avg;
    }

    dailyRows.push(dayResult);
  }

  // 결과 출력
  console.log('='.repeat(70));
  console.log('  TOP3 선정 방식 3종 비교 (전체 기간, 고래 종목)');
  console.log('='.repeat(70));

  for (const [name, r] of Object.entries(results)) {
    const avg = r.returns.length ? r.returns.reduce((a, b) => a + b, 0) / r.returns.length : 0;
    const win = r.returns.filter(x => x > 0).length;
    const rets = [...r.returns].sort((a, b) => a - b);
    const median = rets.length ? rets[Math.floor(rets.length / 2)] : 0;
    console.log('\n' + name);
    console.log('  종목수:', r.returns.length);
    console.log('  평균 수익률:', avg.toFixed(2) + '%');
    console.log('  중앙값:', median.toFixed(2) + '%');
    console.log('  승률:', (win / r.returns.length * 100).toFixed(1) + '% (' + win + '/' + r.returns.length + ')');
  }

  // 날짜별 비교
  console.log('\n' + '='.repeat(70));
  console.log('  날짜별 비교');
  console.log('='.repeat(70));
  const names = Object.keys(methods);
  console.log('날짜'.padEnd(13) + names.map(n => n.slice(0,1)).join('').padStart(3) + '   A평균    B평균    C평균    C-A');
  console.log('-'.repeat(60));

  let aWin = 0, bWin = 0, cWin = 0;
  dailyRows.forEach(d => {
    const a = d[names[0]], b = d[names[1]], c = d[names[2]];
    if (a === null && c === null) return;
    const diff = (c !== null && a !== null) ? c - a : 0;
    if (c > a + 0.1) cWin++;
    else if (a > c + 0.1) aWin++;

    const marker = diff > 3 ? ' <<' : diff < -3 ? ' >>' : '';
    console.log(
      d.date.padEnd(13) +
      '   ' +
      (a !== null ? (a.toFixed(1) + '%').padStart(7) : '   N/A') +
      (b !== null ? (b.toFixed(1) + '%').padStart(8) : '     N/A') +
      (c !== null ? (c.toFixed(1) + '%').padStart(8) : '     N/A') +
      ((diff >= 0 ? '+' : '') + diff.toFixed(1) + '%p').padStart(8) +
      marker
    );
  });

  console.log('\n일별 승패: A(현재) ' + aWin + '일 | C(제안) ' + cWin + '일');
}

main().catch(e => console.error('Fatal:', e.message));
