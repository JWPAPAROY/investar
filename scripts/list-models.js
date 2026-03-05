require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function test() {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();
        const models = data.models.map(m => m.name);
        console.log(models.filter(m => m.includes('gemini')));
    } catch (e) {
        console.error(e);
    }
}

test();
