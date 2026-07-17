-- ============================================================================
-- top3_rank 컬럼 추가 — TOP3 순위(🥇=1, 🥈=2, 🥉=3)를 사실로 저장 (v3.94)
--
-- 실행 위치: Supabase 대시보드 → SQL Editor
-- 안전: 추가 전용(additive), nullable. 기존 행/코드에 영향 없음.
--       코드는 컬럼 존재를 런타임 감지하므로(supportsTop3Rank) 적용 전에도 정상 동작하고,
--       적용 즉시 다음 결산부터 자동으로 순위를 저장하기 시작한다.
--
-- 왜 필요한가
--   screening_recommendations 에는 is_top3 불리언만 있고 순위가 없었다. 그래서
--   weekly-diagnostic.js 가 순위를 total_score 내림차순으로 재구성했는데, 실제 정렬은
--   v387(수급등급→기관매수일→스윗스팟)이고 스윗스팟은 50-59점을 90+점보다 선호한다.
--   → 실측 결과 **57%의 날에 진단의 TOP1 ≠ 실제 🥇** (2026-06-01~, n=23).
--   TOP1 알파 진단이 존재한 적 없는 종목을 측정하고 있었다.
--
-- 과거 백필을 하지 않는 이유
--   정렬 로직이 v376 → v384 → v385 → v387 로 계속 바뀌었다. 지금 comparator로 과거를
--   백필하면 "그날 실제로 보여진 🥇"이 아니라 "지금 기준으로 다시 매긴 순위"가 된다.
--   사후 재구성으로는 역사적 사실을 복원할 수 없으므로, 과거는 NULL로 두고
--   분석 코드가 resolveTop3Order()로 현재 comparator를 일관 적용해 평가한다
--   (backend/top3Ranking.js — top3_rank 가 있으면 그 사실을 우선한다).
-- ============================================================================

ALTER TABLE screening_recommendations
  ADD COLUMN IF NOT EXISTS top3_rank smallint;

COMMENT ON COLUMN screening_recommendations.top3_rank IS
  'TOP3 순위 (1=🥇, 2=🥈, 3=🥉). v387 정렬(수급등급→기관매수일→스윗스팟) 결과를 저장. '
  'is_top3=false면 NULL. v3.94 이전 행은 순위 미기록이라 NULL — 정렬 로직이 버전마다 '
  '달라 사후 백필 시 그날 실제 순서와 달라지므로 백필하지 않는다. '
  '재구성이 필요한 분석은 backend/top3Ranking.js 의 resolveTop3Order() 사용.';

-- 정합성: is_top3 인 행만 1~3 을 갖는다
ALTER TABLE screening_recommendations
  DROP CONSTRAINT IF EXISTS top3_rank_valid;
ALTER TABLE screening_recommendations
  ADD CONSTRAINT top3_rank_valid CHECK (
    (top3_rank IS NULL) OR (is_top3 = true AND top3_rank BETWEEN 1 AND 3)
  );

-- 조회용 인덱스 (TOP1만 뽑는 분석이 잦음)
CREATE INDEX IF NOT EXISTS idx_screening_top3_rank
  ON screening_recommendations (recommendation_date, top3_rank)
  WHERE top3_rank IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────
-- [검증] 적용 후 확인
-- ─────────────────────────────────────────────────────────────────────────
-- 1) 컬럼 생성 확인
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'screening_recommendations' AND column_name = 'top3_rank';

-- 2) 다음 결산(평일 15:35 KST) 이후 — 순위가 채워지는지
-- SELECT recommendation_date, top3_rank, stock_name, total_score,
--        institution_buy_days, foreign_buy_days
--   FROM screening_recommendations
--  WHERE is_top3 = true AND top3_rank IS NOT NULL
--  ORDER BY recommendation_date DESC, top3_rank
--  LIMIT 9;
--   → 같은 날짜 안에서 top3_rank 가 1,2,3 이고, total_score 순서와 일치하지 않는 게 정상
--     (스윗스팟 밴드가 50-59를 90+보다 선호하므로)
