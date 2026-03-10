const https = require('https');
https.get('https://investar-xi.vercel.app/api/screening/recommend?limit=1', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const j = JSON.parse(d);
    const s = (j.data || j.recommendations || [])[0];
    if (!s) { console.log('No data'); return; }
    console.log('momentumScore type:', typeof s.momentumScore);
    if (s.momentumScore) console.log('momentumScore keys:', Object.keys(s.momentumScore));
    console.log('dailyRisePenalty:', JSON.stringify(s.momentumScore?.dailyRisePenalty));
    console.log('scoreBreakdown.momentumScore type:', typeof s.scoreBreakdown?.momentumScore);
    console.log('scoreBreakdown.momentumScore:', s.scoreBreakdown?.momentumScore);
  });
}).on('error', e => console.error(e.message));
