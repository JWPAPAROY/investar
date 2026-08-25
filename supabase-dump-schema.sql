-- ============================================================================
-- 스키마 덤프 쿼리 v2 (2026-08-25)
--
-- v1의 한계로 두 번 데었다:
--   · table_type='BASE TABLE'만 잡아 **뷰를 통째로 놓쳤다**
--     → 잔재 테이블 DROP 시 hot_issue_stocks / search_surge_stocks 가 튀어나옴
--   · information_schema 는 **권한 있는 객체만** 보여준다 → 뷰 목록이 0행
--   · FK·CHECK 제약, 트리거, 함수, 시퀀스, RLS 활성화가 전부 빠져 있었다
--     (success_patterns → screening_recommendations FK가 문서에만 있고 덤프엔 없음)
-- v2는 전부 pg_catalog 기준이다.
--
-- 사용법
--   1) Supabase 대시보드 → SQL Editor 에 아래 전체를 붙여넣고 실행
--   2) 결과(ddl 컬럼) 전부 복사 → 그대로 supabase-schema-full.sql 로 저장
--
-- 출력 순서 = 재구축 실행 순서:
--   시퀀스 → 테이블 → 뷰 → 제약(PK/UNIQUE/FK/CHECK) → 인덱스 → RLS 활성화
--   → RLS 정책 → 함수 → 트리거
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
  JOIN pg_catalog.pg_tables pt
    ON pt.schemaname = c.table_schema AND pt.tablename = c.table_name
  WHERE c.table_schema = 'public'
  GROUP BY c.table_name
)
SELECT ddl FROM (

  -- 1. 시퀀스 (serial/bigserial 기본값이 참조한다)
  SELECT 1 AS ord, sequencename AS nm,
         'CREATE SEQUENCE IF NOT EXISTS ' || sequencename || ';' AS ddl
    FROM pg_catalog.pg_sequences WHERE schemaname = 'public'

  UNION ALL
  -- 2. 테이블
  SELECT 2, table_name,
         E'\n-- ===== TABLE: ' || table_name || E' =====\n' || ddl FROM t

  UNION ALL
  -- 3. 뷰 (v1이 놓친 것)
  SELECT 3, viewname,
         E'\n-- ===== VIEW: ' || viewname || E' =====\nCREATE OR REPLACE VIEW '
         || viewname || E' AS\n' || definition
    FROM pg_catalog.pg_views WHERE schemaname = 'public'

  UNION ALL
  -- 4. 제약 (PK / UNIQUE / FK / CHECK) — v1에 통째로 빠져 있었다
  SELECT 4, cl.relname,
         'ALTER TABLE ' || cl.relname || ' ADD CONSTRAINT ' || con.conname
         || ' ' || pg_get_constraintdef(con.oid) || ';'
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
   WHERE con.contype IN ('p', 'u', 'f', 'c')

  UNION ALL
  -- 5. 인덱스 — 제약이 만들어주는 것은 제외(4번과 중복 방지)
  SELECT 5, tablename, indexdef || ';'
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname NOT IN (
       SELECT con.conname FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
     )

  UNION ALL
  -- 6. RLS 활성화 — 정책만 있고 이게 없으면 정책이 작동하지 않는다
  SELECT 6, cl.relname,
         'ALTER TABLE ' || cl.relname || ' ENABLE ROW LEVEL SECURITY;'
    FROM pg_class cl
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
   WHERE cl.relkind = 'r' AND cl.relrowsecurity

  UNION ALL
  -- 7. RLS 정책
  SELECT 7, tablename,
         'CREATE POLICY "' || policyname || '" ON ' || tablename
         || ' FOR ' || cmd
         || ' TO ' || array_to_string(roles, ', ')
         || COALESCE(' USING (' || qual || ')', '')
         || COALESCE(' WITH CHECK (' || with_check || ')', '') || ';'
    FROM pg_policies WHERE schemaname = 'public'

  UNION ALL
  -- 8. 함수
  SELECT 8, p.proname, pg_get_functiondef(p.oid) || ';'
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace AND ns.nspname = 'public'
   WHERE p.prokind = 'f'

  UNION ALL
  -- 9. 트리거 (내부 트리거 제외)
  SELECT 9, cl.relname, pg_get_triggerdef(tg.oid) || ';'
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
   WHERE NOT tg.tgisinternal
) x
ORDER BY ord, nm;
