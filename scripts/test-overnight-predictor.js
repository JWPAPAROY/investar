require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const kisApi = require('../backend/kisApi');
const overnightPredictor = require('../backend/overnightPredictor');

async function testFetch() {
    console.log("Testing KIS API fetch directly...");
    const futures = await kisApi.getKospi200FuturesPrice();
    console.log("KIS API returned:", futures);

    console.log("\nTesting overnight prediction...");
    // 모의 req, res 객체 생성
    const mockReq = {
        query: { bypassCache: 'true' },
        method: 'GET'
    };

    const mockRes = {
        status: function (code) {
            this.statusCode = code;
            return this;
        },
        json: function (data) {
            console.log(`Response Status: ${this.statusCode}`);
            if (data.prediction && data.prediction.factors) {
                console.log("Factors:", JSON.stringify(data.prediction.factors.find(f => f.ticker === 'KOSPI200F'), null, 2));
            } else {
                console.log("Response Data:", JSON.stringify(data, null, 2));
            }
        }
    };

    try {
        // default 로 export 된 함수가 Vercel handler
        await overnightPredictor(mockReq, mockRes);
    } catch (err) {
        console.error("Handler error:", err);
    }
}

testFetch();
