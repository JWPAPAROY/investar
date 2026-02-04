/**
 * 지표 효과성 분석 스크립트 (v3.23) - 직접 스크리닝 버전
 * 각 지표가 D+5 수익률에 미치는 영향(승률 기여도) 분석
 */

require('dotenv').config();
const kisApi = require('./backend/kisApi');
const screening = require('./backend/screening');

// 10개 지표 목록
const INDICATORS = [
    { key: 'whale', name: '🐋 고래 감지' },
    { key: 'escape', name: '🚀 탈출 속도' },
    { key: 'drain', name: '💧 유동성 고갈' },
    { key: 'asymmetric', name: '📊 비대칭 거래량' },
    { key: 'gradualAccumulation', name: '🐌 조용한 누적' },
    { key: 'smartMoney', name: '🧠 스마트머니' },
    { key: 'bottomFormation', name: '🌱 저점 형성' },
    { key: 'breakoutPrep', name: '🚪 돌파 준비' },
    { key: 'institutionalFlow', name: '🏛️ 기관/외국인' },
    { key: 'confluence', name: '🎯 합류점' }
];

// 지표 감지 여부 확인
function isIndicatorDetected(stock, key) {
    const ind = stock.advancedAnalysis?.indicators;
    if (!ind) return false;

    switch (key) {
        case 'whale':
            return ind.whale && ind.whale.length > 0;
        case 'escape':
            return ind.escape?.detected === true;
        case 'drain':
            return ind.drain?.detected === true;
        case 'asymmetric':
            return ind.asymmetric?.ratio >= 1.5;
        case 'gradualAccumulation':
            return ind.gradualAccumulation?.detected === true;
        case 'smartMoney':
            return ind.smartMoney?.detected === true;
        case 'bottomFormation':
            return ind.bottomFormation?.detected === true;
        case 'breakoutPrep':
            return ind.breakoutPrep?.detected === true;
        case 'institutionalFlow':
            return stock.institutionalFlow?.totalConsecutiveDays >= 2;
        case 'confluence':
            return stock.confluence?.count >= 3;
        default:
            return false;
    }
}

async function analyzeEffectiveness() {
    console.log('📊 지표 효과성 분석 시작 (v3.23)\n');

    // 1. 직접 스크리닝 실행
    console.log('⏳ 스크리닝 직접 실행 중 (약 2-3분 소요)...\n');

    const result = await screening.screenAllStocks('ALL', 50, true);

    if (!result || !result.stocks || result.stocks.length === 0) {
        console.log('❌ 스크리닝 결과 없음');
        return;
    }

    const stocks = result.stocks;
    console.log(`\n✅ ${stocks.length}개 종목 분석 완료\n`);

    // 2. 지표별 통계 초기화
    const stats = {};
    INDICATORS.forEach(ind => {
        stats[ind.key] = { name: ind.name, detected: [], notDetected: [] };
    });

    // 3. 각 종목별 D-5 수익률 계산 및 지표 분류
    console.log('📈 종목별 D+5 수익률 분석 중...\n');

    let processed = 0;
    for (const stock of stocks) {
        try {
            const chartData = await kisApi.getDailyChart(stock.stockCode, 10);
            if (!chartData || chartData.length < 6) continue;

            const d0Price = chartData[0].close;
            const d5Price = chartData[5].close;
            const returnPct = ((d0Price - d5Price) / d5Price * 100);
            const isWin = returnPct >= 3;

            // 지표별 분류
            for (const ind of INDICATORS) {
                const detected = isIndicatorDetected(stock, ind.key);
                if (detected) {
                    stats[ind.key].detected.push({ name: stock.stockName, returnPct, isWin, score: stock.totalScore });
                } else {
                    stats[ind.key].notDetected.push({ name: stock.stockName, returnPct, isWin, score: stock.totalScore });
                }
            }

            processed++;
            if (processed % 10 === 0) {
                console.log(`  ${processed}/${stocks.length} 처리...`);
            }

            await new Promise(r => setTimeout(r, 100));
        } catch (e) {
            // Skip
        }
    }

    console.log(`\n✅ ${processed}개 종목 수익률 분석 완료\n`);

    // 4. 통계 계산
    for (const key of Object.keys(stats)) {
        const s = stats[key];

        if (s.detected.length > 0) {
            s.detectCount = s.detected.length;
            s.detectWins = s.detected.filter(x => x.isWin).length;
            s.detectWinRate = (s.detectWins / s.detectCount * 100).toFixed(1);
            s.detectAvgReturn = (s.detected.reduce((sum, x) => sum + x.returnPct, 0) / s.detectCount).toFixed(2);
            s.detectAvgScore = (s.detected.reduce((sum, x) => sum + (x.score || 0), 0) / s.detectCount).toFixed(1);
        } else {
            s.detectCount = 0;
            s.detectWinRate = '0.0';
            s.detectAvgReturn = '0.00';
            s.detectAvgScore = '0.0';
        }

        if (s.notDetected.length > 0) {
            s.notDetectWinRate = (s.notDetected.filter(x => x.isWin).length / s.notDetected.length * 100).toFixed(1);
            s.notDetectAvgReturn = (s.notDetected.reduce((sum, x) => sum + x.returnPct, 0) / s.notDetected.length).toFixed(2);
            s.notDetectAvgScore = (s.notDetected.reduce((sum, x) => sum + (x.score || 0), 0) / s.notDetected.length).toFixed(1);
        } else {
            s.notDetectWinRate = '0.0';
            s.notDetectAvgReturn = '0.00';
            s.notDetectAvgScore = '0.0';
        }

        s.contribution = (parseFloat(s.detectWinRate) - parseFloat(s.notDetectWinRate)).toFixed(1);
        s.returnDiff = (parseFloat(s.detectAvgReturn) - parseFloat(s.notDetectAvgReturn)).toFixed(2);
        s.scoreDiff = (parseFloat(s.detectAvgScore) - parseFloat(s.notDetectAvgScore)).toFixed(1);
    }

    // 5. 결과 출력
    console.log('═'.repeat(100));
    console.log('📊 지표 효과성 분석 결과 (D+5 기준)');
    console.log('═'.repeat(100));

    console.log('\n지표명\t\t\t감지수\t감지승률\t미감지승률\t승률기여도\t평균수익차\t점수기여');
    console.log('─'.repeat(100));

    const sorted = Object.entries(stats)
        .sort((a, b) => parseFloat(b[1].contribution) - parseFloat(a[1].contribution));

    for (const [key, s] of sorted) {
        const name = s.name.padEnd(16);
        const contribution = parseFloat(s.contribution);
        const sign = contribution >= 0 ? '+' : '';
        const color = contribution >= 10 ? '🟢' : contribution >= 0 ? '🟡' : '🔴';
        const returnSign = parseFloat(s.returnDiff) >= 0 ? '+' : '';
        const scoreSign = parseFloat(s.scoreDiff) >= 0 ? '+' : '';

        console.log(`${name}\t${s.detectCount}개\t${s.detectWinRate}%\t\t${s.notDetectWinRate}%\t\t${color} ${sign}${s.contribution}%\t\t${returnSign}${s.returnDiff}%\t\t${scoreSign}${s.scoreDiff}점`);
    }

    // 6. 상관관계 분석
    console.log('\n' + '═'.repeat(100));
    console.log('📈 지표-점수-수익률 상관관계 분석');
    console.log('─'.repeat(100));

    console.log('\n| 구분 | 감지 시 평균점수 | 미감지 시 평균점수 | 점수 기여 |');
    console.log('|------|-----------------|-------------------|----------|');
    for (const [key, s] of sorted) {
        console.log(`| ${s.name} | ${s.detectAvgScore}점 | ${s.notDetectAvgScore}점 | ${parseFloat(s.scoreDiff) >= 0 ? '+' : ''}${s.scoreDiff}점 |`);
    }

    // 7. 요약
    console.log('\n' + '═'.repeat(100));
    console.log('🏆 효과성 요약');
    console.log('─'.repeat(100));

    const positive = sorted.filter(([_, s]) => parseFloat(s.contribution) > 5);
    const negative = sorted.filter(([_, s]) => parseFloat(s.contribution) < 0);

    console.log('\n✅ 높은 승률 기여도 (+5% 이상):');
    if (positive.length > 0) {
        positive.forEach(([_, s]) => console.log(`   ${s.name}: 승률 +${s.contribution}%, 수익 ${parseFloat(s.returnDiff) >= 0 ? '+' : ''}${s.returnDiff}%`));
    } else {
        console.log('   없음');
    }

    if (negative.length > 0) {
        console.log('\n❌ 음의 기여도 (역효과, 비중 축소 검토):');
        negative.forEach(([_, s]) => console.log(`   ${s.name}: 승률 ${s.contribution}%, 수익 ${s.returnDiff}%`));
    }

    // 점수와 수익률 상관관계
    const allStocks = stocks.filter(s => s.totalScore);
    if (allStocks.length > 0) {
        console.log('\n📊 점수 구간별 평균 D+5 수익률:');
        const scoreRanges = [
            { min: 70, max: 100, label: '70점+' },
            { min: 50, max: 69, label: '50-69점' },
            { min: 30, max: 49, label: '30-49점' },
            { min: 0, max: 29, label: '30점 미만' }
        ];

        for (const range of scoreRanges) {
            const inRange = allStocks.filter(s => s.totalScore >= range.min && s.totalScore <= range.max);
            if (inRange.length > 0) {
                const avgScore = (inRange.reduce((s, x) => s + x.totalScore, 0) / inRange.length).toFixed(1);
                console.log(`   ${range.label}: ${inRange.length}개 종목 (평균 ${avgScore}점)`);
            }
        }
    }

    console.log('\n✅ 분석 완료');
}

analyzeEffectiveness().catch(console.error);
