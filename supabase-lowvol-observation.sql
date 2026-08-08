-- lowvol_observations: 저변동성 후보 실시간 관측 기록 (검증 전용)
--
-- 2026-08-08 대안 깔때기 검증에서 유일하게 살아남은 후보(저변동성)를
-- 백테스트가 아닌 **실시간**으로 기록해 2026-09-16 정식 판정에 쓰기 위한 테이블.
--
-- ⚠️ 이 테이블은 추천/알림/정책 경로와 무관하다. 읽는 쪽은 scripts/record-lowvol-picks.js 뿐.
--    실운영(screening_recommendations, active_policy)에 영향을 주지 않는다.

CREATE TABLE IF NOT EXISTS lowvol_observations (
  signal_date  DATE PRIMARY KEY,          -- 신호 산출일 (매수는 D+1 종가 기준)
  params       JSONB NOT NULL,            -- { univ, look, k } — 설정 변경 이력 추적용
  picks        JSONB NOT NULL,            -- [{ stock_code, sector, close, market_cap, vol20_pct }]
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE lowvol_observations IS
  '저변동성 후보 실시간 관측 기록 (검증 전용, 실운영 무관). 규칙: 시총상위 N 중 LOOK일 일간수익 표준편차 하위 K.';
COMMENT ON COLUMN lowvol_observations.params IS
  '설정을 바꾸면 기록의 연속성이 끊긴다. 바꿀 경우 판정 시 구간을 분리할 것.';

ALTER TABLE lowvol_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon read lowvol_observations"   ON lowvol_observations FOR SELECT USING (true);
CREATE POLICY "anon insert lowvol_observations" ON lowvol_observations FOR INSERT WITH CHECK (true);
CREATE POLICY "anon update lowvol_observations" ON lowvol_observations FOR UPDATE USING (true);
