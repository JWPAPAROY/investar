/**
 * 장기 백테스팅 실행 스크립트 (90일)
 * 사용법: node run-backtest-90days.js
 */

const backtest = require('./backend/backtest');

async function runBacktest() {
  console.log('🚀 투자 시스템 장기 백테스팅 시작 (90일)...\n');
  console.log('=' .repeat(80));

  try {
    // 백테스팅 실행 (90일 전부터, 7일 보유)
    const result = await backtest.runBacktest(90, 7);

    console.log('\n' + '='.repeat(80));
    console.log('📊 백테스팅 결과 요약 (90일 기간)');
    console.log('='.repeat(80));

    // 전체 성과
    if (result.statistics && result.statistics.overall) {
      const stats = result.statistics.overall;
      console.log('\n📈 전체 성과');
      console.log('─'.repeat(80));
      console.log(`  총 샘플: ${stats.totalCount}개`);
      console.log(`  승리: ${stats.winCount}개 | 패배: ${stats.lossCount}개`);
      console.log(`  승률: ${stats.winRate}%`);
      console.log(`  평균 수익률: ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}%`);
      console.log(`  최고 수익: +${stats.maxReturn}% | 최대 손실: ${stats.minReturn}%`);
    }

    // 등급별 성과
    if (result.statistics && result.statistics.byGrade) {
      console.log('\n🏆 등급별 성과');
      console.log('─'.repeat(80));
      for (const [grade, stats] of Object.entries(result.statistics.byGrade)) {
        console.log(`  ${grade}등급: 승률 ${stats.winRate}% | 평균 ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}% | 샘플 ${stats.count}개`);
      }
    }

    // 카테고리별 성과
    if (result.statistics && result.statistics.byCategory) {
      console.log('\n📋 카테고리별 성과');
      console.log('─'.repeat(80));
      for (const [key, stats] of Object.entries(result.statistics.byCategory)) {
        console.log(`  ${stats.label}: 승률 ${stats.winRate}% | 평균 ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}% | 샘플 ${stats.count}개`);
      }
    }

    // 고급 지표
    if (result.statistics && result.statistics.advanced) {
      const adv = result.statistics.advanced;
      console.log('\n💡 고급 지표');
      console.log('─'.repeat(80));
      console.log(`  Sharpe Ratio: ${adv.sharpeRatio} (위험 대비 수익)`);
      console.log(`  최대 낙폭(MDD): ${adv.maxDrawdown}%`);
      console.log(`  변동성: ${adv.volatility}%`);
      console.log(`  Profit Factor: ${adv.profitFactor} (수익/손실 비율)`);
      console.log(`  평균 수익: +${adv.avgWin}% | 평균 손실: -${adv.avgLoss}%`);
      console.log(`  KOSPI 대비 초과수익: ${adv.excessReturn > 0 ? '+' : ''}${adv.excessReturn}%`);

      if (adv.interpretation && adv.interpretation.length > 0) {
        console.log('\n  📊 해석:');
        adv.interpretation.forEach(msg => console.log(`    ${msg}`));
      }
    }

    // 상위 5개 수익
    if (result.results && result.results.length > 0) {
      const topWinners = result.results
        .filter(r => r.isWin)
        .sort((a, b) => b.returnRate - a.returnRate)
        .slice(0, 5);

      if (topWinners.length > 0) {
        console.log('\n🎯 최고 수익 TOP 5');
        console.log('─'.repeat(80));
        topWinners.forEach((r, i) => {
          console.log(`  ${i + 1}. [${r.stockName}] ${r.grade || 'N/A'}등급 | ${r.holdingDays}일 보유 | +${r.returnRate}%`);
          console.log(`     매수: ${r.buyPrice?.toLocaleString()}원 → 매도: ${r.sellPrice?.toLocaleString()}원`);
        });
      }

      // 하위 5개 손실
      const topLosers = result.results
        .filter(r => !r.isWin)
        .sort((a, b) => a.returnRate - b.returnRate)
        .slice(0, 5);

      if (topLosers.length > 0) {
        console.log('\n⚠️  최대 손실 TOP 5');
        console.log('─'.repeat(80));
        topLosers.forEach((r, i) => {
          console.log(`  ${i + 1}. [${r.stockName}] ${r.grade || 'N/A'}등급 | ${r.holdingDays}일 보유 | ${r.returnRate}%`);
          console.log(`     매수: ${r.buyPrice?.toLocaleString()}원 → 매도: ${r.sellPrice?.toLocaleString()}원`);
        });
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ 장기 백테스팅 완료!\n');

    // JSON 파일로 저장
    const fs = require('fs');
    fs.writeFileSync(
      './backtest-90days-results.json',
      JSON.stringify(result, null, 2)
    );
    console.log('💾 결과가 backtest-90days-results.json에 저장되었습니다.\n');

  } catch (error) {
    console.error('\n❌ 백테스팅 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 실행
runBacktest();
