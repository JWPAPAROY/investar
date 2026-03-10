require('dotenv').config({ path: 'c:/Users/knoww/investar/.env' });
const kisApi = require('c:/Users/knoww/investar/backend/kisApi.js');

async function checkStock(code, name) {
    try {
        // 1. 현재 가격 및 등락률
        const priceInfo = await kisApi.getCurrentPrice(code);
        const price = priceInfo.price;
        const change = priceInfo.changeRate;

        // 2. 오늘의 누적 거래량 (getDailyChart 데이터의 최신값)
        const chart = await kisApi.getDailyChart(code, 2);
        const todayVolume = chart[0].volume;
        const prevVolume = chart[1].volume;
        const volumeRatio = (todayVolume / prevVolume).toFixed(2);

        // 3. 외인/기관 순매수 (getInvestorData)
        const investors = await kisApi.getInvestorData(code, 1);
        const todayFlow = investors[0] || {};
        const instNet = todayFlow.institution || 0;
        const forNet = todayFlow.foreign || 0;

        console.log(`\n=== [${name} (${code})] ===`);
        console.log(`종가: ${price}원 (${change}%)`);
        console.log(`오늘 거래량: ${Number(todayVolume).toLocaleString()}주`);
        console.log(`전일 거래량: ${Number(prevVolume).toLocaleString()}주`);
        console.log(`거래량 증감: ${volumeRatio}배`);

        console.log(`기관순매수량: ${Number(instNet).toLocaleString()}주`);
        console.log(`외국인순매수량: ${Number(forNet).toLocaleString()}주`);

        // 진단 로직
        if (change < -3 && volumeRatio < 0.4) {
            console.log(`🛡️ 진단: 주가는 크게 빠졌으나 거래량이 전일대비 매우 적음. 세력 이탈보다는 시장 폭락에 동기화된 가벼운 하락(Panic Sell) 가능성이 높음.`);
        } else if (change < -3 && volumeRatio >= 0.8) {
            console.log(`⚠️ 진단: 대량 하락(거래량 동반). 어제 진입한 초거대 매수 주체가 차익실현 또는 손절로 이탈했을 가능성 높음!`);
        } else {
            console.log(`📊 진단: 특이 동향 없음 (단순 약보합/조정). 세력이 빠져나갔다고 볼 거래량은 아님.`);
        }

    } catch (e) {
        console.error(`[${name}] 에러:`, e.message);
    }
}

async function run() {
    await kisApi.getAccessToken(); // 토큰 선제발급
    console.log('데이터 분석 중...');
    await checkStock('003280', '흥아해운');
    await checkStock('010950', 'S-Oil');
    await checkStock('005880', '대한해운');
}

run();
