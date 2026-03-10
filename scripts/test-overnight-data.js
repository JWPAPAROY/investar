const overnightPredictor = require('../backend/overnightPredictor');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function testFetch() {
    // 모듈의 내부 함수를 직접 테스트하기 어려우니 fetchAndPredict 를 실행해보거나
    // 간단하게 임포트한 구조를 본다.
    const req = { query: { bypassCache: 'true' } };
    const res = {
        status: (code) => ({
            json: (data) => console.log(JSON.stringify(data.prediction, null, 2))
        })
    };
    await overnightPredictor(req, res);
}

testFetch();
