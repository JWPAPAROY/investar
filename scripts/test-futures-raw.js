require('dotenv').config();
const axios = require('axios');

// KIS API에서 코스피200선물 raw 응답 확인
async function main() {
  const kisApi = require('../backend/kisApi');
  const token = await kisApi.getAccessToken();

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
        FID_INPUT_ISCD: '101000'
      }
    }
  );

  const output = response.data.output1 || response.data.output;

  console.log('=== RAW API Response ===');
  console.log('rt_cd:', response.data.rt_cd);
  console.log('msg1:', response.data.msg1);
  console.log('\n=== Key Fields ===');
  console.log('futs_prpr (현재가):', output.futs_prpr);
  console.log('futs_sdpr (전일종가):', output.futs_sdpr);
  console.log('futs_prdy_ctrt (전일대비등락률):', output.futs_prdy_ctrt);
  console.log('futs_prdy_vrss (전일대비):', output.futs_prdy_vrss);
  console.log('futs_oprc (시가):', output.futs_oprc);
  console.log('futs_hgpr (고가):', output.futs_hgpr);
  console.log('futs_lwpr (저가):', output.futs_lwpr);
  console.log('hts_kor_isnm (종목명):', output.hts_kor_isnm);

  console.log('\n=== All Fields ===');
  for (const [k, v] of Object.entries(output)) {
    if (v && v !== '0' && v !== '0.00' && v !== '') {
      console.log(`${k}: ${v}`);
    }
  }
}

main().catch(e => console.error(e.message));
