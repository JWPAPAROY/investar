-- ============================================
-- 성공 패턴 분석 시스템 v2
-- 목적: +10% 수익 달성 종목의 추천 시점 지표 특징 추출
-- ============================================

-- 기존 테이블 삭제 (새로 시작)
DROP TABLE IF EXISTS success_patterns CASCADE;
DROP VIEW IF EXISTS indicator_statistics CASCADE;
DROP VIEW IF EXISTS volume_indicator_analysis CASCADE;
DROP VIEW IF EXISTS price_indicator_analysis CASCADE;

-- ============================================
-- 1. 성공 패턴 테이블 (확장된 지표 저장)
-- ============================================
CREATE TABLE success_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 종목 정보
  recommendation_id UUID REFERENCES screening_recommendations(id),
  stock_code VARCHAR(20) NOT NULL,
  stock_name VARCHAR(100),

  -- 성공 기준 정보
  success_date DATE NOT NULL,                    -- 10% 달성일
  recommendation_date DATE NOT NULL,             -- 추천일
  days_to_success INTEGER NOT NULL,              -- 달성까지 소요일
  max_return DECIMAL(10, 2) NOT NULL,            -- 최고 수익률
  final_return DECIMAL(10, 2),                   -- 최종 수익률 (현재 시점)

  -- 추천 등급/점수
  recommendation_grade VARCHAR(10),
  total_score DECIMAL(5, 2),

  -- ========================================
  -- 거래량 기준 지표 (Volume-based)
  -- ========================================

  -- 거래량 비율 (vs 20일 평균)
  volume_ratio DECIMAL(10, 2),                   -- 예: 2.3 = 230%

  -- 거래량 가속도 (4구간 분석)
  volume_acceleration_score INTEGER,             -- 0-15점
  volume_acceleration_trend VARCHAR(20),         -- strong_acceleration, acceleration, mixed, deceleration

  -- 비대칭 비율 (상승일 거래량 / 하락일 거래량)
  asymmetric_ratio DECIMAL(5, 2),                -- 예: 1.8 = 상승일이 1.8배
  asymmetric_signal VARCHAR(50),                 -- 강한 매수세, 강한 매도세, 균형

  -- OBV 추세
  obv_trend VARCHAR(20),                         -- 상승, 하락, 보합
  obv_value BIGINT,

  -- 5일 거래량 변화율
  volume_5d_change_rate DECIMAL(10, 2),          -- % 변화

  -- 고래 감지 상세
  whale_detected BOOLEAN DEFAULT FALSE,
  whale_confirmed BOOLEAN DEFAULT FALSE,
  whale_volume_ratio DECIMAL(10, 2),             -- 고래 감지 시 거래량 배수
  whale_price_change DECIMAL(10, 2),             -- 고래 감지 시 가격 변동%

  -- ========================================
  -- 시세 기준 지표 (Price-based)
  -- ========================================

  -- RSI (14일)
  rsi DECIMAL(5, 2),

  -- MFI (14일)
  mfi DECIMAL(5, 2),

  -- 이격도 (20일 이동평균 대비)
  disparity DECIMAL(5, 2),                       -- 예: 108 = 8% 위

  -- VWAP 대비 괴리율
  vwap_divergence DECIMAL(5, 2),                 -- % (양수=VWAP 위, 음수=VWAP 아래)

  -- 당일 등락률
  daily_change_rate DECIMAL(5, 2),

  -- 연속 상승일
  consecutive_rise_days INTEGER,

  -- 탈출 속도 (저항선 돌파)
  escape_velocity BOOLEAN DEFAULT FALSE,
  escape_closing_strength DECIMAL(5, 2),         -- 마감 강도 %

  -- 윗꼬리 비율
  upper_shadow_ratio DECIMAL(5, 2),              -- (고가-종가)/(고가-저가) * 100

  -- ========================================
  -- 수급 기준 지표 (Institutional)
  -- ========================================

  -- 기관 연속 매수일
  institution_buy_days INTEGER,

  -- 외국인 연속 매수일
  foreign_buy_days INTEGER,

  -- ========================================
  -- 복합 지표
  -- ========================================

  -- 조용한 매집
  accumulation_detected BOOLEAN DEFAULT FALSE,

  -- Volume-Price Divergence
  vpd_score DECIMAL(5, 2),                       -- VPD 점수
  vpd_raw DECIMAL(5, 2),                         -- VPD raw 값

  -- 시가총액
  market_cap BIGINT,

  -- 메타데이터
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- 중복 방지
  UNIQUE(recommendation_id, success_date)
);

-- 인덱스
CREATE INDEX idx_success_v2_date ON success_patterns(success_date DESC);
CREATE INDEX idx_success_v2_stock ON success_patterns(stock_code);
CREATE INDEX idx_success_v2_return ON success_patterns(max_return DESC);
CREATE INDEX idx_success_v2_grade ON success_patterns(recommendation_grade);

-- ============================================
-- 2. 거래량 지표 통계 뷰
-- ============================================
CREATE OR REPLACE VIEW volume_indicator_analysis AS
SELECT
  -- 샘플 수
  COUNT(*) as sample_count,

  -- 거래량 비율 통계
  ROUND(AVG(volume_ratio)::numeric, 2) as volume_ratio_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY volume_ratio)::numeric, 2) as volume_ratio_median,
  ROUND(MIN(volume_ratio)::numeric, 2) as volume_ratio_min,
  ROUND(MAX(volume_ratio)::numeric, 2) as volume_ratio_max,
  ROUND(STDDEV(volume_ratio)::numeric, 2) as volume_ratio_stddev,

  -- 비대칭 비율 통계
  ROUND(AVG(asymmetric_ratio)::numeric, 2) as asymmetric_ratio_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY asymmetric_ratio)::numeric, 2) as asymmetric_ratio_median,
  ROUND(MIN(asymmetric_ratio)::numeric, 2) as asymmetric_ratio_min,
  ROUND(MAX(asymmetric_ratio)::numeric, 2) as asymmetric_ratio_max,

  -- 5일 거래량 변화율 통계
  ROUND(AVG(volume_5d_change_rate)::numeric, 2) as volume_5d_change_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY volume_5d_change_rate)::numeric, 2) as volume_5d_change_median,

  -- 거래량 가속도 분포
  COUNT(*) FILTER (WHERE volume_acceleration_trend = 'strong_acceleration') as accel_strong_count,
  COUNT(*) FILTER (WHERE volume_acceleration_trend = 'acceleration') as accel_normal_count,
  COUNT(*) FILTER (WHERE volume_acceleration_trend = 'mixed') as accel_mixed_count,
  COUNT(*) FILTER (WHERE volume_acceleration_trend = 'deceleration') as accel_decel_count,

  -- 고래 감지 통계
  COUNT(*) FILTER (WHERE whale_detected = true) as whale_detected_count,
  ROUND((AVG(whale_volume_ratio) FILTER (WHERE whale_detected = true))::numeric, 2) as whale_volume_ratio_avg,

  -- OBV 추세 분포
  COUNT(*) FILTER (WHERE obv_trend = '상승') as obv_up_count,
  COUNT(*) FILTER (WHERE obv_trend = '하락') as obv_down_count

FROM success_patterns;

-- ============================================
-- 3. 시세 지표 통계 뷰
-- ============================================
CREATE OR REPLACE VIEW price_indicator_analysis AS
SELECT
  -- 샘플 수
  COUNT(*) as sample_count,

  -- RSI 통계
  ROUND(AVG(rsi)::numeric, 2) as rsi_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rsi)::numeric, 2) as rsi_median,
  ROUND(MIN(rsi)::numeric, 2) as rsi_min,
  ROUND(MAX(rsi)::numeric, 2) as rsi_max,
  ROUND(STDDEV(rsi)::numeric, 2) as rsi_stddev,

  -- MFI 통계
  ROUND(AVG(mfi)::numeric, 2) as mfi_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mfi)::numeric, 2) as mfi_median,
  ROUND(MIN(mfi)::numeric, 2) as mfi_min,
  ROUND(MAX(mfi)::numeric, 2) as mfi_max,

  -- 이격도 통계
  ROUND(AVG(disparity)::numeric, 2) as disparity_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY disparity)::numeric, 2) as disparity_median,
  ROUND(MIN(disparity)::numeric, 2) as disparity_min,
  ROUND(MAX(disparity)::numeric, 2) as disparity_max,

  -- VWAP 괴리율 통계
  ROUND(AVG(vwap_divergence)::numeric, 2) as vwap_divergence_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vwap_divergence)::numeric, 2) as vwap_divergence_median,

  -- 당일 등락률 통계
  ROUND(AVG(daily_change_rate)::numeric, 2) as daily_change_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY daily_change_rate)::numeric, 2) as daily_change_median,

  -- 연속 상승일 분포
  ROUND(AVG(consecutive_rise_days)::numeric, 1) as consecutive_rise_avg,
  COUNT(*) FILTER (WHERE consecutive_rise_days >= 3) as consecutive_rise_3plus_count,

  -- 탈출 속도 통계
  COUNT(*) FILTER (WHERE escape_velocity = true) as escape_velocity_count,
  ROUND((AVG(escape_closing_strength) FILTER (WHERE escape_velocity = true))::numeric, 2) as escape_strength_avg,

  -- 윗꼬리 비율 통계
  ROUND(AVG(upper_shadow_ratio)::numeric, 2) as upper_shadow_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY upper_shadow_ratio)::numeric, 2) as upper_shadow_median

FROM success_patterns;

-- ============================================
-- 4. 수급 지표 통계 뷰
-- ============================================
CREATE OR REPLACE VIEW institutional_indicator_analysis AS
SELECT
  COUNT(*) as sample_count,

  -- 기관 매수일 통계
  ROUND(AVG(institution_buy_days)::numeric, 1) as institution_days_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY institution_buy_days)::numeric, 1) as institution_days_median,
  COUNT(*) FILTER (WHERE institution_buy_days >= 3) as institution_3plus_count,

  -- 외국인 매수일 통계
  ROUND(AVG(foreign_buy_days)::numeric, 1) as foreign_days_avg,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY foreign_buy_days)::numeric, 1) as foreign_days_median,
  COUNT(*) FILTER (WHERE foreign_buy_days >= 3) as foreign_3plus_count,

  -- 조용한 매집 통계
  COUNT(*) FILTER (WHERE accumulation_detected = true) as accumulation_count

FROM success_patterns;

-- ============================================
-- 5. 종합 통계 뷰 (인사이트용)
-- ============================================
CREATE OR REPLACE VIEW success_pattern_insights AS
SELECT
  COUNT(*) as total_patterns,
  ROUND(AVG(max_return)::numeric, 2) as avg_max_return,
  ROUND(AVG(days_to_success)::numeric, 1) as avg_days_to_success,

  -- 등급별 분포
  COUNT(*) FILTER (WHERE recommendation_grade IN ('S+', 'S')) as grade_s_count,
  COUNT(*) FILTER (WHERE recommendation_grade = 'A') as grade_a_count,
  COUNT(*) FILTER (WHERE recommendation_grade = 'B') as grade_b_count,

  -- 점수 구간별 분포
  COUNT(*) FILTER (WHERE total_score >= 70) as score_70plus_count,
  COUNT(*) FILTER (WHERE total_score >= 50 AND total_score < 70) as score_50_70_count,
  COUNT(*) FILTER (WHERE total_score < 50) as score_under_50_count,

  -- 핵심 지표 평균 (한눈에 보기)
  ROUND(AVG(volume_ratio)::numeric, 2) as key_volume_ratio,
  ROUND(AVG(mfi)::numeric, 1) as key_mfi,
  ROUND(AVG(rsi)::numeric, 1) as key_rsi,
  ROUND(AVG(asymmetric_ratio)::numeric, 2) as key_asymmetric,
  ROUND(AVG(disparity)::numeric, 1) as key_disparity,

  -- 신호 비율
  ROUND((COUNT(*) FILTER (WHERE whale_detected = true)::DECIMAL / NULLIF(COUNT(*), 0) * 100)::numeric, 1) as whale_pct,
  ROUND((COUNT(*) FILTER (WHERE escape_velocity = true)::DECIMAL / NULLIF(COUNT(*), 0) * 100)::numeric, 1) as escape_pct,
  ROUND((COUNT(*) FILTER (WHERE accumulation_detected = true)::DECIMAL / NULLIF(COUNT(*), 0) * 100)::numeric, 1) as accumulation_pct

FROM success_patterns;

-- ============================================
-- 6. 구간별 분포 분석 함수
-- ============================================
CREATE OR REPLACE FUNCTION get_indicator_distribution(
  indicator_name TEXT,
  bucket_size DECIMAL DEFAULT 0.5
)
RETURNS TABLE (
  bucket_start DECIMAL,
  bucket_end DECIMAL,
  count BIGINT,
  avg_return DECIMAL
) AS $$
BEGIN
  IF indicator_name = 'volume_ratio' THEN
    RETURN QUERY
    SELECT
      FLOOR(volume_ratio / bucket_size) * bucket_size as bucket_start,
      FLOOR(volume_ratio / bucket_size) * bucket_size + bucket_size as bucket_end,
      COUNT(*)::BIGINT,
      ROUND(AVG(max_return)::DECIMAL, 2)
    FROM success_patterns
    WHERE volume_ratio IS NOT NULL
    GROUP BY FLOOR(volume_ratio / bucket_size)
    ORDER BY bucket_start;
  ELSIF indicator_name = 'mfi' THEN
    RETURN QUERY
    SELECT
      FLOOR(mfi / 10) * 10 as bucket_start,
      FLOOR(mfi / 10) * 10 + 10 as bucket_end,
      COUNT(*)::BIGINT,
      ROUND(AVG(max_return)::DECIMAL, 2)
    FROM success_patterns
    WHERE mfi IS NOT NULL
    GROUP BY FLOOR(mfi / 10)
    ORDER BY bucket_start;
  ELSIF indicator_name = 'rsi' THEN
    RETURN QUERY
    SELECT
      FLOOR(rsi / 10) * 10 as bucket_start,
      FLOOR(rsi / 10) * 10 + 10 as bucket_end,
      COUNT(*)::BIGINT,
      ROUND(AVG(max_return)::DECIMAL, 2)
    FROM success_patterns
    WHERE rsi IS NOT NULL
    GROUP BY FLOOR(rsi / 10)
    ORDER BY bucket_start;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- RLS 정책
-- ============================================
ALTER TABLE success_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read success_patterns" ON success_patterns
  FOR SELECT USING (true);

CREATE POLICY "Allow service insert success_patterns" ON success_patterns
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow service update success_patterns" ON success_patterns
  FOR UPDATE USING (true);

-- ============================================
-- 코멘트
-- ============================================
COMMENT ON TABLE success_patterns IS '10% 이상 수익 달성 종목의 추천 시점 지표 데이터 - 스크리닝 임계값 최적화용';
COMMENT ON VIEW volume_indicator_analysis IS '성공 종목들의 거래량 관련 지표 통계';
COMMENT ON VIEW price_indicator_analysis IS '성공 종목들의 시세 관련 지표 통계';
COMMENT ON VIEW institutional_indicator_analysis IS '성공 종목들의 수급 관련 지표 통계';
COMMENT ON VIEW success_pattern_insights IS '성공 패턴 종합 인사이트';
