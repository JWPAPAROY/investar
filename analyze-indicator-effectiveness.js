/**
 * 지표별 효과성 분석 백테스트
 * 각 점수 컴포넌트와 수익률 상관관계 분석
 */

const screener = require('./backend/screening');
const kisApi = require('./backend/kisApi');

async function analyzeIndicatorEffectiveness() {
    console.log('🔬 지표별 효과성 분석 시작...\n');

    try {
        // 현재 스크리닝 결과 가져오기
        const result = await screener.screenAllStocks('ALL', 50);
        const stocks = result.stocks || [];

        console.log(`📊 분석 대상: ${stocks.length}개 종목\n`);

        // 종목별 상세 점수 수집
        const analysisData = [];

        for (const stock of stocks) {
            const chartData = await kisApi.getDailyChart(stock.stockCode, 30);
            if (!chartData || chartData.length < 10) continue;

            // 5일, 10일, 15일 후 수익률 계산
            const returns = {};
            for (const days of [5, 10, 15]) {
                if (chartData.length > days) {
                    const futurePrice = chartData[0].close;
                    const pastPrice = chartData[days].close;
                    returns[`return_${days}d`] = ((futurePrice - pastPrice) / pastPrice) * 100;
                }
            }

            // 점수 컴포넌트 수집
            analysisData.push({
                stockCode: stock.stockCode,
                stockName: stock.stockName,
                totalScore: stock.totalScore,
                grade: stock.recommendation.grade,

                // Base Score 분해
                baseScore: stock.scoreBreakdown?.baseScore || 0,

                // Momentum 분해
                momentumScore: stock.scoreBreakdown?.momentumScore || 0,
                volumeAcceleration: stock.scoreBreakdown?.momentumComponents?.volumeAcceleration?.score || 0,
                vpdImprovement: stock.scoreBreakdown?.momentumComponents?.vpdImprovement?.score || 0,
                institutionalEntry: stock.scoreBreakdown?.momentumComponents?.institutionalEntry?.score || 0,

                // Trend 분해
                trendScore: stock.scoreBreakdown?.trendScore || 0,
                volumeAccelerationTrend: stock.scoreBreakdown?.trendComponents?.volumeAcceleration?.score || 0,
                volatilityContraction: stock.scoreBreakdown?.trendComponents?.volatilityContraction?.score || 0,
                institutionalAccumulation: stock.scoreBreakdown?.trendComponents?.institutionalAccumulation?.score || 0,
                vpdStrengthening: stock.scoreBreakdown?.trendComponents?.vpdStrengthening?.score || 0,

                // Multi-Signal
                multiSignalBonus: stock.scoreBreakdown?.multiSignalBonus?.score || 0,

                // 수익률
                ...returns
            });

            // API 호출 간격
            await new Promise(r => setTimeout(r, 200));
        }

        console.log(`✅ ${analysisData.length}개 종목 분석 완료\n`);

        // 지표별 상관관계 분석
        console.log('='.repeat(80));
        console.log('📈 지표별 승률 분석 (5일 보유 기준)');
        console.log('='.repeat(80));

        const indicators = [
            { name: 'totalScore', label: '총점' },
            { name: 'baseScore', label: 'Base Score' },
            { name: 'momentumScore', label: 'Momentum Score' },
            { name: 'volumeAcceleration', label: '거래량 가속도' },
            { name: 'vpdImprovement', label: 'VPD 개선도' },
            { name: 'institutionalEntry', label: '기관 진입 가속' },
            { name: 'trendScore', label: 'Trend Score' },
            { name: 'volumeAccelerationTrend', label: '거래량 점진 증가' },
            { name: 'institutionalAccumulation', label: '기관/외국인 매집' },
            { name: 'vpdStrengthening', label: 'VPD 강화 추세' },
            { name: 'multiSignalBonus', label: 'Multi-Signal 보너스' }
        ];

        const results = [];

        for (const ind of indicators) {
            const validData = analysisData.filter(d => d.return_5d !== undefined && d[ind.name] !== undefined);
            if (validData.length === 0) continue;

            // 지표 상위 50%와 하위 50% 비교
            const sorted = [...validData].sort((a, b) => b[ind.name] - a[ind.name]);
            const top50 = sorted.slice(0, Math.ceil(sorted.length / 2));
            const bottom50 = sorted.slice(Math.ceil(sorted.length / 2));

            const top50WinRate = top50.filter(d => d.return_5d > 0).length / top50.length * 100;
            const top50AvgReturn = top50.reduce((s, d) => s + d.return_5d, 0) / top50.length;
            const bottom50WinRate = bottom50.filter(d => d.return_5d > 0).length / bottom50.length * 100;
            const bottom50AvgReturn = bottom50.reduce((s, d) => s + d.return_5d, 0) / bottom50.length;

            const effectiveness = top50AvgReturn - bottom50AvgReturn;

            results.push({
                indicator: ind.label,
                top50WinRate: top50WinRate.toFixed(1),
                top50AvgReturn: top50AvgReturn.toFixed(2),
                bottom50WinRate: bottom50WinRate.toFixed(1),
                bottom50AvgReturn: bottom50AvgReturn.toFixed(2),
                effectiveness: effectiveness.toFixed(2),
                samples: validData.length
            });

            console.log(`\n${ind.label}:`);
            console.log(`  상위 50%: 승률 ${top50WinRate.toFixed(1)}%, 평균 ${top50AvgReturn > 0 ? '+' : ''}${top50AvgReturn.toFixed(2)}%`);
            console.log(`  하위 50%: 승률 ${bottom50WinRate.toFixed(1)}%, 평균 ${bottom50AvgReturn > 0 ? '+' : ''}${bottom50AvgReturn.toFixed(2)}%`);
            console.log(`  효과성(차이): ${effectiveness > 0 ? '+' : ''}${effectiveness.toFixed(2)}%`);
        }

        // 효과성 순위
        console.log('\n' + '='.repeat(80));
        console.log('🏆 지표 효과성 순위 (상위-하위 수익률 차이)');
        console.log('='.repeat(80));

        const ranked = results.sort((a, b) => parseFloat(b.effectiveness) - parseFloat(a.effectiveness));
        ranked.forEach((r, i) => {
            const eff = parseFloat(r.effectiveness);
            const emoji = eff > 2 ? '🔥' : eff > 0 ? '✅' : '⚠️';
            console.log(`${i + 1}. ${emoji} ${r.indicator}: ${eff > 0 ? '+' : ''}${r.effectiveness}%`);
        });

        // 등급별 분석
        console.log('\n' + '='.repeat(80));
        console.log('📊 등급별 성과 (5일 보유)');
        console.log('='.repeat(80));

        const gradeGroups = {};
        analysisData.forEach(d => {
            if (!gradeGroups[d.grade]) gradeGroups[d.grade] = [];
            if (d.return_5d !== undefined) gradeGroups[d.grade].push(d);
        });

        for (const [grade, items] of Object.entries(gradeGroups)) {
            const winRate = items.filter(d => d.return_5d > 0).length / items.length * 100;
            const avgReturn = items.reduce((s, d) => s + d.return_5d, 0) / items.length;
            console.log(`${grade}: 승률 ${winRate.toFixed(1)}%, 평균 ${avgReturn > 0 ? '+' : ''}${avgReturn.toFixed(2)}% (${items.length}개)`);
        }

        // JSON 저장
        const fs = require('fs');
        fs.writeFileSync('./indicator-effectiveness.json', JSON.stringify({
            generatedAt: new Date().toISOString(),
            analysisData,
            indicatorRanking: ranked,
            gradeStats: Object.entries(gradeGroups).map(([grade, items]) => ({
                grade,
                count: items.length,
                winRate: (items.filter(d => d.return_5d > 0).length / items.length * 100).toFixed(1),
                avgReturn: (items.reduce((s, d) => s + d.return_5d, 0) / items.length).toFixed(2)
            }))
        }, null, 2));

        console.log('\n💾 결과가 indicator-effectiveness.json에 저장되었습니다.');

    } catch (error) {
        console.error('❌ 분석 실패:', error.message);
        console.error(error.stack);
    }
}

analyzeIndicatorEffectiveness();
