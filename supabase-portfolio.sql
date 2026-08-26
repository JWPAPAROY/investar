-- ============================================================================
-- portfolio_rebalances: 저PBR·저변동 포트폴리오 리밸런싱 기록 (v3.97, 2026-08-26)
--
-- 왜: 현행 추천 풀(KIS 순위 API 5종 = 전부 주목도 축)은 2026-08-08 측정에서
--   **풀 전체 매칭초과 −7.39%(D+10)**. "문제는 랭킹이 아니라 풀"이라는 결론의 대안이다.
--   구성 근거와 검증되지 않아 뺀 것들은 backend/portfolio.js 헤더 참고.
--
-- ⚠️ 이 테이블은 **현행 추천 경로(screening_recommendations / active_policy)와 무관**하다.
--    프론트엔드에 별도 탭으로 나란히 보여주고, 성적을 눈으로 비교한 뒤 전환을 판단한다.
--
-- 리밸런싱 주기 60거래일. 한 행 = 한 번의 리밸런싱.
-- 일별 평가금액은 저장하지 않는다 — market_flow_daily 종가로 언제든 재계산할 수 있고,
--   저장하면 두 출처가 갈라진다(이 저장소가 반복해서 당한 사고).
-- ============================================================================

CREATE TABLE IF NOT EXISTS portfolio_rebalances (
  rebalance_date  DATE PRIMARY KEY,        -- 신호일 (이 날 종가 기준으로 산출)
  buy_date        DATE,                    -- 실제 매수 기준일 (신호일 +1 거래일)
  next_date       DATE,                    -- 다음 리밸런싱 예정일 (거래일 기준 +60)
  params          JSONB NOT NULL,          -- {factor,k,hold,weight,capMin,valMin,look,univ}
  holdings        JSONB NOT NULL,          -- [{code,name,close,cap,pbr,vol20,score,weight,weightEq}]
  universe_size   INTEGER,                 -- 유니버스 통과 종목 수 (건강도 지표)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE portfolio_rebalances IS
  '저PBR+저변동 포트폴리오 리밸런싱 기록. 실운영 추천 경로와 무관한 병행 관측용.';
COMMENT ON COLUMN portfolio_rebalances.params IS
  '설정을 바꾸면 성과의 연속성이 끊긴다. 바꿀 경우 판정 시 구간을 분리할 것.';
COMMENT ON COLUMN portfolio_rebalances.holdings IS
  'weight=시총가중(검증된 설정), weightEq=동일가중(집중도 부담 시 대안). 둘 다 저장해 실행 시 선택.';

ALTER TABLE portfolio_rebalances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read portfolio_rebalances"   ON portfolio_rebalances;
DROP POLICY IF EXISTS "anon write portfolio_rebalances"  ON portfolio_rebalances;
CREATE POLICY "anon read portfolio_rebalances"  ON portfolio_rebalances FOR SELECT USING (true);
CREATE POLICY "anon write portfolio_rebalances" ON portfolio_rebalances FOR ALL    USING (true) WITH CHECK (true);

-- 확인
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'portfolio_rebalances'
 ORDER BY ordinal_position;
