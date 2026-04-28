-- Phase 2-2: weekly_diagnostics에 active_policy 비교용 컬럼 추가
ALTER TABLE weekly_diagnostics
  ADD COLUMN IF NOT EXISTS active_buy_offset_day INT,            -- 진단 시점의 active_policy.buy_offset_day
  ADD COLUMN IF NOT EXISTS active_sell_offset_day INT,           -- 진단 시점의 active_policy.sell_offset_day
  ADD COLUMN IF NOT EXISTS recommendation_differs BOOL,          -- 권고 (k,n) ≠ active_policy 여부
  ADD COLUMN IF NOT EXISTS consecutive_same_recommendation INT;  -- 같은 (k,n) 권고가 몇 주 연속인가

COMMENT ON COLUMN weekly_diagnostics.consecutive_same_recommendation IS '같은 optimal (k,n)이 연속으로 권고된 주 수. 6주 이상 + active_policy와 다르면 변경 검토 권고.';
