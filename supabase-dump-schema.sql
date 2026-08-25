-- ============================================================================
-- 스키마 덤프 쿼리 (v3.96, 2026-08-25)
--
-- 왜: 코드가 쓰는 14개 테이블 중 7개가 레포에 정의가 없다.
--   screening_recommendations(56컬럼) · recommendation_daily_prices(84,812행) 포함.
--   지금 Supabase 프로젝트가 사라지면 이 저장소만으로 재구축할 수 없다.
--   anon 키로는 PostgREST OpenAPI 조회가 401이라 코드에서 뽑을 수 없어 쿼리로 받는다.
--
-- 사용법
--   1) Supabase 대시보드 → SQL Editor 에 아래 쿼리를 통째로 붙여넣고 실행
--   2) 결과(ddl 컬럼)를 전부 복사 → supabase-schema-full.sql 로 저장
--   ※ 결과가 길면 오른쪽 위 "Download CSV" 로 받아도 된다.
--
-- 나오는 것: CREATE TABLE(타입·NOT NULL·DEFAULT) → 인덱스/PK → RLS 정책 순.
-- ============================================================================

WITH t AS (
  SELECT c.table_name,
         'CREATE TABLE ' || c.table_name || E' (\n' ||
         string_agg(
           '  ' || c.column_name || ' ' ||
           CASE
             WHEN c.data_type = 'character varying'
               THEN 'varchar' || COALESCE('(' || c.character_maximum_length || ')', '')
             WHEN c.data_type = 'character'
               THEN 'char' || COALESCE('(' || c.character_maximum_length || ')', '')
             WHEN c.data_type = 'numeric'
               THEN 'numeric' || COALESCE('(' || c.numeric_precision || ',' || c.numeric_scale || ')', '')
             WHEN c.data_type = 'timestamp with time zone'    THEN 'timestamptz'
             WHEN c.data_type = 'timestamp without time zone' THEN 'timestamp'
             WHEN c.data_type = 'double precision'            THEN 'float8'
             WHEN c.data_type = 'USER-DEFINED'                THEN c.udt_name
             WHEN c.data_type = 'ARRAY'                       THEN ltrim(c.udt_name, '_') || '[]'
             ELSE c.data_type
           END ||
           CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
           CASE WHEN c.column_default IS NOT NULL THEN ' DEFAULT ' || c.column_default ELSE '' END,
           E',\n' ORDER BY c.ordinal_position
         ) || E'\n);' AS ddl
  FROM information_schema.columns c
  JOIN information_schema.tables tb
    ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
   AND tb.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
  GROUP BY c.table_name
)
SELECT ddl FROM (
  SELECT 1 AS ord, table_name AS nm, E'\n-- ===== TABLE: ' || table_name || E' =====\n' || ddl AS ddl FROM t
  UNION ALL
  SELECT 2, tablename, indexdef || ';'
    FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  -- v3.96 보완: 첫 덤프가 table_type='BASE TABLE'만 잡아 **뷰를 통째로 놓쳤다**
  --   (stock_trend_scores DROP 시 의존 뷰 hot_issue_stocks 가 튀어나와 발각).
  SELECT 2, table_name,
         E'
-- ===== VIEW: ' || table_name || E' =====
CREATE OR REPLACE VIEW '
         || table_name || E' AS
' || view_definition
    FROM information_schema.views WHERE table_schema = 'public'
  UNION ALL
  SELECT 3, tablename,
         'CREATE POLICY "' || policyname || '" ON ' || tablename ||
         ' FOR ' || cmd ||
         ' TO ' || array_to_string(roles, ', ') ||
         COALESCE(' USING (' || qual || ')', '') ||
         COALESCE(' WITH CHECK (' || with_check || ')', '') || ';'
    FROM pg_policies WHERE schemaname = 'public'
) x
ORDER BY ord, nm;
