/**
 * 가격 업데이트 테스트 스크립트
 */
require('dotenv').config();
const updatePricesApi = require('./api/recommendations/update-prices');

async function testUpdatePrices() {
  console.log('🧪 가격 업데이트 API 테스트 시작\n');

  // Mock request/response 객체
  const req = {
    method: 'POST',
    query: {}
  };

  let jsonResult = null;
  let statusCode = 200;

  const res = {
    json: (data) => {
      jsonResult = data;
      return res;
    },
    status: (code) => {
      statusCode = code;
      return res;
    },
    setHeader: () => res,
    end: () => res
  };

  try {
    // API 실행
    await updatePricesApi(req, res);

    console.log('\n' + '='.repeat(80));
    console.log('📊 가격 업데이트 결과');
    console.log('='.repeat(80));
    console.log('HTTP Status:', statusCode);
    console.log('Response:', JSON.stringify(jsonResult, null, 2));
    console.log('='.repeat(80));

  } catch (error) {
    console.error('❌ 테스트 실패:', error);
    process.exit(1);
  }
}

testUpdatePrices();
