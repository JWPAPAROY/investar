-- ============================================================================
-- 비거래일(주말·휴장일) 오염 데이터 정리 — v3.94
--
-- ✅ 2026-07-17 실행 완료. 이 파일은 "무엇을 왜 지웠는가"의 기록으로 남긴다.
--    재실행 불필요. 아래 [검증] 쿼리는 언제든 안전하게 돌릴 수 있다.
--
-- 배경
--   1) update-prices.js에 휴장일 가드가 없어, 장이 안 열린 날에도 cron이 돌며
--      직전 거래일 종가가 복제된 "유령 관측"이 쌓였다. 유령 행은
--      days_since_recommendation 한 칸을 차지해 이후 D+N을 전부 하루씩 밀었다.
--   2) days_since_recommendation이 달력일 기준이라 행이 생기는 거래일과 어긋났다.
--      금요일 추천 D+1(토) 존재율 0%, 수·목요일 추천 D+10(토·일) 존재율 0%
--      → active_policy(D+1→D+10) 평가가 월·화 추천(≈39%)만으로 수행되고 있었음.
--   두 원인 모두 v3.94 코드에서 제거됨 (backend/marketCalendar.js 단일 출처).
--
-- 실행 결과 (2026-07-17)
--   [2] 2026-06-03(지방선거) 추천        23행 + 가격 524행 + 패턴 4행 삭제
--   [3] 유령 가격행                    9,390행 삭제 (주말 5,938 + 휴장일 3,452)
--   [4] 비거래일 추천                    137행 + 가격 7,556행 + 패턴 90행 삭제
--       (2025-11-16~2026-02-18, v3.43 타임존 수정 이전 잔재. TOP3 25건 포함)
--   [5] 비거래일 예측                      6행 삭제
--   그 후 scripts/renumber-trading-days.js 로 D+N 72,654행 거래일 기준 재번호.
--
--   결과: D+1·D+10 양쪽 존재 표본 39% → 70%. 요일별 0% 칸 소멸.
--   남은 데이터: 추천 3,136 / 가격행 73,022 / 예측 126 / 패턴 1,131
--   백업: data/backup-nontrading-full.json (git 미추적)
--
-- 주의
--   - success_patterns 가 screening_recommendations 를 FK로 참조한다.
--     추천을 지우려면 success_patterns → recommendation_daily_prices → 추천 순서로.
--   - .env의 anon 키는 RLS로 DELETE가 막혀 있다(에러 없이 0행 반환 — 성공으로 착각 주의).
--     삭제엔 service_role 키 또는 대시보드 SQL Editor가 필요. 정리 후 키는 제거했다.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- [검증] 오염이 재발했는지 확인 — 전부 0이어야 정상
--   0이 아니면 어딘가에 휴장일 가드가 빠진 것.
--   아래 목록은 backend/marketCalendar.js 의 KRX_HOLIDAYS 와 일치해야 한다.
-- ─────────────────────────────────────────────────────────────────────────
WITH holidays(d) AS (VALUES
  ('2025-01-01'::date),('2025-01-28'),('2025-01-29'),('2025-01-30'),('2025-03-01'),('2025-03-03'),
  ('2025-05-01'),('2025-05-05'),('2025-05-06'),('2025-06-06'),('2025-08-15'),('2025-10-03'),
  ('2025-10-06'),('2025-10-07'),('2025-10-08'),('2025-10-09'),('2025-12-25'),('2026-01-01'),
  ('2026-02-16'),('2026-02-17'),('2026-02-18'),('2026-03-02'),('2026-05-01'),('2026-05-05'),
  ('2026-05-25'),('2026-06-03'),('2026-07-17'),('2026-08-17'),('2026-09-24'),('2026-09-25'),
  ('2026-09-28'),('2026-10-05'),('2026-10-09'),('2026-12-25'),('2026-12-31')
)
SELECT '비거래일 추천' AS check, count(*) AS n FROM screening_recommendations
  WHERE EXTRACT(DOW FROM recommendation_date) IN (0,6)
     OR recommendation_date IN (SELECT d FROM holidays)
UNION ALL
SELECT '유령 가격행', count(*) FROM recommendation_daily_prices
  WHERE EXTRACT(DOW FROM tracking_date) IN (0,6)
     OR tracking_date IN (SELECT d FROM holidays)
UNION ALL
SELECT '비거래일 예측', count(*) FROM overnight_predictions
  WHERE prediction_date < '2900-01-01'
    AND (EXTRACT(DOW FROM prediction_date) IN (0,6)
         OR prediction_date IN (SELECT d FROM holidays))
UNION ALL
SELECT '비거래일 수급수집', count(*) FROM market_flow_daily
  WHERE EXTRACT(DOW FROM trade_date) IN (0,6)
     OR trade_date IN (SELECT d FROM holidays);


-- ─────────────────────────────────────────────────────────────────────────
-- [참고] 실제 실행했던 삭제문 (이미 완료 — 재실행 불필요)
--   holidays CTE 를 앞에 붙여야 동작한다.
-- ─────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- -- FK 순서 주의: success_patterns → daily_prices → recommendations
-- DELETE FROM success_patterns
--   WHERE recommendation_id IN (
--     SELECT id FROM screening_recommendations
--      WHERE EXTRACT(DOW FROM recommendation_date) IN (0,6)
--         OR recommendation_date IN (SELECT d FROM holidays));
-- DELETE FROM recommendation_daily_prices
--   WHERE recommendation_id IN (
--     SELECT id FROM screening_recommendations
--      WHERE EXTRACT(DOW FROM recommendation_date) IN (0,6)
--         OR recommendation_date IN (SELECT d FROM holidays));
-- DELETE FROM screening_recommendations
--   WHERE EXTRACT(DOW FROM recommendation_date) IN (0,6)
--      OR recommendation_date IN (SELECT d FROM holidays);
-- -- 유령 가격행 (다른 날 추천의 휴장일 관측)
-- DELETE FROM recommendation_daily_prices
--   WHERE EXTRACT(DOW FROM tracking_date) IN (0,6)
--      OR tracking_date IN (SELECT d FROM holidays);
-- -- 비거래일 예측
-- DELETE FROM overnight_predictions
--   WHERE prediction_date < '2900-01-01'
--     AND (EXTRACT(DOW FROM prediction_date) IN (0,6)
--          OR prediction_date IN (SELECT d FROM holidays));
-- COMMIT;
--
-- 삭제 후 반드시: node scripts/renumber-trading-days.js
