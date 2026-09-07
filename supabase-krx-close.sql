-- ============================================================================
-- market_flow_daily.krx_close 추가 (2026-09-07)
--
-- 왜: 기존 `close`(KIS 유래)에 **수정주가가 부분 구간에 덮이는** 결함이 있다.
--   수집이 최근 20일 창을 다시 채우는데, 권리락 이후 재수집된 행은 수정주가로 들어오고
--   그 이전 행은 원주가로 남아 경계에 불연속이 생긴다.
--   실측(로컬 KRX 대조, 2026-09-07):
--     비비안(002070) 07-23  KRX 7,080(-0.7%)  vs  close 3,544  ← 정확히 1/2
--                    07-31  KRX 5,070(-35.0%) vs  close 5,070  ← 일치(진짜 권리락)
--   2026-01 이후 181,891쌍 중 불가능 변동(|일간|>30.5%) 151건, 그중 80건이 이 결함.
--
-- 해결: KRX 일별매매정보의 TDD_CLSPRC 를 **별도 컬럼**으로 나란히 둔다.
--   기존 close 는 지우지 않는다 — 두 출처의 괴리 자체가 감시 지표이기 때문이다
--   (source_reconciliation 과 같은 원칙).
--
-- ⚠️ KRX는 다음 날 공표라 **당일치는 비어 있다.** 소비 측은 `krx_close ?? close` 로 읽고,
--    당일 값이 필요하면 close 를 쓰되 그날 하루는 오염 위험이 없다(재수집 전이므로).
-- ============================================================================

ALTER TABLE market_flow_daily ADD COLUMN IF NOT EXISTS krx_close NUMERIC;

COMMENT ON COLUMN market_flow_daily.krx_close IS
  'KRX 일별매매정보 TDD_CLSPRC(원천 종가). close(KIS)는 권리락 구간에 수정주가가 덮이므로 계산은 이 값을 우선한다. 당일치는 비어 있다(KRX 익일 공표).';

CREATE INDEX IF NOT EXISTS idx_mfd_krx_close_null
  ON market_flow_daily (trade_date) WHERE krx_close IS NULL;

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'market_flow_daily'
   AND column_name IN ('close','krx_close','krx_market_cap','krx_listed_shares')
 ORDER BY ordinal_position;
