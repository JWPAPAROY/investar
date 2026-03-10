require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const kis = require('../backend/kisApi');
const axios = require('axios');

async function test() {
  const token = await kis.getAccessToken();
  await new Promise(r => setTimeout(r, 300));

  const response = await axios.get('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/fluctuation', {
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${token}`,
      'appkey': process.env.KIS_APP_KEY,
      'appsecret': process.env.KIS_APP_SECRET,
      'tr_id': 'FHPST01700000'
    },
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_COND_SCR_DIV_CODE: '20170',
      FID_INPUT_ISCD: '0000',
      FID_RANK_SORT_CLS_CODE: '0',
      FID_INPUT_CNT_1: '30',
      FID_PRC_CLS_CODE: '0',
      FID_INPUT_PRICE_1: '0',
      FID_INPUT_PRICE_2: '1000000',
      FID_VOL_CNT: '0',
      FID_TRGT_CLS_CODE: '0',
      FID_TRGT_EXLS_CLS_CODE: '0000000000',
      FID_DIV_CLS_CODE: '0',
      FID_RSFL_RATE1: '0',
      FID_RSFL_RATE2: '1000'
    }
  });

  if (response.data.rt_cd === '0') {
    const output = response.data.output;
    console.log(`총 ${output.length}개 반환`);
    console.log('\n첫 번째 종목 전체 필드:');
    console.log(JSON.stringify(output[0], null, 2));
    console.log('\n상위 5개 종목:');
    output.slice(0, 5).forEach(item => {
      console.log(`  ${item.hts_kor_isnm || item.stck_shrn_iscd} (${item.mksc_shrn_iscd || item.stck_shrn_iscd}) 등락률: ${item.prdy_ctrt}%`);
    });
  } else {
    console.log('오류:', response.data.msg1);
  }
}

test().catch(console.error);
