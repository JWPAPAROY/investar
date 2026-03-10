const https = require('https');
const url = 'https://investar-xi.vercel.app/api/screening/recommend?limit=1';

https.get(url, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const j = JSON.parse(d);
    const s = (j.data || j.recommendations)?.[0];
    if (!s) { console.log('No data'); return; }
    console.log(s.stockName, s.totalScore + '점', s.grade);
    const sb = s.scoreBreakdown;
    if (!sb) { console.log('No scoreBreakdown'); return; }

    console.log('\nBase (' + sb.baseScore + '점):');
    if (sb.baseComponents && typeof sb.baseComponents.volumeRatio === 'object') {
      Object.entries(sb.baseComponents).forEach(([k, v]) => console.log('  ' + v.name + ': ' + v.score + '점'));
    } else {
      console.log('  baseComponents:', JSON.stringify(sb.baseComponents));
    }

    console.log('Whale:', (sb.whaleBonus?.score ?? '?') + '점', sb.whaleBonus?.details || '');
    console.log('Momentum:', sb.momentumScore + '점');
    if (sb.momentumComponents) {
      Object.entries(sb.momentumComponents).forEach(([k, v]) => console.log('  ' + v.name + ': ' + v.score + '점'));
    }
    const penalty = s.momentumScore?.dailyRisePenalty;
    if (penalty?.penalty) console.log('  당일급등페널티:', penalty.penalty + '점 (등락률 ' + penalty.closeChange + '%)');
    console.log('Trend:', sb.trendScore + '점');

    const adj = sb.signalAdjustments || {};
    const sig = (adj.escapeVelocityBonus || 0) + (adj.upperShadowPenalty || 0) + (adj.sellWhalePenalty || 0);
    console.log('Signal:', sig + '점', JSON.stringify(adj));
    console.log('\n합산:', sb.baseScore, '+', (sb.whaleBonus?.score || 0), '+', sb.momentumScore, '+', sb.trendScore, '+', sig, '=', sb.finalScore);
  });
}).on('error', e => console.error(e.message));
