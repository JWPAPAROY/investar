-- ============================================================================
-- 시장 흐름 탭 (2026-11-15) — 연준·국면·정책·산업 상황판
--
-- 수집: scripts/collect-macro.js (GitHub Actions macro.yml, 매일 1회)
-- 화면: index.html '🌏 시장 흐름' 탭 → GET /api/screening/prediction?view=macro (api/_macroView.js)
--
-- 원칙: 화면 문구는 전부 이 테이블의 실측치에서 계산한다. 고정 안내문·매매 권고 없음.
--   근거 측정(2026-11-15): 정책 발표 후 20일 추세 6/12 = 동전 던지기, 금리-주가 관계는 국면 따라 부호 반전.
-- ============================================================================

-- 패널별 스냅샷 (id = 'fed' | 'regime' | 'sectors')
CREATE TABLE IF NOT EXISTS macro_snapshot (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 정책·국가자본주의 뉴스 (Google 뉴스 RSS 자동 수집 — 사람 확인 전 원문 제목 그대로)
CREATE TABLE IF NOT EXISTS policy_news (
  link          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  source        TEXT,
  published_at  TIMESTAMPTZ,
  tag           TEXT,                 -- 수집 질의 묶음 (kr_policy / state_capital / fed)
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policy_news_pub ON policy_news (published_at DESC);

-- 정책 사건과 발표 후 실제 흐름 (반응 = D-1 종가→D+1 종가, 이후 = D+1 종가→+N거래일, 기준 대비 초과 %p)
-- target_kind = 'yahoo' 인 행은 수집기가 매번 다시 계산한다. 'krx' 행(target_sym = KRX 지수 이름, bench_sym = '코스피')은
--   d20 이 비어 있을 때만 수집기가 KRX 업종지수로 계산한다(끝난 사건은 다시 받지 않는다).
CREATE TABLE IF NOT EXISTS policy_events (
  id           TEXT PRIMARY KEY,
  event_date   DATE NOT NULL,
  market       TEXT NOT NULL,        -- KR | US
  name         TEXT NOT NULL,
  target       TEXT NOT NULL,        -- 표시용 대상 이름
  target_kind  TEXT NOT NULL,        -- yahoo | krx
  target_sym   TEXT,                 -- yahoo 심볼 (자동 계산용)
  bench_sym    TEXT,                 -- yahoo 기준 심볼 (없으면 절대 수익)
  bench        TEXT,                 -- 표시용 기준 이름
  reaction     NUMERIC,              -- 반응 (기준 대비 초과 %p, 기준 없으면 절대 %)
  d5           NUMERIC,
  d10          NUMERIC,
  d20          NUMERIC,
  computed_at  TIMESTAMPTZ
);

ALTER TABLE macro_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_news    ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_events  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "macro_read"  ON macro_snapshot;  DROP POLICY IF EXISTS "macro_write"  ON macro_snapshot;
DROP POLICY IF EXISTS "pnews_read"  ON policy_news;     DROP POLICY IF EXISTS "pnews_write"  ON policy_news;
DROP POLICY IF EXISTS "pevt_read"   ON policy_events;   DROP POLICY IF EXISTS "pevt_write"   ON policy_events;
CREATE POLICY "macro_read"  ON macro_snapshot FOR SELECT USING (true);
CREATE POLICY "macro_write" ON macro_snapshot FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "pnews_read"  ON policy_news    FOR SELECT USING (true);
CREATE POLICY "pnews_write" ON policy_news    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "pevt_read"   ON policy_events  FOR SELECT USING (true);
CREATE POLICY "pevt_write"  ON policy_events  FOR ALL USING (true) WITH CHECK (true);

-- 2026-11-15 측정한 사건 12건 (scratchpad policy-drift.mjs 결과). KR 행은 KRX 업종지수 기준이라 고정값,
-- US 행(yahoo)은 수집기가 다시 계산해 덮어쓴다.
INSERT INTO policy_events (id, event_date, market, name, target, target_kind, target_sym, bench_sym, bench, reaction, d5, d10, d20, computed_at) VALUES
 ('kr-20231105-short', '2023-11-05', 'KR', '공매도 전면 금지 발표', '코스닥 150', 'krx', '코스닥 150', '코스피', '코스피', 6.5, -5.8, -5.1, -3.6, now()),
 ('kr-20240102-fintax', '2024-01-02', 'KR', '금투세 폐지 발표', '코스닥', 'krx', '코스닥', '코스피', '코스피', 2.4, 3.0, 2.2, -4.1, now()),
 ('kr-20240226-valueup', '2024-02-26', 'KR', '기업 밸류업 지원방안 발표', '코스피 200 금융', 'krx', '코스피 200 금융', '코스피', '코스피', -1.8, 3.2, 5.3, -0.9, now()),
 ('kr-20250603-election', '2025-06-03', 'KR', '대선 — 코스피 5000 공약 정부 출범', 'KRX 증권', 'krx', 'KRX 증권', '코스피', '코스피', 5.4, 1.6, 3.9, 6.9, now()),
 ('kr-20250703-commercial1', '2025-07-03', 'KR', '1차 상법 개정 국회 통과', 'KRX 증권', 'krx', 'KRX 증권', '코스피', '코스피', -4.4, 11.4, 4.9, -6.5, now()),
 ('kr-20250731-taxreform', '2025-07-31', 'KR', '세제개편안(대주주 기준 10억 하향) 발표', '코스피', 'yahoo', '^KS11', '^TWII', '대만 가중지수', -4.1, 2.9, 1.9, 0.8, now()),
 ('kr-20250825-commercial2', '2025-08-25', 'KR', '2차 상법 개정 국회 통과', 'KRX 증권', 'krx', 'KRX 증권', '코스피', '코스피', 1.2, 1.1, 9.2, 6.3, now()),
 ('kr-20250915-taxkeep', '2025-09-15', 'KR', '대주주 기준 50억 유지 확정', '코스피', 'yahoo', '^KS11', '^TWII', '대만 가중지수', 1.6, 1.1, -0.7, 10.8, now()),
 ('us-20250710-mp', '2025-07-10', 'US', 'MP Materials 국방부 지분 투자', 'MP Materials', 'yahoo', 'MP', '^GSPC', 'S&P500', 50.3, 39.6, 35.6, 62.7, now()),
 ('us-20250814-intel', '2025-08-14', 'US', '인텔 정부 지분 협의 첫 보도(8/22 확정)', 'Intel', 'yahoo', 'INTC', '^GSPC', 'S&P500', 10.8, 0.7, -1.0, -1.7, now()),
 ('us-20250924-lac', '2025-09-24', 'US', 'Lithium Americas 정부 지분 검토 보도', 'Lithium Americas', 'yahoo', 'LAC', '^GSPC', 'S&P500', 140.8, -8.6, 7.1, -14.1, now()),
 ('us-20251006-tmq', '2025-10-06', 'US', 'Trilogy Metals 정부 10% 지분 발표', 'Trilogy Metals', 'yahoo', 'TMQ', '^GSPC', 'S&P500', 212.5, 64.1, -14.8, -39.3, now())
ON CONFLICT (id) DO NOTHING;

-- 2026-11-16 개정: 이미 만든 테이블에 적용 (위 INSERT 는 ON CONFLICT DO NOTHING 이라 기존 행을 안 바꾼다)
-- 코스피 사건은 절대수익이 시장 전체 흐름을 정책 효과로 세던 문제 → 같은 시간대·반도체 비중이 비슷한 대만 가중지수 대비로
UPDATE policy_events SET bench_sym = '^TWII', bench = '대만 가중지수' WHERE id IN ('kr-20250731-taxreform', 'kr-20250915-taxkeep');
UPDATE policy_events SET target_sym = target, bench_sym = '코스피' WHERE target_kind = 'krx' AND target_sym IS NULL;

-- ── 월가 시각 (2026-11-16) ──────────────────────────────────────────────────
-- 해외 기사 제목에서 뽑은 기관·대상·방향·수치. 같은 기관·대상·방향이 10일 안이면 한 행(sources 에 기사들).
-- 쌓아 두었다가 "하향 뒤 실제로 어땠나"를 채점하는 용도. 수집 scripts/collect-macro.js, 규칙 backend/streetViews.js.
CREATE TABLE IF NOT EXISTS street_views (
  id          text PRIMARY KEY,               -- 기관|대상|방향|첫날
  first_seen  date NOT NULL,                  -- 첫 기사 날짜(KST)
  inst        text NOT NULL,
  target      text NOT NULL,                  -- kospi/korea/asia/spx/ndx/samsung/hynix/memory/fed/krw
  dir         text NOT NULL,                  -- up/down/hold/view/bull/bear/hike/cut
  value       text, prev text, pct numeric, horizon text,   -- 제목 원문 그대로의 수치
  method      text NOT NULL,                  -- rule / ai
  title       text, link text, source text,   -- 대표 기사(해외 매체 우선순위)
  sources     jsonb NOT NULL DEFAULT '[]',
  n_sources   int  NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS street_views_seen ON street_views (first_seen DESC);
ALTER TABLE street_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "street_read" ON street_views; DROP POLICY IF EXISTS "street_write" ON street_views;
CREATE POLICY "street_read"  ON street_views FOR SELECT USING (true);
CREATE POLICY "street_write" ON street_views FOR ALL USING (true) WITH CHECK (true);
