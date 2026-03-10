require('dotenv').config();
const screener = require('../backend/screening');
(async () => {
  const result = await screener.analyzeStock('003530');
  if (!result) { console.log('FAIL'); process.exit(1); }
  const sb = result.scoreBreakdown;
  console.log(result.stockName, result.totalScore + '점');
  console.log('\nBase 상세 (' + sb.baseScore + '점):');
  Object.entries(sb.baseComponents).forEach(([k, v]) => {
    console.log('  ' + v.name + ':', v.score + '점');
  });

  console.log('\nWhale:', sb.whaleBonus.score + '점', '(' + sb.whaleBonus.details + ')');

  console.log('\nMomentum 상세 (' + sb.momentumScore + '점):');
  Object.entries(sb.momentumComponents).forEach(([k, v]) => {
    console.log('  ' + v.name + ':', v.score + '점');
  });
  if (result.momentumScore?.dailyRisePenalty?.penalty) {
    console.log('  당일급등페널티:', result.momentumScore.dailyRisePenalty.penalty + '점');
  }

  console.log('\nTrend:', sb.trendScore + '점');

  const adj = sb.signalAdjustments;
  const signalTotal = (adj.escapeVelocityBonus || 0) + (adj.upperShadowPenalty || 0) + (adj.sellWhalePenalty || 0);
  console.log('Signal:', signalTotal + '점', JSON.stringify(adj));

  console.log('\n합산: Base(' + sb.baseScore + ') + Whale(' + sb.whaleBonus.score + ') + Momentum(' + sb.momentumScore + ') + Trend(' + sb.trendScore + ') + Signal(' + signalTotal + ') = ' + sb.finalScore);
  process.exit(0);
})();
