/**
 * KIS API 거래량순위 실제 반환 개수 테스트
 * 각 API가 실제로 몇 개를 반환하는지 확인
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const kis = require('../backend/kisApi');

async function test() {
  console.log('=== KIS API 거래량순위 반환 개수 테스트 ===\n');

  const token = await kis.getAccessToken();
  const axios = require('axios');

  const tests = [
    { name: '거래량 증가율 (FID_BLNG_CLS_CODE=1)', code: '1' },
    { name: '거래량 순위 (FID_BLNG_CLS_CODE=0)', code: '0' },
    { name: '거래대금 순위 (FID_BLNG_CLS_CODE=3)', code: '3' },
    { name: '거래회전율 (FID_BLNG_CLS_CODE=2)', code: '2' },
  ];

  for (const market of ['0', '1']) {  // 0=KOSPI, 1=KOSDAQ
    const mktName = market === '0' ? 'KOSPI' : 'KOSDAQ';
    console.log(`\n📊 ${mktName} 시장:`);

    for (const t of tests) {
      try {
        await new Promise(r => setTimeout(r, 300));

        const response = await axios.get(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/volume-rank`, {
          headers: {
            'Content-Type': 'application/json',
            'authorization': `Bearer ${token}`,
            'appkey': process.env.KIS_APP_KEY,
            'appsecret': process.env.KIS_APP_SECRET,
            'tr_id': 'FHPST01710000'
          },
          params: {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_COND_SCR_DIV_CODE: '20171',
            FID_INPUT_ISCD: '0000',
            FID_DIV_CLS_CODE: market,
            FID_BLNG_CLS_CODE: t.code,
            FID_TRGT_CLS_CODE: '111111111',
            FID_TRGT_EXLS_CLS_CODE: '0000000000',
            FID_INPUT_PRICE_1: '',
            FID_INPUT_PRICE_2: '',
            FID_VOL_CNT: '',
            FID_INPUT_DATE_1: ''
          }
        });

        if (response.data.rt_cd === '0') {
          const output = response.data.output || [];
          const nonEtf = output.filter(item => {
            const name = item.hts_kor_isnm || '';
            const excludeKeywords = ['ETF', 'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'ACE', 'plus', 'unicorn'];
            return !excludeKeywords.some(kw => name.includes(kw));
          });
          console.log(`  ${t.name}: API반환 ${output.length}개, ETF제외 ${nonEtf.length}개`);

          // 처음 3개와 마지막 3개 종목명 출력
          if (output.length > 0) {
            const first3 = output.slice(0, 3).map(i => i.hts_kor_isnm).join(', ');
            const last3 = output.slice(-3).map(i => i.hts_kor_isnm).join(', ');
            console.log(`    처음: ${first3} | 마지막: ${last3}`);
          }
        } else {
          console.log(`  ${t.name}: 오류 - ${response.data.msg1}`);
        }
      } catch (err) {
        console.log(`  ${t.name}: 실패 - ${err.message}`);
      }
    }
  }
}

test().catch(console.error);
