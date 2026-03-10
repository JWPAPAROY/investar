const axios = require('axios');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const KIS_APP_KEY = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;

async function getAccessToken() {
    try {
        const response = await axios.post('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
            grant_type: 'client_credentials',
            appkey: KIS_APP_KEY,
            appsecret: KIS_APP_SECRET
        });
        return response.data.access_token;
    } catch (error) {
        console.error('토큰 발급 실패:', error.response?.data || error.message);
        return null;
    }
}

async function fetchKOSPI200Futures() {
    try {
        const token = await getAccessToken();
        if (!token) throw new Error("토큰 발급 실패");

        console.log("Fetching KIS API data...");
        const response = await axios.get('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price', {
            headers: {
                'authorization': `Bearer ${token}`,
                'appkey': KIS_APP_KEY,
                'appsecret': KIS_APP_SECRET,
                'tr_id': 'FHKST01010100', // 주식현재가 조회 (선물용 TR이 다를 수 있음 주의)
                'custtype': 'P'
            },
            params: {
                fid_cond_mrkt_div_code: 'J', // 코스피
                fid_input_iscd: '10100000' // KOSPI 200 선물 연결지수 (이 코드가 맞는지 확인)
            }
        });

        console.log("KIS API Response:", JSON.stringify(response.data.output, null, 2));
    } catch (err) {
        console.error("Fetch Error:", err.response?.data || err.message);
    }
}

fetchKOSPI200Futures();
