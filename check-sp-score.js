const https = require('https');
const url = 'https://investar-xi.vercel.app/api/recommendations/performance?days=14';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const sp = (j.stocks || []).filter(s => s.recommendation_grade === 'S+');

    console.log('=== S+ 등급 점수대별 성과 분석 ===\n');
    console.log(`총 S+ 종목: ${sp.length}개\n`);

    // 점수대별 분류
    const ranges = [
      { label: '50-54점', min: 50, max: 55 },
      { label: '55-59점', min: 55, max: 60 },
      { label: '60-64점', min: 60, max: 65 },
      { label: '65-69점', min: 65, max: 70 },
      { label: '70-74점', min: 70, max: 75 },
      { label: '75-79점', min: 75, max: 80 },
    ];

    console.log('--- 점수대별 ---');
    ranges.forEach(r => {
      const group = sp.filter(s => s.total_score >= r.min && s.total_score < r.max);
      if (group.length === 0) return;
      const rets = group.map(s => s.current_return || 0);
      const wins = rets.filter(x => x > 0).length;
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      const crashes = rets.filter(x => x < -5).length;
      const maxR = Math.max(...rets);
      const minR = Math.min(...rets);
      console.log(`${r.label}: ${group.length}개 | 승률 ${(wins/group.length*100).toFixed(0)}% | 평균 ${avg.toFixed(2)}% | 최대 ${maxR.toFixed(1)}% | 최소 ${minR.toFixed(1)}% | 폭락 ${crashes}개`);
    });

    // 고래 유무별
    console.log('\n--- 고래 유무별 ---');
    const whale = sp.filter(s => s.whale_detected);
    const noWhale = sp.filter(s => !s.whale_detected);

    [{ label: '고래 O', arr: whale }, { label: '고래 X', arr: noWhale }].forEach(({ label, arr }) => {
      if (arr.length === 0) { console.log(`${label}: 0개`); return; }
      const rets = arr.map(s => s.current_return || 0);
      const wins = rets.filter(x => x > 0).length;
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      const crashes = rets.filter(x => x < -5).length;
      console.log(`${label}: ${arr.length}개 | 승률 ${(wins/arr.length*100).toFixed(0)}% | 평균 ${avg.toFixed(2)}% | 폭락 ${crashes}개`);
    });

    // 점수 vs 수익률 상관관계
    console.log('\n--- 점수-수익률 산점도 (점수순) ---');
    sp.sort((a, b) => a.total_score - b.total_score).forEach(s => {
      const r = (s.current_return || 0);
      const bar = r >= 0 ? '+'.repeat(Math.min(Math.round(r), 30)) : '-'.repeat(Math.min(Math.round(Math.abs(r)), 30));
      const whale = s.whale_detected ? 'W' : ' ';
      console.log(`${s.total_score.toFixed(1).padStart(5)}점 ${whale} | ${r.toFixed(1).padStart(6)}% | ${bar} ${s.stock_name}`);
    });

    // 상관계수 계산
    const scores = sp.map(s => s.total_score);
    const returns = sp.map(s => s.current_return || 0);
    const n = scores.length;
    const avgScore = scores.reduce((a, b) => a + b, 0) / n;
    const avgReturn = returns.reduce((a, b) => a + b, 0) / n;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i++) {
      num += (scores[i] - avgScore) * (returns[i] - avgReturn);
      denA += (scores[i] - avgScore) ** 2;
      denB += (returns[i] - avgReturn) ** 2;
    }
    const corr = num / (Math.sqrt(denA) * Math.sqrt(denB));
    console.log(`\n상관계수 (점수 vs 수익률): ${corr.toFixed(3)}`);
    if (corr > 0.3) console.log('→ 양의 상관: 점수 높을수록 수익률 높은 경향');
    else if (corr < -0.3) console.log('→ 음의 상관: 점수 높을수록 수익률 낮은 경향');
    else console.log('→ 상관관계 약함: 점수와 수익률 사이에 뚜렷한 관계 없음');
  });
}).on('error', e => console.error(e));
