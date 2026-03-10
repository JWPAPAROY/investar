require('dotenv').config();
const supabase = require('../backend/supabaseClient');

async function main() {
  const { data: rows } = await supabase
    .from('overnight_predictions')
    .select('prediction_date, factors, kospi_open_change')
    .neq('prediction_date', '9999-12-31')
    .not('factors', 'is', null)
    .order('prediction_date', { ascending: false });

  console.log(`총 ${rows.length}건\n`);

  // 모든 팩터별 통계
  const stats = {};

  for (const row of rows) {
    const factors = row.factors || [];
    if (!Array.isArray(factors)) continue;

    for (const f of factors) {
      if (!stats[f.ticker]) stats[f.ticker] = { total: 0, failed: 0, zero: 0, valid: 0, changes: [] };
      stats[f.ticker].total++;
      if (f.failed) stats[f.ticker].failed++;
      else if (f.change === 0) stats[f.ticker].zero++;
      else {
        stats[f.ticker].valid++;
        stats[f.ticker].changes.push({ date: row.prediction_date, change: f.change, price: f.price, prev: f.previousClose });
      }
    }
  }

  console.log('=== 팩터별 데이터 품질 ===');
  for (const [ticker, s] of Object.entries(stats).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = ((s.valid / s.total) * 100).toFixed(0);
    const flag = s.valid < 30 ? '⚠️' : (s.failed > 0 || s.zero > 5) ? '🟡' : '✅';
    console.log(`${flag} ${ticker.padEnd(12)} 전체:${s.total} 유효:${s.valid}(${pct}%) failed:${s.failed} zero:${s.zero}`);

    // 이상값 체크: 변동률 절대값 > 20%
    const outliers = s.changes.filter(c => Math.abs(c.change) > 20);
    if (outliers.length > 0) {
      console.log(`   🔴 이상값: ${outliers.map(o => `${o.date} ${o.change}%`).join(', ')}`);
    }

    // KOSDAQ150F 상세 (KOSPI200F와 같은 문제 가능성)
    if (ticker === 'KOSDAQ150F') {
      console.log('   --- KOSDAQ150F 상세 ---');
      s.changes.slice(0, 10).forEach(c => {
        console.log(`   ${c.date} change=${c.change}% price=${c.price} prev=${c.prev}`);
      });
      // zero 데이터
      const zeroRows = [];
      for (const row of rows) {
        const f = (row.factors || []).find(f => f.ticker === 'KOSDAQ150F');
        if (f && f.change === 0 && !f.failed) zeroRows.push(row.prediction_date);
      }
      if (zeroRows.length > 0) console.log(`   zero 날짜: ${zeroRows.join(', ')}`);
    }
  }
}

main().catch(e => console.error(e.message));
