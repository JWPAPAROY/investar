/**
 * 누락된 day 백필 스크립트
 *
 * recommendation_daily_prices에 부분 누락된 day(1~15)를 찾아서
 * KIS API 일봉 데이터로 채움.
 *
 * 실행: node scripts/backfill-missing-days.js
 */
require('dotenv').config();
const supabase = require('../backend/supabaseClient');
const kisApi = require('../backend/kisApi');

async function main() {
  console.log('📊 누락 day 백필 시작\n');

  // 1. 전체 추천 조회
  let allRecs = [], from = 0;
  while (true) {
    const { data } = await supabase.from('screening_recommendations')
      .select('id, stock_code, stock_name, recommendation_date, recommended_price')
      .gt('recommended_price', 0)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allRecs = allRecs.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log('총 추천:', allRecs.length + '건');

  // 2. 기존 daily_prices 조회 (day 0~15)
  let allPrices = [];
  from = 0;
  while (true) {
    const { data } = await supabase.from('recommendation_daily_prices')
      .select('recommendation_id, days_since_recommendation')
      .gte('days_since_recommendation', 0)
      .lte('days_since_recommendation', 15)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allPrices = allPrices.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log('기존 가격 데이터:', allPrices.length + '건');

  // 3. 종목별 존재하는 day Set 구성
  const existingDays = {}; // rec_id → Set of days
  allPrices.forEach(p => {
    if (!existingDays[p.recommendation_id]) existingDays[p.recommendation_id] = new Set();
    existingDays[p.recommendation_id].add(p.days_since_recommendation);
  });

  // 4. 누락된 day 찾기 (day 1~15)
  const missingRecs = []; // { rec, missingDays: [1,2,3,...] }
  allRecs.forEach(rec => {
    const existing = existingDays[rec.id] || new Set();
    // 추천일이 최소 16일 전인 것만 (day 15까지 채울 수 있는 것)
    const recDate = new Date(rec.recommendation_date);
    const now = new Date();
    const daysSinceRec = Math.floor((now - recDate) / (1000 * 60 * 60 * 24));

    const missing = [];
    for (let d = 1; d <= Math.min(15, daysSinceRec); d++) {
      if (!existing.has(d)) missing.push(d);
    }
    if (missing.length > 0) {
      missingRecs.push({ rec, missingDays: missing });
    }
  });

  console.log('누락 있는 종목:', missingRecs.length + '건');
  const totalMissing = missingRecs.reduce((s, r) => s + r.missingDays.length, 0);
  console.log('총 누락 day:', totalMissing + '건');

  if (missingRecs.length === 0) {
    console.log('\n✅ 누락 없음!');
    return;
  }

  // 5. 종목코드별 그룹핑 (API 호출 최소화)
  const byStock = {};
  missingRecs.forEach(({ rec, missingDays }) => {
    if (!byStock[rec.stock_code]) byStock[rec.stock_code] = { name: rec.stock_name, items: [] };
    byStock[rec.stock_code].items.push({ rec, missingDays });
  });

  const stockCodes = Object.keys(byStock);
  console.log('고유 종목:', stockCodes.length + '개 (API 호출 필요)\n');

  // 6. KIS API 토큰 발급
  await kisApi.getAccessToken();

  let totalInserted = 0;
  let totalFailed = 0;
  let stocksDone = 0;

  // 7. 종목별 처리
  for (const code of stockCodes) {
    const { name, items } = byStock[code];
    stocksDone++;
    const itemMissing = items.reduce((s, i) => s + i.missingDays.length, 0);
    process.stdout.write(`[${stocksDone}/${stockCodes.length}] ${name} (${code}, 추천${items.length}건, 누락${itemMissing}일)... `);

    try {
      await new Promise(r => setTimeout(r, 200)); // Rate limit
      const chartData = await kisApi.getDailyChart(code, 100);

      if (!chartData || chartData.length < 5) {
        console.log('차트 데이터 부족 (skip)');
        totalFailed += itemMissing;
        continue;
      }

      // chartData: 최신순 → 날짜 오름차순으로
      const sorted = [...chartData].reverse();

      const inserts = [];

      for (const { rec, missingDays } of items) {
        const recDateStr = rec.recommendation_date.replace(/-/g, '');
        const recPrice = rec.recommended_price;

        // 추천일의 인덱스 찾기
        const startIdx = sorted.findIndex(d => d.date >= recDateStr);
        if (startIdx === -1) continue;

        // 추천일 이후 거래일 목록 구성 (day 0, 1, 2, ...)
        // day 0 = 추천일, day 1 = 다음 거래일, ...
        const tradingDays = []; // [{daysSince, chartEntry}]
        for (let i = startIdx; i < sorted.length; i++) {
          const day = sorted[i];
          const dayDate = new Date(day.date.slice(0, 4) + '-' + day.date.slice(4, 6) + '-' + day.date.slice(6, 8));
          const recDate = new Date(rec.recommendation_date);
          const daysSince = Math.floor((dayDate - recDate) / (1000 * 60 * 60 * 24));
          tradingDays.push({ daysSince, day, prevClose: i > 0 ? sorted[i - 1].close : null });
        }

        // 누락된 day에 해당하는 거래일 데이터 찾아서 삽입
        for (const targetDay of missingDays) {
          const match = tradingDays.find(td => td.daysSince === targetDay);
          if (!match) continue;

          const cumReturn = recPrice > 0
            ? ((match.day.close - recPrice) / recPrice * 100)
            : 0;

          let changeRate = 0;
          if (match.prevClose && match.prevClose > 0) {
            changeRate = ((match.day.close - match.prevClose) / match.prevClose * 100);
          }

          inserts.push({
            recommendation_id: rec.id,
            tracking_date: match.day.date.slice(0, 4) + '-' + match.day.date.slice(4, 6) + '-' + match.day.date.slice(6, 8),
            closing_price: match.day.close,
            change_rate: parseFloat(changeRate.toFixed(2)),
            volume: match.day.volume || 0,
            cumulative_return: parseFloat(cumReturn.toFixed(2)),
            days_since_recommendation: targetDay
          });
        }
      }

      if (inserts.length === 0) {
        console.log('매칭 0건 (차트 범위 초과)');
        continue;
      }

      // 배치 upsert
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
      console.log(`${inserted}건 저장`);

    } catch (e) {
      console.log(`에러: ${e.message}`);
      totalFailed += itemMissing;
    }
  }

  console.log(`\n✅ 완료: ${totalInserted}건 저장, ${totalFailed}건 실패`);
}

main().catch(e => console.error('Fatal:', e.message));
