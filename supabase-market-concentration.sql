-- market_concentration_daily — 유가증권 보통주 시총 집중도 일별 (2026-10-23, S3 관측)
--
-- 왜: S3 시총 쏠림 가속 신호(S3_OBSERVATION.md)는 250+60 거래일 이력이 필요하다.
--   market_flow_daily 는 2026-05-22 이후만 유효해 부족하다. 일별 요약 4개 숫자만 남긴다.
-- 시드: node scripts/s3-observation.js --seed  (로컬 data/krx-daily-2010.jsonl, 2010-01~)
-- 갱신: 매주 render-operating-state 워크플로 (KRX stk_bydd_trd)
-- Supabase SQL 에디터에서 1회 실행.

CREATE TABLE market_concentration_daily (
  trade_date  DATE PRIMARY KEY,
  n_stocks    INTEGER NOT NULL,   -- 그날 종가 > 0 인 유가 보통주 수
  total_cap   BIGINT  NOT NULL,   -- 원
  top1_cap    BIGINT  NOT NULL,
  top2_cap    BIGINT  NOT NULL,   -- 상위 2종목 합 (S3 지표)
  top3_cap    BIGINT  NOT NULL,
  top5_cap    BIGINT  NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE market_concentration_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mcd_read"  ON market_concentration_daily FOR SELECT USING (true);
CREATE POLICY "mcd_write" ON market_concentration_daily FOR ALL USING (true) WITH CHECK (true);
