-- ============================================================================
-- bonus_issue_signals: 무상증자 실전 신호 추적 (2026-09-07)
--
-- 근거: DISCLOSURE_VERDICT.md 2회차 판정에서 A1_무상증자가 ①②를 모두 통과한
--   **유일한** 유형이다. D+1 종가 매수 → D+5 종가 매도, 매칭초과 중앙 +1.25%,
--   비용 차감 후 +0.87%p (n=248 / 신호일 224 / 독립블록 56).
--
-- ⚠️ 권리락이 이 전략의 최대 위험이다. 실측: 무상증자 결정 후 **중앙 D+10**
--   (10%분위 D+9)에 −20% 이하 급락. 매도일(D+5) 뒤 겨우 5거래일이다.
--   그래서 `fricDecsn`의 신주배정기준일(nstk_asstd)로 권리락일을 **미리 계산**해
--   매도일보다 앞서면 자격에서 탈락시킨다. 평균 2%가 아니라 건별로 확인한다.
--
-- 이 테이블은 **판정용이 아니라 운영용**이다. 사전 등록된 판정은 이미 끝났고,
--   여기서는 실전 성적과 백테스트의 괴리를 측정한다 —
--   이 저장소가 반복해서 당한 것이 "설계 의도와 실제 운영의 괴리"이기 때문이다.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bonus_issue_signals (
  rcept_no        TEXT PRIMARY KEY,        -- disclosures.rcept_no
  stock_code      TEXT NOT NULL,
  corp_name       TEXT,
  disclosure_date DATE NOT NULL,           -- D0 (공시 접수일)

  -- fricDecsn 상세
  ratio           NUMERIC,                 -- 1주당 신주배정 주식수 (nstk_ascnt_ps_ostk)
  record_date     DATE,                    -- 신주배정기준일 (nstk_asstd)
  ex_rights_date  DATE,                    -- 권리락 예정일 = 기준일 직전 거래일 (계산)
  listing_date    DATE,                    -- 신주 상장 예정일 (nstk_lstprd)

  -- 실행 일정 (거래일 기준)
  buy_date        DATE,                    -- D+1 종가 매수
  sell_date       DATE,                    -- D+5 종가 매도

  -- 신호일 스냅샷
  market_cap      BIGINT,
  cap_quintile    SMALLINT,                -- 1~5. 백테스트에서 Q1은 효과 없었다(사후 슬라이스)
  avg_value_20d   BIGINT,                  -- 20일 평균 거래대금

  eligible        BOOLEAN NOT NULL DEFAULT FALSE,
  reject_reason   TEXT,

  -- 실전 결과 (사후 채움)
  buy_price       NUMERIC,
  sell_price      NUMERIC,
  return_pct      NUMERIC,                 -- 원수익 (비용 미차감)
  matched_excess  NUMERIC,                 -- 동일일×시총분위 매칭초과 (백테스트와 같은 척도)

  notified_buy    BOOLEAN NOT NULL DEFAULT FALSE,
  notified_sell   BOOLEAN NOT NULL DEFAULT FALSE,
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bonus_buy   ON bonus_issue_signals (buy_date);
CREATE INDEX IF NOT EXISTS idx_bonus_sell  ON bonus_issue_signals (sell_date);
CREATE INDEX IF NOT EXISTS idx_bonus_stock ON bonus_issue_signals (stock_code, disclosure_date);

COMMENT ON TABLE bonus_issue_signals IS
  '무상증자 실전 신호. 판정은 DISCLOSURE_VERDICT.md에서 끝났고 여기서는 실전 성적을 추적한다.';
COMMENT ON COLUMN bonus_issue_signals.ex_rights_date IS
  '권리락 예정일. 매도일(D+5)보다 앞서면 자격 탈락 — 실측 중앙 D+10이라 여유가 5거래일뿐이다.';
COMMENT ON COLUMN bonus_issue_signals.cap_quintile IS
  '백테스트 강건성 표에서 Q1 -0.07% / Q5 +2.09%였다. 다만 이는 **사후 슬라이스**이므로 자격이 아니라 등급 표시로만 쓴다.';
COMMENT ON COLUMN bonus_issue_signals.matched_excess IS
  '실전과 백테스트를 같은 자로 비교하기 위한 값. 원수익과 함께 본다.';

ALTER TABLE bonus_issue_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon read bonus_issue_signals"  ON bonus_issue_signals;
DROP POLICY IF EXISTS "anon write bonus_issue_signals" ON bonus_issue_signals;
CREATE POLICY "anon read bonus_issue_signals"  ON bonus_issue_signals FOR SELECT USING (true);
CREATE POLICY "anon write bonus_issue_signals" ON bonus_issue_signals FOR ALL    USING (true) WITH CHECK (true);

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'bonus_issue_signals' ORDER BY ordinal_position;
