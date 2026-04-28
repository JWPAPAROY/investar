-- weekly_diagnostics: 주간 진단 결과 누적 저장 (append-only)
-- Phase 1: 매주 일요일 22:00 KST에 자동 실행

CREATE TABLE IF NOT EXISTS weekly_diagnostics (
  id BIGSERIAL PRIMARY KEY,
  week_start DATE NOT NULL UNIQUE,                -- 진단 기준 주의 시작일 (월요일)
  evaluated_at TIMESTAMPTZ DEFAULT NOW(),         -- 진단 실행 시각

  -- 1. Regime: 강신호 종목(volR>=3 + VPD>=2)의 최근 30일 T+3 평균
  regime TEXT NOT NULL,                            -- 'momentum' | 'sideways' | 'defense'
  strong_signal_t3_avg FLOAT,                      -- 강신호 평균 T+3 수익률 (%)
  strong_signal_n INT,                             -- 강신호 표본 수

  -- 2. Score Health: 점수 구간별 T+3 평균의 단조성
  score_health_corr FLOAT,                         -- Spearman 상관계수 (-1~+1)
  score_health_label TEXT,                         -- 'healthy' | 'broken' | 'inverted'

  -- 3. Optimal Timing: 모든 평가 주에서 +이고 평균 알파 큰 (k,n)
  optimal_buy_d INT,                               -- 권장 매수 D+k
  optimal_sell_d INT,                              -- 권장 매도 D+n
  optimal_avg_return FLOAT,                        -- 권장 timing의 평균 수익률
  optimal_min_return FLOAT,                        -- 평가 주들 중 최저 평균 수익
  optimal_sample_n INT,                            -- 표본 크기

  -- 4. TOP1 Alpha: 최근 30일 TOP1 vs TOP3 알파
  top1_alpha_current_timing FLOAT,                 -- 현재 정책(D+0매수) 알파 (%p)
  top1_alpha_optimal_timing FLOAT,                 -- 권장 정책 알파 (%p)

  -- 메타
  in_sample_weeks INT,                             -- in-sample 기간 (주)
  oos_weeks INT,                                   -- out-of-sample 기간 (주)
  total_recs_evaluated INT,                        -- 평가에 사용된 추천 수
  warnings TEXT[],                                 -- 경고 (표본 부족, regime 변화 등)
  raw_json JSONB,                                  -- 전체 진단 원본 (디버깅용)

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weekly_diag_week_start ON weekly_diagnostics(week_start DESC);

COMMENT ON TABLE weekly_diagnostics IS 'Phase 1: 주간 진단 결과 (관측 only, action 없음). 매주 일요일 22:00 KST 자동 실행';
COMMENT ON COLUMN weekly_diagnostics.score_health_corr IS '점수 구간(45-55/55-65/65-75/>=75) × T+3 평균의 Spearman r. >0이면 점수 높을수록 수익 단조 증가 (정상)';
COMMENT ON COLUMN weekly_diagnostics.optimal_buy_d IS '직전 N주 동안 모든 주에서 + 알파인 (k,n) 매트릭스 스캔 결과';

-- RLS: anon key로 INSERT/SELECT 허용 (다른 테이블과 동일한 정책)
ALTER TABLE weekly_diagnostics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon read weekly_diagnostics" ON weekly_diagnostics FOR SELECT USING (true);
CREATE POLICY "anon insert weekly_diagnostics" ON weekly_diagnostics FOR INSERT WITH CHECK (true);
CREATE POLICY "anon update weekly_diagnostics" ON weekly_diagnostics FOR UPDATE USING (true);
