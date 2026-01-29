/**
 * Supabase 연결 테스트
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

console.log('Supabase URL:', supabaseUrl);
console.log('Supabase Key:', supabaseKey ? '설정됨' : '없음');

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Supabase 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testConnection() {
  try {
    console.log('\n🔌 Supabase 연결 테스트 중...\n');

    const { data, error, count } = await supabase
      .from('screening_recommendations')
      .select('*', { count: 'exact', head: false })
      .limit(5);

    if (error) {
      console.error('❌ 연결 실패:', error);
      return;
    }

    console.log('✅ 연결 성공!');
    console.log('총 레코드 수:', count);
    console.log('샘플 데이터 (최대 5개):', data.length, '개\n');

    if (data.length > 0) {
      console.log('첫 번째 레코드:');
      console.log(JSON.stringify(data[0], null, 2));
    }

  } catch (error) {
    console.error('❌ 테스트 실패:', error);
  }
}

testConnection();
