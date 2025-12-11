/**
 * backtest-results.json 등급별 성과 분석
 */
const fs = require('fs');

try {
  const rawData = JSON.parse(fs.readFileSync('backtest-results.json', 'utf8'));
  const data = rawData.stocks || [];

  console.log('\n📊 등급별 성과 종합 분석\n');
  console.log('='.repeat(80));
  console.log(`총 종목: ${data.length}개\n`);

  // 등급별 분류
  const byGrade = {};
  data.forEach(stock => {
    const grade = stock.recommendation_grade || 'UNKNOWN';
    if (!byGrade[grade]) {
      byGrade[grade] = [];
    }
    byGrade[grade].push(stock);
  });

  console.log('📈 등급별 성과 분석\n');

  // 등급 순서
  const gradeOrder = ['과열', 'S+', 'S', 'A', 'B', 'C', 'D', 'UNKNOWN'];

  gradeOrder.forEach(grade => {
    if (!byGrade[grade] || byGrade[grade].length === 0) return;

    const stocks = byGrade[grade];
    const returns = stocks.map(s => s.current_return || 0).filter(r => r !== 0);

    // 수익률 데이터가 없는 종목 제외
    if (returns.length === 0) {
      console.log(`${grade}등급: ${stocks.length}개 (수익률 데이터 없음)\n`);
      return;
    }

    const wins = returns.filter(r => r > 0).length;
    const losses = returns.filter(r => r < 0).length;
    const draws = returns.filter(r => r === 0).length;
    const winRate = returns.length > 0 ? (wins / returns.length * 100).toFixed(1) : '0.0';
    const avgReturn = returns.length > 0 ? (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2) : '0.00';
    const maxReturn = returns.length > 0 ? Math.max(...returns).toFixed(2) : '0.00';
    const minReturn = returns.length > 0 ? Math.min(...returns).toFixed(2) : '0.00';

    // 수익/손실 합계
    const totalProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    const profitFactor = totalLoss > 0 ? (totalProfit / totalLoss).toFixed(2) : 'Infinity';

    console.log(`${grade}등급:`);
    console.log(`  전체: ${stocks.length}개 (데이터: ${returns.length}개)`);
    console.log(`  승률: ${winRate}% (${wins}승 ${losses}패)`);
    console.log(`  평균 수익률: ${avgReturn}%`);
    console.log(`  최고/최저: ${maxReturn}% / ${minReturn}%`);
    console.log(`  Profit Factor: ${profitFactor}`);

    // 평균 점수
    const avgScore = (stocks.reduce((a, b) => a + (b.total_score || 0), 0) / stocks.length).toFixed(1);
    console.log(`  평균 점수: ${avgScore}점`);
    console.log('');
  });

  console.log('='.repeat(80));
  console.log('\n💰 점수 구간별 성과 분석\n');

  // 점수 구간별 분류
  const scoreRanges = [
    { min: 0, max: 25, label: '<25점' },
    { min: 25, max: 45, label: '25-44점 (위험)' },
    { min: 45, max: 50, label: '45-49점 (배제)' },
    { min: 50, max: 60, label: '50-59점 (안정 구간 ⭐)' },
    { min: 60, max: 70, label: '60-69점 (혼재)' },
    { min: 70, max: 80, label: '70-79점 (대박 구간 🚀)' },
    { min: 80, max: 100, label: '80+점 (과열 위험)' }
  ];

  scoreRanges.forEach(range => {
    const stocks = data.filter(s => s.total_score >= range.min && s.total_score < range.max);
    if (stocks.length === 0) return;

    const returns = stocks.map(s => s.current_return || 0).filter(r => r !== 0);
    if (returns.length === 0) return;

    const wins = returns.filter(r => r > 0).length;
    const winRate = (wins / returns.length * 100).toFixed(1);
    const avgReturn = (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);

    console.log(`${range.label}: ${stocks.length}개 | 승률: ${winRate}% | 평균: ${avgReturn}%`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('\n📊 카테고리별 성과\n');

  // 카테고리 분류
  const categories = {
    '고래 감지': data.filter(s => s.whale_detected && !s.accumulation_detected),
    '조용한 매집': data.filter(s => s.accumulation_detected && !s.whale_detected),
    '복합 신호 (고래+조용한매집)': data.filter(s => s.whale_detected && s.accumulation_detected),
    '일반': data.filter(s => !s.whale_detected && !s.accumulation_detected)
  };

  Object.entries(categories).forEach(([category, stocks]) => {
    if (stocks.length === 0) return;

    const returns = stocks.map(s => s.current_return || 0).filter(r => r !== 0);
    if (returns.length === 0) {
      console.log(`${category}: ${stocks.length}개 (수익률 데이터 없음)`);
      return;
    }

    const wins = returns.filter(r => r > 0).length;
    const winRate = (wins / returns.length * 100).toFixed(1);
    const avgReturn = (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);

    console.log(`${category}:`);
    console.log(`  종목수: ${stocks.length}개 (데이터: ${returns.length}개)`);
    console.log(`  승률: ${winRate}% | 평균 수익률: ${avgReturn}%`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('\n🏆 TOP 5 수익 종목\n');

  const withReturns = data.filter(s => (s.current_return || 0) > 0);
  const top5 = [...withReturns].sort((a, b) => b.current_return - a.current_return).slice(0, 5);

  top5.forEach((s, i) => {
    const category = s.whale_detected && s.accumulation_detected ? '복합'
      : s.whale_detected ? '고래'
      : s.accumulation_detected ? '조용한매집'
      : '일반';

    console.log(`${i + 1}. ${s.stock_name} (${s.stock_code})`);
    console.log(`   등급: ${s.recommendation_grade} | 점수: ${s.total_score}점 | 수익률: ${s.current_return.toFixed(2)}%`);
    console.log(`   카테고리: ${category} | 경과: ${s.days_since_recommendation}일`);
    console.log('');
  });

  console.log('='.repeat(80));
  console.log('\n📉 WORST 5 손실 종목\n');

  const withLosses = data.filter(s => (s.current_return || 0) < 0);
  const worst5 = [...withLosses].sort((a, b) => a.current_return - b.current_return).slice(0, 5);

  worst5.forEach((s, i) => {
    const category = s.whale_detected && s.accumulation_detected ? '복합'
      : s.whale_detected ? '고래'
      : s.accumulation_detected ? '조용한매집'
      : '일반';

    console.log(`${i + 1}. ${s.stock_name} (${s.stock_code})`);
    console.log(`   등급: ${s.recommendation_grade} | 점수: ${s.total_score}점 | 수익률: ${s.current_return.toFixed(2)}%`);
    console.log(`   카테고리: ${category} | 경과: ${s.days_since_recommendation}일`);
    console.log('');
  });

  console.log('='.repeat(80));

  // 통계 요약
  if (rawData.statistics) {
    console.log('\n📊 전체 통계 요약\n');
    const stats = rawData.statistics;
    console.log('전체:');
    console.log(`  총 종목: ${stats.total}개`);
    console.log(`  승률: ${stats.winRate.toFixed(1)}%`);
    console.log(`  평균 수익률: ${stats.avgReturn.toFixed(2)}%`);
    console.log('');

    if (stats.risingStocks) {
      console.log('연속 상승 중인 종목:');
      console.log(`  ${stats.risingStocks.count}개 (${(stats.risingStocks.count / stats.total * 100).toFixed(1)}%)`);
    }
  }

  console.log('\n' + '='.repeat(80));

} catch (error) {
  console.error('❌ 분석 실패:', error.message);
  console.error(error.stack);
}
