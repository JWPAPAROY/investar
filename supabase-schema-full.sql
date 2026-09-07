-- ============================================================================
-- investar 전체 스키마 (실DB 덤프, 2026-09-07)
--
-- 생성 방법: supabase-dump-schema.sql(v2, pg_catalog 기준)을 Supabase SQL Editor 에서
--   실행하고 ddl 컬럼 전체를 여기에 저장. anon 키로는 pg_catalog 를 읽을 수 없어 수동이다.
--
-- ⚠️ **이 파일은 평소에 실행하지 않는다.** DB를 처음부터 재구성할 때만 쓴다.
--    스키마를 바꾸는 것은 개별 supabase-*.sql 이고, 이 파일은 그 결과를 떠낸 기록이다.
--
-- ⚠️ **덤프는 COMMENT ON 을 잡지 않는다.** 컬럼이 왜 그렇게 생겼는지(설계 근거)는
--    개별 supabase-*.sql 에만 있다. 그래서 그것들을 지우지 않는다.
--
-- 2026-08-25 덤프 대비 변경:
--   + disclosures            DART 공시 메타데이터 (공시 이벤트 축 판정 입력)
--   + buyback_details        자기주식취득 결정 상세 (강제 흐름 축)
--   + bonus_issue_signals    무상증자 실전 신호 + 성과 추적
--   + source_reconciliation  KIS↔KRX 일별 대조
--   + market_flow_daily.krx_close       KRX 원천 종가 (close 는 권리락 구간에 수정주가가 덮인다)
--   + market_flow_daily.krx_market_cap / krx_listed_shares
--   − lowvol_observations    저변동성 실시간 관측 종료(판정이 2.5년 표본으로 이관됨)
--
-- 현황: 테이블 18 · 뷰 0 · 제약 29 · 인덱스 33 · RLS정책 38 · 함수 2 · 트리거 2
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS active_policy_history_id_seq;
CREATE SEQUENCE IF NOT EXISTS expected_return_stats_id_seq;
CREATE SEQUENCE IF NOT EXISTS overnight_predictions_id_seq;
CREATE SEQUENCE IF NOT EXISTS stock_expected_returns_id_seq;
CREATE SEQUENCE IF NOT EXISTS weekly_diagnostics_id_seq;

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

-- ===== TABLE: bonus_issue_signals =====
CREATE TABLE bonus_issue_signals (
  rcept_no text NOT NULL,
  stock_code text NOT NULL,
  corp_name text,
  disclosure_date date NOT NULL,
  ratio numeric,
  record_date date,
  ex_rights_date date,
  listing_date date,
  buy_date date,
  sell_date date,
  market_cap bigint,
  cap_quintile smallint,
  avg_value_20d bigint,
  eligible boolean NOT NULL DEFAULT false,
  reject_reason text,
  buy_price numeric,
  sell_price numeric,
  return_pct numeric,
  matched_excess numeric,
  notified_buy boolean NOT NULL DEFAULT false,
  notified_sell boolean NOT NULL DEFAULT false,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== TABLE: buyback_details =====
CREATE TABLE buyback_details (
  rcept_no text NOT NULL,
  corp_code text NOT NULL,
  stock_code text,
  rcept_dt date NOT NULL,
  method text NOT NULL,
  plan_amount bigint,
  plan_shares bigint,
  period_bgd date,
  period_edd date,
  purpose text,
  broker text,
  daily_limit bigint,
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== TABLE: disclosures =====
CREATE TABLE disclosures (
  rcept_no text NOT NULL,
  rcept_dt date NOT NULL,
  corp_code text NOT NULL,
  corp_name text,
  stock_code text,
  corp_cls text,
  report_nm text NOT NULL,
  flr_nm text,
  rm text,
  report_type text,
  is_amendment boolean NOT NULL DEFAULT false,
  is_subsidiary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
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
  updated_at timestamptz DEFAULT now(),
  krx_market_cap bigint,
  krx_listed_shares bigint,
  krx_close numeric
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

-- ===== TABLE: portfolio_rebalances =====
CREATE TABLE portfolio_rebalances (
  rebalance_date date NOT NULL,
  buy_date date,
  next_date date,
  params jsonb NOT NULL,
  holdings jsonb NOT NULL,
  universe_size integer,
  created_at timestamptz NOT NULL DEFAULT now()
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

-- ===== TABLE: source_reconciliation =====
CREATE TABLE source_reconciliation (
  trade_date date NOT NULL,
  compared integer,
  fields jsonb NOT NULL,
  worst jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
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

-- ===== 제약 =====
ALTER TABLE active_policy ADD CONSTRAINT active_policy_id_check CHECK ((id = 1));
ALTER TABLE active_policy ADD CONSTRAINT active_policy_pkey PRIMARY KEY (id);
ALTER TABLE active_policy_history ADD CONSTRAINT active_policy_history_pkey PRIMARY KEY (id);
ALTER TABLE bonus_issue_signals ADD CONSTRAINT bonus_issue_signals_pkey PRIMARY KEY (rcept_no);
ALTER TABLE buyback_details ADD CONSTRAINT buyback_details_pkey PRIMARY KEY (rcept_no);
ALTER TABLE disclosures ADD CONSTRAINT disclosures_pkey PRIMARY KEY (rcept_no);
ALTER TABLE expected_return_stats ADD CONSTRAINT expected_return_stats_pkey PRIMARY KEY (id);
ALTER TABLE expected_return_stats ADD CONSTRAINT expected_return_stats_grade_whale_detected_key UNIQUE (grade, whale_detected);
ALTER TABLE market_flow_daily ADD CONSTRAINT market_flow_daily_pkey PRIMARY KEY (stock_code, trade_date);
ALTER TABLE overnight_predictions ADD CONSTRAINT overnight_predictions_prediction_date_key UNIQUE (prediction_date);
ALTER TABLE overnight_predictions ADD CONSTRAINT overnight_predictions_pkey PRIMARY KEY (id);
ALTER TABLE portfolio_rebalances ADD CONSTRAINT portfolio_rebalances_pkey PRIMARY KEY (rebalance_date);
ALTER TABLE recommendation_daily_prices ADD CONSTRAINT recommendation_daily_prices_pkey PRIMARY KEY (id);
ALTER TABLE recommendation_daily_prices ADD CONSTRAINT recommendation_daily_prices_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES screening_recommendations(id) ON DELETE CASCADE;
ALTER TABLE recommendation_daily_prices ADD CONSTRAINT recommendation_daily_prices_recommendation_id_tracking_date_key UNIQUE (recommendation_id, tracking_date);
ALTER TABLE screening_recommendations ADD CONSTRAINT screening_recommendations_pkey PRIMARY KEY (id);
ALTER TABLE screening_recommendations ADD CONSTRAINT top3_rank_valid CHECK (((top3_rank IS NULL) OR ((is_top3 = true) AND ((top3_rank >= 1) AND (top3_rank <= 3)))));
ALTER TABLE screening_recommendations ADD CONSTRAINT screening_recommendations_recommendation_date_stock_code_key UNIQUE (recommendation_date, stock_code);
ALTER TABLE sector_outlook_stats ADD CONSTRAINT sector_outlook_stats_pkey PRIMARY KEY (sector_name);
ALTER TABLE source_reconciliation ADD CONSTRAINT source_reconciliation_pkey PRIMARY KEY (trade_date);
ALTER TABLE stock_expected_returns ADD CONSTRAINT stock_expected_returns_pkey PRIMARY KEY (id);
ALTER TABLE stock_expected_returns ADD CONSTRAINT stock_expected_returns_recommendation_date_stock_code_key UNIQUE (recommendation_date, stock_code);
ALTER TABLE stock_financials ADD CONSTRAINT stock_financials_pkey PRIMARY KEY (stock_code, stac_yymm);
ALTER TABLE stock_master ADD CONSTRAINT stock_master_pkey PRIMARY KEY (stock_code);
ALTER TABLE success_patterns ADD CONSTRAINT success_patterns_recommendation_id_success_date_key UNIQUE (recommendation_id, success_date);
ALTER TABLE success_patterns ADD CONSTRAINT success_patterns_pkey PRIMARY KEY (id);
ALTER TABLE success_patterns ADD CONSTRAINT success_patterns_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES screening_recommendations(id);
ALTER TABLE weekly_diagnostics ADD CONSTRAINT weekly_diagnostics_week_start_key UNIQUE (week_start);
ALTER TABLE weekly_diagnostics ADD CONSTRAINT weekly_diagnostics_pkey PRIMARY KEY (id);

-- ===== 인덱스 =====
CREATE INDEX idx_policy_history_changed_at ON public.active_policy_history USING btree (changed_at DESC);
CREATE INDEX idx_bonus_sell ON public.bonus_issue_signals USING btree (sell_date);
CREATE INDEX idx_bonus_stock ON public.bonus_issue_signals USING btree (stock_code, disclosure_date);
CREATE INDEX idx_bonus_buy ON public.bonus_issue_signals USING btree (buy_date);
CREATE INDEX idx_buyback_stock ON public.buyback_details USING btree (stock_code, rcept_dt);
CREATE INDEX idx_buyback_method ON public.buyback_details USING btree (method, rcept_dt);
CREATE INDEX idx_buyback_dt ON public.buyback_details USING btree (rcept_dt);
CREATE INDEX idx_disclosures_type ON public.disclosures USING btree (report_type, rcept_dt);
CREATE INDEX idx_disclosures_dt ON public.disclosures USING btree (rcept_dt);
CREATE INDEX idx_disclosures_stock ON public.disclosures USING btree (stock_code, rcept_dt);
CREATE INDEX idx_mfd_krx_close_null ON public.market_flow_daily USING btree (trade_date) WHERE (krx_close IS NULL);
CREATE INDEX idx_mfd_date ON public.market_flow_daily USING btree (trade_date);
CREATE INDEX idx_mfd_code_date ON public.market_flow_daily USING btree (stock_code, trade_date DESC);
CREATE INDEX idx_overnight_predictions_hit ON public.overnight_predictions USING btree (hit) WHERE (hit IS NOT NULL);
CREATE INDEX idx_overnight_predictions_date ON public.overnight_predictions USING btree (prediction_date DESC);
CREATE INDEX idx_daily_prices_date ON public.recommendation_daily_prices USING btree (tracking_date DESC);
CREATE INDEX idx_daily_prices_rec ON public.recommendation_daily_prices USING btree (recommendation_id);
CREATE INDEX idx_recommendations_stock ON public.screening_recommendations USING btree (stock_code);
CREATE INDEX idx_recommendations_date ON public.screening_recommendations USING btree (recommendation_date DESC);
CREATE INDEX idx_rec_rsi ON public.screening_recommendations USING btree (rsi);
CREATE INDEX idx_screening_top3_rank ON public.screening_recommendations USING btree (recommendation_date, top3_rank) WHERE (top3_rank IS NOT NULL);
CREATE INDEX idx_recommendations_active ON public.screening_recommendations USING btree (is_active) WHERE (is_active = true);
CREATE INDEX idx_rec_mfi ON public.screening_recommendations USING btree (mfi);
CREATE INDEX idx_rec_volume_ratio ON public.screening_recommendations USING btree (volume_ratio);
CREATE INDEX idx_stock_exp_returns_date ON public.stock_expected_returns USING btree (recommendation_date);
CREATE INDEX idx_stock_exp_returns_code ON public.stock_expected_returns USING btree (stock_code);
CREATE INDEX idx_stock_financials_ym ON public.stock_financials USING btree (stac_yymm);
CREATE INDEX idx_stock_master_name ON public.stock_master USING btree (stock_name);
CREATE INDEX idx_success_v2_return ON public.success_patterns USING btree (max_return DESC);
CREATE INDEX idx_success_v2_stock ON public.success_patterns USING btree (stock_code);
CREATE INDEX idx_success_v2_grade ON public.success_patterns USING btree (recommendation_grade);
CREATE INDEX idx_success_v2_date ON public.success_patterns USING btree (success_date DESC);
CREATE INDEX idx_weekly_diag_week_start ON public.weekly_diagnostics USING btree (week_start DESC);

-- ===== RLS =====
-- ⚠️ anon 정책이 대부분 FOR ALL(쓰기 포함)이다. **anon 키를 프론트에 노출하면 안 된다** —
--    누구나 판정 기록과 공시 54.9만 건을 삭제·수정할 수 있다.
--    프론트는 반드시 서버리스 함수(api/)를 경유한다.
ALTER TABLE active_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_policy_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonus_issue_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyback_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosures ENABLE ROW LEVEL SECURITY;
ALTER TABLE expected_return_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_flow_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE overnight_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_rebalances ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_daily_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE screening_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE success_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_diagnostics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon read active_policy" ON active_policy FOR SELECT TO public USING (true);
CREATE POLICY "anon update active_policy" ON active_policy FOR UPDATE TO public USING (true);
CREATE POLICY "anon insert active_policy_history" ON active_policy_history FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon read active_policy_history" ON active_policy_history FOR SELECT TO public USING (true);
CREATE POLICY "anon read bonus_issue_signals" ON bonus_issue_signals FOR SELECT TO public USING (true);
CREATE POLICY "anon write bonus_issue_signals" ON bonus_issue_signals FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon write buyback_details" ON buyback_details FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon read buyback_details" ON buyback_details FOR SELECT TO public USING (true);
CREATE POLICY "anon write disclosures" ON disclosures FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon read disclosures" ON disclosures FOR SELECT TO public USING (true);
CREATE POLICY "Allow service write" ON expected_return_stats FOR ALL TO public USING (true);
CREATE POLICY "Allow public read" ON expected_return_stats FOR SELECT TO public USING (true);
CREATE POLICY "mfd_write" ON market_flow_daily FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "mfd_read" ON market_flow_daily FOR SELECT TO public USING (true);
CREATE POLICY "Allow anonymous update" ON overnight_predictions FOR UPDATE TO public USING (true);
CREATE POLICY "Allow anonymous read" ON overnight_predictions FOR SELECT TO public USING (true);
CREATE POLICY "Allow anonymous insert" ON overnight_predictions FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon write portfolio_rebalances" ON portfolio_rebalances FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon read portfolio_rebalances" ON portfolio_rebalances FOR SELECT TO public USING (true);
CREATE POLICY "Service can insert daily prices" ON recommendation_daily_prices FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Public can read daily prices" ON recommendation_daily_prices FOR SELECT TO public USING (true);
CREATE POLICY "allow_update_daily_prices" ON recommendation_daily_prices FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "allow_insert_daily_prices" ON recommendation_daily_prices FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Service can update recommendations" ON screening_recommendations FOR UPDATE TO public USING (true);
CREATE POLICY "Public can read recommendations" ON screening_recommendations FOR SELECT TO public USING (true);
CREATE POLICY "Service can insert recommendations" ON screening_recommendations FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon write source_reconciliation" ON source_reconciliation FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "anon read source_reconciliation" ON source_reconciliation FOR SELECT TO public USING (true);
CREATE POLICY "anon read stock_financials" ON stock_financials FOR SELECT TO public USING (true);
CREATE POLICY "anon write stock_financials" ON stock_financials FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "stock_master_write" ON stock_master FOR ALL TO public USING (true);
CREATE POLICY "stock_master_read" ON stock_master FOR SELECT TO public USING (true);
CREATE POLICY "Allow public read success_patterns" ON success_patterns FOR SELECT TO public USING (true);
CREATE POLICY "Allow service update success_patterns" ON success_patterns FOR UPDATE TO public USING (true);
CREATE POLICY "Allow service insert success_patterns" ON success_patterns FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "anon read weekly_diagnostics" ON weekly_diagnostics FOR SELECT TO public USING (true);
CREATE POLICY "anon update weekly_diagnostics" ON weekly_diagnostics FOR UPDATE TO public USING (true);
CREATE POLICY "anon insert weekly_diagnostics" ON weekly_diagnostics FOR INSERT TO public WITH CHECK (true);

-- ===== 함수 =====
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
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$function$
;

-- ===== 트리거 =====
-- ⚠️ trg_active_policy_history 가 active_policy UPDATE 마다 이력을 자동 INSERT 한다.
--    weekly-diagnostic.js 가 **또** 명시적으로 INSERT 하면 2행이 쌓인다.
CREATE TRIGGER trg_active_policy_history BEFORE UPDATE ON public.active_policy FOR EACH ROW EXECUTE FUNCTION log_active_policy_change();
CREATE TRIGGER update_recommendations_updated_at BEFORE UPDATE ON public.screening_recommendations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
