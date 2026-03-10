/**
 * 새로운 5-API 풀 크기 테스트
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const kis = require('../backend/kisApi');

async function test() {
  console.log('=== 새로운 5-API 풀 크기 테스트 ===\n');

  const result = await kis.getAllStockList('ALL');

  console.log(`\n📊 최종 결과:`);
  console.log(`  - 총 종목 수: ${result.codes.length}`);
  console.log(`  - KOSPI: ${result.codes.filter(c => c.startsWith('0')).length}개`);
  console.log(`  - KOSDAQ: ${result.codes.filter(c => !c.startsWith('0')).length}개`);
}

test().catch(console.error);
