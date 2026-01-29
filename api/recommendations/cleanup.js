/**
 * 저품질 종목 삭제 API
 * GET /api/recommendations/cleanup
 * GET /api/recommendations/cleanup?mode=etf  (ETF/지수 종목 삭제)
 *
 * 수동 실행용 (일회성)
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

module.exports = async (req, res) => {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Supabase 비활성화 시
  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase not configured'
    });
  }

  try {
    const mode = req.query.mode || 'low_grade';

    // ETF/지수 삭제 모드
    if (mode === 'etf') {
      console.log('\n🧹 ETF/지수 연동 종목 삭제 시작...\n');

      // ETF 키워드
      const etfKeywords = ['200', '150', '300', 'ETF', 'ETN', '파워', 'HK', 'BK', '레버', '인버스', 'KODEX', 'TIGER'];

      // 전체 종목 조회
      const { data: allStocks, error: selectError } = await supabase
        .from('screening_recommendations')
        .select('id, stock_code, stock_name, total_score, recommendation_grade, recommendation_date');

      if (selectError) {
        return res.status(500).json({ error: selectError.message });
      }

      // ETF 필터링
      const etfStocks = allStocks.filter(s => {
        const name = s.stock_name || '';
        return etfKeywords.some(k => name.includes(k));
      });

      if (etfStocks.length === 0) {
        return res.status(200).json({ success: true, message: 'No ETF stocks to delete', deleted: 0 });
      }

      console.log(`📊 ETF 삭제 대상: ${etfStocks.length}개`);
      etfStocks.forEach(s => console.log(`  - ${s.stock_name} (${s.stock_code})`));

      // 일별 가격 삭제
      const ids = etfStocks.map(s => s.id);
      await supabase.from('recommendation_daily_prices').delete().in('recommendation_id', ids);

      // 추천 종목 삭제
      await supabase.from('screening_recommendations').delete().in('id', ids);

      console.log(`\n✅ ETF 삭제 완료: ${etfStocks.length}개\n`);
      return res.status(200).json({
        success: true,
        mode: 'etf',
        deleted: etfStocks.length,
        stocks: etfStocks.map(s => ({ name: s.stock_name, code: s.stock_code }))
      });
    }

    // 기존 로직: 45점 미만 삭제
    console.log('\n🧹 45점 미만 (C, D 등급) 종목 삭제 시작...\n');

    // Step 1: 45점 미만 종목 조회
    const { data: lowGradeStocks, error: selectError } = await supabase
      .from('screening_recommendations')
      .select('id, stock_code, stock_name, total_score, recommendation_grade, recommendation_date')
      .lt('total_score', 45);

    if (selectError) {
      console.error('❌ 조회 실패:', selectError);
      return res.status(500).json({ error: selectError.message });
    }

    if (!lowGradeStocks || lowGradeStocks.length === 0) {
      console.log('✅ 삭제할 종목이 없습니다.');
      return res.status(200).json({
        success: true,
        message: 'No stocks to delete',
        deleted: 0
      });
    }

    console.log(`📊 삭제 대상: ${lowGradeStocks.length}개`);

    const stockList = lowGradeStocks.map(stock => ({
      name: stock.stock_name,
      code: stock.stock_code,
      score: stock.total_score,
      grade: stock.recommendation_grade,
      date: stock.recommendation_date
    }));

    // Step 2: 관련 일별 가격 데이터 삭제
    const recommendationIds = lowGradeStocks.map(s => s.id);

    console.log('\n🗑️  일별 가격 데이터 삭제 중...');
    const { error: dailyPricesError } = await supabase
      .from('recommendation_daily_prices')
      .delete()
      .in('recommendation_id', recommendationIds);

    if (dailyPricesError) {
      console.warn('⚠️ 일별 가격 삭제 실패 (계속 진행):', dailyPricesError.message);
    } else {
      console.log('✅ 일별 가격 데이터 삭제 완료');
    }

    // Step 3: 추천 종목 삭제
    console.log('\n🗑️  추천 종목 삭제 중...');
    const { error: deleteError } = await supabase
      .from('screening_recommendations')
      .delete()
      .lt('total_score', 45);

    if (deleteError) {
      console.error('❌ 추천 종목 삭제 실패:', deleteError);
      return res.status(500).json({ error: deleteError.message });
    }

    console.log(`\n✅ 삭제 완료: ${lowGradeStocks.length}개 종목 제거됨\n`);

    return res.status(200).json({
      success: true,
      deleted: lowGradeStocks.length,
      stocks: stockList
    });

  } catch (error) {
    console.error('❌ 오류 발생:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
