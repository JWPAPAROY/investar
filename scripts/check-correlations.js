require('dotenv').config();
const supabase = require('../backend/supabaseClient');

async function main() {
  const { data } = await supabase
    .from('overnight_predictions')
    .select('prediction_date, factors, kospi_open_change')
    .not('kospi_open_change', 'is', null)
    .neq('prediction_date', '9999-12-31')
    .order('prediction_date', { ascending: false })
    .limit(100);

  console.log(`총 ${data.length}건\n`);

  const tickers = ['KOSPI200F', 'USDKRW=X', 'CL=F', '^VIX', '^SOX', 'NQ=F', 'ES=F'];

  for (const ticker of tickers) {
    const pairs = [];
    for (const row of data) {
      const factor = (row.factors || []).find(f => f.ticker === ticker);
      if (factor && row.kospi_open_change != null) {
        pairs.push({ date: row.prediction_date, x: factor.change, y: row.kospi_open_change });
      }
    }

    if (pairs.length < 5) {
      console.log(`${ticker}: 데이터 부족 (${pairs.length}건)`);
      continue;
    }

    // 피어슨 상관계수
    const n = pairs.length;
    const sumX = pairs.reduce((s, p) => s + p.x, 0);
    const sumY = pairs.reduce((s, p) => s + p.y, 0);
    const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
    const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
    const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    const corr = den === 0 ? 0 : num / den;

    console.log(`${ticker.padEnd(12)} r=${corr.toFixed(4)}  (${n}건)  avgChange=${(sumX/n).toFixed(2)}%`);

    // KOSPI200F의 경우 각 데이터 포인트 출력
    if (ticker === 'KOSPI200F') {
      console.log('  --- KOSPI200F 상세 ---');
      pairs.slice(0, 15).forEach(p => {
        console.log(`  ${p.date}  선물=${p.x.toFixed(2)}%  KOSPI개장=${p.y.toFixed(2)}%`);
      });
    }
  }
}

main().catch(e => console.error(e.message));
