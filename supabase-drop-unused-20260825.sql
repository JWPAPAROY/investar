-- ============================================================================
-- 미사용 뷰·함수 정리 — v3.96 (2026-08-25)
--
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 실행.
-- SQL Editor는 스크립트를 트랜잭션으로 감싸므로 중간 실패 시 전부 롤백된다.
--
-- 근거: 레포 전체 검색(코드·HTML·문서)에서 사용처 0건.
--   CLAUDE.md 가 recommendation_statistics / overall_performance 를 언급하지만
--   "DB에 이런 게 있다"는 목록일 뿐 호출하는 코드는 없다(문서도 함께 갱신).
--
-- ⚠️ 복원: 정의는 supabase-schema-full.sql 과 git history 에 그대로 남아 있다.
--   되살리려면 그 파일의 해당 CREATE 문을 다시 실행하면 된다.
-- ============================================================================

-- ── 1. 뷰 6개 ───────────────────────────────────────────────────────────────
-- 의존 순서 주의: overall_performance 가 recommendation_statistics 를 참조하므로 먼저.
DROP VIEW IF EXISTS overall_performance;
DROP VIEW IF EXISTS recommendation_statistics;
DROP VIEW IF EXISTS institutional_indicator_analysis;
DROP VIEW IF EXISTS price_indicator_analysis;
DROP VIEW IF EXISTS volume_indicator_analysis;
DROP VIEW IF EXISTS success_pattern_insights;

-- ── 2. 고아 함수 ────────────────────────────────────────────────────────────
-- 트리거가 붙어 있던 stock_trend_scores 가 2026-08-25에 삭제되며 갈 곳을 잃었다.
DROP FUNCTION IF EXISTS public.update_trend_scores_updated_at();

-- ── 3. 미사용 함수 ──────────────────────────────────────────────────────────
-- get_indicator_distribution(text, numeric): 지표 분포 조회용 수동 도구. 사용처 0.
-- 위 뷰들과 같은 성격(대시보드에서 손으로 부르는 집계)이라 함께 정리한다.
-- 남겨두고 싶으면 이 줄만 지우고 실행할 것.
DROP FUNCTION IF EXISTS public.get_indicator_distribution(text, numeric);

-- ── 남기는 것 (트리거가 실제로 쓴다) ────────────────────────────────────────
--   log_active_policy_change()  ← trg_active_policy_history
--   update_updated_at_column()  ← update_recommendations_updated_at

-- ── 4. 검증 (기대: 0행) ─────────────────────────────────────────────────────
SELECT viewname AS leftover FROM pg_catalog.pg_views
 WHERE schemaname = 'public'
   AND viewname IN ('overall_performance', 'recommendation_statistics',
                    'institutional_indicator_analysis', 'price_indicator_analysis',
                    'volume_indicator_analysis', 'success_pattern_insights')
UNION ALL
SELECT p.proname FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 WHERE p.proname IN ('update_trend_scores_updated_at', 'get_indicator_distribution');

-- 남아야 하는 함수 (기대: 2행)
SELECT p.proname AS kept FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 WHERE p.proname IN ('log_active_policy_change', 'update_updated_at_column');
