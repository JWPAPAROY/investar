/**
 * TOP 3 선정 조건 테스트
 */
const screening = require('./backend/screening');

async function testTop3() {
  try {
    console.log('🔍 TOP 3 선정 테스트 시작...\n');

    const result = await screening.screenAllStocks('ALL');

    console.log(`📊 전체 종목: ${result.stocks.length}개`);
    console.log(`🏆 TOP 3: ${result.top3?.length || 0}개\n`);

    if (result.top3 && result.top3.length > 0) {
      console.log('TOP 3 종목:');
      result.top3.forEach((stock, i) => {
        console.log(`  ${i + 1}. ${stock.stockName} (${stock.stockCode})`);
        console.log(`     점수: ${stock.totalScore}점`);
        console.log(`     등급: ${stock.recommendation.grade}`);
        console.log(`     고래: ${stock.advancedAnalysis?.indicators?.whale?.length > 0 ? 'O' : 'X'}`);
        console.log(`     매집: ${stock.advancedAnalysis?.indicators?.accumulation?.detected ? 'O' : 'X'}`);
        console.log(`     전략: ${stock.top3Meta?.strategy}`);
        console.log(`     승률: ${stock.top3Meta?.expectedWinRate}%\n`);
      });
    } else {
      console.log('❌ TOP 3 조건을 만족하는 종목이 없습니다.\n');

      // 고래 감지 종목 확인
      const whaleStocks = result.stocks.filter(s =>
        s.advancedAnalysis?.indicators?.whale?.length > 0
      );
      console.log(`🐋 고래 감지 종목: ${whaleStocks.length}개`);

      if (whaleStocks.length > 0) {
        console.log('\n고래 감지 종목 상세:');
        whaleStocks.forEach(s => {
          const isComposite = s.advancedAnalysis?.indicators?.accumulation?.detected;
          const isOverheated = s.recommendation?.grade === '과열';
          console.log(`  - ${s.stockName}: ${s.totalScore}점, ${s.recommendation.grade}등급`);
          console.log(`    복합: ${isComposite ? 'O (제외)' : 'X'}, 과열: ${isOverheated ? 'O (제외)' : 'X'}`);
        });
      }

      // 점수 분포 확인
      console.log('\n📊 점수 분포:');
      const score45plus = result.stocks.filter(s => s.totalScore >= 45).length;
      const score50plus = result.stocks.filter(s => s.totalScore >= 50).length;
      const score60plus = result.stocks.filter(s => s.totalScore >= 60).length;
      console.log(`  45점 이상: ${score45plus}개`);
      console.log(`  50점 이상: ${score50plus}개`);
      console.log(`  60점 이상: ${score60plus}개`);
    }

  } catch (error) {
    console.error('❌ 테스트 실패:', error.message);
    console.error(error.stack);
  }
}

testTop3();
