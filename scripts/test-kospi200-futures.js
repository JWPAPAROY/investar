require('dotenv').config({ path: 'c:\\Users\\knoww\\investar\\.env' });
const kisApi = require('c:\\Users\\knoww\\investar\\backend\\kisApi');
const predictor = require('c:\\Users\\knoww\\investar\\backend\\overnightPredictor');

async function runTest() {
    console.log('1. KOSPI200 선물 단독 조회 테스트');
    try {
        const futures = await kisApi.getKospi200FuturesPrice();
        console.log('Result:', futures);
    } catch (e) {
        console.error('Error fetching futures:', e);
    }

    console.log('\n2. fetchOvernightData 통합 테스트');
    try {
        const data = await predictor.fetchOvernightData();
        console.log('KOSPI200F from fetchOvernightData:', data['KOSPI200F']);
    } catch (e) {
        console.error('Error in fetchOvernightData:', e);
    }
}

runTest();
