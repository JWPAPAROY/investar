require('dotenv').config({ path: 'c:\\Users\\knoww\\investar\\.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // There is no direct listModels in the client, but we can try to call a model to see the error or use the REST API
        console.log('API Key:', process.env.GEMINI_API_KEY ? 'Set' : 'Missing');
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Hi");
        console.log('Response:', (await result.response).text());
    } catch (e) {
        console.error('Error:', e);
    }
}

listModels();
