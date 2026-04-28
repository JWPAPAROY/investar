-- active_policy: 현재 운영 중인 매매 정책 (1행 고정)
-- Phase 2: 자동 변경 없음. 사용자가 수동으로 update.
-- weekly-diagnostic은 권고만 하고, 차이 발생 시 텔레그램 알림.

CREATE TABLE IF NOT EXISTS active_policy (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- 단일 행 enforcement
  buy_offset_day INT NOT NULL DEFAULT 0,         -- D+k 매수 (현재 default = 0)
  sell_offset_day INT NOT NULL DEFAULT 3,        -- D+n 매도 (현재 default = 3)
  regime_mode TEXT,                              -- 'auto' | 'momentum' | 'sideways' | 'defense' (auto = 진단 따름)
  since_date DATE NOT NULL DEFAULT CURRENT_DATE, -- 이 정책이 적용 시작된 날
  set_by TEXT NOT NULL DEFAULT 'system',         -- 'system' | 'user' | 'webhook'
  change_reason TEXT,                            -- 변경 사유 (사용자 기록용)
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 초기 정책 행 (1행만, 현재 시스템 default 반영)
INSERT INTO active_policy (id, buy_offset_day, sell_offset_day, regime_mode, since_date, set_by, change_reason)
VALUES (1, 0, 3, 'auto', CURRENT_DATE, 'system', 'Phase 2 초기값 (현재 시스템 default)')
ON CONFLICT (id) DO NOTHING;

-- 변경 이력 테이블 (append-only)
CREATE TABLE IF NOT EXISTS active_policy_history (
  id BIGSERIAL PRIMARY KEY,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  buy_offset_day INT NOT NULL,
  sell_offset_day INT NOT NULL,
  regime_mode TEXT,
  set_by TEXT NOT NULL,
  change_reason TEXT,
  prev_buy_offset_day INT,
  prev_sell_offset_day INT,
  prev_regime_mode TEXT
);

CREATE INDEX IF NOT EXISTS idx_policy_history_changed_at ON active_policy_history(changed_at DESC);

-- 정책 변경 시 이력에 자동 기록 (trigger)
CREATE OR REPLACE FUNCTION log_active_policy_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.buy_offset_day IS DISTINCT FROM OLD.buy_offset_day
   OR NEW.sell_offset_day IS DISTINCT FROM OLD.sell_offset_day
   OR NEW.regime_mode IS DISTINCT FROM OLD.regime_mode) THEN
    INSERT INTO active_policy_history (
      buy_offset_day, sell_offset_day, regime_mode, set_by, change_reason,
      prev_buy_offset_day, prev_sell_offset_day, prev_regime_mode
    ) VALUES (
      NEW.buy_offset_day, NEW.sell_offset_day, NEW.regime_mode, NEW.set_by, NEW.change_reason,
      OLD.buy_offset_day, OLD.sell_offset_day, OLD.regime_mode
    );
    NEW.updated_at = NOW();
    NEW.since_date = CURRENT_DATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_active_policy_history ON active_policy;
CREATE TRIGGER trg_active_policy_history
  BEFORE UPDATE ON active_policy
  FOR EACH ROW
  EXECUTE FUNCTION log_active_policy_change();

-- RLS: 다른 테이블과 동일 패턴
ALTER TABLE active_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon read active_policy" ON active_policy FOR SELECT USING (true);
CREATE POLICY "anon update active_policy" ON active_policy FOR UPDATE USING (true);

ALTER TABLE active_policy_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon read active_policy_history" ON active_policy_history FOR SELECT USING (true);
CREATE POLICY "anon insert active_policy_history" ON active_policy_history FOR INSERT WITH CHECK (true);

COMMENT ON TABLE active_policy IS 'Phase 2: 현재 운영 중인 매매 정책 (단일 행). 자동 변경 없음 — 사용자 수동 update.';
COMMENT ON COLUMN active_policy.regime_mode IS 'auto = weekly_diagnostics.regime 따름. 그 외는 강제 모드 고정.';
COMMENT ON COLUMN active_policy.since_date IS '이 정책이 적용 시작된 날. trigger에서 변경 시 자동 갱신.';
