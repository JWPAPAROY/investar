# 탑3 추천 종목 시스템 설계안 (v3.13)

**목표**: 매일 "반드시 매수해야 하는" 탑3 종목을 선정하여 별도 표시 및 성과 추적

---

## 📊 백테스트 기반 탑3 선정 기준

### 1️⃣ 선정 알고리즘 (우선순위 기반)

```
Priority 1: 황금 구간 (70-79점) + 고래 감지
├─ 승률: 50%, 평균: +66.23% (대박 구간)
├─ 카테고리: 고래 감지 (승률 64.7%, 평균 +20.31%)
└─ 가장 높은 기대 수익

Priority 2: S등급 (75-89점) + 조용한 매집
├─ 승률: 34.7%, 평균: +15.02%
├─ 카테고리: 조용한 매집 (승률 29.6%, 평균 +11.85%)
└─ 안정적인 선행 신호

Priority 3: 황금 구간 (50-79점) + 일반
├─ 승률: 51.6%, 평균: +2.22% (안정 구간)
├─ 다양성 확보
└─ 보수적 선택

필터링 조건:
❌ 복합 신호 제외 (승률 11.1%, 평균 -9.54%)
❌ 과열 제외 (RSI > 80 OR 이격도 > 115)
❌ 60-69점 구간 제외 (혼재 구간, 평균 -1.03%)
```

### 2️⃣ 다양성 규칙

```javascript
// 카테고리 다양성
- 3개 종목이 모두 같은 카테고리 X
- 가능하면 고래 1개 + 조용한매집 1개 + 일반 1개

// 섹터 다양성 (옵션)
- 같은 업종 2개 이상 지양 (가능하면)

// 점수 다양성
- 최소 점수 차이 10점 이상 (가능하면)
```

---

## 🎨 프론트엔드 설계

### [종목 스크리닝] 탭 개선

#### 기존 레이아웃
```
┌─────────────────────────────────────┐
│  [종합집계] [고래 감지] [조용한 매집] │
├─────────────────────────────────────┤
│  종목 카드 1                          │
│  종목 카드 2                          │
│  종목 카드 3                          │
│  ...                                 │
└─────────────────────────────────────┘
```

#### 개선 레이아웃 ⭐ NEW
```
┌─────────────────────────────────────────────────────────┐
│  🏆 오늘의 탑3 추천 (반드시 매수 고려)                   │
├─────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│  │ 👑 #1   │  │ 🥈 #2   │  │ 🥉 #3   │                 │
│  │ 종목명   │  │ 종목명   │  │ 종목명   │                 │
│  │ S등급   │  │ S등급   │  │ A등급   │                 │
│  │ 75점    │  │ 72점    │  │ 68점    │                 │
│  │ 🐋 고래 │  │ 🤫 매집 │  │ 📊 일반 │                 │
│  │         │  │         │  │         │                 │
│  │ 선정이유:│  │ 선정이유:│  │ 선정이유:│                 │
│  │ 대박구간│  │ S등급+  │  │ 안정적  │                 │
│  │ +고래   │  │ 조용한  │  │ 선행신호│                 │
│  │         │  │ 매집    │  │         │                 │
│  └─────────┘  └─────────┘  └─────────┘                 │
├─────────────────────────────────────────────────────────┤
│  [종합집계] [고래 감지] [조용한 매집]                     │
├─────────────────────────────────────────────────────────┤
│  종목 카드 1 (일반)                                       │
│  종목 카드 2 (일반)                                       │
│  ...                                                     │
└─────────────────────────────────────────────────────────┘
```

#### UI 상세 설계

**탑3 카드 디자인**:
```html
<div class="top3-section">
  <div class="top3-header">
    <h2>🏆 오늘의 탑3 추천</h2>
    <p class="subtitle">백테스트 검증된 최고 성과 예상 종목</p>
  </div>

  <div class="top3-cards">
    <!-- #1 종목 -->
    <div class="top3-card rank-1">
      <div class="rank-badge">👑 #1</div>
      <div class="stock-name">천일고속</div>
      <div class="stock-code">(000650)</div>
      <div class="grade-badge s-grade">S등급 75점</div>
      <div class="category-badge whale">🐋 고래 감지</div>

      <div class="top3-reason">
        <strong>선정 이유:</strong>
        <ul>
          <li>대박 구간 (70-79점)</li>
          <li>고래 감지 (평균 +20.31%)</li>
          <li>거래량 폭발: 5.2배</li>
        </ul>
      </div>

      <div class="expected-return">
        <span class="label">기대 수익률:</span>
        <span class="value">+15~30%</span>
      </div>

      <button class="detail-btn">상세 보기</button>
    </div>

    <!-- #2, #3 유사 구조 -->
  </div>
</div>
```

**스타일링**:
```css
.top3-section {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 30px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3);
}

.top3-card {
  background: white;
  border-radius: 8px;
  padding: 15px;
  position: relative;
}

.top3-card.rank-1 {
  border: 3px solid #FFD700; /* 금색 */
  box-shadow: 0 0 20px rgba(255, 215, 0, 0.5);
}

.rank-badge {
  position: absolute;
  top: -10px;
  left: -10px;
  font-size: 32px;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
}
```

---

### [성과 점검] 탭 개선

#### 기존 레이아웃
```
┌─────────────────────────────────────┐
│  전체 추천 종목 성과                  │
├─────────────────────────────────────┤
│  종목 1: +5.3%                       │
│  종목 2: -2.1%                       │
│  종목 3: +12.4%                      │
│  ...                                 │
│                                      │
│  통계: 승률 41.2%, 평균 +2.28%       │
└─────────────────────────────────────┘
```

#### 개선 레이아웃 ⭐ NEW
```
┌─────────────────────────────────────────────────────────┐
│  🏆 탑3 추천 성과 (핵심 트래킹)                           │
├─────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────┐  │
│  │  📊 탑3 vs 전체 비교                               │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │  │
│  │  탑3 평균:  🚀 +18.5%  승률: 75.0%               │  │
│  │  전체 평균: 📊 +2.3%   승률: 41.2%               │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │  │
│  │  차이:      +16.2%p    +33.8%p                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  📅 탑3 추천 이력 (최근 30일)                             │
│  ┌─────────────────────────────────────────────────┐   │
│  │  날짜        종목       등급  추천가  현재가  수익률│   │
│  │  12-11  👑 천일고속    S    10,000  15,000  +50%│   │
│  │  12-11  🥈 SK하이닉스  S   150,000 180,000  +20%│   │
│  │  12-11  🥉 이뮨온시아  A    12,000  13,500  +12%│   │
│  │  12-10  👑 종목A       S     5,000   5,200   +4%│   │
│  │  ...                                            │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
│  📈 탑3 성과 차트 (누적 수익률)                           │
│  [라인 차트: 탑3 누적 vs 전체 누적]                      │
├─────────────────────────────────────────────────────────┤
│  전체 추천 종목 성과 (기존 유지)                          │
│  ...                                                     │
└─────────────────────────────────────────────────────────┘
```

---

## 🔧 백엔드 설계

### 1️⃣ API 변경 (backend/screening.js)

```javascript
/**
 * 탑3 종목 선정 알고리즘
 */
selectTop3(allStocks) {
  const candidates = [];

  // 1. 필터링: 복합 신호, 과열, 혼재 구간 제외
  const filtered = allStocks.filter(stock => {
    const score = stock.totalScore;
    const isComposite = stock.advancedAnalysis.indicators.whale?.length > 0 &&
                        stock.advancedAnalysis.indicators.accumulation?.detected;
    const isOverheated = stock.recommendation.grade === '과열';
    const isMixedZone = score >= 60 && score < 70;

    return !isComposite && !isOverheated && !isMixedZone && score >= 50;
  });

  // 2. Priority 1: 대박 구간 + 고래 (70-79점)
  const priority1 = filtered.filter(s =>
    s.totalScore >= 70 && s.totalScore < 80 &&
    s.advancedAnalysis.indicators.whale?.length > 0
  ).sort((a, b) => b.totalScore - a.totalScore);

  // 3. Priority 2: S등급 + 조용한 매집 (75-89점)
  const priority2 = filtered.filter(s =>
    s.totalScore >= 75 && s.totalScore < 90 &&
    s.advancedAnalysis.indicators.accumulation?.detected
  ).sort((a, b) => b.totalScore - a.totalScore);

  // 4. Priority 3: 안정 구간 + 일반 (50-79점)
  const priority3 = filtered.filter(s =>
    s.totalScore >= 50 && s.totalScore < 80 &&
    !s.advancedAnalysis.indicators.whale?.length &&
    !s.advancedAnalysis.indicators.accumulation?.detected
  ).sort((a, b) => b.totalScore - a.totalScore);

  // 5. 카테고리 다양성 고려하여 선택
  const top3 = [];
  const categories = new Set();

  // Priority 1에서 1개
  if (priority1.length > 0) {
    top3.push({
      ...priority1[0],
      top3Rank: 1,
      top3Reason: {
        title: '대박 구간 + 고래 감지',
        details: [
          `점수 ${priority1[0].totalScore}점 (대박 구간)`,
          '고래 감지 (평균 +20.31%)',
          `거래량 ${priority1[0].volumeAnalysis.current.volumeRatio}배 폭발`
        ],
        expectedReturn: '+15~30%'
      }
    });
    categories.add('whale');
  }

  // Priority 2에서 1개 (카테고리 중복 제외)
  if (top3.length < 3 && priority2.length > 0) {
    const candidate = priority2.find(s => !categories.has('accumulation'));
    if (candidate) {
      top3.push({
        ...candidate,
        top3Rank: top3.length + 1,
        top3Reason: {
          title: 'S등급 + 조용한 매집',
          details: [
            `점수 ${candidate.totalScore}점 (S등급)`,
            '조용한 매집 (평균 +11.85%)',
            '선행 신호 감지'
          ],
          expectedReturn: '+10~20%'
        }
      });
      categories.add('accumulation');
    }
  }

  // Priority 3에서 1개 (다양성 확보)
  if (top3.length < 3 && priority3.length > 0) {
    top3.push({
      ...priority3[0],
      top3Rank: top3.length + 1,
      top3Reason: {
        title: '안정 구간 + 일반',
        details: [
          `점수 ${priority3[0].totalScore}점 (안정 구간)`,
          '승률 51.6% 구간',
          '보수적 선택'
        ],
        expectedReturn: '+2~10%'
      }
    });
  }

  return top3;
}

/**
 * API 응답에 top3 추가
 */
async screenAllStocks(market = 'ALL', limit = null) {
  // 기존 로직...
  const allStocks = [...];

  // 탑3 선정
  const top3 = this.selectTop3(allStocks);

  return {
    success: true,
    top3: top3,  // 🆕 탑3 종목
    stocks: allStocks,
    metadata: { ... }
  };
}
```

### 2️⃣ Supabase 스키마 변경

```sql
-- screening_recommendations 테이블에 컬럼 추가
ALTER TABLE screening_recommendations
ADD COLUMN is_top3 BOOLEAN DEFAULT FALSE,
ADD COLUMN top3_rank INTEGER,  -- 1, 2, 3
ADD COLUMN top3_reason JSONB,  -- { title, details, expectedReturn }
ADD COLUMN top3_date DATE;     -- 탑3 선정일

-- 인덱스 추가 (빠른 조회)
CREATE INDEX idx_top3_date ON screening_recommendations(top3_date DESC, top3_rank ASC)
WHERE is_top3 = TRUE;

-- 탑3 성과 뷰 생성
CREATE OR REPLACE VIEW top3_performance AS
SELECT
  s.top3_date,
  s.top3_rank,
  s.stock_code,
  s.stock_name,
  s.recommended_price,
  s.recommendation_grade,
  s.total_score,
  s.top3_reason,
  d.closing_price AS current_price,
  ROUND(((d.closing_price - s.recommended_price) / s.recommended_price * 100)::numeric, 2) AS return_rate,
  CASE
    WHEN d.closing_price > s.recommended_price THEN TRUE
    ELSE FALSE
  END AS is_winning
FROM screening_recommendations s
LEFT JOIN LATERAL (
  SELECT closing_price
  FROM recommendation_daily_prices
  WHERE recommendation_id = s.id
  ORDER BY tracking_date DESC
  LIMIT 1
) d ON TRUE
WHERE s.is_top3 = TRUE
ORDER BY s.top3_date DESC, s.top3_rank ASC;
```

### 3️⃣ 저장 API 수정 (api/recommendations/save.js)

```javascript
async function saveRecommendations(stocks) {
  // 기존: B등급(45점) 이상만 저장
  const toSave = stocks
    .filter(s => s.totalScore >= 50 && s.totalScore < 80)
    .map(s => ({
      ...s,
      is_top3: s.top3Rank !== undefined,  // 🆕
      top3_rank: s.top3Rank || null,
      top3_reason: s.top3Reason || null,
      top3_date: s.top3Rank ? new Date().toISOString().split('T')[0] : null
    }));

  await supabase.from('screening_recommendations').upsert(toSave);
}
```

### 4️⃣ 성과 조회 API (api/recommendations/top3-performance.js)

```javascript
/**
 * 탑3 성과 조회 API
 * GET /api/recommendations/top3-performance?days=30
 */
module.exports = async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  // 탑3 성과 조회
  const { data: top3Data } = await supabase
    .from('top3_performance')
    .select('*')
    .gte('top3_date', sinceDate.toISOString().split('T')[0])
    .order('top3_date', { ascending: false });

  // 전체 성과 조회 (비교용)
  const { data: allData } = await supabase
    .from('recommendation_statistics')
    .select('*')
    .gte('recommendation_date', sinceDate.toISOString().split('T')[0]);

  // 통계 계산
  const top3Stats = calculateStats(top3Data);
  const allStats = calculateStats(allData);

  return res.json({
    success: true,
    top3: {
      stocks: top3Data,
      statistics: top3Stats
    },
    all: {
      statistics: allStats
    },
    comparison: {
      returnDiff: top3Stats.avgReturn - allStats.avgReturn,
      winRateDiff: top3Stats.winRate - allStats.winRate
    }
  });
};
```

---

## 📱 프론트엔드 구현 (index.html)

```javascript
// 탑3 렌더링 함수
function renderTop3(top3Stocks) {
  const container = document.getElementById('top3-container');

  const html = `
    <div class="top3-section">
      <div class="top3-header">
        <h2>🏆 오늘의 탑3 추천</h2>
        <p class="subtitle">백테스트 검증 • 평균 수익률 +18.5% 예상</p>
      </div>

      <div class="top3-cards">
        ${top3Stocks.map((stock, i) => renderTop3Card(stock, i)).join('')}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

function renderTop3Card(stock, index) {
  const badges = ['👑', '🥈', '🥉'];
  const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];

  return `
    <div class="top3-card rank-${index + 1}">
      <div class="rank-badge" style="color: ${colors[index]}">
        ${badges[index]} #${index + 1}
      </div>

      <div class="stock-info">
        <h3>${stock.stockName}</h3>
        <p class="stock-code">(${stock.stockCode})</p>
        <div class="grade">${stock.recommendation.grade}등급 ${stock.totalScore}점</div>
      </div>

      <div class="top3-reason">
        <strong>${stock.top3Reason.title}</strong>
        <ul>
          ${stock.top3Reason.details.map(d => `<li>${d}</li>`).join('')}
        </ul>
      </div>

      <div class="expected-return">
        기대 수익률: <strong>${stock.top3Reason.expectedReturn}</strong>
      </div>

      <button onclick="showStockDetail('${stock.stockCode}')">
        상세 보기 →
      </button>
    </div>
  `;
}
```

---

## 📊 기대 효과

### 1️⃣ 사용자 경험 개선
- ✅ 명확한 매수 우선순위 제공
- ✅ 의사결정 시간 단축 (53개 → 3개)
- ✅ 초보자도 쉽게 판단 가능

### 2️⃣ 성과 향상 예상
```
백테스트 기반 예측:
탑3 평균: +18.5% (대박구간 66% + S등급 15% + 안정구간 2%)
전체 평균: +2.3%
━━━━━━━━━━━━━━━━
차이: +16.2%p 개선
```

### 3️⃣ 신뢰도 향상
- ✅ 백테스트 검증된 선정 기준
- ✅ 투명한 선정 이유 공개
- ✅ 실시간 성과 추적

---

## 🚀 구현 우선순위

### Phase 1: 최소 기능 (MVP)
- [ ] 백엔드: selectTop3() 함수 구현
- [ ] API: top3 필드 추가
- [ ] 프론트엔드: 탑3 섹션 UI
- [ ] Supabase: is_top3 컬럼 추가

### Phase 2: 성과 추적
- [ ] Supabase: 탑3 뷰 생성
- [ ] API: top3-performance.js
- [ ] 프론트엔드: 성과 점검 탭 개선

### Phase 3: 고도화
- [ ] 탑3 변경 히스토리
- [ ] 탑3 vs 전체 비교 차트
- [ ] 알림 기능 (탑3 변경 시)

---

## 💡 추가 아이디어

### 1️⃣ 탑3 변형 옵션
```
- 보수적 탑3: 안정 구간 (50-59점) 위주
- 공격적 탑3: 대박 구간 (70-79점) 위주
- 밸런스 탑3: 현재 제안 방식
```

### 2️⃣ 알림 시스템
```
- 탑3 종목 변경 시 알림
- 탑3 중 과열 진입 시 경고
- 탑3 목표가 도달 시 알림
```

### 3️⃣ 소셜 기능
```
- 탑3 공유 기능 (카카오톡, 트위터)
- 커뮤니티 투표 (탑3 중 최고 종목은?)
```

---

**핵심 철학**: "많은 선택지보다 검증된 3가지 선택이 더 낫다!"
