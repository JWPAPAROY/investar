require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { fetchAndPredict } = require('../backend/overnightPredictor');

async function test() {
    const result = await fetchAndPredict();
    console.log('\n--- AI Interpretation ---');
    console.log(result.aiInterpretation);
    console.log('-------------------------\n');
}

test();
