require('dotenv').config({ path: 'c:\\Users\\knoww\\investar\\.env' });
const axios = require('axios');
const kisApi = require('c:\\Users\\knoww\\investar\\backend\\kisApi');

const testCodes = ['101000'];

async function run() {
    const token = await kisApi.getAccessToken();

    for (const code of testCodes) {
        try {
            const response = await axios.get(
                `${kisApi.baseUrl}/uapi/domestic-futureoption/v1/quotations/inquire-price`,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'authorization': `Bearer ${token}`,
                        'appkey': kisApi.appKey,
                        'appsecret': kisApi.appSecret,
                        'tr_id': 'FHMIF10000000'
                    },
                    params: {
                        FID_COND_MRKT_DIV_CODE: 'F',
                        FID_INPUT_ISCD: code
                    }
                }
            );
            const out = response.data.output1 || response.data.output;
            console.log(`✅ Full Output for ${code}:`, out);
        } catch (e) {
            console.log(`❌ Error for ${code}:`, e.response?.data?.msg1 || e.message);
        }
    }
}
run();
