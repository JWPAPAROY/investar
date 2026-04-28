-- Phase 3 (C): meta-monitor 컬럼 추가
-- 매주 진단 시 N주 전 권장의 후향 검증 결과 저장
ALTER TABLE weekly_diagnostics
  ADD COLUMN IF NOT EXISTS meta_lookback_weeks INT,             -- 몇 주 전을 검증했는가 (default 4)
  ADD COLUMN IF NOT EXISTS meta_past_buy_d INT,                 -- N주 전이 권장한 buy_offset
  ADD COLUMN IF NOT EXISTS meta_past_sell_d INT,                -- N주 전이 권장한 sell_offset
  ADD COLUMN IF NOT EXISTS meta_backtest_avg_return FLOAT,      -- 그 (k,n)으로 후속 N주 가상 운영 시 TOP3 평균 수익
  ADD COLUMN IF NOT EXISTS meta_backtest_win_rate FLOAT,        -- 가상 운영 승률
  ADD COLUMN IF NOT EXISTS meta_backtest_sample_n INT,          -- 가상 표본
  ADD COLUMN IF NOT EXISTS meta_baseline_avg_return FLOAT,      -- 같은 기간 baseline (D+0,D+3) 평균 수익
  ADD COLUMN IF NOT EXISTS meta_alpha_vs_baseline FLOAT;        -- recommendation - baseline (>0이면 진단이 도움됨)

COMMENT ON COLUMN weekly_diagnostics.meta_alpha_vs_baseline IS '진단 권장 timing이 baseline(D+0,D+3) 대비 만든 추가 수익. 누적해서 양수이면 진단의 예측력이 작동 중.';
