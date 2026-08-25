-- ============================================================================
-- 비거래일 잔여 오염 정리 — v3.96 (2026-08-25)
--
-- ⚠️ 실행 방법: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행.
--    API(anon 키)로는 지울 수 없다 — RLS에 DELETE 정책이 없어 **오류 없이 0행**이
--    삭제된다(조용한 실패). v3.94 정리도 같은 이유로 SQL Editor에서 실행됐다.
--
-- 배경
--   v3.94 대청소(2026-07-17, 유령 9,390행 삭제)는 backend/marketCalendar.js의
--   KRX_HOLIDAYS를 기준으로 돌았는데, 그 목록에 **휴장일 50일이 누락**돼 있었다
--   (목록이 2025년부터 시작 + 2025년도 3일 누락). 그래서 아래가 살아남았다.
--
--   ① 2025-12-31 (연말 휴장) — 목록에 없어 거래일로 취급
--      · update-prices가 직전(12/30) 종가를 복제한 유령 가격행 **260행**
--        (샘플 5/5 전부 12/30 종가와 동일). 이 행은 days_since_recommendation
--        한 칸을 차지해 이후 D+N을 하루씩 민다.
--      · 그날 생성된 추천 **2건** (비거래일 추천)
--   ② 2026-05-01 (근로자의 날) — success_patterns.success_date가 휴장일인 **4건**.
--      v3.94가 가격행은 지웠지만 패턴의 success_date는 남았다. days_to_success 왜곡.
--
--   2026-08-25에 KRX 실거래일 1,133일(2022-01-03~2026-08-21)과 전수 대조해
--   달력을 보정했다(커밋 f1dc747). 보정 후 누락 0 / 오탐 0.
--   전체 재스캔 결과 남은 오염은 위 ①②가 전부다(market_flow_daily는 깨끗).
--
-- 백업: data/backup-20251231-nontrading.json (git 미추적, 2026-08-25 생성)
--
-- 삭제 순서 주의: success_patterns 가 screening_recommendations 를 FK 참조한다.
--   반드시 success_patterns → recommendation_daily_prices → screening_recommendations.
-- ============================================================================

-- [1] 실행 전 확인 (지우기 전에 눈으로 볼 것)
SELECT '유령 가격행' AS what, COUNT(*) FROM recommendation_daily_prices WHERE tracking_date = '2025-12-31'
UNION ALL SELECT '비거래일 추천', COUNT(*) FROM screening_recommendations WHERE recommendation_date = '2025-12-31'
UNION ALL SELECT '휴장일 성공 패턴', COUNT(*) FROM success_patterns WHERE success_date = '2026-05-01';
-- 기대: 260 / 2 / 4

-- [2] 2025-12-31 추천 2건에 딸린 패턴 먼저 (FK)
DELETE FROM success_patterns
WHERE recommendation_id IN (
  SELECT id FROM screening_recommendations WHERE recommendation_date = '2025-12-31'
);

-- [3] 유령 가격행 (다른 추천 소속 포함) + 삭제 대상 추천의 잔여 가격행
DELETE FROM recommendation_daily_prices WHERE tracking_date = '2025-12-31';
DELETE FROM recommendation_daily_prices
WHERE recommendation_id IN (
  SELECT id FROM screening_recommendations WHERE recommendation_date = '2025-12-31'
);

-- [4] 비거래일 추천
DELETE FROM screening_recommendations WHERE recommendation_date = '2025-12-31';

-- [5] 휴장일에 성공 판정된 패턴 (2026-05-01 근로자의 날)
--     success_date 자체가 존재할 수 없는 날이라 행을 지운다.
--     (패턴 수집 cron이 다음 실행에서 올바른 거래일로 다시 만든다)
DELETE FROM success_patterns WHERE success_date = '2026-05-01';

-- [6] 검증 — 전부 0이어야 한다
SELECT '유령 가격행' AS what, COUNT(*) FROM recommendation_daily_prices WHERE tracking_date = '2025-12-31'
UNION ALL SELECT '비거래일 추천', COUNT(*) FROM screening_recommendations WHERE recommendation_date = '2025-12-31'
UNION ALL SELECT '휴장일 성공 패턴', COUNT(*) FROM success_patterns WHERE success_date = '2026-05-01';

-- [7] 이 스크립트 실행 후 반드시:
--     node scripts/renumber-trading-days.js --dry   (0행이면 정상, 아니면 --dry 빼고 재실행)
--     유령 행이 남아 있으면 이 스크립트는 스스로 중단한다.
