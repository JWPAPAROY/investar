-- 성공 패턴 수집 테이블 (v3.28)
-- 연속 급등주가 될 때 추천 시점의 신호들을 저장

CREATE TABLE IF NOT EXISTS success_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 종목 정보
  recommendation_id UUID REFERENCES screening_recommendations(id),
  stock_code VARCHAR(20) NOT NULL,
  stock_name VARCHAR(100),

  -- 성공 시점 정보
  success_date DATE NOT NULL,                    -- 연속 급등 감지일
  consecutive_days INTEGER NOT NULL,             -- 연속 상승일수
  total_return DECIMAL(10, 2) NOT NULL,          -- 누적 수익률

  -- 추천 시점 신호들 (screening 시점)
  recommendation_date DATE NOT NULL,
  recommendation_grade VARCHAR(10),
  recommendation_score DECIMAL(5, 2),

  -- 주요 신호
  whale_detected BOOLEAN DEFAULT FALSE,          -- 고래 감지
  whale_confirmed BOOLEAN DEFAULT FALSE,         -- 고래 확인됨 (v3.25)
  accumulation_detected BOOLEAN DEFAULT FALSE,   -- 조용한 매집
  escape_velocity BOOLEAN DEFAULT FALSE,         -- 탈출 속도

  -- 수치 지표
  mfi DECIMAL(5, 2),                             -- Money Flow Index
  volume_ratio DECIMAL(5, 2),                    -- 거래량 비율
  rsi DECIMAL(5, 2),                             -- RSI

  -- 상승 중 패턴
  volume_trend VARCHAR(20),                      -- increasing, stable, decreasing
  rise_pattern VARCHAR(20),                      -- explosive, gradual, slow

  -- 메타데이터
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- 중복 방지 (같은 추천에 대해 하루에 한 번만 기록)
  UNIQUE(recommendation_id, success_date)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_success_patterns_date ON success_patterns(success_date DESC);
CREATE INDEX IF NOT EXISTS idx_success_patterns_stock ON success_patterns(stock_code);
CREATE INDEX IF NOT EXISTS idx_success_patterns_grade ON success_patterns(recommendation_grade);
CREATE INDEX IF NOT EXISTS idx_success_patterns_whale ON success_patterns(whale_detected);

-- 월간 분석용 뷰
CREATE OR REPLACE VIEW monthly_pattern_analysis AS
SELECT
  DATE_TRUNC('month', success_date) as month,

  -- 전체 통계
  COUNT(*) as total_successes,
  AVG(total_return) as avg_return,
  AVG(consecutive_days) as avg_consecutive_days,

  -- 고래 감지 신호 효과
  COUNT(*) FILTER (WHERE whale_detected = true) as whale_count,
  AVG(total_return) FILTER (WHERE whale_detected = true) as whale_avg_return,
  AVG(total_return) FILTER (WHERE whale_detected = false) as non_whale_avg_return,

  -- 확인된 고래 효과
  COUNT(*) FILTER (WHERE whale_confirmed = true) as confirmed_whale_count,
  AVG(total_return) FILTER (WHERE whale_confirmed = true) as confirmed_whale_avg_return,

  -- 탈출 속도 효과
  COUNT(*) FILTER (WHERE escape_velocity = true) as escape_count,
  AVG(total_return) FILTER (WHERE escape_velocity = true) as escape_avg_return,

  -- 거래량 추이별 효과
  COUNT(*) FILTER (WHERE volume_trend = 'increasing') as vol_increasing_count,
  AVG(total_return) FILTER (WHERE volume_trend = 'increasing') as vol_increasing_avg_return,
  COUNT(*) FILTER (WHERE volume_trend = 'decreasing') as vol_decreasing_count,
  AVG(total_return) FILTER (WHERE volume_trend = 'decreasing') as vol_decreasing_avg_return,

  -- 등급별 효과
  COUNT(*) FILTER (WHERE recommendation_grade = 'S') as grade_s_count,
  AVG(total_return) FILTER (WHERE recommendation_grade = 'S') as grade_s_avg_return,
  COUNT(*) FILTER (WHERE recommendation_grade = 'A') as grade_a_count,
  AVG(total_return) FILTER (WHERE recommendation_grade = 'A') as grade_a_avg_return,
  COUNT(*) FILTER (WHERE recommendation_grade = 'B') as grade_b_count,
  AVG(total_return) FILTER (WHERE recommendation_grade = 'B') as grade_b_avg_return,

  -- MFI 구간별 효과
  COUNT(*) FILTER (WHERE mfi >= 70) as high_mfi_count,
  AVG(total_return) FILTER (WHERE mfi >= 70) as high_mfi_avg_return,
  COUNT(*) FILTER (WHERE mfi < 50) as low_mfi_count,
  AVG(total_return) FILTER (WHERE mfi < 50) as low_mfi_avg_return

FROM success_patterns
GROUP BY DATE_TRUNC('month', success_date)
ORDER BY month DESC;

-- 신호 조합별 분석 뷰
CREATE OR REPLACE VIEW signal_combination_analysis AS
SELECT
  -- 신호 조합
  whale_detected,
  whale_confirmed,
  escape_velocity,
  volume_trend,

  -- 통계
  COUNT(*) as sample_count,
  AVG(total_return) as avg_return,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_return) as median_return,
  MIN(total_return) as min_return,
  MAX(total_return) as max_return,
  AVG(consecutive_days) as avg_consecutive_days

FROM success_patterns
GROUP BY whale_detected, whale_confirmed, escape_velocity, volume_trend
HAVING COUNT(*) >= 3  -- 최소 3개 샘플
ORDER BY avg_return DESC;

-- RLS 정책
ALTER TABLE success_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON success_patterns
  FOR SELECT USING (true);

CREATE POLICY "Allow service insert" ON success_patterns
  FOR INSERT WITH CHECK (true);

COMMENT ON TABLE success_patterns IS '연속 급등주의 추천 시점 신호 패턴을 수집하여 스크리닝 로직 개선에 활용';
