require('dotenv').config();
const supabase = require('../backend/supabaseClient');

async function main() {
  // 테이블 존재 여부 확인 (간단히 select 시도)
  const { data, error } = await supabase
    .from('stock_master')
    .select('stock_code')
    .limit(1);

  if (error && error.code === '42P01') {
    console.log('❌ stock_master 테이블이 없습니다.');
    console.log('Supabase SQL Editor에서 다음을 실행하세요:\n');
    console.log(`
CREATE TABLE stock_master (
  stock_code VARCHAR(6) PRIMARY KEY,
  stock_name VARCHAR(100) NOT NULL,
  market VARCHAR(10) NOT NULL DEFAULT 'KOSPI',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stock_master_name ON stock_master(stock_name);

-- RLS 비활성화 (공개 데이터)
ALTER TABLE stock_master ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock_master_read" ON stock_master FOR SELECT USING (true);
CREATE POLICY "stock_master_write" ON stock_master FOR ALL USING (true);
    `);
  } else if (error) {
    console.error('오류:', error.message);
  } else {
    console.log(`✅ stock_master 테이블 존재 (${data.length}건 샘플)`);
  }
}

main();
