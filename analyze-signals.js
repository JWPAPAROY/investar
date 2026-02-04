/**
 * Signal Effectiveness Analysis (v3.24)
 * 8개 신호별 D+5 수익률 상관성 분석
 */

require('dotenv').config();
const screening = require('./backend/screening');
const kisApi = require('./backend/kisApi');

// 8개 신호 정의
const SIGNALS = [
    { key: 'buyWhale', name: '🐋 매수고래', pattern: /매수고래/ },
    { key: 'sellWhale', name: '🐳 매도고래', pattern: /매도고래/ },
    { key: 'escapeVelocity', name: '🚀 탈출 속도 달성', pattern: /탈출 속도 달성/ },
    { key: 'upperShadowWarning', name: '⚠️ 윗꼬리 과다', pattern: /윗꼬리 과다/ },
    { key: 'weakClosing', name: '⚠️ 약한 마감', pattern: /약한 마감/ },
    { key: 'strongBuy', name: '📈 강한 매수세', pattern: /강한 매수세/ },
    { key: 'strongSell', name: '📉 강한 매도세', pattern: /강한 매도세/ },
    { key: 'balanced', name: '⚖️ 균형', pattern: /균형/ }
];

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getD5Return(stockCode) {
    try {
        const chartData = await kisApi.getDailyChart(stockCode);
        if (!chartData || chartData.length < 6) return null;

        // chartData[0] = 오늘, chartData[5] = 5일 전
        const todayPrice = chartData[0].close;
        const d5Price = chartData[5].close;

        // D+5 수익률 = (5일 전 종가 → 오늘 종가) 변화율
        // 실제로는 "오늘 매수 → 5일 후 매도" 시뮬레이션이지만, 
        // 과거 데이터이므로 5일 전 대비 오늘 수익률로 대체
        const returnRate = ((todayPrice - d5Price) / d5Price) * 100;
        return returnRate;
    } catch (e) {
        return null;
    }
}

async function analyzeSignals() {
    console.log('📊 8개 신호별 수익률 상관성 분석 (v3.24)\n');
    console.log('⏳ 스크리닝 실행 중...\n');

    const result = await screening.screenAllStocks('ALL', 50, true);

    if (!result || !result.stocks || result.stocks.length === 0) {
        console.log('❌ 스크리닝 결과 없음');
        return;
    }

    const stocks = result.stocks;
    console.log(`✅ ${stocks.length}개 종목 분석 완료\n`);

    // 신호별 통계 초기화
    const stats = {};
    SIGNALS.forEach(sig => {
        stats[sig.key] = {
            name: sig.name,
            stocks: [],      // 해당 신호가 있는 종목들
            returns: [],     // 수익률
            scores: []       // 점수
        };
    });

    // 전체 통계
    const allStocksData = [];

    console.log('📈 종목별 D+5 수익률 분석 중...\n');

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];

        // D+5 수익률 조회
        const d5Return = await getD5Return(stock.stockCode);
        await sleep(100); // Rate limit

        if (d5Return === null) continue;

        const stockData = {
            code: stock.stockCode,
            name: stock.stockName,
            score: stock.totalScore,
            signals: stock.advancedAnalysis?.signals || [],
            d5Return: d5Return
        };

        allStocksData.push(stockData);

        // 각 신호별로 분류
        SIGNALS.forEach(sig => {
            const hasSignal = stockData.signals.some(s => sig.pattern.test(s));
            if (hasSignal) {
                stats[sig.key].stocks.push(stockData);
                stats[sig.key].returns.push(d5Return);
                stats[sig.key].scores.push(stock.totalScore);
            }
        });

        if ((i + 1) % 10 === 0) {
            console.log(`  ${i + 1}/${stocks.length} 처리...`);
        }
    }

    console.log(`\n✅ ${allStocksData.length}개 종목 수익률 분석 완료\n`);

    // 전체 평균
    const allReturns = allStocksData.map(s => s.d5Return);
    const avgReturn = allReturns.reduce((a, b) => a + b, 0) / allReturns.length;
    const winRate = (allReturns.filter(r => r > 0).length / allReturns.length) * 100;

    console.log('═'.repeat(100));
    console.log('📊 8개 신호별 수익률 상관성 분석 결과');
    console.log('═'.repeat(100));
    console.log(`\n📌 전체 평균: 수익률 ${avgReturn.toFixed(2)}%, 승률 ${winRate.toFixed(1)}% (${allStocksData.length}개)\n`);

    console.log('신호명                    감지수    승률        평균수익률      전체대비      점수반영권장');
    console.log('─'.repeat(100));

    const signalResults = [];

    SIGNALS.forEach(sig => {
        const data = stats[sig.key];
        const count = data.returns.length;

        if (count === 0) {
            console.log(`${sig.name.padEnd(20)} ${String(count).padStart(4)}개    -           -               -               ❓ 샘플 없음`);
            signalResults.push({ ...sig, count: 0, winRate: 0, avgReturn: 0, diff: 0, recommendation: '샘플 없음' });
            return;
        }

        const sigWinRate = (data.returns.filter(r => r > 0).length / count) * 100;
        const sigAvgReturn = data.returns.reduce((a, b) => a + b, 0) / count;
        const diff = sigAvgReturn - avgReturn;
        const avgScore = data.scores.reduce((a, b) => a + b, 0) / count;

        let recommendation = '';
        let emoji = '';

        if (diff >= 3 && sigWinRate >= winRate + 5) {
            recommendation = '✅ 점수 반영 필요';
            emoji = '🟢';
        } else if (diff >= 1 && sigWinRate >= winRate) {
            recommendation = '⬆️ 가점 고려';
            emoji = '🟡';
        } else if (diff <= -3 || sigWinRate <= winRate - 10) {
            recommendation = '❌ 제거 검토';
            emoji = '🔴';
        } else if (diff < 0) {
            recommendation = '⚠️ 효과 의문';
            emoji = '🟠';
        } else {
            recommendation = '➖ 현상 유지';
            emoji = '⚪';
        }

        console.log(
            `${sig.name.padEnd(20)} ${String(count).padStart(4)}개    ${sigWinRate.toFixed(1).padStart(5)}%      ${sigAvgReturn >= 0 ? '+' : ''}${sigAvgReturn.toFixed(2).padStart(6)}%         ${diff >= 0 ? '+' : ''}${diff.toFixed(2).padStart(6)}%         ${emoji} ${recommendation}`
        );

        signalResults.push({
            ...sig,
            count,
            winRate: sigWinRate,
            avgReturn: sigAvgReturn,
            diff,
            avgScore,
            recommendation
        });
    });

    console.log('\n');
    console.log('═'.repeat(100));
    console.log('💡 분석 결론');
    console.log('═'.repeat(100));

    // 점수 반영 필요
    const needScoring = signalResults.filter(r => r.recommendation.includes('점수 반영'));
    if (needScoring.length > 0) {
        console.log('\n✅ 점수 반영 권장 신호:');
        needScoring.forEach(r => {
            console.log(`   ${r.name}: 승률 ${r.winRate.toFixed(1)}%, 수익 ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(2)}% (전체 대비 +${r.diff.toFixed(2)}%)`);
        });
    }

    // 가점 고려
    const considerBonus = signalResults.filter(r => r.recommendation.includes('가점 고려'));
    if (considerBonus.length > 0) {
        console.log('\n⬆️ 가점 고려 신호:');
        considerBonus.forEach(r => {
            console.log(`   ${r.name}: 승률 ${r.winRate.toFixed(1)}%, 수익 ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(2)}%`);
        });
    }

    // 제거 검토
    const removeConsider = signalResults.filter(r => r.recommendation.includes('제거') || r.recommendation.includes('효과 의문'));
    if (removeConsider.length > 0) {
        console.log('\n❌ 제거/축소 검토 신호:');
        removeConsider.forEach(r => {
            if (r.count > 0) {
                console.log(`   ${r.name}: 승률 ${r.winRate.toFixed(1)}%, 수익 ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(2)}% (전체 대비 ${r.diff.toFixed(2)}%)`);
            }
        });
    }

    // 신호 조합 분석
    console.log('\n');
    console.log('═'.repeat(100));
    console.log('🔗 신호 조합 분석');
    console.log('═'.repeat(100));

    // 매수고래 + 강한 매수세 조합
    const buyWhaleAndStrongBuy = allStocksData.filter(s =>
        s.signals.some(sig => /매수고래/.test(sig)) &&
        s.signals.some(sig => /강한 매수세/.test(sig))
    );

    if (buyWhaleAndStrongBuy.length > 0) {
        const comboWinRate = (buyWhaleAndStrongBuy.filter(s => s.d5Return > 0).length / buyWhaleAndStrongBuy.length) * 100;
        const comboAvg = buyWhaleAndStrongBuy.reduce((a, b) => a + b.d5Return, 0) / buyWhaleAndStrongBuy.length;
        console.log(`\n🐋+📈 매수고래 + 강한 매수세: ${buyWhaleAndStrongBuy.length}개, 승률 ${comboWinRate.toFixed(1)}%, 수익 ${comboAvg >= 0 ? '+' : ''}${comboAvg.toFixed(2)}%`);
    }

    // 매수고래 + 탈출 속도 조합
    const buyWhaleAndEscape = allStocksData.filter(s =>
        s.signals.some(sig => /매수고래/.test(sig)) &&
        s.signals.some(sig => /탈출 속도 달성/.test(sig))
    );

    if (buyWhaleAndEscape.length > 0) {
        const comboWinRate = (buyWhaleAndEscape.filter(s => s.d5Return > 0).length / buyWhaleAndEscape.length) * 100;
        const comboAvg = buyWhaleAndEscape.reduce((a, b) => a + b.d5Return, 0) / buyWhaleAndEscape.length;
        console.log(`🐋+🚀 매수고래 + 탈출 속도: ${buyWhaleAndEscape.length}개, 승률 ${comboWinRate.toFixed(1)}%, 수익 ${comboAvg >= 0 ? '+' : ''}${comboAvg.toFixed(2)}%`);
    }

    // 매도고래 분석 (경고 신호로 사용해야 하는지)
    const sellWhaleOnly = allStocksData.filter(s =>
        s.signals.some(sig => /매도고래/.test(sig)) &&
        !s.signals.some(sig => /매수고래/.test(sig))
    );

    if (sellWhaleOnly.length > 0) {
        const comboWinRate = (sellWhaleOnly.filter(s => s.d5Return > 0).length / sellWhaleOnly.length) * 100;
        const comboAvg = sellWhaleOnly.reduce((a, b) => a + b.d5Return, 0) / sellWhaleOnly.length;
        console.log(`🐳 매도고래만 (매수고래 없음): ${sellWhaleOnly.length}개, 승률 ${comboWinRate.toFixed(1)}%, 수익 ${comboAvg >= 0 ? '+' : ''}${comboAvg.toFixed(2)}%`);
    }

    console.log('\n✅ 분석 완료');
}

analyzeSignals().catch(console.error);
