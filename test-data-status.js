/**
 * Supabase 데이터 현황 확인 스크립트
 */

const supabase = require('./backend/supabaseClient');

async function checkDataStatus() {
  if (!supabase) {
    console.log('❌ Supabase 미설정');
    return;
  }

  try {
    // 1. 추천 종목 데이터 확인
    const { data: recommendations, error: recError } = await supabase
      .from('screening_recommendations')
      .select('recommendation_date, stock_code, stock_name, total_score, recommendation_grade')
      .order('recommendation_date', { ascending: false });

    if (recError) {
      console.log('❌ 추천 데이터 조회 실패:', recError.message);
      return;
    }

    // 2. 일별 가격 데이터 확인
    const { data: prices, error: priceError } = await supabase
      .from('recommendation_daily_prices')
      .select('recommendation_id, tracking_date, closing_price')
      .order('tracking_date', { ascending: false });

    if (priceError) {
      console.log('❌ 가격 데이터 조회 실패:', priceError.message);
      return;
    }

    // 통계 계산
    const uniqueDates = [...new Set(recommendations.map(r => r.recommendation_date))].sort();
    const uniqueStocks = [...new Set(recommendations.map(r => r.stock_code))];
    const dateRange = uniqueDates.length > 0 ? {
      start: uniqueDates[0],
      end: uniqueDates[uniqueDates.length - 1]
    } : null;

    const daysDiff = dateRange ? Math.ceil((new Date(dateRange.end) - new Date(dateRange.start)) / (1000 * 60 * 60 * 24)) : 0;

    console.log('\n📊 데이터 현황\n');
    console.log('추천 종목 데이터:');
    console.log('  - 총 추천 레코드:', recommendations.length, '개');
    console.log('  - 고유 종목 수:', uniqueStocks.length, '개');
    console.log('  - 추천 일수:', uniqueDates.length, '일');
    console.log('  - 기간:', dateRange ? `${dateRange.start} ~ ${dateRange.end} (${daysDiff}일)` : 'N/A');
    console.log('');
    console.log('일별 가격 데이터:');
    console.log('  - 총 가격 레코드:', prices.length, '개');
    console.log('  - 평균 추적일:', Math.round(prices.length / Math.max(recommendations.length, 1)), '일');
    console.log('');

    // 등급별 분포
    const gradeCount = recommendations.reduce((acc, r) => {
      acc[r.recommendation_grade] = (acc[r.recommendation_grade] || 0) + 1;
      return acc;
    }, {});
    console.log('등급별 분포:', gradeCount);
    console.log('');

    // 최근 추천일 목록
    console.log('최근 추천일:', uniqueDates.slice(-10).reverse().join(', '));
    console.log('');

    // 백테스트 가능 여부 판단
    const minRecommendations = 30;  // 최소 30개 추천
    const minDays = 5;             // 최소 5일
    const minPrices = 100;         // 최소 100개 가격 데이터

    const canBacktest = recommendations.length >= minRecommendations &&
                       uniqueDates.length >= minDays &&
                       prices.length >= minPrices;

    console.log('\n✅ 백테스트 가능 여부:', canBacktest ? '✅ YES' : '❌ NO');
    console.log('');

    if (!canBacktest) {
      console.log('권장 최소 요구사항:');
      console.log('  - 추천 레코드:', minRecommendations, '개 이상 (현재:', recommendations.length, '개)', recommendations.length >= minRecommendations ? '✅' : '❌');
      console.log('  - 추천 일수:', minDays, '일 이상 (현재:', uniqueDates.length, '일)', uniqueDates.length >= minDays ? '✅' : '❌');
      console.log('  - 가격 데이터:', minPrices, '개 이상 (현재:', prices.length, '개)', prices.length >= minPrices ? '✅' : '❌');
      console.log('');
      console.log('⏳ 데이터 축적 필요 - 매일 Cron이 자동으로 데이터 수집 중');
    } else {
      console.log('✅ 백테스트 가능 조건 충족!');
      console.log('');
      console.log('권장 분석 방법:');
      console.log('  1. 보유기간별 수익률 (5일/10일/15일/20일/25일)');
      console.log('  2. 등급별 성과 비교 (S+/S/A/B)');
      console.log('  3. 승률 및 평균 수익률');
      console.log('  4. 최대 낙폭 (MDD) 분석');
      console.log('  5. Sharpe Ratio, Profit Factor');
      console.log('');
      console.log('🔬 백테스트 API:');
      console.log('  GET /api/recommendations/performance?days=30');
    }

  } catch (error) {
    console.error('❌ 오류 발생:', error.message);
  }
}

checkDataStatus();
