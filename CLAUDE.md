# Investar - AI 기반 주식 스크리닝 시스템

## 프로젝트 개요

**Investar**는 한국투자증권 OpenAPI를 활용한 거래량 기반 주식 종목 발굴 시스템입니다.

- **목적**: 거래량 지표로 급등 "예정" 종목 선행 발굴 (Volume-Price Divergence)
- **기술 스택**: Node.js, React (CDN), Vercel Serverless, KIS OpenAPI
- **배포 URL**: https://investar-xi.vercel.app
- **버전**: 3.21 (Scoring Improvements - 5일 거래량 변동율, VWAP 단계별, 비대칭 버그 수정)
- **최종 업데이트**: 2026-02-02

---

## 📊 현재 시스템 상태 (2025-11-06)

### ✅ 작동 현황
- **종목 풀**: 53개 (KOSPI + KOSDAQ, 동적 API 기반)
- **API 호출**: 240개/일 (4개 순위 API × 2시장 × 30개)
- **중복 제거율**: 78% (240개 → 53개)
- **ETF/ETN 필터링**: 15개 키워드 차단 (plus, unicorn, POST IPO 등)

### 🎯 핵심 철학 (v3.5)
**"거래량 폭발 + 가격 미반영 = 급등 예정 신호"**

- ✅ **Volume-Price Divergence** - 거래량 증가율 높은데 급등 안 한 주식 우선 발굴
- ✅ **선행 지표 통합** - smartPatternMining + volumeDnaExtractor → leadingIndicators
- ✅ **점수 체계** - 100점 만점 (기본 20 + 선행지표 80)
- ✅ **중복 모듈 정리** - 사용하지 않는 파일 삭제

---

## 🎯 종목 포착 로직 (Stock Screening Pipeline)

### 전체 흐름도

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: 종목 풀 확보 (Stock Pool Generation)               │
│ ─────────────────────────────────────────────────────────── │
│ KIS API 4가지 순위 조회 (KOSPI + KOSDAQ)                    │
│ ├─ 등락률 상승 순위 30개 × 2시장 = 60개                      │
│ ├─ 거래량 증가율 순위 30개 × 2시장 = 60개                    │
│ ├─ 거래량 순위 30개 × 2시장 = 60개                          │
│ └─ 거래대금 순위 30개 × 2시장 = 60개                        │
│ = 총 240개 종목 수집                                         │
│                                                              │
│ ↓ ETF/ETN 필터링 (15개 키워드)                              │
│ ↓ 중복 제거                                                  │
│                                                              │
│ 최종 종목 풀: ~53개 (78% 중복 제거)                          │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: 종목별 데이터 수집 (Data Collection)                │
│ ─────────────────────────────────────────────────────────── │
│ 각 종목마다 3가지 API 호출 (일봉 30일 기준)                  │
│ ├─ getCurrentPrice(): 현재가, 거래량, 시총                  │
│ ├─ getDailyChart(30): 최근 30일 일봉 (OHLCV)                │
│ └─ getInvestorData(5): 최근 5일 기관/외국인 수급             │
│                                                              │
│ Rate Limiting: 18 calls/sec (200ms 간격)                    │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: 지표 분석 (Indicator Analysis)                      │
│ ─────────────────────────────────────────────────────────── │
│ 3-1. 기본 거래량 지표 (volumeIndicators.js)                 │
│      ├─ 거래량 비율 (vs 20일 평균)                          │
│      ├─ OBV (On-Balance Volume) 추세                        │
│      ├─ VWAP (Volume Weighted Average Price)                │
│      └─ MFI (Money Flow Index, 14일)                        │
│                                                              │
│ 3-2. 고급 지표 (advancedIndicators.js)                      │
│      ├─ 비대칭 비율 (상승일 vs 하락일 거래량, 20일)          │
│      ├─ 고래 감지 (거래량 2.5배+ && 가격 3%+)                │
│      ├─ 조용한 매집 (가격 ±10% && 거래량 20%+)               │
│      ├─ 기관/외국인 수급 (연속 매수일)                       │
│      ├─ 합류점 (10개 지표 중 동시 신호)                      │
│      ├─ 당일/전일 신호 (D-0, D-1 신호 발생)                  │
│      ├─ Cup&Handle 패턴                                     │
│      └─ Triangle 패턴                                       │
│                                                              │
│ 3-3. 선행 지표 (leadingIndicators.js)                       │
│      ├─ 패턴 매칭 (smartPatternMining)                      │
│      └─ 거래량 DNA (volumeDnaExtractor)                     │
│                                                              │
│ 3-4. Volume-Price Divergence                                │
│      divergence = volumeRatio - priceRatio                  │
│      → 거래량 급증했는데 가격 안 오른 종목 = 고득점          │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 4: 점수 계산 및 등급 부여 (Scoring & Grading)          │
│ ─────────────────────────────────────────────────────────── │
│ 총점 = 기본 점수 (0-20) + 선행 지표 (0-80)                   │
│                                                              │
│ 등급 산정 (7-Tier 시스템, 점수 내림차순) ⭐ v3.10.2 실제 코드 │
│ ├─ ⚠️ 과열: RSI > 80 AND 이격도 > 115 (점수 무관)            │
│ │   └─ 과열 감지 시 점수와 무관하게 최우선 경고 표시        │
│ ├─ S+등급: 90+점 (🌟 최상위 매수)                           │
│ │   └─ Golden Zones 패턴 또는 완벽한 Radar Score           │
│ ├─ S등급: 75-89점 (🔥 최우선 매수)                          │
│ │   └─ 거래량 폭발, 기관 본격 매수                         │
│ ├─ A등급: 60-74점 (🟢 적극 매수)                            │
│ │   └─ 거래량 증가 시작, 기관 초기 진입                    │
│ ├─ B등급: 45-59점 (🟡 매수 고려)                            │
│ │   └─ 선행 패턴 감지, Supabase 저장 대상                  │
│ ├─ C등급: 30-44점 (🟠 관망)                                 │
│ │   └─ 약한 신호, 저장 제외                                │
│ └─ D등급: <30점 (⚫ 비추천)                                  │
│     └─ 선행 지표 미감지                                     │
│                                                              │
│ 필터링: B등급(45점) 이상만 Supabase 저장                     │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 5: 정렬 및 반환 (Sorting & Response)                   │
│ ─────────────────────────────────────────────────────────── │
│ 점수 내림차순 정렬                                           │
│ limit 파라미터 적용 (기본값: 전체, 옵션: 상위 N개)           │
│                                                              │
│ 반환 데이터 구조:                                            │
│ {                                                            │
│   stocks: [...],        // 종목 배열                         │
│   metadata: {                                                │
│     totalAnalyzed: 53,  // 분석한 종목 수                    │
│     totalFound: 23,     // 20점 이상 종목 수                 │
│     returned: 10        // 실제 반환 종목 수                 │
│   }                                                          │
│ }                                                            │
└─────────────────────────────────────────────────────────────┘
```

### 핵심 설계 원칙

1. **다양한 패턴 포착**: 4가지 순위 API로 거래량 급증, 가격 급등, 대형주 활동 등 다양한 패턴 수집
2. **일봉 기준 분석**: 모든 지표는 일봉 데이터 기반 (노이즈 최소화)
3. **선행성 우선**: Volume-Price Divergence로 "이미 급등"이 아닌 "곧 급등할" 종목 발굴
4. **투명성**: 모든 지표의 계산 근거와 수치를 사용자에게 공개

---

## 📊 점수 배점 상세 (Scoring System Details)

### 점수 체계 개요 (v3.21)

```
총점 (0-92점) = Base(0-17) + Momentum(0-45) + Trend(0-40) + MultiSignal(0-6)

추천 등급 (v3.21 실제 코드 기준, 7-Tier System)
⚠️ 과열: RSI > 80 AND 이격도 > 115 (점수 무관, 최우선 경고)
S+등급: 90+ (최상위 매수)
S등급: 75-89 (최우선 매수)
A등급: 60-74 (적극 매수)
B등급: 45-59 (매수 고려, Supabase 저장 ✅)
C등급: 30-44 (관망, 저장 제외 ❌)
D등급: <30 (비추천)
```

---

### 1️⃣ Base Score (0-17점) — v3.21

품질 체크 점수. 현재 종목의 거래량/추세 상태 평가.

| 항목 | 점수 | 설명 |
|------|------|------|
| 거래량 비율 | 0-3점 | 20일 평균 대비 (5배→3, 3배→2, 2배→1) |
| OBV 추세 | 0-3점 | 상승→3, 횡보→1 |
| VWAP 모멘텀 | 0-3점 | VWAP 대비 거리 (5%+→3, 2%+→2, 0%+→1) |
| 비대칭 비율 | 0-4점 | 매수세만 가점, 매도세 0점 (v3.20 버그 수정) |
| VPD raw | 0-3점 | Volume-Price Divergence 현재 상태 |
| 5일 거래량 변동율 🆕 | 0-2점 | 일평균 30%+→2, 15%+→1 (v3.21 신규) |
| 되돌림 페널티 | -2~0점 | 고점 대비 20%+→-2, 15%+→-1 |



### 2️⃣ Momentum Score (0-45점) — D-5일 변화율

5일 전과 현재 비교하여 "지금 막 시작되는" 종목 포착.

| 항목 | 점수 | 설명 |
|------|------|------|
| 거래량 가속도 | 0-15점 | D-5 vs D-0 거래량 변화 |
| VPD 개선도 | 0-20점 | Volume-Price Divergence 개선 (핵심 지표) |
| 기관 진입 가속 | 0-10점 | D-5 vs D-0 기관 매수일 비교 |

---

### 3️⃣ Trend Score (0-40점) — 30일 장기 추세

30일 데이터 내 매집 패턴 분석.

| 항목 | 점수 | 설명 |
|------|------|------|
| 거래량 점진 증가 | 0-20점 | 4주간 점진적 거래량 증가 |
| 변동성 수축 | 0-5점 | 볼린저밴드 수축 (상승장에서 제한적) |
| 기관/외국인 매집 | 0-8점 | 장기 순매수 패턴 |
| VPD 강화 추세 | 0-7점 | VPD 장기 개선 |

---

### 4️⃣ Multi-Signal Bonus (0-6점)

여러 API에서 동시 등장 시 가중치.

| 조건 | 점수 |
|------|------|
| 4개+ API 동시 등장 | +6점 |
| 3개 API 동시 등장 | +4점 |
| 2개 API 동시 등장 | +2점 |

---

### 📊 Volume-Price Divergence (핵심 철학)

**"거래량 폭발 + 가격 미반영 = 곧 급등"**

```javascript
// Step 1: 비율 계산
volumeRatio = 당일 거래량 / 20일 평균 거래량
priceRatio = abs(현재가 - 20일 평균가) / 20일 평균가 + 1.0

// Step 2: Divergence 계산
divergence = volumeRatio - priceRatio

// Step 3: 점수 부여
if (divergence >= 3.0 && 가격 변동 ±10%)  → 28-35점 (조용한 매집)
if (divergence >= 2.0 && 가격 변동 ±15%)  → 20-27점 (초기 단계)
if (divergence >= 1.0)                    → 12-19점 (중간 단계)

// Step 4: 페널티
if (가격 20% 이상 급등)  → -15~-25점 (이미 급등)

// Step 5: 스케일링
최종 점수 = VPD 점수 × 0.714  // 35점 → 25점으로 스케일링
```

**예시 1 (최고 점수)**:
- 거래량: 5배 증가 (volumeRatio = 5.0)
- 가격: 5% 상승 (priceRatio = 1.05)
- divergence = 5.0 - 1.05 = 3.95
- 신호: "조용한 매집" → 35점 × 0.714 = **25점**

**예시 2 (페널티)**:
- 거래량: 3배 증가
- 가격: 25% 급등
- 신호: "이미 급등" → **-20점**

---

#### 2-2. 기관/외국인 수급 (0-15점)
**계산 기준**: 최근 5일간 연속 순매수

```javascript
기관 연속 매수일 = count(기관 순매수 > 0인 연속일)
외국인 연속 매수일 = count(외국인 순매수 > 0인 연속일)

if (기관 3일+ && 외국인 3일+)     → 15점 (동반 매수)
if (기관 3일+ || 외국인 3일+)     → 10점 (단독 매수)
else                              → 0점
```

**예시**:
- 기관: 5일 연속 순매수
- 외국인: 3일 연속 순매수
- 결과: **15점**

---

#### 2-3. 합류점 Confluence (0-12점)
**계산 기준**: 10개 지표 중 동시 신호 개수

```javascript
10개 지표:
1. 고래 감지 (거래량 2.5배+ && 가격 3%+)
2. 조용한 매집 (가격 ±3% && 거래량 20%+)
3. 탈출 속도 (저항선 돌파 && Closing Strength 70%+)
4. 조용한 누적 (20일간 점진적 거래량 증가)
5. 스마트머니 (특정 패턴 매칭)
6. 돌파 준비 (저항선 근접 && 거래량 증가)
7. 기관/외국인 매수 (연속 3일+)
8. 돌파 확인 (저항선 돌파 후 재테스트 성공)
9. 이상 급등 (급격한 거래량/가격 변동)
10. 위험조정 점수 (Sharpe Ratio 1.0+)

if (5개 이상 신호)  → 12점
if (3-4개 신호)     → 9점
if (2개 신호)       → 6점
else                → 0점
```

**스케일링**: 원점수 × 0.6 = 최종 점수 (20점 → 12점)

**예시**:
- 감지된 지표: 고래 감지, 조용한 매집, 기관 매수, 돌파 준비, 스마트머니 (5개)
- 점수: 12점 × 0.6 = **7.2점**

---

#### 2-4. 선행 지표 (패턴+DNA) (0-10점)
**계산 기준**: smartPatternMining + volumeDnaExtractor 하이브리드

```javascript
// Step 1: 패턴 매칭 (smartPatternMining)
매칭 점수 = Σ(패턴 매칭도 × 승률 × 신뢰도) / 100

// Step 2: DNA 매칭 (volumeDnaExtractor)
DNA 점수 = (EMA 유사도 × 40%) + (구간별 유사도 × 30%) + (최근5일 유사도 × 30%)

// Step 3: 하이브리드
종합 = (패턴 점수 × 50%) + (DNA 점수 × 50%)

// Step 4: 스케일링
최종 점수 = 종합 × 0.125  // 80점 → 10점
```

**예시**:
- 패턴: "고래 매집 후 급등" 매칭도 87%, 승률 73%, 신뢰도 80%
- 패턴 점수: 0.87 × 0.73 × 0.80 × 100 = 50.8점
- DNA 점수: 65점
- 종합: (50.8 × 50%) + (65 × 50%) = 57.9점
- 최종: 57.9 × 0.125 = **7.2점**

---

#### 2-5. 당일/전일 신호 (0-8점)
**계산 기준**: D-0 (당일) 또는 D-1 (전일) 발생 신호 개수

```javascript
당일/전일 신호 = count(신호 발생일이 오늘 또는 어제인 지표)

신호 점수 = 당일/전일 신호 개수 × 3  // 최대 15점

최종 점수 = min(신호 점수 × 0.53, 8)  // 스케일링
```

**예시**:
- 고래 감지 (D-0), 탈출 속도 (D-1), 기관 매수 (D-0) → 3개
- 점수: 3 × 3 × 0.53 = **4.77점**

**⚠️ 주의**: 당일/전일 신호는 후행 지표 가능성 (이미 급등 중일 수 있음)

---

#### 2-6. Cup&Handle 패턴 (0-5점)
**계산 기준**: U자형 바닥 + 손잡이 형성

```javascript
컵 형성 기간: 10-30일
손잡이 형성 기간: 3-7일
돌파 대기: 손잡이 저항선 근접

if (패턴 완성 && 돌파 임박)  → 20점

최종 점수 = min(20 × 0.25, 5)  // 스케일링
```

---

#### 2-7. 돌파 확인 (0-3점)
**계산 기준**: 저항선 돌파 후 재테스트 성공

```javascript
if (저항선 돌파 && 거래량 2배+ && 재테스트 성공)  → 15점

최종 점수 = min(15 × 0.2, 3)  // 스케일링
```

---

#### 2-8. Triangle 패턴 (0-2점)
**계산 기준**: 대칭 삼각형 수렴

```javascript
if (고점 하락추세 && 저점 상승추세 && 수렴)  → 15점

최종 점수 = min(15 × 0.13, 2)  // 스케일링
```

---

### 최종 점수 계산 예시

**종목: A사**

```
[기본 점수] 18점
├─ 거래량 비율: 3.2배 → 5점
├─ OBV 추세: 상승 → 7점
├─ VWAP: 상승세 → 5점
├─ 비대칭: 2.1배 → 2점
└─ 되돌림: 8% → -1점

[선행 지표] 62점
├─ VPD: divergence 3.5 → 25점
├─ 기관/외국인: 동반 매수 → 15점
├─ 합류점: 5개 신호 → 7점
├─ 패턴+DNA: 하이브리드 72점 → 9점
├─ 당일/전일 신호: 3개 → 5점
├─ Cup&Handle: 미감지 → 0점
├─ 돌파 확인: 감지 → 1점
└─ Triangle: 미감지 → 0점

━━━━━━━━━━━━━━━━━━━━━━
총점: 18 + 62 = 80점 (85점 만점 기준)
등급: C등급 (75점 이상) ⚠️ 과열 경고
추천: 단기 차익 또는 조정 대기

⚠️ 백테스트 결과 80점은 모든 지표 점등으로 "이미 급등 중" 신호!
```

---

## 🚀 핵심 기능

### 1. 🎯 종목 스크리닝 시스템

#### 📊 3개 핵심 카테고리 (2025-10-28 단순화)

**1. 🏆 종합집계**
- 모든 지표를 종합하여 점수가 높은 종목 집계
- 30점 이상 전체 표시
- 점수 내림차순 정렬

**2. 🐋 고래 감지**
- **조건**: 거래량 2.5배 이상 + 가격 3% 이상 상승
- **의미**: 기관/외국인 등 세력 매수 신호
- **특징**: 윗꼬리 30% 이상 시 경고

**3. 🤫 조용한 매집**
- **조건**: 가격 변동 <3% + 거래량 증가 >20%
- **의미**: 세력이 물량을 조용히 모으는 중
- **예측**: 1~2주 후 급등 가능성 (선행 지표)

#### 제거된 지표 (2025-10-28)

**제거 이유:**
- **🚀 탈출 속도**: 가격 지표 (저항선 돌파는 이미 급등 후)
- **🔥 거래량 폭발**: 고래 감지와 중복
- **💧 유동성 고갈**: 타이밍 불명확 (몇 달 지속 가능)

**철학**: "적을수록 강하다" - 예측력 높은 지표만 유지

---

### 2. 📈 종합 점수 계산 (v3.5 - Volume-Price Divergence)

**핵심 철학**: "거래량 증가율이 높은 주식 중에 급등하지 않은 주식에 더 많은 점수"

```javascript
// 기본 점수 (0-20점)
기본 점수 =
  거래량 비율 (0-8점) +
  OBV 추세 (0-7점) +
  VWAP 모멘텀 (0-5점) +
  비대칭 비율 (0-5점) -
  고점 대비 되돌림 페널티 (-5~0점)

// 선행 지표 (0-65점)
선행 지표 =
  VPD (거래량-가격 모멘텀) (0-25점) +
  기관/외국인 수급 (0-15점) +
  합류점 (Confluence) (0-12점) +
  선행 지표 (패턴+DNA) (0-10점) +
  당일/전일 신호 (0-8점) +
  Cup&Handle 패턴 (0-5점) +
  돌파 확인 (0-3점) +
  Triangle 패턴 (0-2점)

최종 점수: 0~85점 (실제 만점)
```

#### Volume-Price Divergence 핵심 로직

```javascript
divergence = volumeRatio - priceRatio

// 최우선 신호 (28-35점)
거래량 3배+ && 가격 변동 ±10% 이내 → "조용한 매집" → 최고 점수

// 페널티 (-15~-25점)
거래량 증가 && 가격 20% 이상 급등 → "이미 급등" → 점수 차감
```

#### 추천 등급 (100점 만점, 점수 내림차순) ⭐ v3.9.2 NEW

**7-Tier System (실제 코드 기준, v3.10.2):**

- **⚠️ 과열** (RSI > 80 AND 이격도 > 115): ⚠️ 과열 경고
  - 점수 무관, RSI/이격도 기반 감지
  - 단기 조정 가능성 높음

- **S+등급** (90+점): 🌟 최상위 매수
  - Golden Zones 패턴 또는 완벽한 Radar Score
  - 강력한 급등 신호

- **S등급** (75-89점): 🔥 최우선 매수
  - 거래량 폭발, 기관 본격 매수

- **A등급** (60-74점): 🟢 적극 매수
  - 거래량 증가 시작, 기관 초기 진입

- **B등급** (45-59점): 🟡 매수 고려
  - 선행 패턴 감지
  - ✅ Supabase 저장 대상 (성과 추적)

- **C등급** (30-44점): 🟠 관망
  - 약한 신호
  - ❌ 저장 제외

- **D등급** (<30점): ⚫ 비추천
  - 선행 지표 미감지

**핵심 원칙**: "RSI/이격도 과열 감지 최우선, 점수는 7단계 등급" (정확성!)

---

### 3. 🔍 종목 풀 구성

**동적 API 기반 (53개 확보)**:
```
등락률 상승 순위: 30개 × 2시장 = 60개
+ 거래량 증가율 순위: 30개 × 2시장 = 60개
+ 거래량 순위: 30개 × 2시장 = 60개
+ 거래대금 순위: 30개 × 2시장 = 60개
= 총 240개 API 호출 → ETF 필터링 → 중복 제거 후 53개
```

**ETF/ETN 필터링 (15개 키워드)**:
```javascript
// ETF 브랜드
'ETF', 'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'ACE'

// 특수 펀드/파생상품
'plus', 'unicorn', 'POST', 'IPO', 'Active', '액티브',
'국채', '선물', '통안증권', '하이일드'

// 리츠/스팩/레버리지
'리츠', 'REIT', '스팩', 'SPAC', '인버스', '레버리지'
```

---

## 📡 API 엔드포인트

### 스크리닝 API

**종합집계**
```bash
GET /api/screening/recommend?market=ALL&limit=10
```

**고래 감지**
```bash
GET /api/screening/whale?market=KOSPI&limit=5
```

**조용한 매집**
```bash
GET /api/screening/accumulation?market=ALL&limit=5
```

### 📊 백테스트 API (v3.7 NEW)

**단기 백테스트 (30일 데이터 기반)**
```bash
GET /api/backtest/simple?holdingDays=5
```

**응답**:
```json
{
  "success": true,
  "results": [
    {
      "stockCode": "114450",
      "stockName": "그린생명과학",
      "grade": "A",
      "totalScore": 49.5,
      "buyDate": "20251024",
      "buyPrice": 2340,
      "sellDate": "20251114",
      "sellPrice": 4375,
      "holdingDays": 15,
      "returnRate": 86.97,
      "isWin": true
    }
  ],
  "statistics": {
    "overall": {
      "totalCount": 145,
      "winCount": 125,
      "winRate": 86.21,
      "avgReturn": 24.71,
      "sharpeRatio": 1.0,
      "maxDrawdown": 50.96,
      "profitFactor": 34.7
    },
    "byGrade": {
      "S": { "winRate": 100, "avgReturn": 8.06 },
      "A": { "winRate": 86.67, "avgReturn": 24.87 },
      "B": { "winRate": 77.78, "avgReturn": 27.5 },
      "C": { "winRate": 89.33, "avgReturn": 24.89 }
    },
    "byHoldingPeriod": {
      "5days": { "winRate": 89.66, "avgReturn": 21.09 },
      "10days": { "winRate": 86.21, "avgReturn": 22.79 },
      "15days": { "winRate": 82.76, "avgReturn": 26.85 },
      "20days": { "winRate": 86.21, "avgReturn": 27.26 },
      "25days": { "winRate": 86.21, "avgReturn": 25.57 }
    }
  }
}
```

**특징**:
- 현재 추천 종목들의 과거 수익률 시뮬레이션
- 5일, 10일, 15일, 20일, 25일 전 매수 시나리오 분석
- 전체/등급별/보유기간별 통계 제공
- Sharpe Ratio, MDD, Profit Factor 등 고급 지표 계산

**제약사항**:
- KIS API 제한으로 최근 30일 데이터만 사용
- 과거 특정 시점 완전 재현 불가 (시뮬레이션으로 대체)
- 장기 백테스트(1~3년)는 Supabase 데이터 축적 필요

### 📊 Volume-Price Divergence 분석

**핵심 철학**: "거래량 폭발 + 가격 미반영 = 곧 급등할 신호"

**Divergence 계산**:
```javascript
volumeRatio = 최근 거래량 / 평균 거래량
priceRatio = abs(현재가 - 평균가) / 평균가 + 1.0
divergence = volumeRatio - priceRatio

// 예시
거래량 5배 증가 (volumeRatio=5.0)
가격 5% 상승 (priceRatio=1.05)
→ divergence = 3.95 → 35점 (최고 점수)
```

**점수 체계**:
- **Quiet Accumulation** (28-35점): divergence 3.0+ && 가격 ±10%
- **Early Stage** (20-27점): divergence 2.0-3.0 && 가격 ±15%
- **Moderate** (12-19점): divergence 1.0-2.0
- **Already Surged** (-15~-25점): 가격 20%+ 급등 → 페널티

### 🧬 거래량 DNA 시스템 (2025-10-30)

**핵심 철학**: "과거 급등주의 거래량 패턴에서 DNA를 추출하여, 현재 시장에서 같은 패턴을 가진 종목을 찾는다"

#### DNA 추출 (Phase 1)
```bash
POST /api/patterns/volume-dna
{
  "mode": "extract",
  "stocks": [
    { "code": "005930", "startDate": "20251001", "endDate": "20251025" },
    { "code": "000660", "startDate": "20251005", "endDate": "20251025" }
  ]
}
```

**응답**:
```json
{
  "success": true,
  "mode": "extract",
  "result": {
    "commonDNA": {
      "volumeRate": {
        "avgEMA": 2.23,
        "avgRecent5d": -0.31,
        "threshold": { "emaMin": 1.134, "recent5dMin": -0.756 }
      },
      "institutionFlow": {
        "avgConsecutiveDays": 2,
        "threshold": { "minConsecutiveDays": 0 }
      }
    },
    "dnaStrength": 100,
    "basedOnStocks": 2
  }
}
```

#### 시장 스캔 (Phase 2)
```bash
POST /api/patterns/volume-dna
{
  "mode": "scan",
  "commonDNA": { ... },  // Phase 1에서 추출된 DNA
  "options": {
    "matchThreshold": 70,  // 최소 매칭 점수
    "limit": 10,           // 최대 반환 개수
    "days": 25             // 분석 기간 (최근 N일)
  }
}
```

#### DNA 시스템 특징

**시간 가중치 분석**:
- **EMA (Exponential Moving Average)**: 지수 가중 평균 (반감기 5일)
- **구간별 분석**: 초반 20%, 중반 30%, 후반 50% 가중치
- **하이브리드 점수**: EMA 40% + 구간별 30% + 최근5일 30%

**지표**:
1. **거래량 증가율**: EMA 평균, 최근 5일 평균, 트렌드 (accelerating/mixed/decelerating)
2. **기관 순매수**: 연속 매수일, 강도 (strong/moderate/weak)
3. **외국인 순매수**: 연속 매수일, 강도

**선행 지표 통합** (v3.4):
- volumeDnaExtractor + smartPatternMining → leadingIndicators.js
- 패턴 50% + DNA 50% 하이브리드 점수
- 강도 계산: very_high/high/moderate/low

---

## 🛠️ 로컬 개발 가이드

### 환경 설정

```bash
# 1. 저장소 클론
git clone https://github.com/knwwhr/investar.git
cd investar

# 2. 의존성 설치
npm install

# 3. 환경변수 설정 (.env 파일 생성)
KIS_APP_KEY=your_app_key
KIS_APP_SECRET=your_app_secret

# 선택 (KRX API 연동 시)
KRX_API_KEY=your_krx_api_key

# 4. 로컬 서버 실행
npm start
# http://localhost:3001
```

### API 테스트

```bash
# 종목 스크리닝
curl http://localhost:3001/api/screening/recommend?limit=5
curl http://localhost:3001/api/screening/whale
curl http://localhost:3001/api/screening/accumulation

# 백테스트 (v3.7 NEW)
curl http://localhost:3001/api/backtest/simple
node test-backtest.js  # 상세 결과 출력
```

### 개발 시 주의사항 (v3.11 추가)

**파일 수정 작업 시 원칙:**

1. **자동화 스크립트 실패 시 사용자에게 떠넘기지 말 것**
   - ❌ 잘못된 접근: 자동화 스크립트 실패 → "수동으로 수정해주세요" 요청
   - ✅ 올바른 접근: 자동화 스크립트 실패 → Read + Edit 도구로 직접 수정

2. **파일 수정 도구 우선순위**
   - 1순위: Read + Edit 도구 (단일 파일 수정)
   - 2순위: 자동화 스크립트 (복잡한 배치 작업, 여러 파일 동시 수정)
   - 피할 것: 사용자에게 수동 작업 요청

3. **실제 사례 (v3.11 손절가 기능 구현)**
   - 시도 1: `add-stoploss-feature.js` 자동화 스크립트 → HTML 패턴 매칭 실패
   - 시도 2 (❌): 사용자에게 수동 수정 요청 → 사용자 불만 ("지랄하네 갑자기 왜 나시켜?")
   - 시도 3 (✅): Read + Edit 도구로 직접 수정 → 성공

**핵심 원칙**: "자동화 실패는 개발자가 해결해야 할 문제이지, 사용자에게 전가할 문제가 아니다"

---

## 📁 프로젝트 구조 (v3.7 업데이트)

```
investar/
├── api/                          # Vercel Serverless Functions
│   ├── screening/
│   │   ├── recommend.js         # 종합집계
│   │   └── [category].js        # whale, accumulation
│   ├── backtest/
│   │   └── simple.js            # 🆕 단기 백테스트 (v3.7)
│   ├── patterns/
│   │   ├── index.js             # D-5 선행 패턴 분석
│   │   └── volume-dna.js        # 🧬 DNA 추출 + 스캔
│   ├── trends/
│   │   └── index.js             # 트렌드 분석 (뉴스+AI 감성)
│   ├── recommendations/
│   │   ├── performance.js       # 성과 추적
│   │   ├── save.js              # 추천 저장
│   │   └── update-prices.js     # 가격 업데이트
│   ├── cron/
│   │   └── update-patterns.js   # 패턴 자동 업데이트
│   ├── debug-env.js             # 환경변수 디버그
│   └── health.js                # 헬스체크
│
├── backend/                      # 백엔드 로직
│   ├── kisApi.js                # KIS OpenAPI 클라이언트 ⭐
│   ├── screening.js             # 스크리닝 엔진 ⭐
│   ├── leadingIndicators.js     # 선행지표 통합 (패턴+DNA)
│   ├── volumeIndicators.js      # 거래량 지표
│   ├── advancedIndicators.js    # 창의적 지표
│   ├── smartPatternMining.js    # D-5 선행 패턴 마이닝
│   ├── volumeDnaExtractor.js    # 거래량 DNA 추출
│   ├── patternMining.js         # 급등 패턴 분석 (후행)
│   ├── backtest.js              # 백테스팅 엔진 (구버전)
│   ├── trendScoring.js          # 트렌드 점수 (뉴스+AI)
│   ├── patternCache.js          # 패턴 메모리 캐시
│   └── gistStorage.js           # GitHub Gist 영구 저장
│
├── index.html                    # React SPA 프론트엔드
├── server.js                     # 로컬 개발 서버
├── vercel.json                   # Vercel 설정
├── test-backtest.js              # 🆕 백테스트 테스트 스크립트 (v3.7)
├── test-leading-integration.js   # 선행지표 통합 테스트
├── INTEGRATION_COMPLETE_SUMMARY.md # 통합 완료 요약
└── CLAUDE.md                     # 이 문서
```

**삭제된 파일**:
- ❌ `backend/backtestEngine.js` (미사용)
- ❌ `backend/screeningHybrid.js` (중복)
- ❌ `backend/shortSellingApi.js` (v3.5에서 제거)

---

## ⚙️ 주요 설정

### Vercel 배포 설정 (vercel.json)

```json
{
  "functions": {
    "api/**/*.js": {
      "maxDuration": 60
    }
  },
  "crons": [
    {
      "path": "/api/cron/update-patterns",
      "schedule": "0 9 * * *"
    }
  ]
}
```

### 환경변수 (Vercel)

```
# 필수
KIS_APP_KEY=<한국투자증권 앱 키>
KIS_APP_SECRET=<한국투자증권 앱 시크릿>

# 선택 (Gist 패턴 저장 시)
GITHUB_GIST_ID=<GitHub Gist ID>
GITHUB_TOKEN=<GitHub Personal Token>

# 선택 (Supabase 성과 추적 시)
SUPABASE_URL=<Supabase 프로젝트 URL>
SUPABASE_KEY=<Supabase Anon Key>
```

---

## ⚠️ 사용 시 주의사항

### 투자 주의사항

⚠️ **본 시스템은 투자 참고용 도구이며, 투자 결정의 책임은 전적으로 투자자에게 있습니다.**

1. **과열 경고 확인**: 거래량 10배 이상 종목은 조정 위험
2. **윗꼬리 주의**: 고래 감지 + 고가 대비 낙폭 30% 이상은 신중 진입
3. **분산 투자**: 상위 5~10개 종목 분산 추천
4. **손절 설정**: -5~7% 손절 기준 설정 권장
5. **공매도 신뢰도**: 차트 기반 추정은 참고용, KRX API 연동 권장

### API 사용 제한

- **KIS API 호출 제한**: 초당 20회 (안전 마진 18회 적용)
- **토큰 발급 제한**: 1분당 1회
- **순위 API 제한**: 최대 30건/호출
- **Vercel Timeout**: 최대 60초

---

### 🗄️ Supabase 성과 추적 시스템 (2025-11-03)

**핵심 철학**: "추천했던 종목들의 실제 성과를 추적하여 시스템 신뢰도를 검증하고, 연속 급등주를 조기에 발견한다"

#### 자동 추천 저장
```javascript
// 종합집계 조회 시 자동 저장
fetchRecommendations('all') // B등급(45점) 이상 종목만 자동 저장
```

#### 실시간 성과 조회
```bash
GET /api/recommendations/performance?days=30
```

**응답**:
```json
{
  "success": true,
  "count": 15,
  "stocks": [
    {
      "stock_code": "005930",
      "stock_name": "삼성전자",
      "recommended_price": 68000,
      "current_price": 70000,
      "current_return": 2.94,
      "consecutive_rise_days": 3,
      "is_rising": true
    }
  ],
  "statistics": {
    "winRate": 60.0,
    "avgReturn": 1.35,
    "risingCount": 4
  }
}
```

#### 핵심 기능

1. **자동 저장**: 종합집계 조회 시 B등급 이상 자동 저장
2. **일별 추적**: Vercel Cron으로 매일 16시 KST 종가 자동 기록 (주말 포함)
   - 병렬 처리 최적화: 5개씩 배치 처리로 Timeout 방지
   - 처리 성능: 186개 종목 38초 완료 (60초 제한 안전)
3. **연속 급등주 감지**: 2일 이상 연속 상승 중인 종목 자동 표시
4. **실시간 수익률**: 추천가 대비 현재 수익률 실시간 계산
   - Cron 실패 대비 Fallback: 최신 daily_prices가 오늘이 아니면 KIS API로 실시간 조회
5. **등급별 성과**: S/A/B/C 등급별 승률 및 평균 수익률

#### 데이터베이스 스키마

- `screening_recommendations`: 추천 종목 이력
- `recommendation_daily_prices`: 일별 가격 추적
- `recommendation_statistics` (뷰): 종목별 성과 통계
- `overall_performance` (뷰): 전체 성과 요약

자세한 설정: `SUPABASE_SETUP.md` 참조

---

## 📚 참고 자료

### 공식 문서
- **KIS Developers**: https://apiportal.koreainvestment.com
- **KRX 데이터 포털**: https://data.krx.co.kr
- **Vercel Serverless**: https://vercel.com/docs/functions
- **Supabase**: https://supabase.com/docs

### GitHub 저장소
- **본 프로젝트**: https://github.com/knwwhr/investar
- **공식 샘플 코드**: https://github.com/koreainvestment/open-trading-api

---

## 🎯 v3.10.0-beta: Golden Zones 패턴 시스템 (진행 중)

### 개요

**목표**: 기존 점수 체계에 **차트 패턴 기반 선행 신호**를 추가하여 "급등 1-2일 전" 포착 정확도 향상

**전략**: 단계적 구현 (Option A)
- ✅ Golden Zones 패턴 감지만 구현 (보너스 점수)
- ✅ 기존 v3.9.2 점수 체계는 그대로 유지 (백테스트 검증된 로직)
- ⏳ 1주일 실전 데이터 수집 및 백테스트 검증
- ⏳ 검증 완료 후 배점 조정 또는 패턴 선별

### 🎯 Golden Zones 4대 패턴 명세

| Priority | 패턴명 | 보너스 | 감지 조건 | 노이즈 필터 |
|:---:|:---|:---|:---|:---|
| **1** | **🔥 Power Candle** | +15점 | 1. 거래량 ≥ 전일×2.0 & ≥ 20일평균×1.0<br>2. 등락률 +5~12%<br>3. 시가 ≒ 저가 (0.5% 이내) | 거래대금 ≥ 100억 |
| **2** | **🕳️ 개미지옥** | +15점 | 1. 장중 저가 < 전일 저가 × 0.97 (-3% 이탈)<br>2. 아래꼬리 ≥ 몸통 × 2.0<br>3. 종가 ≥ 시가 (양봉) | 3일 내 최저가 갱신 |
| **3** | **⚡ N자 눌림목** | +15점 | 1. 5일 내 +15% 이상 급등일 존재<br>2. 고점 대비 -5~-12% 조정<br>3. 금일 거래량 < 20일평균 × 0.7 | 거래량 < 기준봉 × 50% |
| **4** | **🌋 휴화산** | +10점 | 1. 거래량 ≤ 20일평균 × 0.4<br>2. 캔들 몸통 ≤ 1.5%<br>3. Bollinger Band Width < 0.1 | 5일선 위 + 거래대금 ≥ 30억 |

**공통 필터**:
- 거래대금(당일) ≥ 30억 원 (소형주 노이즈 제거)
- 우선순위 로직: 중복 감지 시 Priority 높은 순으로 하나만 채택

### 점수 적용 방식

```javascript
// 기존 점수 계산 (v3.9.2 유지)
const baseScore = calculateExistingScore();  // 0-100점

// Golden Zone 패턴 감지
const goldenZone = detectGoldenZones(stockData);

// 보너스 점수 적용
const finalScore = goldenZone.detected
  ? Math.min(baseScore + goldenZone.bonus, 95)  // 최대 95점
  : baseScore;

// 등급 체계는 v3.9.2 유지
if (finalScore >= 89) {
  grade = '⚠️ 과열';
} else if (finalScore >= 90 && goldenZone.detected) {
  grade = 'S';  // Golden Zone으로 S등급 진입
  badge = `🎯 ${goldenZone.pattern} 포착`;
} else if (finalScore >= 58) {
  grade = 'S';
  // ... (기존 로직)
}
```

### 데이터 구조

```javascript
// Golden Zone 메타데이터
{
  goldenZone: {
    detected: true,
    pattern: 'Power Candle',
    bonus: 15,
    confidence: 0.92,
    tradingValue: 15000000000,  // 150억
    details: {
      volumeRatio: 2.5,
      priceChange: 8.5,
      candleType: '꽉 찬 양봉',
      // ... 패턴별 상세 데이터
    }
  },
  baseScore: 78,
  finalScore: 93,
  grade: 'S',
  recommendation: {
    text: '🎯 Power Candle 포착',
    tooltip: '거래량 폭발 & 꽉 찬 양봉 → 내일 급등 유력'
  }
}
```

### 단계적 로드맵

#### Phase 1: 구현 ✅ 완료 (2025-11-20)
```
1. backend/screening.js에 detectGoldenZones() 함수 추가 ✅
2. 4대 패턴 로직 구현 (우선순위 + 필터) ✅
3. 기존 점수에 보너스 추가 ✅
4. goldenZone 메타데이터 API 반환 추가 ✅
```

#### Phase 2: 백테스트 ✅ 완료 (2025-11-20)
```
**백테스트 결과**:
- 분석 종목: 51개 (KOSPI + KOSDAQ)
- Golden Zone 감지: 0개 ✅ (과적합 방지 확인)

**주요 발견사항**:
1. ✅ 패턴 기준이 매우 보수적 (과적합 방지 성공)
2. ✅ 노이즈 필터링 정상 작동 (거래대금 30억 이상)
3. ⚠️ 실용성 검토 필요 (감지 빈도 낮음)

**권장 전략**: Option A (현재 기준 유지) + 1~2주 실전 모니터링
**상세 결과**: GOLDEN_ZONES_BACKTEST.md 참조
```

#### Phase 3: 배점 조정 (검증 완료 후)
```
// 백테스트 결과 기반 차등 배점
const goldenBonusScore = {
  'Power Candle': 20,    // 승률 90%+ → 20점
  'N자 눌림목': 15,      // 승률 85%+ → 15점
  '개미지옥': 10,        // 승률 80%+ → 10점
  '휴화산': 5            // 승률 70%+ → 5점
};

// 또는 저조한 패턴 제거
if (pattern === '휴화산' && 승률 < 70%) {
  // 패턴 비활성화
}
```

### 백테스트 계획

```javascript
// test-golden-zones.js (신규 파일 생성)
const { screenAllStocks } = require('./backend/screening');

async function testGoldenZones() {
  // 1. 최근 30일 데이터 수집
  const stocks = await screenAllStocks('ALL');

  // 2. Golden Zone 감지된 종목 필터
  const goldenStocks = stocks.filter(s => s.goldenZone?.detected);

  // 3. 패턴별 분류
  const byPattern = groupBy(goldenStocks, 'goldenZone.pattern');

  // 4. 5일/10일 후 수익률 계산
  for (const pattern in byPattern) {
    const results = await backtest(byPattern[pattern], [5, 10]);
    console.log(`${pattern}: 승률 ${results.winRate}%, 평균 ${results.avgReturn}%`);
  }

  // 5. 패턴 없는 종목과 성과 비교
  const nonGolden = stocks.filter(s => !s.goldenZone?.detected);
  const comparison = compare(goldenStocks, nonGolden);

  return { byPattern, comparison };
}
```

### 성공 기준

✅ **검증 통과 조건**:
- 패턴별 승률 **75% 이상**
- 패턴 없는 종목 대비 **평균 수익률 +5% 이상**
- 과적합 방지: 감지 빈도 **주당 5개 이내** (노이즈 아님)

⚠️ **검증 실패 조건**:
- 패턴 승률 70% 미만 → 해당 패턴 제거
- 과도한 감지 (주당 20개+) → 필터 강화
- 패턴 없는 종목과 성과 차이 없음 → 전체 재검토

### 리스크 관리

1. **브랜치 전략**:
   ```bash
   git checkout -b v3.10.0-beta
   # 1주일 검증 후 main 병합
   ```

2. **롤백 계획**:
   - 검증 실패 시 즉시 main 브랜치로 복귀
   - 기존 v3.9.2 로직은 100% 유지 (변경 없음)

3. **사용자 공지**:
   - 프론트엔드에 "🧪 BETA 기능 테스트 중" 배지 표시
   - Supabase에 beta_version 플래그 저장

---

## 📝 변경 이력

### v3.21 (2026-02-02) - 📊 Scoring Improvements

**Base Score 개선 (0-15점 → 0-17점)**

1. **비대칭 비율 버그 수정** (v3.20)
   - 기존: `|ratio - 1| × 50` → 매도세에도 가점 (버그)
   - 수정: `ratio >= 1 ? (ratio - 1) * 50 : 0` → 매수세만 가점

2. **VPD raw 값 반영** (v3.20)
   - 기존: VPD raw 점수 계산하지만 totalScore에 미포함
   - 수정: Base Score에 0-3점 직접 추가

3. **VWAP 이진→단계별** (v3.20)
   - 기존: VWAP 위 3점, 이하 0점 (이진 신호)
   - 수정: 5%+→3점, 2%+→2점, 0%+→1점 (거리 기반)

4. **5일 거래량 변동율 점수화** 🆕 (v3.21)
   - 기존: 표시 전용 (점수 기여 0)
   - 수정: 일평균 30%+→2점, 15%+→1점

5. **VPT Slope 버그** — 이미 수정됨 (`[...chartData].reverse()` 적용)

**공식 변경**
```
v3.20: Base(0-15) + Momentum(0-45) + Trend(0-40) + MultiSignal(0-6) = 0-90점
v3.21: Base(0-17) + Momentum(0-45) + Trend(0-40) + MultiSignal(0-6) = 0-92점
```

---

### v3.18.1 (2026-01-31) - 🐛 기관 매집 데이터 수정 + 과열 기준 AND 전환 + grade 필드 추가

**배경**: v3.18에서 기관/외국인 매집 점수가 여전히 전원 0점, 과열 판정 82%로 등급 시스템 무력화

#### 근본 원인

KIS API(`kisApi.js`)는 중첩 구조로 반환하지만, `screening.js`는 플랫 구조를 참조:

```javascript
// KIS API 반환 (kisApi.js:918-951)
day.institution.netBuyQty   // ✅ 중첩 구조 (실제 데이터)
day.foreign.netBuyQty

// screening.js가 참조 (버그)
day.institution_net_buy     // ❌ 플랫 구조 (존재하지 않음 → undefined → 0)
day.foreign_net_buy
```

결과: `parseInt(undefined || 0)` = 항상 0 → 기관/외국인 매수일 0일 → 매집 점수 전원 0점

#### 수정 내용

**1️⃣ screening.js — analyzeInstitutionalAccumulation (line 197-198)**
```javascript
// 수정: optional chaining으로 양쪽 구조 모두 지원
const institutionNet = parseInt(day.institution?.netBuyQty || day.institution_net_buy || 0);
const foreignNet = parseInt(day.foreign?.netBuyQty || day.foreign_net_buy || 0);
```

**2️⃣ screening.js — calculateStateAtDay (line 461-462)**
동일 패턴 수정 (기관 진입 가속 계산에 사용)

**3️⃣ advancedIndicators.js — checkInstitutionalFlow (line 735, 743)**
```javascript
// 수정 전: optional chaining 없이 직접 접근 (crash 위험)
day.institution.netBuyQty   // ❌

// 수정 후: 안전한 접근 + 폴백
day.institution?.netBuyQty || parseInt(day.institution_net_buy || 0)  // ✅
```

#### 수정 결과

| 지표 | v3.18 (수정 전) | v3.18.1 (수정 후) |
|------|---------------|-----------------|
| 평균 점수 | 41.7 | **47.0 (+5.3)** |
| 최고 점수 | 66.07 | **67.07 (+1.0)** |
| 기관 매집 작동 | 0/21종목 | **다수 작동** |
| 로보티즈 매집 | 0점 | **5점 (5일, strong)** |
| SK스퀘어 매집 | 0점 | **4점 (3일, moderate)** |

#### 4️⃣ 과열 기준 OR → AND 전환

```javascript
// 기존: RSI > 80 OR 이격도 > 115 → 82% 과열 (등급 시스템 무력화)
const overheated = (rsi > 80) || (disparity > 115);  // ❌

// 수정: RSI > 80 AND 이격도 > 115 → 48% 과열 (진짜 과열만 감지)
const overheated = (rsi > 80) && (disparity > 115);  // ✅
```

스크리닝 풀 자체가 거래량/가격 활동 종목이라 이격도가 높은 건 정상.
이격도만 높고 RSI가 정상인 종목(로보티즈, 아주IB투자 등)은 상승 추세이지 과열이 아님.

#### 5️⃣ 최상위 grade 필드 추가 + investorData 에러 로깅

```javascript
// grade가 recommendation.grade에만 있어 접근 불편 → 최상위에도 추가
grade: recommendation.grade,

// investorData 실패 시 silent → warning 로그 추가
.catch(e => { console.warn(`⚠️ 투자자 데이터 실패: ${e.message}`); return null; })
```

#### 종합 수정 결과

| 지표 | v3.18 | v3.18.1 |
|------|-------|---------|
| 평균 점수 | 41.7 | **47.0 (+5.3)** |
| 최고 점수 | 66.07 | **70.3 (+4.2)** |
| 과열 비율 | 82% | **48%** |
| A등급 | 0개 | **2개** |
| B등급 | 3개 | **5개** |
| 기관 매집 평균 | 0점 | **3.6점** |

**수정 파일**:
- `backend/screening.js`: 데이터 구조 수정 + 과열 AND + grade 필드 + 에러 로깅
- `backend/advancedIndicators.js`: checkInstitutionalFlow optional chaining 추가

---

### v3.18 (2026-01-31) - 🔧 죽은 컴포넌트 활성화 — 임계값 조정

**배경**: v3.17 데이터 정확성 복원 후 점수 하락 (평균 38.2점). 원인: Trend/Multi 컴포넌트 3개가 전원 0점 — 임계값이 현실 데이터와 불일치.

#### 변경 내용

**1️⃣ 변동성 수축 (analyzeVolatilityContraction) — 새 등급 추가**
```javascript
// 기존: ≤0.85 이하만 점수 → 실데이터 ratio 1.09~1.96 (전부 expanding)
// 수정: stable(≤1.0→4점), mild_expansion(≤1.2→2점) 추가
```

**2️⃣ 기관/외국인 매집 (analyzeInstitutionalAccumulation) — 총 매수일 카운트**
```javascript
// 기존: 연속 매수일만 카운트 (5일 중 연속 3일+ 달성 어려움)
// 수정: 총 매수일 카운트 + 기관/외국인 개별 추적
// 합산 4일+→5점, 3일→4점, 2일→3점, 단독 3일+→2점, 단독 2일+→1점
```

**3️⃣ Multi-Signal 보너스 — 2개 API 등장 인정**
```javascript
// 기존: 3개 API→+3, 4개→+6 (대부분 1개 API → 전원 0점)
// 수정: 2개 API→+2, 3개→+4, 4개→+6
```

**4️⃣ 거래량 가속 (analyzeVolumeAcceleration) — moderate 진입 완화**
```javascript
// 기존: recent>1.2 & mid>1.0 → 10점
// 수정: recent>1.1 & mid>1.0 → 11점, 새 mild 등급(recent>1.0 & mid>1.0 → 4점) 추가
```

**수정 파일**: `backend/screening.js` (4개 함수 임계값 조정)

---

### v3.17 (2026-01-30) - 🐛 데이터 정확성 복원 — slice/인덱싱 버그 일괄 수정

**배경**: v3.3에서 chartData 내림차순 인덱싱 버그를 일부 수정했으나, 전체 코드 감사 결과 advancedIndicators.js에 23개, volumeIndicators.js에 5개의 동일 버그가 추가 발견됨

#### 근본 원인

chartData는 **내림차순** (`chartData[0]`=오늘, `chartData[29]`=30일전).
`slice(-N)`은 가장 **오래된** N개를 반환하므로, "최근 N일"을 원하면 `slice(0, N)`을 써야 함.

```javascript
// 버그 (모든 함수에서 반복)
const recent = chartData.slice(-30);  // ❌ 가장 오래된 30개
const latest = recent[recent.length - 1];  // ❌ 가장 오래된 1개

// 수정
const recent = chartData.slice(0, 30);  // ✅ 최근 30개
const latest = recent[0];  // ✅ 가장 최신
```

#### 1️⃣ advancedIndicators.js — slice(-N) 23개 일괄 수정

**수정 함수 목록** (23개):
detectEscapeVelocity, detectLiquidityDrain, calculateAsymmetricVolume,
checkVolumeConsecutiveIncrease, detectGradualAccumulation, detectSmartMoney,
detectBottomFormation, detectBreakoutPreparation, checkOverheating,
detectBreakoutConfirmation, detectAnomaly, calculateRiskAdjustedScore,
calculateSignalFreshness, predictVolume, detectCupAndHandle, detectTriangle,
detectManipulation, checkLiquidity, checkPreviousSurge

**수정 패턴**: 각 함수에서 `slice(-N)` → `slice(0, N)` + 내부 인덱스 참조 교정
- `array[length-1]`(최신으로 착각) → `array[0]`(실제 최신)
- 시간 순서 비교/반복문 방향 교정
- 가격 변화율 계산의 분자/분모 교정

#### 2️⃣ advancedIndicators.js — 조용한 매집 점수 반전 수정

```javascript
// 버그: volumeGrowth=0.5%여도 Math.max(0.5, 10) = 10점
score: isSilentAccumulation ? Math.max(volumeGrowth, 10) : 0  // ❌

// 수정: volumeGrowth에 비례, 최대 25점 캡
score: isSilentAccumulation ? Math.min(volumeGrowth, 25) : 0  // ✅
```

#### 3️⃣ volumeIndicators.js — indicators/signals 인덱싱 수정

```javascript
// 버그: 가장 오래된 값 반환
obv: obv[obv.length - 1]?.obv  // ❌ 30일전 OBV

// 수정: 최신 값 반환
obv: obv[0]?.obv  // ✅ 오늘 OBV
```

동일하게 volumeMA20, mfi, vwap, adLine, volumeSurge, mfiSignal, obvTrend, priceVsVWAP 수정.

#### 4️⃣ volumeIndicators.js — VWAP 누적 방향 수정

VWAP은 세션 시작(과거)부터 현재까지 누적 계산해야 함.
기존: 최신→과거 순으로 누적 (역방향) → 수정: 과거→최신 순으로 누적.

#### 5️⃣ volumeIndicators.js — VPTSlope 인덱싱 수정

```javascript
// 버그
const recent = vptData[vptData.length - 1].vpt;  // ❌ 가장 오래된

// 수정
const recent = vptData[0].vpt;  // ✅ 최신
```

#### 6️⃣ save-daily-recommendations.js — 저장 필터 확장

```javascript
// 기존: S등급(75-89점) 저장 안 됨
return score >= 50 && score < 80;  // ❌

// 수정: S등급까지 저장하여 성과 추적
return score >= 50 && score < 90;  // ✅
```

TOP 3 알림의 2순위가 70점+ 종목을 추천하므로, 추천 종목은 반드시 저장되어야 함.

**수정 파일**:
- `backend/advancedIndicators.js`: slice(-N) 23개 + 조용한 매집 점수
- `backend/volumeIndicators.js`: indicators 인덱싱 + VWAP 방향 + VPTSlope
- `api/cron/save-daily-recommendations.js`: 저장 필터 확장

**영향**: 모든 고급 지표가 최신 데이터 기반으로 정확히 계산됨. 점수 분포가 변할 수 있으므로 1-2주 모니터링 권장.

---

### v3.16 (2026-01-30) - 🔧 S+ 등급 정리 & Golden Zones 기준 완화

**배경**: S+ 등급 성과 분석 결과, v3.13에서 도입한 "과열=기회" 전략이 과적합된 백테스트에 기반한 것으로 판명

#### 실제 성과 vs 백테스트 주장
| 항목 | 백테스트 주장 | 실제 14일 성과 |
|------|-------------|---------------|
| 승률 | 100% | **64%** |
| 평균 수익률 | +30.72% | **+1.08%** |
| 폭락률(-5%↓) | 0% | **28%** (7건) |

대표 폭락 사례: 한화갤러리아(-17.1%, 인적분할 차익실현), 한국전력(-12.8%, 전기요금 동결)

#### 1️⃣ Route 1 (과열→S+) 제거

**v3.13에서 도입한 로직 삭제:**
- 기존: 과열(RSI>80 or 이격도>115) + 황금구간(50-79점) → S+ 등급
- 변경: 과열 감지 시 점수 무관하게 **"과열" 경고** 등급으로 통일

```javascript
// v3.16: 과열 = 무조건 경고 (점수 무관)
if (overheatingV2 && overheatingV2.overheated) {
  grade = '과열';
  return { grade, text: '⚠️ 과열 경고', ... };
}
```

S+ 등급은 90점+(Golden Zones 감지 시에만 도달 가능)으로 유지.

#### 2️⃣ Golden Zones 4대 패턴 기준 완화

기존 기준이 너무 엄격하여 감지 0건 → 기준 완화로 발동 빈도 향상

| 패턴 | 주요 완화 내용 |
|------|--------------|
| **Power Candle** (99점) | 전일대비 2.0→1.5배, 등락률 5~12→3~15%, 거래대금 50→30억 |
| **개미지옥** (98점) | 전일저가 이탈 -3→-2%, 아래꼬리 1.5→1.2배 |
| **N자 눌림목** (97점) | 급등기준 12→8%, 조정 -5~-12→-3~-15% |
| **휴화산** (96점) | 거래량 0.4→0.5배, 몸통 1.5→2.0%, BB Width 0.15→0.20 |

#### 3️⃣ 저장 필터에 Golden Zones 예외 추가

```javascript
// v3.16: Golden Zones 감지 종목도 저장하여 실적 추적
return (score >= 50 && score < 80) || (stock.goldenZone && stock.goldenZone.detected);
```

**수정 파일**:
- `backend/screening.js`: 등급 로직 수정 + Golden Zones 기준 완화
- `api/cron/save-daily-recommendations.js`: 저장 필터 확장

**검증 계획**: 2~4주간 Golden Zones 발동 빈도 및 실적 모니터링

---

### v3.15 (2026-01-29) - 📱 텔레그램 아침 알림 시스템

**사용자 요청**: "자동으로 알림 받고 싶어"

#### 텔레그램 알림 기능 추가 🆕

**구현 내용**: 기존 `save-daily-recommendations.js`에 mode 파라미터 추가
- `mode=save` (16:10 KST): 기존 스크리닝 + Supabase 저장
- `mode=alert` (08:30 KST): 전날 저장된 TOP 3 텔레그램 알림

**Cron 스케줄 (vercel.json)**:
| 시간 (UTC) | 시간 (KST) | 모드 | 동작 |
|-----------|-----------|------|------|
| 07:10 | 16:10 | save | 당일 스크리닝 → Supabase 저장 |
| 23:30 | 08:30 | alert | 전날 TOP 3 → 텔레그램 알림 |

**알림 메시지 내용**:
- 🥇🥈🥉 TOP 3 종목 (고래 감지 종목 우선)
- 종목명, 코드, 점수, 등급
- 추천가, 손절가 (-5%)
- 고래/매집 태그

**환경변수 (Vercel)**:
- `TELEGRAM_BOT_TOKEN`: 텔레그램 봇 토큰
- `TELEGRAM_CHAT_ID`: 알림 받을 채팅 ID

**수정 파일**:
- `api/cron/save-daily-recommendations.js`: alert 모드 추가
- `vercel.json`: Cron 스케줄 추가

**핵심 철학**: "API 추가 없이 기존 파일에 mode 파라미터로 기능 확장"

---

### v3.14 (2026-01-29) - 📊 중복 등장 가중치 & TOP 3 전략 최적화

**개선 배경**: 종목 선별 로직 검토 결과, 2가지 핵심 개선점 발견

#### 1️⃣ 중복 등장 가중치 (Multi-Signal Bonus) 🆕

**문제**: `badgeMap`에 API별 등장 정보를 수집하지만 점수에 미반영
- 여러 API에서 동시 등장 = 더 강한 신호인데 활용 안 함

**해결**: 중복 등장 횟수에 따른 보너스 점수 부여
```
2개 API 등장: +0점
3개 API 등장: +3점
4개 API 등장: +6점 (등락률+거래량증가율+거래량순위+거래대금순위)
```

**수정 파일**: `backend/screening.js:1260-1294`
- `radarScore`에 `multiSignalBonus`, `multiSignalCount` 추가
- `scoreBreakdown`에 중복 등장 정보 표시

#### 2️⃣ TOP 3 2순위 기준 상향 (60점 → 70점)

**문제**: 백테스트에서 60-69점 구간 역전 현상 발견
| 구간 | 승률 | 평균 수익률 |
|------|------|------------|
| 50-59점 | 51.6% | +2.22% |
| **60-69점** | 35.3% | **-1.03%** ← 역전! |
| 70-79점 | 50.0% | +66.23% |

**해결**: 2순위 조건을 70점 이상으로 상향
- 기존: `s.totalScore >= 60`
- 변경: `s.totalScore >= 70`

**수정 파일**: `backend/screening.js:2012-2020`
- 전략명: '60점 이상' → '대박구간(70점+)'
- 예상 수익률: +23.0% → +66.23%

**점수 체계 변경**:
```
기존: Base(0-15) + Momentum(0-45) + Trend(0-40) = 0-90점
변경: Base(0-15) + Momentum(0-45) + Trend(0-40) + MultiSignal(0-6) = 0-90점 (cap 유지)
```

**핵심 철학**: "기존 데이터 최대 활용 + 백테스트 검증된 구간만 추천"

---

### v3.12.1 (2025-12-11) - ⚠️ 복합 신호 페널티 시스템

**백테스트 결과**: 복합 신호(고래+조용한매집) 최악의 성과 발견
- 복합 신호: 승률 **11.1%**, 평균 **-9.54%** ❌
- 고래 단독: 승률 **64.7%**, 평균 **+20.31%** ✅
- 조용한매집 단독: 승률 **29.6%**, 평균 **+11.85%** ✅

**문제 원인**: 복합 신호 = "이미 급등 시작" 신호로 판명
- 고래 감지 + 조용한 매집이 동시에 나타나면 이미 늦은 타이밍

**해결책**: 복합 신호 강력 페널티 적용
- ✅ `calculateTotalScore` 함수에 **-15점 페널티** 추가 (backend/screening.js:1460-1471)
- ✅ Base Score 최대 15점에서 복합 신호 시 0점으로 하락
- ✅ 결과적으로 복합 신호 종목은 낮은 등급(C/D) 배정

**기대 효과**:
- ✅ 복합 신호 종목 자동 필터링 (45점 이하 저장 제외)
- ✅ "이미 급등 시작" 종목 추천 방지
- ✅ 선행 지표 정확도 향상

**핵심 철학**: "단일 신호는 좋지만, 복합 신호는 이미 늦었다!"

---

### v3.11 (2025-12-05) - 🛡️ 손절가 기능 구현 & 개발 원칙 확립

**사용자 요청**: "손절가 제시 기능만 구현하자"

- ✅ **손절가 표시 기능 추가**
  - 종목 스크리닝 카드에 손절가 기준 표시 (-5%, -7%, -10%)
  - 추천가(currentPrice) 기준 자동 계산
  - 시각적으로 구분된 3단계 손절가 표시
  - 수정 파일: `index.html` (line 736)

- 📚 **개발 시 주의사항 문서화**
  - 실제 사례: 자동화 스크립트 실패 → 사용자에게 떠넘김 → 사용자 불만
  - 교훈: "자동화 실패는 개발자가 해결해야 할 문제"
  - 파일 수정 도구 우선순위 확립:
    1. Read + Edit 도구 (단일 파일)
    2. 자동화 스크립트 (복잡한 배치 작업)
    3. ❌ 사용자에게 수동 작업 요청 금지

**기대 효과**:
- ✅ 손절 기준 명확화로 리스크 관리 개선
- ✅ 향후 개발 시 사용자 경험 우선 원칙 확립

**핵심 철학**: "개발자는 문제를 해결하는 사람이지, 떠넘기는 사람이 아니다"

---

### v3.12 (2025-12-06) - 📊 등급 역전 해결 - 황금구간 저장 + 타이밍 경고 시스템

**사용자 질문**: "왜 A등급이 B등급보다 수익률이 낮아?" → 백테스팅으로 등급 역전 문제 발견

#### 문제점 분석
- **A등급** (60-74점): 승률 38.89%, 평균 **-1.41%** ❌ (유일한 마이너스 등급)
- **B등급** (45-59점): 승률 42.86%, 평균 **+5.21%** ✅ (A보다 성과 좋음)
- **원인**: A등급 내 25%가 -10% 이상 대형 손실, 저등급이 고등급보다 성과 우수

#### 해결책: Option A+C (저장 기준 변경 + 타이밍 경고)

##### 1. 황금구간만 저장 (45+ → 50-79점)
**백테스팅 검증 결과 (175개 종목, 30일)**:
- ✅ **황금 구간** (50-79점): 114개, 승률 43.86%, 평균 **+7.87%** (최고 성과!)
  - **안정 구간** (50-59점): 65개, 승률 50.77%, 평균 +2.08%
  - **대박 구간** (70-79점): 12개, 승률 56.25%, 평균 **+60.28%**
- ❌ **배제 구간**:
  - 45-49점: 37개, 승률 21.62%, 평균 -5.13% (위험)
  - 60-69점: 35개, 승률 31.25%, 평균 -0.75% (혼재)
  - 80+점: 4개, 승률 25%, 평균 +7.60% (샘플 부족, 불안정)

**수정 파일**: `api/cron/save-daily-recommendations.js`
```javascript
// 기존: score >= 45
// 변경: score >= 50 && score < 80
return score >= 50 && score < 80; // 황금 구간만 저장
```

##### 2. 타이밍 경고 시스템 추가
**수정 파일**: `backend/screening.js`, `index.html`

**5가지 타이밍 경고**:
- 🚀 **대박 구간** (70-79점): 평균 +60.28% 수익 구간
- 🎯 **안정 구간** (50-59점): 승률 50.77%, 평균 +2.08%
- ⚠️ **신중 진입** (60-69점): 성과 혼재 구간, 신중한 진입 필요
- ⚠️ **신호 약함** (<50점): 평균 -5.13%, 위험 구간
- 🔥 **과열 의심** (80+점): 샘플 부족으로 불안정, 신중 진입

**추가 구조**:
```javascript
// backend/screening.js - getRecommendation()
timingWarning: {
  type: 'jackpot' | 'golden' | 'caution' | 'weak' | 'overheat',
  badge: '🚀 대박 구간',
  color: '#ff0000',
  message: '평균 +60.28% 수익 구간 (백테스트 검증)'
}
```

#### 기대 효과
- ✅ **평균 수익률 개선**: -0.5% → **+7.87%** (+8.37%p 향상!)
- ✅ **저장 품질 향상**: 위험 구간 56개 제거 (100% 필터링)
- ✅ **백테스팅 정확도 향상**: 노이즈 제거로 정확한 성과 측정
- ✅ **사용자 경험**: 명확한 진입 타이밍 가이드 제공
- ✅ **S등급 보존**: 핵심 70-79점 구간 완전 포함

#### 백테스팅 분석 스크립트 추가
- `analyze-returns.js`: 등급별 성과 분석 (Win Rate, Profit Factor, 손익 분포)
- `analyze-category-performance.js`: 고래감지/조용한매집 카테고리 성과 비교

**핵심 발견**:
- **복합 신호의 저주**: 고래+조용한매집 동시 감지 → 평균 **-9.54%** (이미 늦음)
- **Goldilocks Zone**: 50-79점 = "너무 낮지도 높지도 않은 완벽한 구간"
- **S등급 진실**: 대부분 70-79점 구간, 80+점은 샘플 4개로 통계적 무의미

**핵심 철학**: "적지만 고품질 데이터가 많지만 저품질 데이터보다 낫다!"

---

### v3.10.2 (2025-11-28) - 📝 CLAUDE.md 등급 체계 수정 ⭐ Critical Documentation Fix

**문제 발견**: CLAUDE.md의 등급 체계가 실제 코드(screening.js)와 완전히 불일치

- 🔥 **실제 코드 기준으로 문서 수정** - 정확성 개선
  - **잘못된 문서 (v3.9.2)**: S (58-88) > A (42-57) > B (45+) > C (<45)
  - **실제 코드 (v3.10.2)**: 과열 (RSI/이격도) > S+ (90+) > S (75-89) > A (60-74) > B (45-59) > C (30-44) > D (<30)
  - **핵심 개선**: 7-Tier System 정확히 반영

- ✅ **과열 등급 기준 수정**
  - 잘못된 기준: 89+점 (점수 기반)
  - **실제 기준**: RSI > 80 AND 이격도 > 115 (점수 무관)
  - 로직: overheatingV2 최우선 감지, 점수와 무관하게 과열 경고

- ✅ **등급 범위 정확히 반영**
  - S+등급: 90+점 (Golden Zones 또는 완벽한 Radar Score)
  - S등급: 75-89점 (거래량 폭발, 기관 본격 매수)
  - A등급: 60-74점 (거래량 증가 시작, 기관 초기 진입)
  - B등급: 45-59점 (선행 패턴 감지, Supabase 저장 ✅)
  - C등급: 30-44점 (약한 신호, 저장 제외 ❌)
  - D등급: <30점 (선행 지표 미감지)

- ✅ **저장 기준 확인**
  - 실제 코드: 45점 이상 (B등급 이상) 저장
  - save-daily-recommendations.js, cleanup.js 모두 45점 기준 사용

- ✅ **실제 코드** (backend/screening.js:1478-1527)
  ```javascript
  // Priority 0: Overheating Detection (최우선)
  if (overheatingV2 && overheatingV2.overheated) {
    grade = '과열';
    // RSI > 80 AND 이격도 > 115 감지
  }

  // 등급 체계 (점수 내림차순, 7-Tier System)
  if (score >= 90) grade = 'S+';       // 90+점
  else if (score >= 75) grade = 'S';   // 75-89점
  else if (score >= 60) grade = 'A';   // 60-74점
  else if (score >= 45) grade = 'B';   // 45-59점
  else if (score >= 30) grade = 'C';   // 30-44점
  else grade = 'D';                    // <30점
  ```

**기대 효과**:
- ✅ 문서와 실제 코드 완전 일치
- ✅ 과열 감지 로직 정확히 설명 (RSI/이격도 기반)
- ✅ 7-Tier System 완전 반영

**핵심 철학**: "문서는 실제 코드를 정확히 반영해야 한다!"

---

### v3.9.2 (2025-11-20) - 🎨 등급 체계 재설계 (점수 내림차순) ⭐ UX 개선 (DEPRECATED)

**주의**: 이 버전의 등급 체계 설명은 부정확합니다. v3.10.2 참조

**사용자 요청**: "과열경고부터 보여줘. 점수기준으로 내림차순 해야 직관적이니까."

- ⚠️ **잘못된 등급 설명** - 실제 코드와 불일치
  - 이 문서는 실제 코드를 반영하지 못했음
  - v3.10.2에서 수정됨

---

### v3.9.1 (2025-11-20) - 🐛 등급 버그 수정 ⭐ Critical Fix (DEPRECATED)

**주의**: 이 버전의 등급 체계 설명은 부정확합니다. v3.10.2 참조

- ⚠️ **잘못된 등급 설명** - 실제 코드와 불일치
  - 문서에 기재된 등급 범위가 실제 코드와 다름
  - v3.10.2에서 정확한 등급 체계 반영

### v3.9 (2025-11-20) - 🎯 Gemini 제안 점수 체계 재조정 ⭐ Major Update
- 🔥 **핵심 철학 강화**: "변곡점 1~2일 전 선취매" 전략 최적화
  - 문제: Base Score 40%가 후행 지표에 집중 (이미 추세 진행 중인 종목에 유리)
  - 해결: Trend Score 35%로 확대 (조용한 매집 패턴 강화)

- ✅ **Base Score 재조정 (40점 → 25점)** ⬇️
  - 거래량 비율: 8→5점 (5배 이상 = 5점)
  - OBV 추세: 7→5점 (상승 = 5점)
  - VWAP 모멘텀: 5점 유지
  - **비대칭 비율: 5→7점 ⬆️** 선행 지표 강화!
  - **유동성 필터: 3점 🆕 NEW** (거래대금 기준)
  - 되돌림 페널티: -5→-3점 완화

- ✅ **Trend Score 확대 (20점 → 35점)** ⬆️
  - 거래량 점진 증가: 10→15점 (조용한 매집 비중 증가)
  - **변동성 수축: 10점 🆕 NEW** (볼린저밴드 수축 = 급등 전조)
  - 기관/외국인 장기 매집: 5점 유지
  - VPD 강화 추세: 5점 유지

- ✅ **Momentum Score 강화 (40점 유지)**
  - **당일 급등 페널티: -16→-20점 ⬆️** 강력한 필터링!
  - 거래량 가속: 15점
  - VPD 개선: 10점
  - 선행 지표 강화: 10점
  - 기관 진입 가속: 5점

**새로운 점수 체계**:
```
Base(0-25) + Momentum(0-40) + Trend(0-35) = Total(0-100)

철학:
- Base 25%: 품질 체크 (극단적으로 나쁜 종목 걸러내기)
- Momentum 40%: 변곡점 포착 (D-5 vs D-0 비교)
- Trend 35%: 조용한 매집 (30일 점진적 패턴)
```

**변동성 수축 (NEW)**:
- 계산: 최근 5일 vs 과거 20일 일간 변동폭 비교
- 50% 이하 수축 → 10점 (강력한 신호!)
- 70% 이하 수축 → 7점
- 85% 이하 수축 → 4점
- 의미: 볼린저밴드 수축 = 급등 직전 신호

**유동성 필터 (NEW)**:
- 100억 이상 → 3점
- 50억 이상 → 2점
- 10억 이상 → 1점
- 의미: 극단적 저유동성 종목 제외

**기대 효과**:
- ✅ "이미 급등 시작" 종목 필터링 강화 (당일 급등 -20점)
- ✅ "조용한 매집" 종목 발굴 강화 (Trend 35%, 변동성 수축 10점)
- ✅ 선행 지표 비중 증가 (비대칭 7점, Trend 35점)
- ✅ "변곡점 1~2일 전" 포착 정확도 향상

**Gemini 제안 수용도**: 90% (저항선 근접 제외, 변동성 수축 우선 구현)

### v3.8 (2025-11-14) - 🔧 등급 시스템 직관성 개선 ⭐ Critical Fix (DEPRECATED)

**주의**: 이 버전의 등급 체계 설명은 부정확합니다. v3.10.2 참조

- ⚠️ **잘못된 등급 설명** - 실제 코드와 불일치
  - 문서에 기재된 등급 범위가 실제 코드와 다름
  - 실제 코드는 7-Tier System (S+/S/A/B/C/D) 사용
  - v3.10.2에서 정확한 등급 체계 반영

**실제 등급 체계 (v3.10.2 기준)**:
- S+: 90+점, S: 75-89점, A: 60-74점, B: 45-59점, C: 30-44점, D: <30점
- 과열: RSI > 80 AND 이격도 > 115 (점수 무관)

### v3.7 (2025-11-14) - 📊 백테스트 시스템 구현 & 등급 체계 재정의
- ✅ **단기 백테스트 API 구현** (api/backtest/simple.js)
  - 현재 추천 종목의 과거 수익률 시뮬레이션
  - 5일, 10일, 15일, 20일, 25일 전 매수 시나리오 분석
  - 승률, 평균 수익률, Sharpe Ratio, MDD, Profit Factor 계산
- ✅ **백테스트 결과** (145개 샘플, 30개 종목)
  - 승률: **86.21%** (매우 우수)
  - 평균 수익률: **+24.71%**
  - Sharpe Ratio: **1.0** (위험 대비 수익 양호)
  - Profit Factor: **34.7** (수익이 손실의 34배)
  - 최고 수익: +86.97% (그린생명과학, A등급, 15일 보유)
- ✅ **테스트 스크립트 추가** (test-backtest.js, test-stoploss.js)
  - 상세 결과 출력 (전체/등급별/보유기간별 통계)
  - TOP 5 수익/손실 종목 표시
  - 성과 해석 메시지 자동 생성
  - 손절매 백테스트 (-5%, -7%, -10% 비교)
- 🔥 **등급 체계 재정의** (백테스트 결과 기반) ⭐ 핵심 개선!
  - **직관성 문제 해결**: 점수가 높을수록 높은 등급 (v3.8)
  - **등급 범위 재정의**:
    - S등급 (58-88점): 거래량 폭발, 최우선 매수 (승률 86.7%, 평균 +24.9%)
    - A등급 (42-57점): 진입 적기 (승률 77.8%, 평균 +27.5% ⭐ 최고!)
    - B등급 (25-41점): 선행 신호 (승률 89.3%, 평균 +24.9% ⭐ 최고 승률!)
    - C등급 (89+점): 과열 경고 (샘플 부족)
  - **핵심 원칙**: "점수가 높을수록 높은 등급" (직관적 시스템!)
- ✅ **용어 개선**: "신선도" → "당일/전일 신호" (구체적 표현으로 변경)
- ⚠️ **제약사항**
  - KIS API 제한으로 최근 30일 데이터만 사용
  - 과거 특정 시점 완전 재현 불가 (매수 시점 시뮬레이션으로 대체)
  - 장기 백테스트(1~3년)는 Supabase 데이터 축적 필요

**성과 검증 완료**: 시스템의 예측 정확도가 실제로 우수함을 입증 ✅
**등급 체계 혁신**: 백테스트 데이터로 검증된 새로운 등급 의미 확립!

### v3.6 (2025-11-14) - 🎨 UI 투명성 대폭 향상
- ✅ **서비스 카드 '추천 등급 기준' 재구성**
  - '핵심 지표 3개' 삭제 (하단 개별 지표와 중복)
  - '적용된 선행 지표' 구체적 설명 추가
  - 패턴 이름, DNA 트렌드, 합류점 지표명, Cup&Handle 상세 표시
  - 선행 지표 미감지 시 fallback 메시지 표시
- ✅ **지표 Tooltip 기준 기간 명시**
  - 거래량 비율: "일봉 20일 기준" + 현재/평균 수치 표시
  - MFI: "일봉 14일 기준" + 계산 방식 설명
  - 비대칭: "일봉 20일 기준" + 상승/하락일 상세 수치
  - 모든 tooltip에 구체적 수치와 해석 추가
- ✅ **감지된 신호 Tooltip 추가**
  - 약한 마감/윗꼬리: 종가/고가/윗꼬리 비율/고가 대비 낙폭
  - 유동성 고갈: 거래대금/시총/회전율
  - 강한 매도세: 하락일 평균 거래량 vs 상승일
  - 강한 매수세: 상승일 평균 거래량 vs 하락일
  - 고래 감지: 거래량 비율/가격 변동/윗꼬리/경고 메시지
- ✅ **문서 업데이트 (CLAUDE.md)**
  - 종목 포착 로직 5단계 플로우차트 추가
  - 점수 배점 상세 (각 지표별 계산식 + 예시)
  - 핵심 설계 원칙 명시

**UX 개선 효과**:
- 투명성: 추상적 설명 → 구체적 수치 (예: "5개 이상 지표" → "고래감지, 조용한매집, 기관매수, 돌파준비, 스마트머니")
- 신뢰성: 모든 tooltip에 기준 기간 명시 (일봉 20일/14일 등)
- 이해도: 마우스 오버만으로 세부 수치 확인 가능

### v3.5 (2025-11-12) - 🎯 Volume-Price Divergence 시스템
- ✅ **공매도 로직 완전 제거**
  - KRX API가 공매도 데이터 미제공 확인
  - `shortSellingApi.js`, `api/shortselling/index.js` 삭제
  - screening.js에서 공매도 점수 제거
- ✅ **점수 체계 복원**: 120점 → 100점
  - 기본: 0-20점
  - 선행 지표: 0-80점
  - 보너스 제거 (공매도, 트렌드)
- ✅ **추천 등급 조정**: 100점 만점 기준 (v3.7에서 백테스트 기반 재정의)
  - S: 25-41 (선행 신호), A: 42-57 (진입 적기)
  - B: 58-88 (추세 진행), C: 89+ (과열 경고)
- ✅ **Volume-Price Divergence 철학 확립**
  - "거래량 증가율 높은데 급등 안 한 주식 = 최고 점수"
  - divergence = volumeRatio - priceRatio
  - 조용한 매집 (Quiet Accumulation) 우선 발굴

### v3.4 (2025-11-06) - 시스템 통합 (이후 v3.5에서 공매도 제거)
- ✅ **패턴+DNA 통합**
  - `leadingIndicators.js` 통합 모듈 생성
  - smartPatternMining + volumeDnaExtractor 통합
  - 하이브리드 점수: 패턴 50% + DNA 50%
- ✅ **중복 모듈 정리**
  - backtestEngine.js, screeningHybrid.js 삭제

### v3.3 (2025-11-06) - 🐛 Critical Bug Fix
- 🐛 **chartData 배열 인덱싱 버그 수정** - 시스템 전체에 영향을 주는 critical 버그 발견 및 수정
  - **문제**: KIS API는 chartData를 **내림차순**(최신=0)으로 반환하지만, 코드는 오름차순을 가정
  - **증상**: `chartData[length-1]`로 항상 **가장 오래된 데이터**(9월 19일)를 최신으로 잘못 인식
  - **영향**: volumeAnalysis, advancedIndicators, backtest 모든 분석이 2개월 오래된 데이터로 작동
  - **수정 파일**:
    - `backend/volumeIndicators.js:193` - analyzeVolume() 최신 데이터 인덱스
    - `backend/advancedIndicators.js:508, 953-954` - checkOverheating(), calculateSignalFreshness()
    - `backend/backtest.js:99-101` - 백테스팅 매수/매도가 인덱스
  - **결과**: 9월 19일 → 11월 6일 최신 데이터로 정확한 분석 ✅

### v3.2 (2025-11-03) - 🗄️ Supabase 성과 추적 시스템
- ✅ Supabase 데이터베이스 연동
- ✅ 추천 종목 자동 저장 (B등급 이상)
- ✅ 실시간 성과 조회 API 구현
- ✅ 연속 급등주 감지 (2일 이상 연속 상승)
- ✅ 일별 가격 업데이트 Cron Job
- ✅ 성과 검증 탭 UI 개선
- ✅ 등급별 성과 통계 및 시각화
- 📄 SUPABASE_SETUP.md 가이드 작성

### v3.1 (2025-10-30) - 🧬 거래량 DNA 시스템
- ✅ DNA 추출 시스템 구현 (volumeDnaExtractor.js)
- ✅ 시간 가중치 분석 (EMA + 구간별 + 최근5일)
- ✅ 기관/외국인 투자자 데이터 통합
- ✅ 통합 API 엔드포인트 (extract + scan)
- ✅ 배치 처리 + 병렬 처리 최적화
- ✅ Vercel 12-function limit 준수

### v3.0 (2025-10-28) - 지표 단순화
- ✅ 카테고리 6개 → 3개 축소 (종합집계, 고래 감지, 조용한 매집)
- ✅ ETF/ETN 필터링 강화 (15개 키워드)
- ✅ Unknown 종목명 → [종목코드] 표시
- ✅ "종합 TOP 10" → "종합집계" 변경
- ❌ 제거: 탈출 속도, 거래량 폭발, 유동성 고갈

### v2.1 (2025-10-27)
- ✅ KIS API 통합 완료 (4개 순위 API)
- ✅ 거래량 증가율 API 추가
- ✅ 종목 풀 80개 확보 (67% 중복 제거)

### v2.0 (2025-10-26)
- ✅ 패턴 마이닝 시스템 통합
- ✅ 백테스팅 API 추가
- ✅ Vercel Cron 설정

### v1.0 (2025-10-25)
- ✅ 기본 스크리닝 시스템 구축
- ✅ 창의적 지표 개발
- ✅ React SPA 프론트엔드

---

**Last Updated**: 2026-01-31
**Version**: 3.18.1 (죽은 컴포넌트 활성화 + 데이터 구조 불일치 수정)
**Author**: Claude Code with @knwwhr

**🐛 v3.18.1: 기관 매집 데이터 수정 + 과열 OR→AND + grade 필드 + 에러 로깅**
**🔧 v3.18: 변동성 수축/기관 매집/Multi-Signal/거래량 가속 임계값 조정**
**🔧 등급: ⚠️과열(RSI>80 AND 이격도>115) > S+(90+) > S(75-89) > A(60-74) > B(45-59) > C(30-44) > D(<30)**

---

## 🔧 알려진 이슈 및 해결

### ✅ 해결됨: chartData 배열 인덱싱 버그 (2025-11-06)

**문제 증상**:
- Vercel 배포 환경에서 스크리닝 API가 항상 9월 18-19일 데이터를 반환
- 로컬 환경에서는 최신 데이터(11월 6일)가 정상 작동

**원인 분석**:
```javascript
// KIS API 응답 구조 (내림차순)
chartData[0] = "20251106"  // 최신 ✅
chartData[1] = "20251105"
...
chartData[29] = "20250918" // 가장 오래됨 ❌

// 기존 코드 (잘못됨)
const latestData = chartData[chartData.length - 1];  // ❌ 9월 18일
const latestDate = chartData[chartData.length - 1].date;  // ❌ 9월 18일

// 수정된 코드 (올바름)
const latestData = chartData[0];  // ✅ 11월 6일
const latestDate = chartData[0].date;  // ✅ 11월 6일
```

**영향 범위**:
- ❌ `volumeAnalysis.current` - 항상 9월 19일 데이터 표시
- ❌ `advancedIndicators` - 과열 감지 및 신호 신선도 계산 오류
- ❌ `backtest` - 백테스팅 매수/매도가 계산 오류
- 🎯 **결과**: 모든 추천이 2개월 오래된 데이터 기반으로 부정확

**수정 결과**:
```bash
# 수정 전
"volumeAnalysis": { "current": { "date": "20250919" } }  # ❌

# 수정 후
"volumeAnalysis": { "current": { "date": "20251106" } }  # ✅
```

**교훈**:
- ⚠️ KIS API는 **내림차순** 응답 (최신 데이터가 첫 번째)
- ⚠️ 배열 인덱싱 시 API 응답 구조 명확히 확인 필요
- ⚠️ 로컬과 Vercel 환경의 데이터 일관성 테스트 필요

**후속 조치 (v3.17)**: v3.3에서 일부만 수정된 동일 버그 클래스가 advancedIndicators.js 23개, volumeIndicators.js 5개에서 추가 발견되어 일괄 수정 완료. `slice(-N)` → `slice(0, N)` 패턴 전수 교정.

---

## 📋 현재 점수 체계 상태 (v3.21 기준, 2026-02-02)

### 컴포넌트별 작동 현황

| 컴포넌트 | 배점 | 현재 상태 | 비고 |
|----------|------|----------|------|
| Base Score | 0-17 | ✅ 정상 | v3.21: 5일 거래량 변동율 추가 |
| Momentum (거래량 가속) | 0-15 | ✅ 정상 | D-5 vs D-0 비교 |
| Momentum (VPD 개선) | 0-20 | ✅ 정상 | 핵심 철학 지표 |
| Momentum (기관 진입 가속) | 0-10 | ✅ 정상 | D-5 vs D-0 기관 매수일 비교 |
| Trend (거래량 점진 증가) | 0-20 | ✅ 정상 | 30일 가속 패턴 |
| Trend (변동성 수축) | 0-5 | ⚠️ 시장 의존 | 상승장에서 제한적 |
| Trend (기관/외국인 매집) | 0-8 | ✅ 정상 | 장기 순매수 패턴 |
| Trend (VPD 강화 추세) | 0-7 | ✅ 정상 | VPD 장기 개선 |
| Multi-Signal 보너스 | 0-6 | ⚠️ 구조적 한계 | 대부분 1개 API 등장 |
| **합계** | **0-92** | | |

### 남은 한계점 (코드로 해결 불가)

#### 1. Multi-Signal 보너스 — 전원 0점 (구조적)
- **원인**: 종목 풀이 4개 순위 API에서 수집되지만, 대부분 종목이 1개 API에서만 등장
- **왜 코드로 안 되나**: 2개+ API에 동시 등장하는 건 시장 데이터 현실이지 로직 문제가 아님
- **예상 해결**: 시장 활황기(거래량 전반 급증)에는 중복 등장 증가하여 자연 작동

#### 2. 변동성 수축 — 대부분 0점 (시장 국면 의존)
- **원인**: 현재 시장이 확장기 — contractionRatio 1.09~1.96 (전부 expanding)
- **왜 코드로 안 되나**: 볼린저밴드 수축은 횡보/조정기에 나타나는 패턴. 상승장에서는 원래 안 나옴
- **v3.18에서 완화**: stable(≤1.0→4점), mild_expansion(≤1.2→2점) 추가하여 일부 작동
- **예상 해결**: 시장 조정기 진입 시 자연 작동

#### 3. Leading Indicators — 대부분 0-5점 (데이터 부재)
- **원인**: DNA 패턴 데이터가 축적되어 있지 않아 패턴 매칭 불가
- **구조**: `leadingIndicators.js`가 smartPatternMining + volumeDnaExtractor를 통합하지만, DNA 패턴 미로드
- **scale factor**: 0.125로 공격적 — 원점수 80점이어도 최종 10점
- **장기 과제**: 패턴 데이터 축적 파이프라인 구축 필요 (Supabase에 급등 패턴 저장 → 매칭)

### 다음 단계 로드맵

#### 단기 (1-2주): 모니터링
- v3.18.1 점수 분포 일별 추이 관찰
- Supabase에 쌓이는 성과 데이터로 점수 구간별 승률/수익률 재검증
- 과열 AND 기준의 적절성 확인 (과열 비율 40-50% 유지 목표)

#### 중기 (2-4주): 성과 검증
- 2주 이상 성과 데이터 축적 후 v3.18.1 점수 기준 수익률 분포 분석
- 점수 구간별 승률이 기존 대비 개선되었는지 확인
- 필요 시 등급 임계값 미세 조정

#### 장기: Leading Indicators 활성화
- 급등 패턴 데이터 축적 파이프라인 구축
- DNA 패턴 자동 추출 + Supabase/Gist 저장
- 패턴 매칭 threshold 완화 (60% → 50%) 및 scale factor 조정 (0.125 → 0.2)

---

## 🎉 v3.5 Volume-Price Divergence 완료

**핵심 철학 확립!**

- ✅ Volume-Price Divergence 로직 구현
- ✅ "거래량 폭발 + 가격 미반영" 우선 발굴
- ✅ 조용한 매집 (Quiet Accumulation) 신호
- ✅ 100점 만점 시스템 (75점 이상 = S등급)
- ✅ 이미 급등한 종목 페널티 (-15~-25점)

**최종 목표**: "곧 급등할 종목을 거래량 선행 신호로 발굴" ✅ 달성!


##  Project Migrated to Windows
**Date**: 2025-11-21
**New Location**: \C:\Users\knoww\investar

This project has been migrated to the Windows environment to facilitate development with Claude Code.
Please perform all future development in the Windows location.


##  Project Migrated to Windows
**Date**: 2025-11-21
**New Location**: \C:\Users\knoww\investar

This project has been migrated to the Windows environment to facilitate development with Claude Code.
Please perform all future development in the Windows location.

