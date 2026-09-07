-- ============================================================================
-- disclosures: DART 공시 메타데이터 (2026-09-07)
--
-- 왜: 공시 이벤트 축의 판정 입력. 조건과 임계값은 DISCLOSURE_VERDICT.md에
--   **데이터를 보기 전에** 사전 등록돼 있다.
--
-- ⚠️ 본문은 저장하지 않는다. DART list.json이 주는 목록 메타데이터만 담는다.
--    B군·C군·통제군 판정은 report_nm(제목)만으로 가능하고, 본문 판독이 필요한 것은
--    A군 2번(자기주식 취득: 주가안정/이익소각 vs 임직원 인센티브 — 선행연구에서
--    부호가 반대)뿐이다. A군이 판정을 통과할 때만 본문 수집 비용을 치른다.
--
-- ⚠️ rcept_dt는 **날짜만** 있고 접수 시각이 없다. 따라서 장중/장후 공시를 구분할 수
--    없고, 진입 시점을 D+1 종가로 고정하는 근거가 된다(DISCLOSURE_VERDICT.md 참고).
--
-- report_type은 backend/disclosureTypes.js의 규칙으로 산출한 파생값이다.
--   원본(report_nm)을 그대로 보관하므로 규칙이 바뀌면 --reclassify로 재산출한다.
--   단 **유형 목록 자체를 늘리는 것은 사전 등록 위반**이다. 판정 리셋 대상.
-- ============================================================================

CREATE TABLE IF NOT EXISTS disclosures (
  rcept_no     TEXT PRIMARY KEY,   -- 접수번호. 날짜(8)+일련번호(6), 하루 안에서 단조 증가
  rcept_dt     DATE NOT NULL,      -- 접수일자 (시각 없음)
  corp_code    TEXT NOT NULL,      -- DART 고유번호 (8자리)
  corp_name    TEXT,
  stock_code   TEXT,               -- 6자리 단축코드. 비상장이면 빈 문자열 → NULL로 정규화
  corp_cls     TEXT,               -- Y=유가증권 K=코스닥 N=코넥스 E=기타
  report_nm    TEXT NOT NULL,      -- 보고서명 (분류의 원본)
  flr_nm       TEXT,               -- 공시 제출인
  rm           TEXT,               -- 비고 (정정/철회 등 표시)
  report_type  TEXT,               -- 사전등록 11종 분류 결과. 미분류는 NULL
  is_amendment BOOLEAN NOT NULL DEFAULT FALSE,  -- [기재정정]/철회/해제/해지 = 새 이벤트가 아님
  is_subsidiary BOOLEAN NOT NULL DEFAULT FALSE, -- (자회사/종속회사의 주요경영사항) = 공시 주체의 이벤트가 아님
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disclosures_dt      ON disclosures (rcept_dt);
CREATE INDEX IF NOT EXISTS idx_disclosures_stock   ON disclosures (stock_code, rcept_dt);
CREATE INDEX IF NOT EXISTS idx_disclosures_type    ON disclosures (report_type, rcept_dt);

COMMENT ON TABLE disclosures IS
  'DART 공시 목록 메타데이터. 판정 기준은 DISCLOSURE_VERDICT.md에 사전 등록.';
COMMENT ON COLUMN disclosures.rcept_dt IS
  '접수 "일자"뿐이다. 시각이 없어 장중/장후 구분 불가 → 진입은 D+1 종가로 고정.';
COMMENT ON COLUMN disclosures.is_amendment IS
  '정정·철회 공시. 원본 이벤트의 재공시이므로 이벤트 스터디에서 제외한다(중복 계상 방지).';
COMMENT ON COLUMN disclosures.is_subsidiary IS
  '자회사·종속회사의 이벤트를 모회사가 대신 공시한 건. stock_code는 모회사라 신호가 희석된다. 판정 제외.';
COMMENT ON COLUMN disclosures.report_type IS
  'backend/disclosureTypes.js 규칙의 파생값. 유형 추가는 사전 등록 위반(판정 리셋).';

ALTER TABLE disclosures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read disclosures"  ON disclosures;
DROP POLICY IF EXISTS "anon write disclosures" ON disclosures;
CREATE POLICY "anon read disclosures"  ON disclosures FOR SELECT USING (true);
CREATE POLICY "anon write disclosures" ON disclosures FOR ALL    USING (true) WITH CHECK (true);

-- 확인
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'disclosures'
 ORDER BY ordinal_position;
