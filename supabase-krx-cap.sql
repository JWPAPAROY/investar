-- ============================================================================
-- market_flow_daily 에 KRX 실측 시총·상장주식수 추가 (v3.97, 2026-08-26)
--
-- 왜: 현재 market_cap 은 KIS 현재가 API에서 **역산한 근사치**다.
--   shares = (현재 시총 / 현재가) → 과거 종가에 곱함  (collect-market-flow.js)
--   KRX 실측과 대조하니 어긋난다(2026-08-21):
--     NAVER  KIS 33.76조 vs KRX 34.85조  (−3.1%)  역산주식수 152.1백만 vs 157.0백만
--     018700 KIS 0.02조 vs KRX 0.02조   (+42.7%) 역산주식수 16.7백만 vs 11.7백만
--     3% 초과 불일치가 하루 8~17종목, cap300 유니버스 안에도 2종목.
--
-- 왜 지금 고치나: 저PBR·저변동 포트폴리오의 유니버스(시총 상위 300)가 이 값으로 정해진다.
--   그리고 **백테스트(strategy-search.js)는 KRX MKTCAP으로 검증됐다** — 실운용이 다른
--   시총을 쓰면 순위가 달라져 성과 비교가 성립하지 않는다.
--
-- 왜 컬럼을 나누나: 두 출처를 나란히 두면 대조 화면을 만들 수 있고,
--   덮어쓰면 "언제부터 어긋났나"를 되짚을 수 없다.
--
-- ⚠️ KRX 일별매매정보는 **다음 날 공표**된다(당일 22시에도 없음, 2026-08-25 실측).
--   그래서 당일 시총은 krx_listed_shares(전일까지의 최신값) × 당일 종가로 계산한다.
--   상장주식수는 자주 안 바뀌므로 이 근사는 시총 역산보다 훨씬 정확하다.
-- ============================================================================

ALTER TABLE market_flow_daily ADD COLUMN IF NOT EXISTS krx_market_cap    BIGINT;
ALTER TABLE market_flow_daily ADD COLUMN IF NOT EXISTS krx_listed_shares BIGINT;

COMMENT ON COLUMN market_flow_daily.market_cap IS
  'KIS 역산 근사치 (현재 시총/현재가 × 해당일 종가). 부정확 — 가능하면 krx_market_cap 사용.';
COMMENT ON COLUMN market_flow_daily.krx_market_cap IS
  'KRX 일별매매정보 MKTCAP (실측). 다음 날 공표되므로 당일은 비어 있다.';
COMMENT ON COLUMN market_flow_daily.krx_listed_shares IS
  'KRX LIST_SHRS (실측 상장주식수). 당일 시총 = 이 값 × 당일 종가로 계산한다.';

-- 확인
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'market_flow_daily'
   AND column_name IN ('market_cap', 'krx_market_cap', 'krx_listed_shares')
 ORDER BY column_name;
