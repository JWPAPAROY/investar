require('dotenv').config({ path: 'c:\\Users\\knoww\\investar\\.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testModels() {
    const models = [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
        "gemini-pro"
    ];

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    for (const m of models) {
        try {
            console.log(`Testing ${m}...`);
            const model = genAI.getGenerativeModel({ model: m });
            const result = await model.generateContent("Hello. Reply with 'OK'.");
            const text = (await result.response).text();
            console.log(`✅ ${m} worked! Response: ${text}`);
            return; // Stop at first success
        } catch (e) {
            console.log(`❌ ${m} failed: ${e.message}`);
        }
    }
}

testModels();
