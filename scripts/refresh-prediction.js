require('dotenv').config();
const overnightPredictor = require('../backend/overnightPredictor');

async function main() {
  console.log('🔄 Prediction 캐시 강제 갱신 중...');
  const result = await overnightPredictor.fetchAndPredict(true); // bypassCache=true

  const kospi200f = result.factors?.find(f => f.ticker === 'KOSPI200F');
  console.log('\n=== KOSPI200F ===');
  console.log('price:', kospi200f?.price);
  console.log('previousClose:', kospi200f?.previousClose);
  console.log('change:', kospi200f?.change);
  console.log('failed:', kospi200f?.failed);

  console.log('\n=== Prediction ===');
  console.log('score:', result.score);
  console.log('signal:', result.signal);
  console.log('✅ 캐시 갱신 완료');
}

main().catch(e => console.error('❌', e.message));
