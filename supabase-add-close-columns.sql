-- overnight_predictions 테이블에 KOSPI/KOSDAQ 실제 종가 컬럼 추가
-- Supabase Dashboard > SQL Editor에서 실행

ALTER TABLE overnight_predictions
  ADD COLUMN IF NOT EXISTS kospi_close numeric,
  ADD COLUMN IF NOT EXISTS kosdaq_close numeric;
