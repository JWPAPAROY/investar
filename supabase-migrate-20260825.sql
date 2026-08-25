-- ============================================================================
-- 마이그레이션 3건 — v3.96 (2026-08-25)
--
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 실행.
-- 셋 다 DDL이라 anon 키(API)로는 불가능하다.
--
--   [A] 폐기된 트렌드 시스템 잔재 테이블 3개 DROP
--   [B] stock_financials 테이블 생성 (미적용 스키마 적용)
--   [C] weekly_diagnostics.regime NOT NULL 해제
--
-- 실행 후 확인 쿼리가 맨 아래 [D] 에 있다.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- [A] 잔재 테이블 정리
--
-- 2025-11-12 "프론트엔드 탭 통폐합"(3b5bf65)에서 트렌드/뉴스 시스템을 걷어내며
-- 코드만 지우고 테이블은 남겼다. 코드 전체에서 사용처 0건을 확인했다.
--   news_mentions       208행
--   stock_trend_scores    7행   (RLS가 FOR ALL — anon 키로 쓰기·삭제까지 열려 있었다)
--   search_trends         0행
-- 딸린 인덱스·RLS 정책은 DROP TABLE 시 함께 사라진다.
-- ────────────────────────────────────────────────────────────────────────────
-- ⚠️ 2026-08-25 실행 중 두 번 걸렸다. 잔재 테이블에 **뷰가 붙어 있다.**
--   1차: view hot_issue_stocks depends on table stock_trend_scores
--   2차: view search_surge_stocks depends on table search_trends
--   원인은 내 덤프 쿼리가 table_type='BASE TABLE'만 잡은 것이다(뷰를 통째로 놓쳤다).
--   게다가 information_schema.views 는 **권한 있는 뷰만** 보여줘서 [A-0]이 0행을 냈다.
--   → 목록 조회는 pg_catalog.pg_views 로 바꾸고, 남은 의존 뷰는 DO 블록이 쓸어담는다.
--   SQL Editor는 스크립트를 트랜잭션으로 감싸므로, 중간에 실패하면 전부 롤백된다
--   (1·2차 실패 후 DB는 손대지 않은 상태였음을 API로 확인했다).

-- [A-0] public 스키마의 뷰 목록 — pg_views 는 권한과 무관하게 전부 보여준다
SELECT viewname FROM pg_catalog.pg_views WHERE schemaname = 'public';

-- [A-1] 잔재 3개 테이블에 의존하는 뷰를 모두 제거.
--   이름을 아는 둘은 명시해 지우고, 혹시 더 있으면 DO 블록이 잡는다.
--   (CASCADE로 뭉개지 않는 이유: 무엇이 지워졌는지 로그에 남기기 위해)
DROP VIEW IF EXISTS hot_issue_stocks;
DROP VIEW IF EXISTS search_surge_stocks;

DO $$
DECLARE v record;
BEGIN
  FOR v IN
    SELECT DISTINCT c.relname AS viewname
      FROM pg_depend d
      JOIN pg_rewrite r  ON r.oid = d.objid
      JOIN pg_class   c  ON c.oid = r.ev_class AND c.relkind = 'v'
      JOIN pg_class   t  ON t.oid = d.refobjid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE t.relname IN ('news_mentions', 'stock_trend_scores', 'search_trends')
  LOOP
    RAISE NOTICE '의존 뷰 제거: %', v.viewname;
    EXECUTE format('DROP VIEW IF EXISTS public.%I', v.viewname);
  END LOOP;
END $$;

DROP TABLE IF EXISTS news_mentions;
DROP TABLE IF EXISTS stock_trend_scores;
DROP TABLE IF EXISTS search_trends;


-- ────────────────────────────────────────────────────────────────────────────
-- [B] stock_financials 생성
--
-- supabase-stock-financials.sql 이 작성만 되고 적용된 적이 없어 테이블이 없었다(404).
-- 그래서 `node scripts/collect-financials.js --push` 가 실패한다.
-- 재무 데이터는 현재 로컬 data/financials.json(9.5MB)에만 있다.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_financials (
  stock_code        VARCHAR(6)  NOT NULL,
  stac_yymm         VARCHAR(6)  NOT NULL,   -- 결산년월 (YYYYMM)
  revenue_growth    NUMERIC,                -- 매출 증가율 (전년동기대비 %)
  op_profit_growth  NUMERIC,                -- 영업이익 증가율
  net_income_growth NUMERIC,                -- 순이익 증가율
  roe               NUMERIC,
  eps               NUMERIC,
  sps               NUMERIC,
  bps               NUMERIC,
  reserve_rate      NUMERIC,                -- 유보율
  debt_ratio        NUMERIC,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stock_code, stac_yymm)
);

CREATE INDEX IF NOT EXISTS idx_stock_financials_ym ON stock_financials (stac_yymm);

ALTER TABLE stock_financials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read stock_financials"   ON stock_financials;
DROP POLICY IF EXISTS "anon write stock_financials"  ON stock_financials;
CREATE POLICY "anon read stock_financials"  ON stock_financials FOR SELECT USING (true);
CREATE POLICY "anon write stock_financials" ON stock_financials FOR ALL    USING (true) WITH CHECK (true);


-- ────────────────────────────────────────────────────────────────────────────
-- [C] weekly_diagnostics.regime NOT NULL 해제
--
-- 왜: regime 개념은 v3.88에서 폐기됐는데 컬럼 제약만 NOT NULL로 남아,
--   코드가 sentinel('deprecated')을 계속 채워 넣고 있었다.
--   2026-05-24 ~ 06-21에는 이 제약 때문에 INSERT가 23502로 실패해
--   **주간진단이 4주간 조용히 사라졌다**(계산은 정상, 저장만 실패).
--   제약을 풀어 같은 함정이 다시 놓이지 않게 한다.
--
-- 코드는 v3.96에서 이미 payload에서 regime을 뺐고, 컬럼이 아직 NOT NULL이어도
-- 23502를 잡아 sentinel로 한 번 재시도하도록 되어 있다(순서 무관, 안전).
-- 이 ALTER 이후에는 그 재시도가 발생하지 않는다.
--
-- 컬럼 자체를 지우지 않는 이유: 기존 17행이 'deprecated'/과거 레짐 값을 갖고 있고
--   드롭은 되돌릴 수 없다. 값이 필요 없어지면 나중에 DROP COLUMN 하면 된다.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE weekly_diagnostics ALTER COLUMN regime DROP NOT NULL;


-- ────────────────────────────────────────────────────────────────────────────
-- [D] 확인 — 기대값을 주석에 적어둔다
-- ────────────────────────────────────────────────────────────────────────────

-- D-1. 잔재 테이블·뷰가 사라졌는가 (기대: 0행)
SELECT tablename AS leftover FROM pg_catalog.pg_tables
 WHERE schemaname = 'public'
   AND tablename IN ('news_mentions', 'stock_trend_scores', 'search_trends')
UNION ALL
SELECT viewname FROM pg_catalog.pg_views
 WHERE schemaname = 'public'
   AND viewname IN ('hot_issue_stocks', 'search_surge_stocks');

-- D-2. stock_financials 가 생겼는가 (기대: 11컬럼 + updated_at)
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'stock_financials'
 ORDER BY ordinal_position;

-- D-3. regime 제약이 풀렸는가 (기대: is_nullable = YES)
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'weekly_diagnostics'
   AND column_name = 'regime';
