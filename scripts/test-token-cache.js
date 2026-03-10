require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const kisApi = require('../backend/kisApi');
const supabase = require('../backend/supabaseClient');

async function testTokenCache() {
    console.log('--- KIS Token Cache Test ---');

    try {
        // 1. Clear existing cache row if any
        console.log('1. Clearing existing cache row...');
        await supabase.from('overnight_predictions').delete().eq('prediction_date', kisApi.TOKEN_CACHE_DATE);

        // 2. Fetch token (should be new)
        console.log('2. Requesting new token...');
        const token1 = await kisApi.getAccessToken();
        console.log('Token 1 loaded.');

        // 3. Nullify memory cache to simulate cold start
        console.log('3. Simulating cold start (clearing memory cache)...');
        kisApi.accessToken = null;
        kisApi.tokenExpiry = null;

        // 4. Fetch token again (should load from Supabase)
        console.log('4. Requesting token again (expecting Supabase load)...');
        const token2 = await kisApi.getAccessToken();

        if (token1 === token2) {
            console.log('✅ Success: Tokens match! Cache logic works.');
        } else {
            console.error('❌ Failure: Tokens do not match. New token was requested.');
        }
    } catch (e) {
        console.error('❌ Test failed with error:', e.message);
    }
}

testTokenCache();
