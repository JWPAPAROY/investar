-- =============================================================================
-- market_flow_daily: 전 상장종목 일별 수급+가격 수집 (v3.93, 2026-07-06)
--
-- 목적: "풀 밖 수급-우선 신호" 가설 검증용 데이터 축적.
--   현행 스크리닝 풀(거래량 순위 top30)은 주목 정점 이후 표본이라 음의 드리프트
--   (4~6월 풀 전체 D+1→D+10 -2.0%/승30%). 순위에 뜨기 전 매집 흔적(기관/외인
--   연속 순매수 + 거래량 점증 + 가격 횡보)을 전 종목에서 찾으려면 전 종목
--   시계열이 필요한데 기존 DB는 풀 진입 종목만 저장 → 반사실 검증 불가.
--
-- 수집: scripts/collect-market-flow.js (GitHub Actions, 평일 17:50 KST)
--   유니버스 = stock_master (KIND 상장법인 ~2,631, ETF/ETN 자연 제외)
--   KIS 종목당 3콜: inquire-investor(30일 수급+종가) + inquire-daily-price(OHLCV)
--   + 현재가(시총/업종). upsert 기반 멱등 — 놓친 날은 다음 실행이 자동 복구.
--
-- 용량: ~2,600종목 × 21거래일/월 ≈ 5.5만 행/월 (행 ~150B ≈ 8MB/월)
-- =============================================================================

CREATE TABLE market_flow_daily (
  stock_code     VARCHAR(6) NOT NULL,
  trade_date     DATE NOT NULL,

  -- 가격 (inquire-daily-price; close는 inquire-investor에서도 보완)
  open           BIGINT,
  high           BIGINT,
  low            BIGINT,
  close          BIGINT,
  volume         BIGINT,
  trading_value  BIGINT,          -- 누적 거래대금 (원)

  -- 수급 (inquire-investor, FHKST01010900) — 수량 단위: 주, 대금 단위: 백만원
  inst_net_qty   BIGINT,          -- 기관 순매수 수량 (주)
  inst_net_value BIGINT,          -- 기관 순매수 대금 (백만원)
  frgn_net_qty   BIGINT,          -- 외국인 순매수 수량 (주)
  frgn_net_value BIGINT,          -- 외국인 순매수 대금 (백만원)
  prsn_net_value BIGINT,          -- 개인 순매수 대금 (백만원)

  -- 메타 (현재가 API 기준; market_cap은 상장주식수×해당일 종가 근사)
  market_cap     BIGINT,
  sector_name    VARCHAR(50),

  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (stock_code, trade_date)
);

CREATE INDEX idx_mfd_date ON market_flow_daily(trade_date);
CREATE INDEX idx_mfd_code_date ON market_flow_daily(stock_code, trade_date DESC);

ALTER TABLE market_flow_daily ENABLE ROW LEVEL SECURITY;
-- anon 키로 수집(insert/upsert)해야 하므로 stock_master와 동일한 개방 정책
CREATE POLICY "mfd_read" ON market_flow_daily FOR SELECT USING (true);
CREATE POLICY "mfd_write" ON market_flow_daily FOR ALL USING (true) WITH CHECK (true);
