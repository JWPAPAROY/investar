/**
 * 매일 추천 종목 자동 저장 Cron (v3.12 개선)
 *
 * 일정: 월-금 오후 4시 10분 (장마감 후 40분, 가격 업데이트 후 10분)
 * 목적: 황금 구간(50-79점) 종목을 Supabase에 자동 저장
 * 백테스팅 검증: 114개, 승률 43.86%, 평균 +7.87% (2025-12-05)
 */

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');

module.exports = async (req, res) => {
  console.log('📊 일일 추천 종목 자동 저장 시작...\n');

  try {
    // Supabase 비활성화 체크
    if (!supabase) {
      console.log('⚠️ Supabase 미설정 - 저장 건너뜀');
      return res.status(200).json({
        success: false,
        message: 'Supabase not configured'
      });
    }

    // Step 1: 종합 스크리닝 (전체 종목)
    console.log('🔍 종합 스크리닝 실행 중...');
    const { stocks } = await screener.screenAllStocks('ALL');

    if (!stocks || stocks.length === 0) {
      console.log('⚠️ 추천 종목 없음');
      return res.status(200).json({
        success: true,
        saved: 0,
        message: 'No stocks to save'
      });
    }

    // Step 2: 황금 구간(50-79점)만 필터링 ⭐ v3.12 개선
    const filteredStocks = stocks.filter(stock => {
      const score = stock.totalScore;

      // 백테스팅 검증 결과 (2025-12-05):
      // - 50-79점: 114개, 승률 43.86%, 평균 +7.87% ✅ 최고 성과!
      // - 70-79점(12개): 평균 +60.28% 대박 구간
      // - 50-59점(65개): 평균 +2.08% 안정적 수익
      //
      // 배제 근거:
      // - 45-49점: 37개, 승률 21.62%, 평균 -5.13% ❌
      // - 80+점: 4개, 승률 25%, 평균 +7.60% (샘플 부족, 불안정)
      return score >= 50 && score < 80;
    });

    console.log(`✅ 스크리닝 완료: ${stocks.length}개 중 ${filteredStocks.length}개 (황금 구간 50-79점)`);

    if (filteredStocks.length === 0) {
      return res.status(200).json({
        success: true,
        saved: 0,
        message: 'No B+ grade stocks found'
      });
    }

    // Step 3: Supabase에 저장
    const today = new Date().toISOString().slice(0, 10);

    const recommendations = filteredStocks.map(stock => ({
      recommendation_date: today,
      stock_code: stock.stockCode,
      stock_name: stock.stockName || stock.stockCode,
      recommended_price: stock.currentPrice || 0,
      recommendation_grade: stock.recommendation?.grade || 'D',
      total_score: stock.totalScore || 0,

      // 추천 근거
      change_rate: stock.changeRate || 0,
      volume: stock.volume || 0,
      market_cap: stock.marketCap || 0,

      whale_detected: stock.advancedAnalysis?.indicators?.whale?.length > 0 || false,
      accumulation_detected: stock.advancedAnalysis?.indicators?.accumulation?.detected || false,
      mfi: stock.volumeAnalysis?.indicators?.mfi || 50,
      volume_ratio: stock.volumeAnalysis?.current?.volumeMA20
        ? (stock.volume / stock.volumeAnalysis.current.volumeMA20)
        : 0,

      is_active: true
    }));

    const { data, error } = await supabase
      .from('screening_recommendations')
      .upsert(recommendations, {
        onConflict: 'recommendation_date,stock_code',
        ignoreDuplicates: false
      })
      .select();

    if (error) {
      console.error('❌ Supabase 저장 실패:', error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    console.log(`✅ ${data.length}개 추천 종목 저장 완료 (${today})`);

    // ⭐ v3.10.0: 추천 당일 가격도 함께 저장 (즉시 성과 집계)
    if (data && data.length > 0) {
      const dailyPrices = data.map(rec => ({
        recommendation_id: rec.id,
        tracking_date: today,
        closing_price: rec.recommended_price,
        change_rate: rec.change_rate || 0,
        volume: rec.volume || 0,
        cumulative_return: 0, // 추천 당일은 0%
        days_since_recommendation: 0
      }));

      const { error: dailyError } = await supabase
        .from('recommendation_daily_prices')
        .upsert(dailyPrices, {
          onConflict: 'recommendation_id,tracking_date',
          ignoreDuplicates: false
        });

      if (dailyError) {
        console.warn('⚠️ 당일 가격 저장 실패 (무시):', dailyError.message);
      } else {
        console.log(`✅ ${dailyPrices.length}개 당일 가격 저장 완료`);
      }
    }

    // 등급별 통계
    const gradeStats = {
      과열: filteredStocks.filter(s => s.recommendation.grade === '과열').length,
      'S+': filteredStocks.filter(s => s.recommendation.grade === 'S+').length,
      S: filteredStocks.filter(s => s.recommendation.grade === 'S').length,
      A: filteredStocks.filter(s => s.recommendation.grade === 'A').length,
      B: filteredStocks.filter(s => s.recommendation.grade === 'B').length
    };
    console.log(`   등급: 과열(${gradeStats.과열}) S+(${gradeStats['S+']}) S(${gradeStats.S}) A(${gradeStats.A}) B(${gradeStats.B})\n`);

    return res.status(200).json({
      success: true,
      saved: data.length,
      date: today,
      grades: gradeStats,
      recommendations: data.map(r => ({
        stockCode: r.stock_code,
        stockName: r.stock_name,
        grade: r.recommendation_grade,
        score: r.total_score
      }))
    });

  } catch (error) {
    console.error('❌ 일일 추천 저장 실패:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
