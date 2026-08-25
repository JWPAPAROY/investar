-- ============================================================================
-- Investar Supabase 전체 스키마 (public) — 2026-08-25 덤프
--
-- 왜 만들었나: 코드가 쓰는 테이블 중 7개가 레포에 정의 없이 대시보드에서만
--   만들어져 있었다. screening_recommendations(56컬럼)·recommendation_daily_prices
--   (84,812행) 포함 — 프로젝트가 사라지면 재구축 불가 상태였다.
--   supabase-dump-schema.sql 을 SQL Editor에서 실행해 받은 결과다.
--
-- 이 파일이 스키마의 단일 출처다. 개별 supabase-*.sql 은 이제 히스토리다
--   (무엇을 언제 왜 추가했는가). SUPABASE_SETUP.md 의 "SQL 파일 색인" 참고.
--
-- 주의: RLS 활성화(ALTER TABLE ... ENABLE ROW LEVEL SECURITY)는 이 덤프에
--   포함되지 않는다. 재구축 시 테이블 생성 후 직접 걸어야 한다.
-- ============================================================================

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
  regime text NOT NULL,
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

-- ===== TABLE: news_mentions =====   [코드 사용처 0 — 트렌드 시스템 폐기 잔재]
CREATE TABLE news_mentions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_code varchar(10),
  stock_name varchar(100) NOT NULL,
  news_title text NOT NULL,
  news_url text,
  news_source varchar(50) NOT NULL,
  published_at timestamp NOT NULL,
  sentiment varchar(20),
  impact_score integer,
  keywords text[],
  ai_summary text,
  collected_at timestamp DEFAULT now()
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

-- ===== TABLE: search_trends =====   [코드 사용처 0 — 트렌드 시스템 폐기 잔재]
CREATE TABLE search_trends (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_code varchar(10) NOT NULL,
  stock_name varchar(100) NOT NULL,
  search_value integer NOT NULL,
  avg_value numeric(10,2) NOT NULL,
  change_rate numeric(10,2) NOT NULL,
  surge_detected boolean DEFAULT false,
  surge_score integer DEFAULT 0,
  collected_at timestamp DEFAULT now()
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

-- ===== TABLE: stock_master =====
CREATE TABLE stock_master (
  stock_code varchar(6) NOT NULL,
  stock_name varchar(100) NOT NULL,
  market varchar(10) NOT NULL DEFAULT 'KOSPI'::character varying,
  updated_at timestamptz DEFAULT now()
);

-- ===== TABLE: stock_trend_scores =====   [코드 사용처 0 — 트렌드 시스템 폐기 잔재]
CREATE TABLE stock_trend_scores (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_code varchar(10) NOT NULL,
  stock_name varchar(100) NOT NULL,
  search_score numeric(5,2) DEFAULT 0,
  search_surge boolean DEFAULT false,
  news_score numeric(5,2) DEFAULT 0,
  mentions_24h integer DEFAULT 0,
  mentions_7d integer DEFAULT 0,
  mention_change_rate numeric(10,2) DEFAULT 0,
  sentiment_score numeric(5,2) DEFAULT 0,
  positive_ratio numeric(5,2) DEFAULT 0,
  total_trend_score numeric(5,2) DEFAULT 0,
  is_hot_issue boolean DEFAULT false,
  updated_at timestamp DEFAULT now()
);

-- ============================================================================
-- 인덱스 / PK
-- ============================================================================
CREATE UNIQUE INDEX active_policy_pkey ON public.active_policy USING btree (id);
CREATE UNIQUE INDEX active_policy_history_pkey ON public.active_policy_history USING btree (id);
CREATE INDEX idx_policy_history_changed_at ON public.active_policy_history USING btree (changed_at DESC);
CREATE UNIQUE INDEX expected_return_stats_pkey ON public.expected_return_stats USING btree (id);
CREATE UNIQUE INDEX expected_return_stats_grade_whale_detected_key ON public.expected_return_stats USING btree (grade, whale_detected);
CREATE UNIQUE INDEX lowvol_observations_pkey ON public.lowvol_observations USING btree (signal_date);
CREATE INDEX idx_mfd_date ON public.market_flow_daily USING btree (trade_date);
CREATE INDEX idx_mfd_code_date ON public.market_flow_daily USING btree (stock_code, trade_date DESC);
CREATE UNIQUE INDEX market_flow_daily_pkey ON public.market_flow_daily USING btree (stock_code, trade_date);
CREATE UNIQUE INDEX idx_news_url_unique ON public.news_mentions USING btree (news_url);
CREATE INDEX idx_news_published ON public.news_mentions USING btree (published_at DESC);
CREATE INDEX idx_news_stock ON public.news_mentions USING btree (stock_code);
CREATE UNIQUE INDEX news_mentions_pkey ON public.news_mentions USING btree (id);
CREATE INDEX idx_news_source ON public.news_mentions USING btree (news_source);
CREATE UNIQUE INDEX overnight_predictions_prediction_date_key ON public.overnight_predictions USING btree (prediction_date);
CREATE INDEX idx_overnight_predictions_date ON public.overnight_predictions USING btree (prediction_date DESC);
CREATE INDEX idx_overnight_predictions_hit ON public.overnight_predictions USING btree (hit) WHERE (hit IS NOT NULL);
CREATE UNIQUE INDEX overnight_predictions_pkey ON public.overnight_predictions USING btree (id);
CREATE UNIQUE INDEX recommendation_daily_prices_recommendation_id_tracking_date_key ON public.recommendation_daily_prices USING btree (recommendation_id, tracking_date);
CREATE INDEX idx_daily_prices_rec ON public.recommendation_daily_prices USING btree (recommendation_id);
CREATE INDEX idx_daily_prices_date ON public.recommendation_daily_prices USING btree (tracking_date DESC);
CREATE UNIQUE INDEX recommendation_daily_prices_pkey ON public.recommendation_daily_prices USING btree (id);
CREATE INDEX idx_screening_top3_rank ON public.screening_recommendations USING btree (recommendation_date, top3_rank) WHERE (top3_rank IS NOT NULL);
CREATE INDEX idx_rec_mfi ON public.screening_recommendations USING btree (mfi);
CREATE INDEX idx_rec_rsi ON public.screening_recommendations USING btree (rsi);
CREATE UNIQUE INDEX screening_recommendations_pkey ON public.screening_recommendations USING btree (id);
CREATE UNIQUE INDEX screening_recommendations_recommendation_date_stock_code_key ON public.screening_recommendations USING btree (recommendation_date, stock_code);
CREATE INDEX idx_recommendations_date ON public.screening_recommendations USING btree (recommendation_date DESC);
CREATE INDEX idx_recommendations_active ON public.screening_recommendations USING btree (is_active) WHERE (is_active = true);
CREATE INDEX idx_recommendations_stock ON public.screening_recommendations USING btree (stock_code);
CREATE INDEX idx_rec_volume_ratio ON public.screening_recommendations USING btree (volume_ratio);
CREATE INDEX idx_search_trends_date ON public.search_trends USING btree (collected_at DESC);
CREATE INDEX idx_search_trends_code ON public.search_trends USING btree (stock_code);
CREATE UNIQUE INDEX search_trends_pkey ON public.search_trends USING btree (id);
CREATE UNIQUE INDEX idx_search_trends_daily ON public.search_trends USING btree (stock_code, date(collected_at));
CREATE INDEX idx_search_trends_surge ON public.search_trends USING btree (surge_detected) WHERE (surge_detected = true);
CREATE UNIQUE INDEX sector_outlook_stats_pkey ON public.sector_outlook_stats USING btree (sector_name);
CREATE UNIQUE INDEX stock_expected_returns_recommendation_date_stock_code_key ON public.stock_expected_returns USING btree (recommendation_date, stock_code);
CREATE UNIQUE INDEX stock_expected_returns_pkey ON public.stock_expected_returns USING btree (id);
CREATE INDEX idx_stock_exp_returns_date ON public.stock_expected_returns USING btree (recommendation_date);
CREATE INDEX idx_stock_exp_returns_code ON public.stock_expected_returns USING btree (stock_code);
CREATE INDEX idx_stock_master_name ON public.stock_master USING btree (stock_name);
CREATE UNIQUE INDEX stock_master_pkey ON public.stock_master USING btree (stock_code);
CREATE INDEX idx_trend_scores_hot ON public.stock_trend_scores USING btree (is_hot_issue) WHERE (is_hot_issue = true);
CREATE UNIQUE INDEX idx_trend_scores_daily ON public.stock_trend_scores USING btree (stock_code, date(updated_at));
CREATE INDEX idx_trend_scores_score ON public.stock_trend_scores USING btree (total_trend_score DESC);
CREATE UNIQUE INDEX stock_trend_scores_pkey ON public.stock_trend_scores USING btree (id);
CREATE INDEX idx_trend_scores_code ON public.stock_trend_scores USING btree (stock_code);
CREATE INDEX idx_success_v2_date ON public.success_patterns USING btree (success_date DESC);
CREATE UNIQUE INDEX success_patterns_recommendation_id_success_date_key ON public.success_patterns USING btree (recommendation_id, success_date);
CREATE UNIQUE INDEX success_patterns_pkey ON public.success_patterns USING btree (id);
CREATE INDEX idx_success_v2_grade ON public.success_patterns USING btree (recommendation_grade);
CREATE INDEX idx_success_v2_return ON public.success_patterns USING btree (max_return DESC);
CREATE INDEX idx_success_v2_stock ON public.success_patterns USING btree (stock_code);
CREATE UNIQUE INDEX weekly_diagnostics_pkey ON public.weekly_diagnostics USING btree (id);
CREATE UNIQUE INDEX weekly_diagnostics_week_start_key ON public.weekly_diagnostics USING btree (week_start);
CREATE INDEX idx_weekly_diag_week_start ON public.weekly_diagnostics USING btree (week_start DESC);

-- ============================================================================
-- RLS 정책
--
-- 읽는 법 (2026-08-25 확인):
--   * FOR ALL 이 걸린 테이블은 anon 키로 **DELETE까지 가능**하다.
--     → market_flow_daily, stock_master, expected_return_stats, stock_trend_scores
--   * 그 외는 SELECT/INSERT/UPDATE만 있고 DELETE 정책이 없다.
--     → recommendation_daily_prices, screening_recommendations, success_patterns,
--       weekly_diagnostics, active_policy(_history), overnight_predictions ...
--     이 때문에 API(anon)로 DELETE를 보내면 **오류 없이 0행**이 지워진다.
--     실제로 2026-08-25 정리 시 이 함정에 걸렸고, SQL Editor로 실행해야 했다.
-- ============================================================================
CREATE POLICY "anon update active_policy" ON active_policy FOR UPDATE TO public USING (true);
CREATE POLICY "anon read active_policy" ON active_policy FOR SELECT TO public USING (true);
CREATE POLICY "anon insert active_policy_history" ON active_policy_history FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon read active_policy_history" ON active_policy_history FOR SELECT TO public USING (true);
CREATE POLICY "Allow service write" ON expected_return_stats FOR ALL TO public USING (true);
CREATE POLICY "Allow public read" ON expected_return_stats FOR SELECT TO public USING (true);
CREATE POLICY "anon read lowvol_observations" ON lowvol_observations FOR SELECT TO public USING (true);
CREATE POLICY "anon update lowvol_observations" ON lowvol_observations FOR UPDATE TO public USING (true);
CREATE POLICY "anon insert lowvol_observations" ON lowvol_observations FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "mfd_read" ON market_flow_daily FOR SELECT TO public USING (true);
CREATE POLICY "mfd_write" ON market_flow_daily FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Service can update news mentions" ON news_mentions FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Public can read news mentions" ON news_mentions FOR SELECT TO public USING (true);
CREATE POLICY "Service can insert news mentions" ON news_mentions FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow anonymous insert" ON overnight_predictions FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow anonymous read" ON overnight_predictions FOR SELECT TO public USING (true);
CREATE POLICY "Allow anonymous update" ON overnight_predictions FOR UPDATE TO public USING (true);
CREATE POLICY "allow_insert_daily_prices" ON recommendation_daily_prices FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "allow_update_daily_prices" ON recommendation_daily_prices FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Service can insert daily prices" ON recommendation_daily_prices FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Public can read daily prices" ON recommendation_daily_prices FOR SELECT TO public USING (true);
CREATE POLICY "Public can read recommendations" ON screening_recommendations FOR SELECT TO public USING (true);
CREATE POLICY "Service can insert recommendations" ON screening_recommendations FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Service can update recommendations" ON screening_recommendations FOR UPDATE TO public USING (true);
CREATE POLICY "Service can insert search trends" ON search_trends FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Public can read search trends" ON search_trends FOR SELECT TO public USING (true);
CREATE POLICY "stock_master_write" ON stock_master FOR ALL TO public USING (true);
CREATE POLICY "stock_master_read" ON stock_master FOR SELECT TO public USING (true);
CREATE POLICY "Service can upsert trend scores" ON stock_trend_scores FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Public can read trend scores" ON stock_trend_scores FOR SELECT TO public USING (true);
CREATE POLICY "Allow service update success_patterns" ON success_patterns FOR UPDATE TO public USING (true);
CREATE POLICY "Allow service insert success_patterns" ON success_patterns FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow public read success_patterns" ON success_patterns FOR SELECT TO public USING (true);
CREATE POLICY "anon update weekly_diagnostics" ON weekly_diagnostics FOR UPDATE TO public USING (true);
CREATE POLICY "anon insert weekly_diagnostics" ON weekly_diagnostics FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon read weekly_diagnostics" ON weekly_diagnostics FOR SELECT TO public USING (true);
