/**
 * D+5 백테스트 스크립트 (v3.23)
 * KIS API로 과거 데이터를 직접 조회하여 성과 분석
 */

require('dotenv').config();
const kisApi = require('./backend/kisApi');

// 테스트할 종목 리스트 (최근 추천 종목들)
const testStocks = [
    { code: '005930', name: '삼성전자' },
    { code: '000660', name: 'SK하이닉스' },
    { code: '035420', name: 'NAVER' },
    { code: '035720', name: '카카오' },
    { code: '051910', name: 'LG화학' },
    { code: '006400', name: '삼성SDI' },
    { code: '028260', name: '삼성물산' },
    { code: '003670', name: '포스코퓨처엠' },
    { code: '086520', name: '에코프로' },
    { code: '247540', name: '에코프로비엠' }
];

async function runBacktest() {
    console.log('📊 D+5 성과 분석 (v3.23 Scoring)\n');

    const results = {
        total: 0,
        wins: 0,
        losses: 0,
        returns: []
    };

    console.log('종목명\t\t\tD-5가격\t\tD-0가격\t\t수익률');
    console.log('─'.repeat(70));

    for (const stock of testStocks) {
        try {
            // 30일 일봉 가져오기
            const chartData = await kisApi.getDailyChart(stock.code, 30);

            if (!chartData || chartData.length < 10) {
                console.log(`${stock.name}\t\t데이터 부족`);
                continue;
            }

            // D-5 (5일전 가격) vs D-0 (현재 가격) 비교
            const d0Price = chartData[0].close;
            const d5Price = chartData[5]?.close;

            if (!d5Price) continue;

            const returnPct = ((d0Price - d5Price) / d5Price * 100).toFixed(2);
            const returnNum = parseFloat(returnPct);

            results.total++;
            results.returns.push({ name: stock.name, returnPct: returnNum });

            if (returnNum >= 3) {
                results.wins++;
            } else if (returnNum <= -3) {
                results.losses++;
            }

            const sign = returnNum >= 0 ? '+' : '';
            const nameFormatted = stock.name.padEnd(12);
            console.log(`${nameFormatted}\t${d5Price.toLocaleString()}원\t\t${d0Price.toLocaleString()}원\t\t${sign}${returnPct}%`);

            // API Rate limiting
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.log(`${stock.name}\t\t오류: ${e.message}`);
        }
    }

    // 결과 요약
    console.log('\n' + '═'.repeat(70));
    console.log('📈 D+5 성과 요약');
    console.log('═'.repeat(70));

    if (results.total === 0) {
        console.log('분석 가능한 데이터가 없습니다.');
        return;
    }

    const avgReturn = results.returns.reduce((sum, r) => sum + r.returnPct, 0) / results.total;
    const winRate = (results.wins / results.total * 100).toFixed(1);

    console.log(`\n📊 전체 통계`);
    console.log(`  • 분석 종목: ${results.total}개`);
    console.log(`  • 승률 (+3%↑): ${results.wins}/${results.total} = ${winRate}%`);
    console.log(`  • 손실 (-3%↓): ${results.losses}개 (${(results.losses / results.total * 100).toFixed(1)}%)`);
    console.log(`  • 평균 수익률: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%`);

    // 정렬
    const sorted = [...results.returns].sort((a, b) => b.returnPct - a.returnPct);

    console.log(`\n🏆 최고 성과`);
    sorted.slice(0, 3).forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.name}: ${r.returnPct >= 0 ? '+' : ''}${r.returnPct}%`);
    });

    console.log(`\n💔 최저 성과`);
    sorted.slice(-3).forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.name}: ${r.returnPct}%`);
    });

    console.log('\n✅ 분석 완료');
}

runBacktest().catch(console.error);
