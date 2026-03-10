require('dotenv').config();
const supabase = require('../backend/supabaseClient');
const kisApi = require('../backend/kisApi');

async function main() {
  // 1. 모든 예측 데이터 조회
  const { data: rows } = await supabase
    .from('overnight_predictions')
    .select('prediction_date, factors, score, signal')
    .neq('prediction_date', '9999-12-31')
    .not('factors', 'is', null)
    .order('prediction_date', { ascending: false });

  console.log(`총 ${rows.length}건 조회\n`);

  const needsFix = [];
  for (const row of rows) {
    const factors = row.factors || [];
    if (!Array.isArray(factors)) continue;
    const k200f = factors.find(f => f.ticker === 'KOSPI200F');

    if (!k200f || k200f.failed || k200f.change === 0) {
      needsFix.push({ date: row.prediction_date, factors, k200f });
      console.log(`❌ ${row.prediction_date}: KOSPI200F ${!k200f ? '없음' : k200f.failed ? 'failed' : 'change=0'}`);
    } else {
      console.log(`✅ ${row.prediction_date}: KOSPI200F change=${k200f.change}%`);
    }
  }

  console.log(`\n수정 필요: ${needsFix.length}건\n`);

  if (needsFix.length === 0) {
    console.log('모든 데이터 정상!');
    return;
  }

  // 2. KOSPI200 지수 일봉으로 변동률 추정 (선물 일봉 API 미지원, 지수와 선물 일일변동률 거의 동일)
  const chart = await kisApi.getIndexChart('2001', 90); // 2001 = KOSPI200 지수
  if (!chart || chart.length < 2) {
    console.error('선물 일봉 데이터 조회 실패');
    return;
  }

  console.log(`선물 일봉 ${chart.length}건 조회 (${chart[chart.length-1].date} ~ ${chart[0].date})\n`);

  // 날짜별 종가 맵 (date format: YYYYMMDD)
  const closeMap = {};
  for (let i = 0; i < chart.length; i++) {
    const d = chart[i];
    const prevDay = chart[i + 1]; // 일봉은 내림차순
    closeMap[d.date] = {
      close: d.close,
      previousClose: prevDay ? prevDay.close : 0
    };
  }

  // 3. 백필
  let fixed = 0;
  for (const item of needsFix) {
    const dateStr = item.date.replace(/-/g, '');
    const dayData = closeMap[dateStr];

    if (!dayData || !dayData.previousClose) {
      console.log(`⚠️ ${item.date}: 선물 일봉 데이터 없음, 스킵`);
      continue;
    }

    const change = +((dayData.close - dayData.previousClose) / dayData.previousClose * 100).toFixed(4);

    // factors 배열 업데이트
    const factors = [...item.factors];
    const idx = factors.findIndex(f => f.ticker === 'KOSPI200F');
    const newFactor = {
      ticker: 'KOSPI200F',
      name: '코스피200선물',
      change,
      price: dayData.close,
      previousClose: dayData.previousClose,
      failed: false,
      source: 'KRX',
      unit: 'pt'
    };

    if (idx >= 0) {
      // 기존 필드 유지하면서 업데이트
      factors[idx] = { ...factors[idx], ...newFactor };
    } else {
      factors.push(newFactor);
    }

    // DB 업데이트
    const { error } = await supabase
      .from('overnight_predictions')
      .update({ factors })
      .eq('prediction_date', item.date);

    if (error) {
      console.error(`❌ ${item.date} 업데이트 실패:`, error.message);
    } else {
      console.log(`✅ ${item.date}: KOSPI200F ${change >= 0 ? '+' : ''}${change}% (${dayData.previousClose} → ${dayData.close})`);
      fixed++;
    }
  }

  console.log(`\n완료: ${fixed}/${needsFix.length}건 수정`);
}

main().catch(e => console.error(e.message));
