/**
 * 수익률 추적 데이터 백필 스크립트
 *
 * recommendation_daily_prices가 없는 과거 추천 종목에 대해
 * KIS API 일봉 데이터를 조회하여 수익률을 역산/저장.
 *
 * 실행: node scripts/backfill-prices.js
 */
require('dotenv').config();
const supabase = require('../backend/supabaseClient');
const kisApi = require('../backend/kisApi');

async function main() {
  console.log('📊 수익률 추적 데이터 백필 시작\n');

  // 1. 추적 데이터가 있는 recommendation_id 집합
  const { data: tracked } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id');
  const trackedIds = new Set(tracked.map(p => p.recommendation_id));
  console.log('기존 추적 데이터:', trackedIds.size + '건');

  // 2. 추적 없는 추천 조회
  const { data: allRecs } = await supabase
    .from('screening_recommendations')
    .select('id, stock_code, stock_name, recommendation_date, recommended_price')
    .order('recommendation_date', { ascending: true });

  const untracked = allRecs.filter(r => !trackedIds.has(r.id) && r.recommended_price > 0);
  console.log('복구 대상:', untracked.length + '건');

  // 3. 종목별 그룹핑
  const byStock = {};
  untracked.forEach(r => {
    if (!byStock[r.stock_code]) byStock[r.stock_code] = { name: r.stock_name, recs: [] };
    byStock[r.stock_code].recs.push(r);
  });

  const stockCodes = Object.keys(byStock);
  console.log('고유 종목:', stockCodes.length + '개 (API 호출 필요)\n');

  // 4. KIS API 토큰 발급
  await kisApi.getAccessToken();

  let totalInserted = 0;
  let totalFailed = 0;
  let stocksDone = 0;

  // 5. 종목별 처리
  for (const code of stockCodes) {
    const { name, recs } = byStock[code];
    stocksDone++;
    process.stdout.write(`[${stocksDone}/${stockCodes.length}] ${name} (${code}, ${recs.length}건)... `);

    try {
      // 100 거래일 일봉 조회 (~5개월)
      const chartData = await kisApi.getDailyChart(code, 100);

      if (!chartData || chartData.length < 5) {
        console.log('데이터 부족 (skip)');
        totalFailed += recs.length;
        continue;
      }

      // chartData: [{date: '20260211', close: 57800, ...}, ...] 최신순
      // 날짜 오름차순으로 변환 (과거→현재)
      const sorted = [...chartData].reverse();

      const inserts = [];

      for (const rec of recs) {
        const recDateStr = rec.recommendation_date.replace(/-/g, '');
        const recPrice = rec.recommended_price;

        // 추천일 이후의 거래일 찾기
        const startIdx = sorted.findIndex(d => d.date >= recDateStr);
        if (startIdx === -1) continue;

        // 추천일부터 이후 모든 거래일에 대해 수익률 계산
        for (let i = startIdx; i < sorted.length; i++) {
          const day = sorted[i];
          const recDate = new Date(rec.recommendation_date);
          const trackDate = new Date(day.date.slice(0, 4) + '-' + day.date.slice(4, 6) + '-' + day.date.slice(6, 8));
          const daysSince = Math.floor((trackDate - recDate) / (1000 * 60 * 60 * 24));

          const cumReturn = recPrice > 0
            ? ((day.close - recPrice) / recPrice * 100)
            : 0;

          // 전일 대비 변화율
          let changeRate = 0;
          if (i > 0) {
            const prevClose = sorted[i - 1].close;
            if (prevClose > 0) changeRate = ((day.close - prevClose) / prevClose * 100);
          }

          inserts.push({
            recommendation_id: rec.id,
            tracking_date: day.date.slice(0, 4) + '-' + day.date.slice(4, 6) + '-' + day.date.slice(6, 8),
            closing_price: day.close,
            change_rate: parseFloat(changeRate.toFixed(2)),
            volume: day.volume || 0,
            cumulative_return: parseFloat(cumReturn.toFixed(2)),
            days_since_recommendation: daysSince
          });
        }
      }

      if (inserts.length === 0) {
        console.log('매칭 0건');
        continue;
      }

      // 배치 upsert (500건씩)
      let inserted = 0;
      for (let i = 0; i < inserts.length; i += 500) {
        const batch = inserts.slice(i, i + 500);
        const { error } = await supabase
          .from('recommendation_daily_prices')
          .upsert(batch, { onConflict: 'recommendation_id,tracking_date' });

        if (error) {
          console.log(`DB 에러: ${error.message}`);
          totalFailed += batch.length;
        } else {
          inserted += batch.length;
        }
      }

      totalInserted += inserted;
      console.log(`${inserted}건 저장 (추천 ${recs.length}개)`);

    } catch (e) {
      console.log(`에러: ${e.message}`);
      totalFailed += recs.length;
    }
  }

  console.log(`\n✅ 완료: ${totalInserted}건 저장, ${totalFailed}건 실패`);

  // 복구 후 현황
  const { data: newTracked } = await supabase
    .from('recommendation_daily_prices')
    .select('recommendation_id');
  const newTrackedIds = new Set(newTracked.map(p => p.recommendation_id));
  console.log(`추적 커버리지: ${trackedIds.size} → ${newTrackedIds.size} / ${allRecs.length} (${(newTrackedIds.size/allRecs.length*100).toFixed(0)}%)`);
}

main().catch(e => console.error('Fatal:', e.message));
