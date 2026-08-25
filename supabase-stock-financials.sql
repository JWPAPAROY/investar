-- =============================================================================
-- stock_financials: 전 상장종목 분기 재무비율 (2026-08-20)
--
-- 목적: "재무지표 기반 선별" 가설 검증용 point-in-time 펀더멘털.
--   2026-08-08 전 시장 스캔 결론 = "고칠 곳은 지표가 아니라 풀 구성". 방어 대형주가
--   하락장에도 플러스였는데 거래량 깔때기가 구조적으로 못 봤다. 가치·퀄리티 지표가
--   그 집합을 복원하는지 보려면 전 종목 × 분기 재무가 필요하다.
--
-- 수집: scripts/collect-financials.js --push
--   KIS /uapi/domestic-stock/v1/finance/financial-ratio (FHKST66430300, 분기)
--   종목당 1콜 × ~2,600종목 ≈ 4분. 분기 1회 재실행이면 충분(멱등 upsert).
--
-- ⚠️ stac_yymm은 **결산년월**이지 공시일이 아니다. 소비 측에서 반드시
--    기말 + 공시시차(12월결산 90일 / 그 외 45일) 이후에만 사용할 것.
--    (direction-signal-battery.js의 FIN_LAG_ANNUAL / FIN_LAG_QUARTER)
-- ⚠️ PER/PBR은 저장하지 않는다. market_flow_daily의 일별 close와 조합해
--    PBR = close/bps, PER = close/eps로 매일 재계산하는 게 point-in-time이다.
-- ⚠️ eps/roe의 누적·TTM 표기 관례가 분기마다 흔들린다(삼성전자 202603 eps 6,993 >
--    202512 6,564). **동일 결산년월 내 횡단면 순위**로만 쓸 것. bps·debt_ratio는
--    잔액 기준이라 관례 문제가 없다.
--
-- 용량: ~2,553종목 × 최대 134분기 ≈ 69,000행 (약 10MB)
-- =============================================================================

CREATE TABLE stock_financials (
  stock_code        VARCHAR(6) NOT NULL,
  stac_yymm         VARCHAR(6) NOT NULL,   -- 결산년월 YYYYMM (공시일 아님)

  revenue_growth    NUMERIC,   -- grs: 매출액 증가율 %
  op_profit_growth  NUMERIC,   -- bsop_prfi_inrt: 영업이익 증가율 % (적자/흑전/적전은 0)
  net_income_growth NUMERIC,   -- ntin_inrt: 순이익 증가율 %
  roe               NUMERIC,   -- roe_val: ROE %
  eps               NUMERIC,   -- 주당순이익 (원)
  sps               NUMERIC,   -- 주당매출액 (원)
  bps               NUMERIC,   -- 주당순자산 (원) — 잔액 기준, PBR 산출용
  reserve_rate      NUMERIC,   -- rsrv_rate: 유보율 %
  debt_ratio        NUMERIC,   -- lblt_rate: 부채비율 % — 잔액 기준

  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (stock_code, stac_yymm)
);

CREATE INDEX idx_sf_code_ym ON stock_financials(stock_code, stac_yymm DESC);
CREATE INDEX idx_sf_ym ON stock_financials(stac_yymm);

ALTER TABLE stock_financials ENABLE ROW LEVEL SECURITY;
-- anon 키로 수집(upsert)하므로 stock_master / market_flow_daily와 동일 정책
CREATE POLICY "sf_read" ON stock_financials FOR SELECT USING (true);
CREATE POLICY "sf_write" ON stock_financials FOR ALL USING (true) WITH CHECK (true);
