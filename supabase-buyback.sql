-- ============================================================================
-- buyback_details: 자기주식취득 결정 상세 (2026-09-07)
--
-- 왜: 강제 흐름 가설의 판정 입력. 조건과 임계값은 BUYBACK_VERDICT.md에
--   **데이터를 보기 전에** 사전 등록돼 있다.
--
-- 두 실행 경로를 하나의 스키마로 정규화한다:
--   direct  tsstkAqDecsn         (자기주식취득결정)         — 3개월 내 직접 시장 매수
--   trust   tsstkAqTrctrCnsDecsn (신탁계약체결결정)         — 6개월~1년, 위탁사가 분산 매수
--   ※ tsstkAqTrctrCcDecsn 은 **해지** 엔드포인트다(cc_* 필드). 체결이 아니다 — 쓰지 말 것.
--
-- 원본은 raw JSONB에 그대로 남긴다. 정규화 규칙이 틀렸을 때 재수집 없이 고치기 위함.
-- ============================================================================

CREATE TABLE IF NOT EXISTS buyback_details (
  rcept_no       TEXT PRIMARY KEY,   -- disclosures.rcept_no 와 1:1
  corp_code      TEXT NOT NULL,
  stock_code     TEXT,
  rcept_dt       DATE NOT NULL,
  method         TEXT NOT NULL,      -- 'direct' | 'trust'  (P2의 분류축)
  plan_amount    BIGINT,             -- 취득 예정 금액(원). direct=aqpln_prc_ostk / trust=ctr_prc → P1 분자
  plan_shares    BIGINT,             -- 취득 예정 주식수 (direct 만 제공)
  period_bgd     DATE,               -- 취득/계약 기간 시작 → P3
  period_edd     DATE,               -- 취득/계약 기간 종료 → P3
  purpose        TEXT,               -- 취득 목적 원문 → P5(병기)
  broker         TEXT,               -- 위탁 중개업자 (흐름의 실행 주체)
  daily_limit    BIGINT,             -- 1일 매수주문 수량 한도 (direct 만) — 흐름 강도의 상한
  raw            JSONB NOT NULL,     -- DART 응답 원본
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buyback_dt     ON buyback_details (rcept_dt);
CREATE INDEX IF NOT EXISTS idx_buyback_stock  ON buyback_details (stock_code, rcept_dt);
CREATE INDEX IF NOT EXISTS idx_buyback_method ON buyback_details (method, rcept_dt);

COMMENT ON TABLE buyback_details IS
  '자기주식취득 결정 상세. 판정 기준은 BUYBACK_VERDICT.md에 사전 등록.';
COMMENT ON COLUMN buyback_details.plan_amount IS
  'P1(용량-반응)의 분자. 신호일 시가총액으로 나눠 5분위를 만든다.';
COMMENT ON COLUMN buyback_details.method IS
  'direct=즉시 시장 매수, trust=위탁 분산 매수. P2는 단기(D+5)에 direct가 더 클 것을 예측한다.';
COMMENT ON COLUMN buyback_details.raw IS
  '정규화가 틀렸을 때 재수집 없이 고치기 위해 원본을 보관한다.';

ALTER TABLE buyback_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read buyback_details"  ON buyback_details;
DROP POLICY IF EXISTS "anon write buyback_details" ON buyback_details;
CREATE POLICY "anon read buyback_details"  ON buyback_details FOR SELECT USING (true);
CREATE POLICY "anon write buyback_details" ON buyback_details FOR ALL    USING (true) WITH CHECK (true);

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'buyback_details'
 ORDER BY ordinal_position;
