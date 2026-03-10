const axios = require('axios');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const KIS_APP_KEY = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;

async function getAccessToken() {
    const response = await axios.post('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
        grant_type: 'client_credentials',
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET
    });
    return response.data.access_token;
}

async function testFuture() {
    const token = await getAccessToken();
    const futuresCode = '101000'; // 최근월물

    try {
        const response = await axios.get(
            `https://openapi.koreainvestment.com:9443/uapi/domestic-futureoption/v1/quotations/inquire-price`,
            {
                headers: {
                    'authorization': `Bearer ${token}`,
                    'appkey': KIS_APP_KEY,
                    'appsecret': KIS_APP_SECRET,
                    'tr_id': 'FHMIF10000000'
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'F',
                    FID_INPUT_ISCD: futuresCode
                }
            }
        );
        console.log("Response:", JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.log("Error:", e.response?.data || e.message);
    }
}

testFuture();
