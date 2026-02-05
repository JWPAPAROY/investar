-- ============================================
-- screening_recommendations 테이블 확장
-- 추천 시점 모든 지표 저장 (성공 패턴 분석용)
-- ============================================

-- 기존 테이블에 컬럼 추가 (ALTER)

-- 거래량 기준 지표
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS volume_acceleration_score INTEGER;
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS volume_acceleration_trend VARCHAR(30);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS asymmetric_ratio DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS asymmetric_signal VARCHAR(50);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS obv_trend VARCHAR(20);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS volume_5d_change_rate DECIMAL(10, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS whale_confirmed BOOLEAN DEFAULT FALSE;
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS whale_volume_ratio DECIMAL(10, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS whale_price_change DECIMAL(10, 2);

-- 시세 기준 지표
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS rsi DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS disparity DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS vwap_divergence DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS consecutive_rise_days INTEGER;
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS escape_velocity BOOLEAN DEFAULT FALSE;
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS escape_closing_strength DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS upper_shadow_ratio DECIMAL(5, 2);

-- 수급 기준 지표
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS institution_buy_days INTEGER;
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS foreign_buy_days INTEGER;

-- 복합 지표
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS vpd_score DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS vpd_raw DECIMAL(5, 2);

-- 점수 컴포넌트
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS base_score DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS whale_bonus INTEGER;
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS momentum_score DECIMAL(5, 2);
ALTER TABLE screening_recommendations ADD COLUMN IF NOT EXISTS trend_score DECIMAL(5, 2);

-- 인덱스 추가 (분석용)
CREATE INDEX IF NOT EXISTS idx_rec_volume_ratio ON screening_recommendations(volume_ratio);
CREATE INDEX IF NOT EXISTS idx_rec_mfi ON screening_recommendations(mfi);
CREATE INDEX IF NOT EXISTS idx_rec_rsi ON screening_recommendations(rsi);

COMMENT ON COLUMN screening_recommendations.volume_acceleration_score IS '거래량 가속도 점수 (0-15)';
COMMENT ON COLUMN screening_recommendations.asymmetric_ratio IS '비대칭 비율 (상승일/하락일 거래량)';
COMMENT ON COLUMN screening_recommendations.escape_velocity IS '탈출 속도 달성 여부';
COMMENT ON COLUMN screening_recommendations.disparity IS '이격도 (20일 이평 대비 %)';
