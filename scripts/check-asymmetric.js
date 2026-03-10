require('dotenv').config();
const supabase = require('../backend/supabaseClient');

async function main() {
  // asymmetric_ratio가 있는 종목 조회
  let recs = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('screening_recommendations')
      .select('id, stock_name, stock_code, recommendation_date, recommended_price, total_score, asymmetric_ratio, whale_detected')
      .not('asymmetric_ratio', 'is', null)
      .gt('asymmetric_ratio', 0)
      .order('recommendation_date', { ascending: false })
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    recs.push(...data);
    from += 1000;
  }

  console.log(`asymmetric_ratio 있는 종목: ${recs.length}건\n`);

  // 각 종목의 최종 수익률 + 최고 수익률 조회
  const entries = [];

  for (const rec of recs) {
    const { data: prices } = await supabase
      .from('recommendation_daily_prices')
      .select('closing_price, tracking_date')
      .eq('recommendation_id', rec.id)
      .order('tracking_date', { ascending: true });

    if (!prices || prices.length === 0 || !rec.recommended_price) continue;

    const returns = prices.map(p => ((p.closing_price - rec.recommended_price) / rec.recommended_price) * 100);
    const lastReturn = returns[returns.length - 1];
    const maxReturn = Math.max(...returns);
    const minReturn = Math.min(...returns);
    const ratio = parseFloat(rec.asymmetric_ratio);

    entries.push({
      name: rec.stock_name,
      ratio,
      lastRet: +lastReturn.toFixed(1),
      maxRet: +maxReturn.toFixed(1),
      minRet: +minReturn.toFixed(1),
      whale: rec.whale_detected,
      score: rec.total_score,
      days: prices.length
    });
  }

  console.log(`가격 데이터 있는 종목: ${entries.length}건\n`);

  // 구간 분류
  function bucket(arr, label) {
    if (arr.length === 0) { console.log(`${label}: 데이터 없음`); return; }
    const wins = arr.filter(a => a.lastRet > 0).length;
    const peak10 = arr.filter(a => a.maxRet >= 10).length;
    const avgLast = arr.reduce((s, a) => s + a.lastRet, 0) / arr.length;
    const avgMax = arr.reduce((s, a) => s + a.maxRet, 0) / arr.length;
    const avgMin = arr.reduce((s, a) => s + a.minRet, 0) / arr.length;
    const sortedLast = arr.map(a => a.lastRet).sort((a, b) => a - b);
    const sortedMax = arr.map(a => a.maxRet).sort((a, b) => a - b);
    const medianLast = sortedLast[Math.floor(sortedLast.length / 2)];
    const medianMax = sortedMax[Math.floor(sortedMax.length / 2)];
    console.log(`${label}:`);
    console.log(`  ${arr.length}건 | 승률(최종) ${(wins/arr.length*100).toFixed(0)}% | +10%달성 ${(peak10/arr.length*100).toFixed(0)}%`);
    console.log(`  최종: 평균 ${avgLast.toFixed(1)}% | 중앙값 ${medianLast.toFixed(1)}%`);
    console.log(`  최고: 평균 ${avgMax.toFixed(1)}% | 중앙값 ${medianMax.toFixed(1)}%`);
    console.log(`  최저: 평균 ${avgMin.toFixed(1)}%`);
  }

  // 1. 비대칭 비율 구간별 성과
  console.log('=== 1. 비대칭 비율 구간별 성과 ===');
  bucket(entries.filter(e => e.ratio > 2.0), 'ratio > 2.0 (매우 강한 매수세)');
  bucket(entries.filter(e => e.ratio > 1.5 && e.ratio <= 2.0), 'ratio 1.5-2.0 (강한 매수세)');
  bucket(entries.filter(e => e.ratio >= 1.0 && e.ratio <= 1.5), 'ratio 1.0-1.5 (중립~약매수)');
  bucket(entries.filter(e => e.ratio < 1.0), 'ratio < 1.0 (매도 우세)');

  // 2. 고래 + 비대칭 조합 (핵심: 확인된 고래 vs 미확인 고래 성과 차이)
  console.log('\n=== 2. 고래 + 비대칭 비율 조합 ===');
  const whaleHigh = entries.filter(e => e.whale && e.ratio > 1.5);
  const whaleLow = entries.filter(e => e.whale && e.ratio <= 1.5);
  const noWhaleHigh = entries.filter(e => !e.whale && e.ratio > 1.5);
  const noWhaleLow = entries.filter(e => !e.whale && e.ratio <= 1.5);
  bucket(whaleHigh, '고래O + ratio>1.5 (확인된 고래 +30점)');
  bucket(whaleLow, '고래O + ratio≤1.5 (미확인 고래 +15점)');
  bucket(noWhaleHigh, '고래X + ratio>1.5');
  bucket(noWhaleLow, '고래X + ratio≤1.5');

  // 3. 점수 구간별 비대칭 비율 효과
  console.log('\n=== 3. 점수 구간별 비대칭 비율 효과 ===');
  for (const [lo, hi, label] of [[50, 69, '50-69점'], [70, 89, '70-89점'], [90, 100, '90+점']]) {
    const inRange = entries.filter(e => e.score >= lo && e.score <= hi);
    const highR = inRange.filter(e => e.ratio > 1.5);
    const lowR = inRange.filter(e => e.ratio <= 1.5);
    console.log(`\n[${label}]`);
    bucket(highR, `  ratio>1.5`);
    bucket(lowR, `  ratio≤1.5`);
  }

  // 4. 비대칭 비율 vs 수익률 상관계수
  if (entries.length > 10) {
    const ratios = entries.map(e => e.ratio);
    const rets = entries.map(e => e.lastRet);
    const maxRets = entries.map(e => e.maxRet);
    const n = entries.length;
    const corr = (xs, ys) => {
      const mx = xs.reduce((a, b) => a + b) / n;
      const my = ys.reduce((a, b) => a + b) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
      }
      return num / Math.sqrt(dx * dy);
    };
    console.log(`\n=== 4. 상관관계 ===`);
    console.log(`ratio vs 최종수익률: r = ${corr(ratios, rets).toFixed(4)}`);
    console.log(`ratio vs 최고수익률: r = ${corr(ratios, maxRets).toFixed(4)}`);
  }
}

main().catch(e => console.error(e.message));
