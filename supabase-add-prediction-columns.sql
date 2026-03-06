-- overnight_predictions 테이블에 누락된 컬럼 7개 추가
-- Supabase Dashboard > SQL Editor에서 실행

ALTER TABLE overnight_predictions
  ADD COLUMN IF NOT EXISTS weights_source text,
  ADD COLUMN IF NOT EXISTS previous_kospi numeric,
  ADD COLUMN IF NOT EXISTS kospi_beta numeric,
  ADD COLUMN IF NOT EXISTS ai_interpretation text,
  ADD COLUMN IF NOT EXISTS expected_change jsonb,
  ADD COLUMN IF NOT EXISTS previous_kospi_date text,
  ADD COLUMN IF NOT EXISTS us_market_date text;
