-- ============================================================================
-- lowvol_observations 제거 (2026-09-07)
--
-- 왜: 이 관측의 **목적이 이미 다른 표본으로 이관됐다.**
--   시작 근거(2026-08-08): "D+10 독립블록 2.2로 판정 요건 미달 → 백테스트가 아닌
--     실시간 기록을 쌓는다." 표본이 부족하니 매일 모으자는 것이었다.
--   그런데 2026-08-24~25에 641거래일·1,133거래일 표본으로 같은 질문에 답이 나왔고,
--   CLAUDE.md 가 직접 이관을 선언했다:
--     > 9/16 저변동성 판정은 이 2.5년 표본으로 대체할 것.
--     > 60거래일 병렬관측만으로는 레짐 하나에 지배된다.
--   판정 결과도 이미 나왔다 — "고르는 덴 못 쓰고 버리는 덴 유효"
--   (저변동성 우위는 작고, 고변동성 회피가 본체).
--
-- 즉 판정은 끝났는데 관측만 매 거래일 돌고 있었다(20일 기록, 읽는 코드 0곳).
--
-- 함께 제거: .github/workflows/record-lowvol-picks.yml · scripts/record-lowvol-picks.js
--            supabase-lowvol-observation.sql · backend/supabasePaging.js 의 정렬키 등록
-- 분석 스크립트 scripts/lowvol-attribution.js 는 **남긴다** — 판정 근거를 재현하는 자산이다.
-- ============================================================================

DROP TABLE IF EXISTS lowvol_observations;

SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'lowvol_observations';
-- 0행이면 제거 완료
