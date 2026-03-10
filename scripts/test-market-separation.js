/**
 * 시장 구분 파라미터 테스트
 * FID_DIV_CLS_CODE, FID_COND_MRKT_DIV_CODE 조합별 결과 비교
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const kis = require('../backend/kisApi');
const axios = require('axios');

async function test() {
  const token = await kis.getAccessToken();

  console.log('=== 시장 구분 파라미터 테스트 ===\n');

  // 테스트 조합들
  const combos = [
    { label: '현재설정 KOSPI (MRKT=J, DIV=0)', mrkt: 'J', div: '0' },
    { label: '현재설정 KOSDAQ (MRKT=J, DIV=1)', mrkt: 'J', div: '1' },
    { label: '전체 (MRKT=J, DIV=0 없음)', mrkt: 'J', div: '' },
    { label: 'KOSPI만 (MRKT=J, DIV=0, ISCD=0001)', mrkt: 'J', div: '0', iscd: '0001' },
    { label: 'KOSDAQ만 (MRKT=J, DIV=1, ISCD=0002)', mrkt: 'J', div: '1', iscd: '0002' },
  ];

  for (const c of combos) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const params = {
        FID_COND_MRKT_DIV_CODE: c.mrkt,
        FID_COND_SCR_DIV_CODE: '20171',
        FID_INPUT_ISCD: c.iscd || '0000',
        FID_DIV_CLS_CODE: c.div,
        FID_BLNG_CLS_CODE: '0',  // 거래량순
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '0000000000',
        FID_INPUT_PRICE_1: '',
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '',
        FID_INPUT_DATE_1: ''
      };

      const response = await axios.get('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/volume-rank', {
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHPST01710000'
        },
        params
      });

      if (response.data.rt_cd === '0') {
        const output = response.data.output || [];
        const codes = output.map(i => i.mksc_shrn_iscd);
        const names = output.slice(0, 5).map(i => `${i.hts_kor_isnm}(${i.mksc_shrn_iscd})`).join(', ');

        // 종목코드로 시장 판별: 0xxxxx = KOSPI, 1/2/3xxxxx = KOSDAQ
        const kospi = codes.filter(c => c.startsWith('0'));
        const kosdaq = codes.filter(c => !c.startsWith('0'));

        console.log(`${c.label}:`);
        console.log(`  총 ${output.length}개 | KOSPI코드: ${kospi.length}개, KOSDAQ코드: ${kosdaq.length}개`);
        console.log(`  상위5: ${names}`);
        console.log();
      } else {
        console.log(`${c.label}: 오류 - ${response.data.msg1}\n`);
      }
    } catch (err) {
      console.log(`${c.label}: 실패 - ${err.response?.data?.msg1 || err.message}\n`);
    }
  }

  // 연속조회(페이지네이션) 테스트
  console.log('\n=== 연속조회(페이지네이션) 테스트 ===\n');

  try {
    const response1 = await axios.get('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/volume-rank', {
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
        FID_DIV_CLS_CODE: '0',
        FID_BLNG_CLS_CODE: '1',  // 거래증가율
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '0000000000',
        FID_INPUT_PRICE_1: '',
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '',
        FID_INPUT_DATE_1: ''
      }
    });

    const data1 = response1.data;
    console.log('첫 번째 조회:');
    console.log(`  output 개수: ${data1.output?.length}`);
    console.log(`  ctx_area_fk: "${data1.ctx_area_fk || ''}" (다음페이지 키)`);
    console.log(`  ctx_area_nk: "${data1.ctx_area_nk || ''}" (다음페이지 키)`);

    // 응답 헤더에서 연속조회 관련 필드 확인
    const headers = response1.headers;
    console.log(`  tr_cont 헤더: "${headers['tr_cont'] || 'N/A'}"`);

    // 연속조회 시도
    if (data1.ctx_area_nk || headers['tr_cont'] === 'M' || headers['tr_cont'] === 'F') {
      await new Promise(r => setTimeout(r, 300));

      const response2 = await axios.get('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/volume-rank', {
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHPST01710000',
          'tr_cont': 'N'  // 연속조회
        },
        params: {
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_COND_SCR_DIV_CODE: '20171',
          FID_INPUT_ISCD: '0000',
          FID_DIV_CLS_CODE: '0',
          FID_BLNG_CLS_CODE: '1',
          FID_TRGT_CLS_CODE: '111111111',
          FID_TRGT_EXLS_CLS_CODE: '0000000000',
          FID_INPUT_PRICE_1: '',
          FID_INPUT_PRICE_2: '',
          FID_VOL_CNT: '',
          FID_INPUT_DATE_1: '',
          CTX_AREA_FK: data1.ctx_area_fk || '',
          CTX_AREA_NK: data1.ctx_area_nk || ''
        }
      });

      const data2 = response2.data;
      console.log('\n연속조회 결과:');
      console.log(`  output 개수: ${data2.output?.length}`);
      if (data2.output?.length > 0) {
        const names2 = data2.output.slice(0, 5).map(i => i.hts_kor_isnm).join(', ');
        console.log(`  상위5: ${names2}`);
      }
    } else {
      console.log('\n  연속조회 불가 (tr_cont 또는 ctx_area 없음)');
    }

  } catch (err) {
    console.log(`연속조회 테스트 실패: ${err.message}`);
  }
}

test().catch(console.error);
