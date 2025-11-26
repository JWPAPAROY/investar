/**
 * C, D 등급 (45점 미만) 종목 삭제 스크립트
 *
 * 실행: node cleanup-low-grades.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Supabase 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function cleanupLowGrades() {
  console.log('\n🧹 45점 미만 (C, D 등급) 종목 삭제 시작...\n');

  try {
    // Step 1: 45점 미만 종목 조회
    const { data: lowGradeStocks, error: selectError } = await supabase
      .from('screening_recommendations')
      .select('id, stock_code, stock_name, total_score, recommendation_grade, recommendation_date')
      .lt('total_score', 45);

    if (selectError) {
      console.error('❌ 조회 실패:', selectError);
      return;
    }

    if (!lowGradeStocks || lowGradeStocks.length === 0) {
      console.log('✅ 삭제할 종목이 없습니다.');
      return;
    }

    console.log(`📊 삭제 대상: ${lowGradeStocks.length}개`);
    console.log('\n삭제될 종목 목록:');
    lowGradeStocks.forEach(stock => {
      console.log(`  - ${stock.stock_name} (${stock.stock_code}): ${stock.total_score}점 [${stock.recommendation_grade}] (${stock.recommendation_date})`);
    });

    // Step 2: 관련 일별 가격 데이터 삭제
    const recommendationIds = lowGradeStocks.map(s => s.id);

    console.log('\n🗑️  일별 가격 데이터 삭제 중...');
    const { error: dailyPricesError } = await supabase
      .from('recommendation_daily_prices')
      .delete()
      .in('recommendation_id', recommendationIds);

    if (dailyPricesError) {
      console.error('⚠️ 일별 가격 삭제 실패 (계속 진행):', dailyPricesError.message);
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
      return;
    }

    console.log(`\n✅ 삭제 완료: ${lowGradeStocks.length}개 종목 제거됨\n`);

  } catch (error) {
    console.error('❌ 오류 발생:', error);
  }
}

// 실행
cleanupLowGrades();
