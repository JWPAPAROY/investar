-- ============================================================================
-- source_reconciliation: KIS ↔ KRX 일별 대조 기록 (v3.97, 2026-08-26)
--
-- 왜: 2026-08-26 하루에만 출처가 조용히 갈라진 사례가 셋 나왔다.
--   ① KIS 미확정 당일 행이 수급 스트릭을 0으로 붕괴 (추천의 59~95%)
--   ② 거래대금이 전 구간 NULL — TR 하나가 필드를 안 줘서
--   ③ market_cap 이 KIS 역산 근사치라 실측과 최대 30% 어긋남
--   셋 다 **아무도 두 출처를 나란히 놓고 보지 않아서** 오래 살아남았다.
--   매일 자동으로 재고 어긋나면 주간진단 경고로 올라오게 한다.
--
-- 한 행 = 하루. 종목별 상세는 저장하지 않는다 —
--   필요하면 scripts/compare-sources.js 로 언제든 재현할 수 있고,
--   저장하면 2,500행/일이 쌓여 정작 볼 수 없게 된다.
-- ============================================================================

CREATE TABLE IF NOT EXISTS source_reconciliation (
  trade_date   DATE PRIMARY KEY,
  compared     INTEGER,        -- 양쪽에 다 있는 종목 수
  fields       JSONB NOT NULL, -- {close:{n,eq,mismatch,medianPct}, volume:{...}, ...}
  worst        JSONB,          -- 필드별 최악 5종목 (원인 추적용)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE source_reconciliation IS
  'KIS ↔ KRX 일별 대조. 값 자체가 아니라 **두 출처가 얼마나 어긋나는지**를 기록한다.';
COMMENT ON COLUMN source_reconciliation.fields IS
  '필드별 {n, eq, mismatch, medianPct}. close/volume/tradingValue/marketCapKis/marketCapKrx.';

ALTER TABLE source_reconciliation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read source_reconciliation"  ON source_reconciliation;
DROP POLICY IF EXISTS "anon write source_reconciliation" ON source_reconciliation;
CREATE POLICY "anon read source_reconciliation"  ON source_reconciliation FOR SELECT USING (true);
CREATE POLICY "anon write source_reconciliation" ON source_reconciliation FOR ALL    USING (true) WITH CHECK (true);

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'source_reconciliation'
 ORDER BY ordinal_position;
