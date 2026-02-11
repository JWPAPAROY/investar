# Investar - AI 기반 주식 스크리닝 시스템

## 프로젝트 개요

**Investar**는 한국투자증권 OpenAPI를 활용한 거래량 기반 주식 종목 발굴 시스템입니다.

- **목적**: 거래량 지표로 급등 "예정" 종목 선행 발굴 (Volume-Price Divergence)
- **기술 스택**: Node.js, React (CDN), Vercel Serverless, KIS OpenAPI, Supabase
- **배포 URL**: https://investar-xi.vercel.app
- **버전**: 3.34
- **최종 업데이트**: 2026-02-11

**핵심 철학**: "거래량 폭발 + 가격 미반영 = 급등 예정 신호"

---

## 📁 프로젝트 구조

```
investar/
├── api/                          # Vercel Serverless Functions
│   ├── screening/
│   │   ├── recommend.js         # 종합집계 API
│   │   └── [category].js       # whale, accumulation
│   ├── patterns/
│   │   └── index.js             # 성공 패턴 분석 + 수집
│   ├── recommendations/
│   │   ├── performance.js       # 성과 추적 API
│   │   ├── save.js              # 추천 저장 API
│   │   └── update-prices.js     # 일별 가격 업데이트
│   ├── cron/
│   │   └── save-daily-recommendations.js  # 결산/알림/추적 + 텔레그램 웹훅
│   └── health.js
│
├── backend/                      # 백엔드 로직
│   ├── kisApi.js                # KIS OpenAPI 클라이언트
│   ├── screening.js             # 스크리닝 엔진 (점수 계산 핵심)
│   ├── leadingIndicators.js     # 선행지표 통합 (패턴+DNA)
│   ├── volumeIndicators.js      # 거래량 지표 (OBV, VWAP, MFI)
│   ├── advancedIndicators.js    # 고급 지표 (고래, 탈출속도, 비대칭)
│   ├── smartPatternMining.js    # D-5 선행 패턴 마이닝
│   ├── volumeDnaExtractor.js    # 거래량 DNA 추출
│   ├── supabaseClient.js        # Supabase 클라이언트
│   ├── patternCache.js          # 패턴 메모리 캐시
│   └── gistStorage.js           # GitHub Gist 영구 저장
│
├── index.html                    # React SPA 프론트엔드
├── tracking-dashboard.html       # 성과 추적 대시보드
├── server.js                     # 로컬 개발 서버
├── vercel.json                   # Vercel 설정 + Cron 스케줄
├── CLAUDE.md                     # 이 문서
├── SUPABASE_SETUP.md             # Supabase 설정 가이드
├── supabase-*.sql                # DB 스키마 (참고용)
└── .env.example                  # 환경변수 템플릿
```

---

## 🎯 종목 포착 로직 (Screening Pipeline)

### Phase 1: 종목 풀 확보

KIS OpenAPI에서 4가지 순위를 KOSPI + KOSDAQ 각각 조회하여 종목 풀을 구성한다.

```
등락률 상승 순위   50개 × 2시장 = 100개
거래량 증가율 순위 50개 × 2시장 = 100개
거래량 순위       50개 × 2시장 = 100개
거래대금 순위     50개 × 2시장 = 100개
────────────────────────────────────
합계: 400개 → ETF/ETN 필터링(15개 키워드) → 중복 제거 → 최종 ~80-90개
```

ETF 필터링 키워드: `ETF, KODEX, TIGER, KBSTAR, ARIRANG, ACE, plus, unicorn, POST, IPO, Active, 액티브, 국채, 선물, 통안증권, 하이일드, 리츠, REIT, 스팩, SPAC, 인버스, 레버리지`

### Phase 2: 종목별 데이터 수집

각 종목마다 3가지 KIS API 호출 (Rate Limit: 200ms 간격, 초당 18회):

| API | 반환 데이터 | 용도 |
|-----|-----------|------|
| `getCurrentPrice()` | 현재가, 거래량, 시가총액 | Base Score 시총 보정, 현재가 기준 |
| `getDailyChart(30)` | 최근 30일 OHLCV (내림차순, [0]=최신) | 모든 지표 계산의 기반 |
| `getInvestorData(5)` | 최근 5일 기관/외국인 순매수 | 기관 진입 가속 점수 |

**주의**: chartData는 **내림차순** 정렬. `chartData[0]` = 오늘, `chartData[29]` = 30일 전.
`slice(0, N)` = 최근 N개, `slice(-N)` = 가장 오래된 N개 (사용 금지).

### Phase 3: 지표 분석

4개 모듈에서 지표를 계산하여 Phase 4 점수 계산에 전달한다.

#### 3-1. 기본 거래량 지표 (`volumeIndicators.js`)

| 지표 | 계산 방식 | 용도 |
|------|----------|------|
| **거래량 비율** | 당일 거래량 / 20일 평균 거래량 | Base Score (0-8점) |
| **OBV** | 가격 상승일 +volume, 하락일 -volume 누적 | 추세 확인 (표시용) |
| **VWAP** | Σ(TP × Volume) / Σ(Volume), TP=(H+L+C)/3 | 가격 위치 판단 (표시용) |
| **MFI(14)** | 14일 Money Flow Index (0-100) | 과매수/과매도 판단 |
| **VPD** | volumeRatio - priceRatio (아래 상세) | Base Score (0-7점) |

**Volume-Price Divergence (VPD) 계산**:
```
volumeRatio = 당일 거래량 / 20일 평균 거래량
priceChange = ((현재가 - 20일 평균가) / 20일 평균가) × 100
priceRatio  = |현재가 - 평균가| / 평균가 + 1.0
divergence  = volumeRatio - priceRatio

의미: divergence > 0 → 거래량은 급증했는데 가격은 아직 안 오름 → 급등 예정 신호
```

VPD divergenceScore (volumeIndicators.js에서 계산, 참고용):

| 조건 | 점수 | 등급 |
|------|------|------|
| divergence ≥ 3.0 && 가격 ±10% && VPT↑ | 28-35 | Quiet Accumulation |
| divergence ≥ 2.0 && 가격 ±15% && VPT↑ | 20-27 | Early Stage |
| divergence ≥ 1.0 && VPT↑ | 12-19 | Moderate |
| divergence ≥ 0.5 && VPT↑ | 5-11 | Weak Signal |
| 가격 > 20% 급등 또는 VPT↓ | -15~-25 | Already Surged (페널티) |

#### 3-2. 고급 지표 (`advancedIndicators.js`)

**활성 지표 3개** (나머지 6개는 v3.24에서 제거, 더미 반환):

**고래 감지 (`detectWhale`)**

대량 거래량 + 큰 가격 변동이 동시 발생하면 고래(대형 투자자)의 진입/이탈로 판단.

| 항목 | 조건 |
|------|------|
| 거래량 | 시총 < 1조: 2.5배 이상 / 1-10조: 2.0배 이상 / 10조+: 1.5배 이상 (vs 20일 평균) |
| 가격 변동 | ±3% 이상 (절대값) |
| 매수고래(🐋) | close > open (양봉) |
| 매도고래(🐳) | close < open (음봉) |
| 윗꼬리 페널티 | 매수고래 && 윗꼬리 ≥ 30% → 강도(intensity) 50% 감소 |

**탈출 속도 (`detectEscapeVelocity`)**

저항선 돌파 + 강한 마감 + 대량 거래를 동시에 만족하면 강력한 상승 신호.

| 조건 | 임계값 |
|------|--------|
| 저항선 돌파 | 종가 > 과거 25일(최근 5일 제외) 중 최고가 |
| 거래량 급증 | 당일 거래량 ≥ 20일 평균 × 2.0 |
| 양봉 | close > open |
| 강한 마감 | closingStrength ≥ 70% ((close-low)/(high-low)×100) |
| 고가 유지 | highDecline < 10% ((high-close)/high×100) |
| 윗꼬리 과다 | highDecline ≥ 10% → 감점 신호 (-10점 SignalAdj) |

5개 조건 모두 충족 시 `detected: true` → +5점 SignalAdj.

**비대칭 거래량 (`calculateAsymmetricVolume`)**

최근 20일간 상승일 총 거래량 vs 하락일 총 거래량 비율.

```
ratio = 상승일 총 거래량 / 하락일 총 거래량
```

| ratio | 신호 |
|-------|------|
| > 1.5 | 강한 매수세 (고래 확인 조건에 사용) |
| < 0.7 | 강한 매도세 |
| 0.7-1.5 | 없음 (중립) |

#### 3-3. 선행 지표 (`smartPatternMining.js`, `volumeDnaExtractor.js`)

- **스마트 패턴 마이닝**: 과거 급등 직전의 거래량 패턴을 학습하여 현재 종목에서 유사 패턴 탐지
- **거래량 DNA**: 급등주의 거래량 변화 특성(EMA, 구간별 분석)을 추출 → 시장 스캔에서 매칭
- `screening.js`에서 `leadingIndicators` 모듈로 통합 호출

### Phase 4: 점수 계산 (`screening.js`)

```
총점(0-100) = Base(0-25) + Whale(0/15/30) + Momentum(0-30) + Trend(0-15) + SignalAdj
             → Math.min(100) cap, Math.max(0) floor
```

---

## 📊 점수 체계 상세 (Scoring System)

### 1. Base Score (0-25점) — `calculateTotalScore()`

종목의 기본 품질을 평가하는 점수. 5개 서브 컴포넌트의 합산.

#### 1-1. 거래량 비율 (0-8점)

| volumeRatio (당일/20일평균) | 점수 |
|---------------------------|------|
| 1.0 ≤ ratio < 2.0 | 8점 (황금구간: 적당히 증가) |
| 2.0 ≤ ratio < 3.0 | 5점 |
| 3.0 ≤ ratio < 5.0 | 2점 |
| ratio ≥ 5.0 또는 < 1.0 | 0점 (과도하거나 감소) |

#### 1-2. VPD raw (0-7점)

VPD(Volume-Price Divergence) = volumeRatio - priceRatio. 거래량은 폭발했는데 가격이 아직 안 오른 종목일수록 고득점.

| divergence | 점수 |
|-----------|------|
| ≥ 3.0 | 7점 |
| ≥ 2.0 | 5점 |
| ≥ 1.0 | 4점 |
| ≥ 0.5 | 2점 |
| > 0 | 1점 |
| ≤ 0 | 0점 |

#### 1-3. 시가총액 보정 (-5 ~ +7점)

대형주일수록 가산, 소형주에 페널티. 시총 단위: 억 원.

| 시총 | 점수 |
|------|------|
| ≥ 1조 (10,000억) | +7점 |
| ≥ 5,000억 | +5점 |
| ≥ 3,000억 | +2점 |
| 1,000~3,000억 | -2점 |
| < 1,000억 | -5점 |

#### 1-4. 고점 대비 되돌림 페널티 (-3 ~ 0점)

최근 30일 고가 대비 현재가 하락폭.

| drawdown | 점수 |
|----------|------|
| ≥ 20% | -3점 |
| ≥ 15% | -2점 |
| ≥ 10% | -1점 |
| < 10% | 0점 |

#### 1-5. 연속 상승일 보너스 (0-5점)

최근 5일 중 연속 상승(종가 기준) 일수.

| 연속 상승 | 점수 |
|----------|------|
| ≥ 4일 | +5점 |
| ≥ 3일 | +3점 |
| ≥ 2일 | +1점 |
| < 2일 | 0점 |

**Base Score = min(max(합산, 0), 25)**

---

### 2. Whale Score (0 / 15 / 30점) — 매수고래 감지 보너스

고래 감지(`advancedIndicators.detectWhale`)에서 **매수고래(🐋)**가 발견된 경우에만 가점.
매도고래(🐳)는 가점 없음 (별도 감점은 Signal Adjustments에서 처리).

| 조건 | 점수 |
|------|------|
| 매수고래 미감지 | 0점 |
| 매수고래 감지 + 확인 조건 미충족 | +15점 (미확인 고래) |
| 매수고래 감지 + 확인 조건 1개+ 충족 | +30점 (확인된 고래) |

**확인 조건** (하나 이상 충족 시 "확인됨"):
1. `escape.detected === true` — 탈출 속도 달성
2. `asymmetric.signal`에 '강한 매수세' 포함 — 비대칭 매수세 (ratio > 1.5)
3. `volumeAcceleration.trend`에 'acceleration' 포함 — 거래량 가속 패턴

---

### 3. Momentum Score (0-30점) — `calculate5DayMomentum()`

D-5일 vs D-0일(현재) 비교로 "지금 막 시작되는" 종목을 포착한다.
3개 서브 컴포넌트의 합산 후, **당일 급등 페널티** 적용.

#### 3-1. 거래량 가속도 (0-15점) — `analyzeVolumeAcceleration()`

30일 데이터를 4개 구간으로 나눠 점진적 거래량 증가 패턴을 감지.

```
구간: Recent(D-0~D-4) / Mid(D-5~D-9) / Old(D-10~D-19) / Oldest(D-20~D-29)
각 구간 평균 거래량 계산 후 비율 비교:
  recentVsMid = avgRecent / avgMid
  midVsOld    = avgMid / avgOld
  oldVsOldest = avgOld / avgOldest
```

| 조건 | 점수 | trend |
|------|------|-------|
| recentVsMid > 1.1 && midVsOld > 1.1 && oldVsOldest > 1.0 | 15점 | strong_acceleration |
| recentVsMid > 1.1 && midVsOld > 1.0 | 11점 | moderate_acceleration |
| recentVsMid > 1.1 | 7점 | weak_acceleration |
| recentVsMid > 1.0 && midVsOld > 1.0 | 4점 | mild_acceleration |
| 그 외 | 0점 | flat |

#### 3-2. 연속 상승일 보너스 (0-10점)

최근 5일 중 연속 상승일 수 (Base Score의 연속상승과 별도 계산).

| 연속 상승 | 점수 |
|----------|------|
| ≥ 4일 | 10점 |
| ≥ 3일 | 7점 |
| ≥ 2일 | 4점 |
| < 2일 | 0점 |

#### 3-3. 기관 진입 가속 (−2 ~ +5점) — `calcInstitutionalEntryScore()`

D-5일 시점과 D-0일(현재) 시점의 기관 순매수 일수를 비교.

| 조건 | 점수 | 의미 |
|------|------|------|
| D-5: 0일 → D-0: ≥ 3일 | +5 | 신규 진입 (최강) |
| D-5: 0일 → D-0: ≥ 1일 | +3 | 진입 시작 |
| D-0 > D-5 && D-0 ≥ 3일 | +4 | 가속 중 |
| D-0 > D-5 | +2 | 증가 |
| D-0 < D-5 | -2 | 감소 (페널티) |
| 그 외 | 0 | 변화 없음 |

#### 3-4. 당일 급등 페널티 — `calculateDailyRisePenalty()`

전일 대비 당일 급등 종목에 Momentum Score 감점 (이미 급등한 종목 필터링).

```
closeChange = ((오늘 종가 - 어제 종가) / 어제 종가) × 100
highChange  = ((오늘 고가 - 어제 종가) / 어제 종가) × 100
```

| 조건 | 페널티 |
|------|--------|
| highChange ≥ 15% | -30점 (상한가급) |
| closeChange ≥ 10% | -15점 |
| closeChange ≤ -10% | -15점 (급락) |
| 그 외 | 0점 |

페널티 적용: `momentumScore = max(0, momentumScore + penalty)`

---

### 4. Trend Score (0-15점) — `calculateTrendScore()`

30일 장기 추세에서 점진적 거래량 증가 패턴을 감지.
내부적으로 `analyzeVolumeAcceleration()`을 재사용하여 0-15점 범위로 캡.

(Momentum의 거래량 가속도와 동일 함수 사용, 별도 호출. Trend Score에서는 max 15점으로 cap)

---

### 5. Signal Adjustments — 최종 점수 가감

rawScore 합산 후 개별 신호에 따라 가감.

| 신호 | 점수 | 조건 | 근거 |
|------|------|------|------|
| 탈출 속도 달성 | +5 | `escape.detected === true` | 승률 100%, 평균 수익 +23.58% |
| 윗꼬리 과다 | -10 | `escape.signal`에 '윗꼬리 과다' 포함 | 승률 66.7%, 평균 수익 +0.83% |
| 매도고래 3일 내 | -10 | 매도고래(🐳) chartData 인덱스 ≤ 3 | 최근 대량 매도 압력 |

**최종 점수**: `Math.min(Math.max(totalScore, 0), 100)`

---

### 6. 등급 판정 — `getRecommendation()`

과열 판정이 최우선, 이후 점수 기준 등급 부여.

**과열 판정** (`detectOverheatingV2`):
```
RSI(14) > 80 AND 20일 이격도 > 115 → 과열 (점수 무관)
이격도 = (현재가 / 20일 이동평균) × 100
```

| 등급 | 점수 | 의미 |
|------|------|------|
| ⚠️ 과열 | RSI>80 AND 이격도>115 | 과열 경고 (점수 무관) |
| S+ | ≥ 90점 | 최상위 매수 |
| S | 75-89점 | 최우선 매수 |
| A | 60-74점 | 적극 매수 |
| B | 45-59점 | 매수 고려 |
| C | 30-44점 | 관망 |
| D | < 30점 | 비추천 |

---

### 7. TOP 3 선별 — `selectSaveTop3()`, `selectAlertTop3()`

텔레그램 알림에 포함할 상위 3개 종목 선별. 3단계 우선순위로 충원.

**공통 필터**: 매수고래(🐋) 존재 + 과열 등급 아님

| 우선순위 | 조건 | 근거 |
|---------|------|------|
| 1순위 | 매수고래 + 50-89점 (황금구간) | 승률 76.9%, 평균 +27.02% |
| 2순위 | 매수고래 + 70점+ | 평균 +66.23% (대박구간) |
| 3순위 | 매수고래 + 40점+ | 승률 64.7%, 평균 +20.31% |

각 우선순위에서 점수 내림차순으로 선별, 3개가 될 때까지 다음 순위로 충원.

---

### 점수 계산 예시

**예시 1: 확인된 고래 + 강한 모멘텀**
```
Base:     15점 (거래량 1.5배=8 + VPD 1.2=4 + 시총 5000억=5 + 되돌림5%=0 + 연속2일=1 → cap 25 → 15)
Whale:    30점 (매수고래 + 탈출속도 확인)
Momentum: 22점 (가속15 + 연속상승3일=7 + 기관새진입=3 → 25, 급등패널티 -3 → 22)
Trend:    8점  (moderate acceleration)
Signal:   +5점 (탈출속도)
────────────────────────────
총점: 15+30+22+8+5 = 80점 → S등급
```

**예시 2: 고래 없음 + 급등 종목**
```
Base:     12점 (거래량 4배=2 + VPD 0.3=1 + 시총 2000억=-2 + 되돌림3%=0 + 연속4일=5 → 6)
Whale:    0점  (고래 미감지)
Momentum: 0점  (가속7 + 연속4일=10 + 기관0=0 → 17, 급등패널티(종가+12%)=-15 → 2 → max(0,2)=2)
Trend:    4점  (mild acceleration)
Signal:   -10점 (윗꼬리 과다)
────────────────────────────
총점: 12+0+2+4-10 = 8점 → D등급
```

---

## 🛡️ 방어 전략 스코어링 (Defense Strategy)

**v3.34에서 추가.** 기존 모멘텀 전략과 병렬 운영되는 하락장/조정기 방어 전략.

**핵심 철학**: "충분히 빠진 + 기관이 사는 = 안전한 반등 종목" (기관 수급 의존)

```
DefenseTotal = Recovery(0-30) + SmartMoney(0-25) + Stability(0-25) + Safety(0-20) + SignalAdj
```

### 1. Recovery Score (0-30점) — 과매도 반등 신호

- **RSI 과매도 (0-12점)**: RSI 25-34 → 12점(반등 확률 최고), 35-44 → 9, 20-24 → 6, 45-49 → 4, <20 → 2, ≥50 → 0
- **MFI 회복 (0-10점)**: MFI 20-29 → 10, 30-39 → 7, 15-19 → 5, 40-49 → 3, else → 0
- **이격도 할인 (0-8점)**: 90-94 → 8(20일선 대비 5-10% 할인), 85-89 → 6, 95-97 → 5, 98-99 → 2, <85 → 1, ≥100 → 0

### 2. SmartMoney Score (0-25점) — 기관/외국인 수급

- **기관 연속매수일 (0-12점)**: ≥5일 → 12, 4 → 10, 3 → 7, 2 → 4, 1 → 1
- **외국인 연속매수일 (0-8점)**: ≥5일 → 8, 4 → 6, 3 → 4, 2 → 2
- **쌍방 수급 보너스 (0-5점)**: 기관≥3 AND 외국인≥3 → 5, 양쪽≥2 → 3, 한쪽≥3+다른쪽≥1 → 2

### 3. Stability Score (0-25점) — 바닥 안정성

- **거래량 안정성 (0-10점)**: volumeRatio 0.8-1.5 + CV<0.3 → 10, +CV 0.3-0.5 → 7, ratio 1.5-2.5+CV<0.5 → 5
- **변동성 수축 (0-8점)**: `analyzeVolatilityContraction()` — contractionRatio ≤0.4 → 8, ≤0.6 → 6, ≤0.8 → 4, ≤1.0 → 2
- **바닥 형성 (0-7점)**: `detectBottomFormation()` — 3조건 충족 → 7, 하락+거래량고갈 → 4, 하락+가격안정 → 3

### 4. Safety Score (0-20점) — 리스크 관리

- **시총 안전성 (0-10점)**: ≥10조 → 10, ≥5조 → 8, ≥3조 → 6, ≥1조 → 4, ≥5000억 → 2
- **위험조정 수익률 (0-5점)**: Sharpe < -1.0 → 5, -1.0~-0.5 → 3, -0.5~0 → 2, ≥0 → 0
- **낙폭 포지셔닝 (0-5점)**: Drawdown 15-25% → 5, 25-35% → 4, 10-15% → 3, >35% → 1

### 5. Signal Adjustments

| 신호 | 가감 | 조건 |
|------|------|------|
| 비대칭 매수세 | +5 | asymmetric.ratio > 1.5 |
| 폭락 진행 중 | -15 | crashCheck.isCrashing |
| 매도고래 3일 내 | -10 | 매도고래 idx ≤ 3 |
| 과열 상태 | 등급 무효화 | RSI>80 AND 이격도>115 |

### 방어 등급

| 등급 | 점수 | 의미 |
|------|------|------|
| D-S+ | ≥ 85 | 최상위 방어 기회 |
| D-S | 70-84 | 우수 방어 후보 |
| D-A | 55-69 | 양호 |
| D-B | 40-54 | 관심 |
| D-C | 25-39 | 약한 신호 |
| D-D | < 25 | 방어 무효 |

### 방어 TOP 3 선별 — `selectDefenseSaveTop3()`, `selectDefenseAlertTop3()`

**자격**: 기관≥3일 OR 외국인≥3일, 비폭락, 비과열, 시총≥5000억

| 우선순위 | 조건 |
|---------|------|
| 1순위 | 55-84점 + 쌍방수급(기관+외국인 ≥ 2일) |
| 2순위 | 55점+ |
| 3순위 | 40점+ |

**텔레그램 표시 조건**: KOSPI 또는 KOSDAQ **한쪽이라도 불안 이하**(불안/공포)일 때 방어 TOP 3 추가 표시

### 방어 손절 기준

| 시총 | 주의 | 손절 |
|------|------|------|
| ≥ 5조 | -4% | -6% |
| < 5조 | -3% | -5% |

---

## 📡 API 엔드포인트

### 스크리닝
```
GET /api/screening/recommend?market=ALL&limit=10   # 종합집계
GET /api/screening/whale?market=KOSPI&limit=5      # 고래 감지
GET /api/screening/accumulation?market=ALL&limit=5  # 조용한 매집
```

### 성과 추적
```
GET /api/recommendations/performance?days=30       # 성과 조회
POST /api/recommendations/save                     # 추천 저장
GET /api/recommendations/update-prices             # 가격 업데이트
```

### 패턴 분석
```
GET /api/patterns                    # 성공 패턴 분석 결과
GET /api/patterns?collect=true       # 수동 패턴 수집
```

---

## 📱 텔레그램 알림 시스템

### Cron 스케줄 (vercel.json)

| UTC | KST | 모드 | 동작 |
|-----|-----|------|------|
| 06:50 | 15:50 | save | 결산: 스크리닝 → Supabase 저장 + 텔레그램 |
| 07:05 | 16:05 | update-prices | 전체 종목 종가 업데이트 (장 마감 후) |
| 07:20 | 16:20 | patterns | 성공 패턴 수집 |
| 23:00 | 08:00 | alert | 실시간 스크리닝 TOP 3 알림 |
| 01:00 | 10:00 | track | 장중 주가 추적 |
| 02:30 | 11:30 | track | 장중 주가 추적 |
| 04:30 | 13:30 | track | 장중 주가 추적 |
| 06:00 | 15:00 | track | 장중 주가 추적 |

### 텔레그램 웹훅 수동 명령어

| 명령어 | 모드 | 설명 |
|--------|------|------|
| `/알림` `/alert` | alert | 실시간 스크리닝 TOP 3 |
| `/추적` `/track` | track | 현재 추적 종목 주가 |
| `/결산` `/save` | save | 오늘의 결산 (장중: 메시지만, 장후: DB 저장+메시지) |
| `/도움` `/help` | - | 명령어 안내 |

**장중 가드**: `/결산`을 장중(09:00-15:30 KST)에 실행하면 DB 저장 건너뛰고 메시지만 전송. 16:00 cron이 최종 결산 처리.

---

## 🗄️ Supabase 성과 추적

### 테이블 구조
- `screening_recommendations`: 추천 종목 이력 (20개+ 지표 포함)
- `recommendation_daily_prices`: 일별 가격 추적
- `success_patterns`: +10% 달성 종목 지표 특징
- `recommendation_statistics` (뷰): 종목별 성과 통계
- `overall_performance` (뷰): 전체 성과 요약

### 저장 기준
- B등급(50점) 이상 ~ S등급(89점) 이하 저장
- Golden Zones 감지 종목도 예외 저장

### 실시간 성과 조회
```
GET /api/recommendations/performance?days=30
```
- 추천가 대비 현재 수익률
- 등급별 승률/평균 수익률
- 연속 급등주 감지 (2일+ 연속 상승)

---

## ⚙️ 환경변수

```
# 필수
KIS_APP_KEY=<한국투자증권 앱 키>
KIS_APP_SECRET=<한국투자증권 앱 시크릿>

# Supabase
SUPABASE_URL=<Supabase 프로젝트 URL>
SUPABASE_ANON_KEY=<Supabase Anon Key>

# 텔레그램
TELEGRAM_BOT_TOKEN=<텔레그램 봇 토큰>
TELEGRAM_CHAT_ID=<알림 받을 채팅 ID>

# 선택 (Gist 패턴 저장)
GITHUB_GIST_ID=<GitHub Gist ID>
GITHUB_TOKEN=<GitHub Personal Token>
```

---

## 🛠️ 로컬 개발

```bash
npm install
npm start        # http://localhost:3001

# API 테스트
curl http://localhost:3001/api/screening/recommend?limit=5
curl http://localhost:3001/api/recommendations/performance?days=7
```

### 개발 원칙
- 파일 수정 시 Read + Edit 도구 우선 사용 (자동화 스크립트 실패 시 사용자에게 떠넘기지 말 것)
- KIS API chartData는 **내림차순** (chartData[0] = 최신, slice(0, N) = 최근 N개)
- Vercel 타임아웃 60초 제한 주의
- KIS API Rate Limit: 초당 20회 (200ms 간격)

---

## 📝 변경 이력

### v3.34 (2026-02-11)
- **방어 전략 병렬 운영**: 기존 모멘텀 전략과 별도로 하락장/조정기 대비 방어 전략 스코어링 추가
- `calculateDefenseScore()`, `getDefenseRecommendation()` — screening.js
- `detectBottomFormation()` 재활성화 — advancedIndicators.js
- `selectDefenseSaveTop3()`, `selectDefenseAlertTop3()`, `isMarketFear()` — save-daily-recommendations.js
- 텔레그램: KOSPI+KOSDAQ 모두 공포일 때만 방어 TOP 3 추가 표시
- Supabase: `defense_score`, `defense_grade` 컬럼 추가
- 프론트엔드: 종합집계 전략 필터(모멘텀/방어/전체), 성과 점검 방어 전략 성과 섹션
- TOP 3 성과 추적 기간 7일 → 3일 (텔레그램 싱크)

### v3.33 (2026-02-09)
- 시장 심리 가이드 모멘텀 전략으로 변경 (과열=적극 매수, 공포=손절/관망)
- `/결산` 속도 최적화: 기존 데이터 있으면 재스크리닝 없이 빠른 반환
- `save` 모드에서 `market` 필드 DB 저장 (KOSPI/KOSDAQ 태그 속도 개선)
- `kisApi.getCurrentPrice`에서 시장 구분 정보 반환 추가
- `formatTrackMessage` 이전 추천에 marketTag 추가
- `formatAlertMessage` r 변수 누락 버그 수정

### v3.30 (2026-02-06)
- 텔레그램 웹훅 핸들러 (`/알림`, `/추적`, `/결산`, `/도움`)
- `/결산` 장중 실행 시 DB 저장 건너뜀 (메시지만 전송 + 경고 표시)
- StockDetailModal null.toFixed() 크래시 수정
- Cron 순서 수정: save(16:00) → update-prices(16:15)
- performance.js 최적화: 배치 쿼리 + 병렬 API + 페이지네이션
- 성과 검증 탭 섹션 순서 변경

### v3.29 (2026-02-06)
- 성공 패턴 분석 v2: +10% 달성 종목 지표 특징 추출
- success_patterns 테이블 + 분석 뷰 4개
- screening_recommendations에 20개+ 지표 컬럼 추가

### v3.28 (2026-02-05)
- update-prices 실패 종목 최대 3회 자동 재시도

### v3.27 (2026-02-05)
- ALERT 모드 실시간 스크리닝 전환
- 성과 계산 종가 기준 통일 (시간외가 제외)
- 텔레그램 메시지 구조 개선 (SAVE/ALERT)

### v3.26 (2026-02-05)
- 매도고래 최근 3일 감점(-10점), 풀 확장(30→50개/API)
- 프론트엔드 시그널 기준표, 신호 발생 날짜 UI

### v3.25 (2026-02-04)
- 고래 확인 보너스: 확인됨 +30 / 미확인 +15 (A등급 역전 해소)

### v3.24 (2026-02-04)
- 매도고래 가점 제거, 0점 지표 6개 totalScore 제거
- 탈출 속도 +5점, 윗꼬리 과다 -10점 Signal Adjustments 도입

이전 버전 이력은 `git log`에서 확인 가능합니다.

---

**Platform**: Windows (C:\Users\knoww\investar)
**공식**: Base(0-25) + Whale(0/15/30) + Momentum(0-30) + Trend(0-15) + SignalAdj = Total(0-100)
