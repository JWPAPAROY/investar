-- 해외 지수 기반 한국 시장 당일 방향 예측 테이블
-- Supabase SQL Editor에서 실행

CREATE TABLE overnight_predictions (
  id SERIAL PRIMARY KEY,
  prediction_date DATE NOT NULL UNIQUE,
  score DECIMAL(6,3),
  signal VARCHAR(20),
  factors JSONB,
  weights JSONB,
  -- 실제 결과 (당일 장 마감 후 업데이트)
  kospi_open_change DECIMAL(6,3),
  kospi_close_change DECIMAL(6,3),
  kosdaq_open_change DECIMAL(6,3),
  kosdaq_close_change DECIMAL(6,3),
  actual_direction VARCHAR(10),  -- 'up', 'down', 'flat'
  hit BOOLEAN,                   -- 예측 적중 여부
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS 정책 (anon 키로 읽기/쓰기 허용)
ALTER TABLE overnight_predictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous read" ON overnight_predictions
  FOR SELECT USING (true);

CREATE POLICY "Allow anonymous insert" ON overnight_predictions
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow anonymous update" ON overnight_predictions
  FOR UPDATE USING (true);

-- 인덱스
CREATE INDEX idx_overnight_predictions_date ON overnight_predictions (prediction_date DESC);
CREATE INDEX idx_overnight_predictions_hit ON overnight_predictions (hit) WHERE hit IS NOT NULL;
