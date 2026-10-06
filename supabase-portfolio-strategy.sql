-- ============================================================================
-- portfolio_rebalances: 전략 구분 컬럼 추가 (2026-10-06)
--
-- 왜: 저PBR·저변동(pbr_lowvol)과 나란히 E/P+저회전(ep_lowturn)을 관측한다.
--   기존 PK가 rebalance_date 하나라 같은 날 두 전략을 저장할 수 없다.
--   기존 행은 전부 pbr_lowvol로 채워진다(DEFAULT) — 기존 관측 기록은 그대로 이어진다.
--
-- 순서: 이 SQL을 실행하기 전에도 scripts/build-portfolio.js는 동작한다
--   (컬럼이 없으면 pbr_lowvol만 돌린다). 실행 후 다음 리밸런싱 잡부터 ep_lowturn이 시작된다.
-- ============================================================================

ALTER TABLE portfolio_rebalances
  ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'pbr_lowvol';

ALTER TABLE portfolio_rebalances DROP CONSTRAINT IF EXISTS portfolio_rebalances_pkey;
ALTER TABLE portfolio_rebalances ADD PRIMARY KEY (strategy, rebalance_date);

COMMENT ON COLUMN portfolio_rebalances.strategy IS
  'pbr_lowvol(저PBR+저변동, PORTFOLIO_VERDICT.md) | ep_lowturn(E/P+저회전, PORTFOLIO_VERDICT_EP.md). backend/portfolio.js STRATEGIES 참고.';

-- 확인: 기존 행이 전부 pbr_lowvol 인지
SELECT strategy, COUNT(*), MIN(rebalance_date), MAX(rebalance_date)
  FROM portfolio_rebalances GROUP BY strategy;
