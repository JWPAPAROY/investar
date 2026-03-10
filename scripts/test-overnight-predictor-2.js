require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const overnightPredictor = require('../backend/overnightPredictor');

async function testFetch() {
    console.log("Testing overnight predictor `fetchAndPredict` with bypassCache=true...");
    try {
        const prediction = await overnightPredictor.fetchAndPredict(true);
        if (prediction && prediction.factors) {
            console.log("Factors:", JSON.stringify(prediction.factors.find(f => f.ticker === 'KOSPI200F'), null, 2));
        } else {
            console.log("Response Data:", JSON.stringify(prediction, null, 2));
        }
    } catch (err) {
        console.error("Handler error:", err);
    }
}

testFetch();
