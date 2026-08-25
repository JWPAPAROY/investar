-- ============================================================================
-- Investar Supabase 전체 스키마 (public) — 2026-08-25 덤프 v2
--
-- 생성: supabase-dump-schema.sql 을 Supabase SQL Editor에서 실행한 결과.
-- 이 파일이 스키마의 **단일 출처**다. 개별 supabase-*.sql 은 히스토리(언제 왜 추가했나).
--
-- 재구축 순서 = 이 파일의 순서:
--   시퀀스 → 테이블 → 뷰 → 제약(PK/UNIQUE/FK/CHECK) → 인덱스
--   → RLS 활성화 → RLS 정책 → 함수 → 트리거
--
-- ── 이 덤프로 확인된 것 (2026-08-25) ─────────────────────────────────────────
-- 1. **트리거 trg_active_policy_history** 가 active_policy UPDATE마다
--    active_policy_history 에 INSERT한다. weekly-diagnostic.js 가 **또** 명시적으로
--    INSERT하고 있어 자동적용 1회당 이력이 2행씩 쌓였다(v3.96에서 코드 쪽 제거).
--    같은 트리거가 NEW.since_date = CURRENT_DATE 로 덮어쓰므로, 코드가 보내는
--    since_date(weekStart)는 DB에 남지 않는다.
-- 2. **FK 2개** — recommendation_daily_prices → screening_recommendations(ON DELETE CASCADE),
--    success_patterns → screening_recommendations(CASCADE 없음).
--    추천을 지울 때 가격행은 자동 삭제되지만 패턴은 먼저 지워야 한다.
-- 3. **CHECK 2개** — active_policy.id = 1 (싱글턴 강제),
--    top3_rank는 is_top3=true일 때만 1~3.
-- 4. **뷰 6개는 코드에서 사용처 0** (성과/지표 집계용 수동 조회 도구로 보인다).
--    recommendation_statistics 는 다른 뷰(overall_performance)의 기반이라 함께 유지.
-- 5. update_trend_scores_updated_at() 는 stock_trend_scores 삭제로 **고아 함수**가 됐다.
-- ============================================================================

-- ── 1. 시퀀스 ───────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS active_policy_history_id_seq;
CREATE SEQUENCE IF NOT EXISTS expected_return_stats_id_seq;
CREATE SEQUENCE IF NOT EXISTS overnight_predictions_id_seq;
CREATE SEQUENCE IF NOT EXISTS stock_expected_returns_id_seq;
CREATE SEQUENCE IF NOT EXISTS weekly_diagnostics_id_seq;

-- ── 2. 테이블 ───────────────────────────────────────────────────────────────
-- ===== TABLE: active_policy =====
CREATE TABLE active_policy (
  id integer NOT NULL DEFAULT 1,
  buy_offset_day integer NOT NULL DEFAULT 0,
  sell_offset_day integer NOT NULL DEFAULT 3,
  regime_mode text,
  since_date date NOT NULL DEFAULT CURRENT_DATE,
  set_by text NOT NULL DEFAULT 'system'::text,
  change_reason text,
  updated_at timestamptz DEFAULT now()
);

-- ===== TABLE: active_policy_history =====
CREATE TABLE active_policy_history (
  id bigint NOT NULL DEFAULT nextval('active_policy_history_id_seq'::regclass),
  changed_at timestamptz DEFAULT now(),
  buy_offset_day integer NOT NULL,
  sell_offset_day integer NOT NULL,
  regime_mode text,
  set_by text NOT NULL,
  change_reason text,
  prev_buy_offset_day integer,
  prev_sell_offset_day integer,
  prev_regime_mode text
);

-- ===== TABLE: expected_return_stats =====
CREATE TABLE expected_return_stats (
  id integer NOT NULL DEFAULT nextval('expected_return_stats_id_seq'::regclass),
  grade varchar(10) NOT NULL,
  whale_detected boolean NOT NULL,
  optimal_days integer NOT NULL,
  p25 numeric(10,2),
  median numeric(10,2),
  p75 numeric(10,2),
  win_rate numeric(5,2),
  sample_count integer,
  updated_at timestamp DEFAULT now(),
  latest_data_date date
);

-- ===== TABLE: lowvol_observations =====
CREATE TABLE lowvol_observations (
  signal_date date NOT NULL,
  params jsonb NOT NULL,
  picks jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- ===== TABLE: market_flow_daily =====
CREATE TABLE market_flow_daily (
  stock_code varchar(6) NOT NULL,
  trade_date date NOT NULL,
  open bigint,
  high bigint,
  low bigint,
  close bigint,
  volume bigint,
  trading_value bigint,
  inst_net_qty bigint,
  inst_net_value bigint,
  frgn_net_qty bigint,
  frgn_net_value bigint,
  prsn_net_value bigint,
  market_cap bigint,
  sector_name varchar(50),
  updated_at timestamptz DEFAULT now()
);

-- ===== TABLE: overnight_predictions =====
CREATE TABLE overnight_predictions (
  id integer NOT NULL DEFAULT nextval('overnight_predictions_id_seq'::regclass),
  prediction_date date NOT NULL,
  score numeric(6,3),
  signal varchar(20),
  factors jsonb,
  weights jsonb,
  kospi_open_change numeric(6,3),
  kospi_close_change numeric(6,3),
  kosdaq_open_change numeric(6,3),
  kosdaq_close_change numeric(6,3),
  actual_direction varchar(10),
  hit boolean,
  created_at timestamptz DEFAULT now(),
  weights_source text,
  previous_kospi numeric,
  kospi_beta numeric,
  ai_interpretation text,
  expected_change jsonb,
  previous_kospi_date text,
  us_market_date text,
  kospi_close numeric,
  kosdaq_close numeric,
  alert_sent_at timestamptz
);

-- ===== TABLE: recommendation_daily_prices =====
CREATE TABLE recommendation_daily_prices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL,
  tracking_date date NOT NULL,
  closing_price integer NOT NULL,
  change_rate numeric(10,2) NOT NULL,
  volume bigint,
  cumulative_return numeric(10,2) NOT NULL,
  days_since_recommendation integer NOT NULL,
  created_at timestamp DEFAULT now(),
  volume_t1 bigint DEFAULT 0,
  volume_t2 bigint DEFAULT 0,
  volume_t3 bigint DEFAULT 0,
  volume_t4 bigint DEFAULT 0
);

-- ===== TABLE: screening_recommendations =====
CREATE TABLE screening_recommendations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recommendation_date date NOT NULL,
  stock_code varchar(10) NOT NULL,
  stock_name varchar(100) NOT NULL,
  recommended_price integer NOT NULL,
  recommendation_grade varchar(10) NOT NULL,
  total_score numeric(5,2) NOT NULL,
  change_rate numeric(10,2),
  volume bigint,
  market_cap bigint,
  whale_detected boolean DEFAULT false,
  accumulation_detected boolean DEFAULT false,
  mfi numeric(5,2),
  volume_ratio numeric(10,2),
  is_active boolean DEFAULT true,
  closed_at timestamp,
  closed_price integer,
  close_reason varchar(50),
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  volume_acceleration_score integer,
  volume_acceleration_trend varchar(30),
  asymmetric_ratio numeric(5,2),
  asymmetric_signal varchar(50),
  obv_trend varchar(20),
  volume_5d_change_rate numeric(10,2),
  whale_confirmed boolean DEFAULT false,
  whale_volume_ratio numeric(10,2),
  whale_price_change numeric(10,2),
  rsi numeric(5,2),
  disparity numeric(5,2),
  vwap_divergence numeric(5,2),
  consecutive_rise_days integer,
  escape_velocity boolean DEFAULT false,
  escape_closing_strength numeric(5,2),
  upper_shadow_ratio numeric(5,2),
  institution_buy_days integer,
  foreign_buy_days integer,
  vpd_score numeric(5,2),
  vpd_raw numeric(5,2),
  base_score numeric(5,2),
  whale_bonus integer,
  momentum_score numeric(5,2),
  trend_score numeric(5,2),
  market text,
  defense_score integer,
  defense_grade text,
  is_top3 boolean DEFAULT false,
  is_defense_top3 boolean DEFAULT false,
  total_score_v2 integer DEFAULT 0,
  is_top3_v2 boolean DEFAULT false,
  signal_adjustment integer DEFAULT 0,
  sector_name text,
  is_sideways_top3 boolean DEFAULT false,
  market_regime text DEFAULT 'momentum'::text,
  top3_rank smallint
);

-- ===== TABLE: sector_outlook_stats =====
CREATE TABLE sector_outlook_stats (
  sector_name text NOT NULL,
  bull_sample_count integer DEFAULT 0,
  bull_win_rate numeric(5,2) DEFAULT 0,
  bull_avg_return numeric(6,2) DEFAULT 0,
  neutral_sample_count integer DEFAULT 0,
  neutral_win_rate numeric(5,2) DEFAULT 0,
  neutral_avg_return numeric(6,2) DEFAULT 0,
  bear_sample_count integer DEFAULT 0,
  bear_win_rate numeric(5,2) DEFAULT 0,
  bear_avg_return numeric(6,2) DEFAULT 0,
  momentum_r numeric(5,3) DEFAULT 0,
  momentum_sample_count integer DEFAULT 0,
  prev_day_avg_return numeric(6,2) DEFAULT 0,
  overall_win_rate numeric(5,2) DEFAULT 0,
  overall_avg_return numeric(6,2) DEFAULT 0,
  overall_sample_count integer DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  leading_score numeric DEFAULT 0,
  sector_daily_change numeric
);

-- ===== TABLE: stock_expected_returns =====
CREATE TABLE stock_expected_returns (
  id bigint NOT NULL DEFAULT nextval('stock_expected_returns_id_seq'::regclass),
  recommendation_date date NOT NULL,
  stock_code varchar(10) NOT NULL,
  optimal_days integer NOT NULL,
  p25 numeric(6,2) NOT NULL,
  median numeric(6,2) NOT NULL,
  p75 numeric(6,2) NOT NULL,
  win_rate numeric(5,2) NOT NULL,
  sample_count integer NOT NULL,
  match_method varchar(20) NOT NULL DEFAULT 'similar'::character varying,
  match_dimensions text,
  updated_at timestamptz DEFAULT now()
);

-- ===== TABLE: stock_financials =====
CREATE TABLE stock_financials (
  stock_code varchar(6) NOT NULL,
  stac_yymm varchar(6) NOT NULL,
  revenue_growth numeric,
  op_profit_growth numeric,
  net_income_growth numeric,
  roe numeric,
  eps numeric,
  sps numeric,
  bps numeric,
  reserve_rate numeric,
  debt_ratio numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== TABLE: stock_master =====
CREATE TABLE stock_master (
  stock_code varchar(6) NOT NULL,
  stock_name varchar(100) NOT NULL,
  market varchar(10) NOT NULL DEFAULT 'KOSPI'::character varying,
  updated_at timestamptz DEFAULT now()
);

-- ===== TABLE: success_patterns =====
CREATE TABLE success_patterns (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recommendation_id uuid,
  stock_code varchar(20) NOT NULL,
  stock_name varchar(100),
  success_date date NOT NULL,
  recommendation_date date NOT NULL,
  days_to_success integer NOT NULL,
  max_return numeric(10,2) NOT NULL,
  final_return numeric(10,2),
  recommendation_grade varchar(10),
  total_score numeric(5,2),
  volume_ratio numeric(10,2),
  volume_acceleration_score integer,
  volume_acceleration_trend varchar(30),
  asymmetric_ratio numeric(5,2),
  asymmetric_signal varchar(50),
  obv_trend varchar(20),
  obv_value bigint,
  volume_5d_change_rate numeric(10,2),
  whale_detected boolean DEFAULT false,
  whale_confirmed boolean DEFAULT false,
  whale_volume_ratio numeric(10,2),
  whale_price_change numeric(10,2),
  rsi numeric(5,2),
  mfi numeric(5,2),
  disparity numeric(5,2),
  vwap_divergence numeric(5,2),
  daily_change_rate numeric(5,2),
  consecutive_rise_days integer,
  escape_velocity boolean DEFAULT false,
  escape_closing_strength numeric(5,2),
  upper_shadow_ratio numeric(5,2),
  institution_buy_days integer,
  foreign_buy_days integer,
  accumulation_detected boolean DEFAULT false,
  vpd_score numeric(5,2),
  vpd_raw numeric(5,2),
  market_cap bigint,
  created_at timestamptz DEFAULT now()
);

-- ===== TABLE: weekly_diagnostics =====
CREATE TABLE weekly_diagnostics (
  id bigint NOT NULL DEFAULT nextval('weekly_diagnostics_id_seq'::regclass),
  week_start date NOT NULL,
  evaluated_at timestamptz DEFAULT now(),
  regime text,
  strong_signal_t3_avg float8,
  strong_signal_n integer,
  score_health_corr float8,
  score_health_label text,
  optimal_buy_d integer,
  optimal_sell_d integer,
  optimal_avg_return float8,
  optimal_min_return float8,
  optimal_sample_n integer,
  top1_alpha_current_timing float8,
  top1_alpha_optimal_timing float8,
  in_sample_weeks integer,
  oos_weeks integer,
  total_recs_evaluated integer,
  warnings text[],
  raw_json jsonb,
  created_at timestamptz DEFAULT now(),
  active_buy_offset_day integer,
  active_sell_offset_day integer,
  recommendation_differs boolean,
  consecutive_same_recommendation integer,
  meta_lookback_weeks integer,
  meta_past_buy_d integer,
  meta_past_sell_d integer,
  meta_backtest_avg_return float8,
  meta_backtest_win_rate float8,
  meta_backtest_sample_n integer,
  meta_baseline_avg_return float8,
  meta_alpha_vs_baseline float8,
  ai_interpretation text,
  oos_avg_return numeric,
  oos_sample_n integer,
  score_bucket_returns jsonb
);

-- ── 3. 뷰 ───────────────────────────────────────────────────────────────────
-- ⚠️ 6개 전부 코드에서 사용처 0 (수동 조회용 집계 뷰로 보인다).
--    recommendation_statistics 는 overall_performance 의 기반이므로 함께 유지할 것.
--    정의가 길어 여기서는 생략하지 않고 그대로 둔다 — 재구축 시 이 순서대로 실행.

-- ===== VIEW: recommendation_statistics =====  (다른 뷰가 참조하므로 먼저)
CREATE OR REPLACE VIEW recommendation_statistics AS
 SELECT r.recommendation_date, r.stock_code, r.stock_name, r.recommended_price,
    r.recommendation_grade, r.total_score,
    COALESCE(latest.closing_price, r.recommended_price) AS current_price,
    COALESCE(latest.cumulative_return, (0)::numeric) AS current_return,
    COALESCE(latest.days_since_recommendation, 0) AS days_tracked,
    COALESCE(max_prices.max_return, (0)::numeric) AS max_return,
    COALESCE(max_prices.max_price, r.recommended_price) AS max_price,
    r.is_active, r.closed_at, r.closed_price,
        CASE
            WHEN ((r.is_active = false) AND (r.closed_price IS NOT NULL))
              THEN round(((((r.closed_price - r.recommended_price))::numeric / (r.recommended_price)::numeric) * (100)::numeric), 2)
            ELSE COALESCE(latest.cumulative_return, (0)::numeric)
        END AS final_return
   FROM ((screening_recommendations r
     LEFT JOIN LATERAL ( SELECT recommendation_daily_prices.closing_price,
            recommendation_daily_prices.cumulative_return,
            recommendation_daily_prices.days_since_recommendation
           FROM recommendation_daily_prices
          WHERE (recommendation_daily_prices.recommendation_id = r.id)
          ORDER BY recommendation_daily_prices.tracking_date DESC
         LIMIT 1) latest ON (true))
     LEFT JOIN LATERAL ( SELECT max(recommendation_daily_prices.cumulative_return) AS max_return,
            max(recommendation_daily_prices.closing_price) AS max_price
           FROM recommendation_daily_prices
          WHERE (recommendation_daily_prices.recommendation_id = r.id)) max_prices ON (true))
  ORDER BY r.recommendation_date DESC, r.total_score DESC;

-- ===== VIEW: overall_performance =====
CREATE OR REPLACE VIEW overall_performance AS
 SELECT count(*) AS total_recommendations,
    count(*) FILTER (WHERE (final_return > (0)::numeric)) AS winning_count,
    count(*) FILTER (WHERE (final_return <= (0)::numeric)) AS losing_count,
    round(avg(final_return), 2) AS avg_return,
    round(avg(final_return) FILTER (WHERE (final_return > (0)::numeric)), 2) AS avg_winning_return,
    round(avg(final_return) FILTER (WHERE (final_return <= (0)::numeric)), 2) AS avg_losing_return,
    round(max(final_return), 2) AS max_return,
    round(min(final_return), 2) AS min_return,
    round((((count(*) FILTER (WHERE (final_return > (0)::numeric)))::numeric / (count(*))::numeric) * (100)::numeric), 1) AS win_rate
   FROM recommendation_statistics;

-- ===== VIEW: success_pattern_insights =====
CREATE OR REPLACE VIEW success_pattern_insights AS
 SELECT count(*) AS total_patterns,
    round(avg(max_return), 2) AS avg_max_return,
    round(avg(days_to_success), 1) AS avg_days_to_success,
    count(*) FILTER (WHERE ((recommendation_grade)::text = ANY ((ARRAY['S+'::character varying, 'S'::character varying])::text[]))) AS grade_s_count,
    count(*) FILTER (WHERE ((recommendation_grade)::text = 'A'::text)) AS grade_a_count,
    count(*) FILTER (WHERE ((recommendation_grade)::text = 'B'::text)) AS grade_b_count,
    count(*) FILTER (WHERE (total_score >= (70)::numeric)) AS score_70plus_count,
    count(*) FILTER (WHERE ((total_score >= (50)::numeric) AND (total_score < (70)::numeric))) AS score_50_70_count,
    count(*) FILTER (WHERE (total_score < (50)::numeric)) AS score_under_50_count,
    round(avg(volume_ratio), 2) AS key_volume_ratio,
    round(avg(mfi), 1) AS key_mfi,
    round(avg(rsi), 1) AS key_rsi,
    round(avg(asymmetric_ratio), 2) AS key_asymmetric,
    round(avg(disparity), 1) AS key_disparity,
    round((((count(*) FILTER (WHERE (whale_detected = true)))::numeric / (NULLIF(count(*), 0))::numeric) * (100)::numeric), 1) AS whale_pct,
    round((((count(*) FILTER (WHERE (escape_velocity = true)))::numeric / (NULLIF(count(*), 0))::numeric) * (100)::numeric), 1) AS escape_pct,
    round((((count(*) FILTER (WHERE (accumulation_detected = true)))::numeric / (NULLIF(count(*), 0))::numeric) * (100)::numeric), 1) AS accumulation_pct
   FROM success_patterns;

-- ===== VIEW: institutional_indicator_analysis =====
CREATE OR REPLACE VIEW institutional_indicator_analysis AS
 SELECT count(*) AS sample_count,
    round(avg(institution_buy_days), 1) AS institution_days_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((institution_buy_days)::double precision)))::numeric, 1) AS institution_days_median,
    count(*) FILTER (WHERE (institution_buy_days >= 3)) AS institution_3plus_count,
    round(avg(foreign_buy_days), 1) AS foreign_days_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((foreign_buy_days)::double precision)))::numeric, 1) AS foreign_days_median,
    count(*) FILTER (WHERE (foreign_buy_days >= 3)) AS foreign_3plus_count,
    count(*) FILTER (WHERE (accumulation_detected = true)) AS accumulation_count
   FROM success_patterns;

-- ===== VIEW: price_indicator_analysis =====
CREATE OR REPLACE VIEW price_indicator_analysis AS
 SELECT count(*) AS sample_count,
    round(avg(rsi), 2) AS rsi_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((rsi)::double precision)))::numeric, 2) AS rsi_median,
    round(min(rsi), 2) AS rsi_min, round(max(rsi), 2) AS rsi_max, round(stddev(rsi), 2) AS rsi_stddev,
    round(avg(mfi), 2) AS mfi_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((mfi)::double precision)))::numeric, 2) AS mfi_median,
    round(min(mfi), 2) AS mfi_min, round(max(mfi), 2) AS mfi_max,
    round(avg(disparity), 2) AS disparity_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((disparity)::double precision)))::numeric, 2) AS disparity_median,
    round(min(disparity), 2) AS disparity_min, round(max(disparity), 2) AS disparity_max,
    round(avg(vwap_divergence), 2) AS vwap_divergence_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((vwap_divergence)::double precision)))::numeric, 2) AS vwap_divergence_median,
    round(avg(daily_change_rate), 2) AS daily_change_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((daily_change_rate)::double precision)))::numeric, 2) AS daily_change_median,
    round(avg(consecutive_rise_days), 1) AS consecutive_rise_avg,
    count(*) FILTER (WHERE (consecutive_rise_days >= 3)) AS consecutive_rise_3plus_count,
    count(*) FILTER (WHERE (escape_velocity = true)) AS escape_velocity_count,
    round(avg(escape_closing_strength) FILTER (WHERE (escape_velocity = true)), 2) AS escape_strength_avg,
    round(avg(upper_shadow_ratio), 2) AS upper_shadow_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((upper_shadow_ratio)::double precision)))::numeric, 2) AS upper_shadow_median
   FROM success_patterns;

-- ===== VIEW: volume_indicator_analysis =====
CREATE OR REPLACE VIEW volume_indicator_analysis AS
 SELECT count(*) AS sample_count,
    round(avg(volume_ratio), 2) AS volume_ratio_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((volume_ratio)::double precision)))::numeric, 2) AS volume_ratio_median,
    round(min(volume_ratio), 2) AS volume_ratio_min, round(max(volume_ratio), 2) AS volume_ratio_max,
    round(stddev(volume_ratio), 2) AS volume_ratio_stddev,
    round(avg(asymmetric_ratio), 2) AS asymmetric_ratio_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((asymmetric_ratio)::double precision)))::numeric, 2) AS asymmetric_ratio_median,
    round(min(asymmetric_ratio), 2) AS asymmetric_ratio_min, round(max(asymmetric_ratio), 2) AS asymmetric_ratio_max,
    round(avg(volume_5d_change_rate), 2) AS volume_5d_change_avg,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((volume_5d_change_rate)::double precision)))::numeric, 2) AS volume_5d_change_median,
    count(*) FILTER (WHERE ((volume_acceleration_trend)::text = 'strong_acceleration'::text)) AS accel_strong_count,
    count(*) FILTER (WHERE ((volume_acceleration_trend)::text = 'acceleration'::text)) AS accel_normal_count,
    count(*) FILTER (WHERE ((volume_acceleration_trend)::text = 'mixed'::text)) AS accel_mixed_count,
    count(*) FILTER (WHERE ((volume_acceleration_trend)::text = 'deceleration'::text)) AS accel_decel_count,
    count(*) FILTER (WHERE (whale_detected = true)) AS whale_detected_count,
    round(avg(whale_volume_ratio) FILTER (WHERE (whale_detected = true)), 2) AS whale_volume_ratio_avg,
    count(*) FILTER (WHERE ((obv_trend)::text = '상승'::text)) AS obv_up_count,
    count(*) FILTER (WHERE ((obv_trend)::text = '하락'::text)) AS obv_down_count
   FROM success_patterns;

-- ── 4. 제약 (PK / UNIQUE / FK / CHECK) ──────────────────────────────────────
-- ⚠️ v1 덤프에 통째로 빠져 있던 부분. FK 2개가 삭제 순서를 규정한다.
ALTER TABLE active_policy ADD CONSTRAINT active_policy_pkey PRIMARY KEY (id);
ALTER TABLE active_policy ADD CONSTRAINT active_policy_id_check CHECK ((id = 1));
ALTER TABLE active_policy_history ADD CONSTRAINT active_policy_history_pkey PRIMARY KEY (id);
ALTER TABLE expected_return_stats ADD CONSTRAINT expected_return_stats_pkey PRIMARY KEY (id);
ALTER TABLE expected_return_stats ADD CONSTRAINT expected_return_stats_grade_whale_detected_key UNIQUE (grade, whale_detected);
ALTER TABLE lowvol_observations ADD CONSTRAINT lowvol_observations_pkey PRIMARY KEY (signal_date);
ALTER TABLE market_flow_daily ADD CONSTRAINT market_flow_daily_pkey PRIMARY KEY (stock_code, trade_date);
ALTER TABLE overnight_predictions ADD CONSTRAINT overnight_predictions_pkey PRIMARY KEY (id);
ALTER TABLE overnight_predictions ADD CONSTRAINT overnight_predictions_prediction_date_key UNIQUE (prediction_date);
ALTER TABLE recommendation_daily_prices ADD CONSTRAINT recommendation_daily_prices_pkey PRIMARY KEY (id);
ALTER TABLE recommendation_daily_prices ADD CONSTRAINT recommendation_daily_prices_recommendation_id_tracking_date_key UNIQUE (recommendation_id, tracking_date);
ALTER TABLE recommendation_daily_prices ADD CONSTRAINT recommendation_daily_prices_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES screening_recommendations(id) ON DELETE CASCADE;
ALTER TABLE screening_recommendations ADD CONSTRAINT screening_recommendations_pkey PRIMARY KEY (id);
ALTER TABLE screening_recommendations ADD CONSTRAINT screening_recommendations_recommendation_date_stock_code_key UNIQUE (recommendation_date, stock_code);
ALTER TABLE screening_recommendations ADD CONSTRAINT top3_rank_valid CHECK (((top3_rank IS NULL) OR ((is_top3 = true) AND ((top3_rank >= 1) AND (top3_rank <= 3)))));
ALTER TABLE sector_outlook_stats ADD CONSTRAINT sector_outlook_stats_pkey PRIMARY KEY (sector_name);
ALTER TABLE stock_expected_returns ADD CONSTRAINT stock_expected_returns_pkey PRIMARY KEY (id);
ALTER TABLE stock_expected_returns ADD CONSTRAINT stock_expected_returns_recommendation_date_stock_code_key UNIQUE (recommendation_date, stock_code);
ALTER TABLE stock_financials ADD CONSTRAINT stock_financials_pkey PRIMARY KEY (stock_code, stac_yymm);
ALTER TABLE stock_master ADD CONSTRAINT stock_master_pkey PRIMARY KEY (stock_code);
ALTER TABLE success_patterns ADD CONSTRAINT success_patterns_pkey PRIMARY KEY (id);
ALTER TABLE success_patterns ADD CONSTRAINT success_patterns_recommendation_id_success_date_key UNIQUE (recommendation_id, success_date);
ALTER TABLE success_patterns ADD CONSTRAINT success_patterns_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES screening_recommendations(id);
ALTER TABLE weekly_diagnostics ADD CONSTRAINT weekly_diagnostics_pkey PRIMARY KEY (id);
ALTER TABLE weekly_diagnostics ADD CONSTRAINT weekly_diagnostics_week_start_key UNIQUE (week_start);

-- ── 5. 인덱스 (제약이 자동 생성하는 것 제외) ────────────────────────────────
CREATE INDEX idx_policy_history_changed_at ON public.active_policy_history USING btree (changed_at DESC);
CREATE INDEX idx_mfd_code_date ON public.market_flow_daily USING btree (stock_code, trade_date DESC);
CREATE INDEX idx_mfd_date ON public.market_flow_daily USING btree (trade_date);
CREATE INDEX idx_overnight_predictions_hit ON public.overnight_predictions USING btree (hit) WHERE (hit IS NOT NULL);
CREATE INDEX idx_overnight_predictions_date ON public.overnight_predictions USING btree (prediction_date DESC);
CREATE INDEX idx_daily_prices_date ON public.recommendation_daily_prices USING btree (tracking_date DESC);
CREATE INDEX idx_daily_prices_rec ON public.recommendation_daily_prices USING btree (recommendation_id);
CREATE INDEX idx_recommendations_date ON public.screening_recommendations USING btree (recommendation_date DESC);
CREATE INDEX idx_recommendations_active ON public.screening_recommendations USING btree (is_active) WHERE (is_active = true);
CREATE INDEX idx_recommendations_stock ON public.screening_recommendations USING btree (stock_code);
CREATE INDEX idx_rec_volume_ratio ON public.screening_recommendations USING btree (volume_ratio);
CREATE INDEX idx_screening_top3_rank ON public.screening_recommendations USING btree (recommendation_date, top3_rank) WHERE (top3_rank IS NOT NULL);
CREATE INDEX idx_rec_mfi ON public.screening_recommendations USING btree (mfi);
CREATE INDEX idx_rec_rsi ON public.screening_recommendations USING btree (rsi);
CREATE INDEX idx_stock_exp_returns_date ON public.stock_expected_returns USING btree (recommendation_date);
CREATE INDEX idx_stock_exp_returns_code ON public.stock_expected_returns USING btree (stock_code);
CREATE INDEX idx_stock_financials_ym ON public.stock_financials USING btree (stac_yymm);
CREATE INDEX idx_stock_master_name ON public.stock_master USING btree (stock_name);
CREATE INDEX idx_success_v2_date ON public.success_patterns USING btree (success_date DESC);
CREATE INDEX idx_success_v2_grade ON public.success_patterns USING btree (recommendation_grade);
CREATE INDEX idx_success_v2_stock ON public.success_patterns USING btree (stock_code);
CREATE INDEX idx_success_v2_return ON public.success_patterns USING btree (max_return DESC);
CREATE INDEX idx_weekly_diag_week_start ON public.weekly_diagnostics USING btree (week_start DESC);

-- ── 6. RLS 활성화 (이게 없으면 아래 정책이 작동하지 않는다) ─────────────────
ALTER TABLE active_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_policy_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE expected_return_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE lowvol_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_flow_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE overnight_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_daily_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE screening_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE success_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_diagnostics ENABLE ROW LEVEL SECURITY;

-- ── 7. RLS 정책 ─────────────────────────────────────────────────────────────
-- 읽는 법: FOR ALL 이 걸린 것만 anon 키로 DELETE가 된다
--   (market_flow_daily · stock_master · expected_return_stats · stock_financials).
--   나머지는 DELETE 정책이 없어 API로 지우면 **오류 없이 0행**으로 끝난다.
CREATE POLICY "anon read active_policy" ON active_policy FOR SELECT TO public USING (true);
CREATE POLICY "anon update active_policy" ON active_policy FOR UPDATE TO public USING (true);
CREATE POLICY "anon read active_policy_history" ON active_policy_history FOR SELECT TO public USING (true);
CREATE POLICY "anon insert active_policy_history" ON active_policy_history FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow public read" ON expected_return_stats FOR SELECT TO public USING (true);
CREATE POLICY "Allow service write" ON expected_return_stats FOR ALL TO public USING (true);
CREATE POLICY "anon read lowvol_observations" ON lowvol_observations FOR SELECT TO public USING (true);
CREATE POLICY "anon insert lowvol_observations" ON lowvol_observations FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon update lowvol_observations" ON lowvol_observations FOR UPDATE TO public USING (true);
CREATE POLICY "mfd_read" ON market_flow_daily FOR SELECT TO public USING (true);
CREATE POLICY "mfd_write" ON market_flow_daily FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Allow anonymous read" ON overnight_predictions FOR SELECT TO public USING (true);
CREATE POLICY "Allow anonymous insert" ON overnight_predictions FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow anonymous update" ON overnight_predictions FOR UPDATE TO public USING (true);
CREATE POLICY "Public can read daily prices" ON recommendation_daily_prices FOR SELECT TO public USING (true);
CREATE POLICY "allow_insert_daily_prices" ON recommendation_daily_prices FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Service can insert daily prices" ON recommendation_daily_prices FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "allow_update_daily_prices" ON recommendation_daily_prices FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Public can read recommendations" ON screening_recommendations FOR SELECT TO public USING (true);
CREATE POLICY "Service can insert recommendations" ON screening_recommendations FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Service can update recommendations" ON screening_recommendations FOR UPDATE TO public USING (true);
CREATE POLICY "anon read stock_financials" ON stock_financials FOR SELECT TO public USING (true);
CREATE POLICY "anon write stock_financials" ON stock_financials FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "stock_master_read" ON stock_master FOR SELECT TO public USING (true);
CREATE POLICY "stock_master_write" ON stock_master FOR ALL TO public USING (true);
CREATE POLICY "Allow public read success_patterns" ON success_patterns FOR SELECT TO public USING (true);
CREATE POLICY "Allow service insert success_patterns" ON success_patterns FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow service update success_patterns" ON success_patterns FOR UPDATE TO public USING (true);
CREATE POLICY "anon read weekly_diagnostics" ON weekly_diagnostics FOR SELECT TO public USING (true);
CREATE POLICY "anon insert weekly_diagnostics" ON weekly_diagnostics FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon update weekly_diagnostics" ON weekly_diagnostics FOR UPDATE TO public USING (true);

-- ── 8. 함수 ─────────────────────────────────────────────────────────────────
-- log_active_policy_change: active_policy UPDATE 시 이력을 자동 INSERT한다.
--   ⚠️ NEW.since_date = CURRENT_DATE 로 **덮어쓴다** — 코드가 보내는 weekStart는 남지 않는다.
CREATE OR REPLACE FUNCTION public.log_active_policy_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW.buy_offset_day IS DISTINCT FROM OLD.buy_offset_day
   OR NEW.sell_offset_day IS DISTINCT FROM OLD.sell_offset_day
   OR NEW.regime_mode IS DISTINCT FROM OLD.regime_mode) THEN
    INSERT INTO active_policy_history (
      buy_offset_day, sell_offset_day, regime_mode, set_by, change_reason,
      prev_buy_offset_day, prev_sell_offset_day, prev_regime_mode
    ) VALUES (
      NEW.buy_offset_day, NEW.sell_offset_day, NEW.regime_mode, NEW.set_by, NEW.change_reason,
      OLD.buy_offset_day, OLD.sell_offset_day, OLD.regime_mode
    );
    NEW.updated_at = NOW();
    NEW.since_date = CURRENT_DATE;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$function$;

-- ⚠️ 고아 함수: 트리거가 붙어 있던 stock_trend_scores 가 2026-08-25에 삭제됐다.
--    남겨둬도 무해하지만 쓰는 곳이 없다. 지우려면: DROP FUNCTION public.update_trend_scores_updated_at();
CREATE OR REPLACE FUNCTION public.update_trend_scores_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    BEGIN
       NEW.updated_at = NOW();
       RETURN NEW;
    END;
    $function$;

-- get_indicator_distribution: 지표 분포 조회용 (코드 사용처 0, 수동 조회 도구)
-- 정의는 길어 생략하지 않고 필요 시 supabase-dump-schema.sql 재실행으로 복원할 것.

-- ── 9. 트리거 ───────────────────────────────────────────────────────────────
CREATE TRIGGER trg_active_policy_history BEFORE UPDATE ON public.active_policy
  FOR EACH ROW EXECUTE FUNCTION log_active_policy_change();
CREATE TRIGGER update_recommendations_updated_at BEFORE UPDATE ON public.screening_recommendations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
