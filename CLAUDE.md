# Investar - AI 기반 주식 스크리닝 시스템

## 프로젝트 개요

**Investar**는 한국투자증권 OpenAPI를 활용한 거래량 기반 주식 종목 발굴 시스템입니다.

- **목적**: 거래량 지표로 급등 "예정" 종목 선행 발굴 (Volume-Price Divergence)
- **기술 스택**: Node.js, React (CDN), Vercel Serverless, KIS OpenAPI, Supabase
- **배포 URL**: https://investar-xi.vercel.app
- **버전**: 3.75
- **최종 업데이트**: 2026-03-26

**핵심 철학**: "거래량 폭발 + 가격 미반영 = 급등 예정 신호"

---

## 📁 프로젝트 구조

```
investar/
├── api/                          # Vercel Serverless Functions
│   ├── screening/
│   │   ├── recommend.js         # 종합집계 API
│   │   └── [category].js       # 카테고리별 스크리닝 (레거시)
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
├── api/koreainvestment/          # 한국투자증권 OpenAPI 공식 문서 (카테고리별)
│
├── backend/                      # 백엔드 로직
│   ├── kisApi.js                # KIS OpenAPI 클라이언트
│   ├── screening.js             # 스크리닝 엔진 (점수 계산 핵심)
│   ├── leadingIndicators.js     # 선행지표 통합 (패턴+DNA)
│   ├── volumeIndicators.js      # 거래량 지표 (OBV, VWAP, MFI)
│   ├── advancedIndicators.js    # 고급 지표 (고래, 탈출속도, 비대칭)
│   ├── smartPatternMining.js    # D-5 선행 패턴 마이닝
│   ├── volumeDnaExtractor.js    # 거래량 DNA 추출
│   ├── overnightPredictor.js     # 해외 지수 기반 시장 방향 예측
│   ├── momentumAnalyzer.js      # 장중 모멘텀 분석 (6차원 복합 시그널)
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

KIS OpenAPI에서 5가지 순위를 1회씩 조회하여 종목 풀을 구성한다.
(API는 시장 구분 파라미터와 무관하게 KOSPI+KOSDAQ 통합 30개를 반환, 시장 태깅은 종목코드 기반)

```
거래량 증가율 순위  30개  (핵심 VPD 신호, FID_BLNG_CLS_CODE=1)
거래량 순위        30개  (절대 거래량, FID_BLNG_CLS_CODE=0)
거래대금 순위      30개  (메가캡 보완, FID_BLNG_CLS_CODE=3)
거래회전율 순위    30개  (유통량 대비 거래 활발, FID_BLNG_CLS_CODE=2)
등락률 상승 순위   30개  (풀 다양성 확보, TR_ID=FHPST01700000)
────────────────────────────────────
합계: 150개 → ETF/ETN 필터링 → 중복 제거 → 최종 ~70-80개
```

**참고**: KIS 거래량순위 API(`FHPST01710000`)는 1회 호출 시 최대 30개만 반환하며, 페이지네이션 미지원. 5개 API × 1회 = 5호출로 풀 구성.

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
| 거래량 | 시총 < 1조: 2.0배 이상 / 1-10조: 1.5배 이상 / 10조+: 1.2배 이상 (vs 20일 평균) |
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
RSI(14) > 85 AND 20일 이격도 > 120 → 과열 (점수 무관)
이격도 = (현재가 / 20일 이동평균) × 100
```

| 등급 | 점수 | 의미 |
|------|------|------|
| ⚠️ 과열 | RSI>85 AND 이격도>120 | 과열 경고 (점수 무관) |
| S+ | ≥ 90점 | 최상위 매수 |
| S | 75-89점 | 최우선 매수 |
| A | 60-74점 | 적극 매수 |
| B | 45-59점 | 매수 고려 |
| C | 30-44점 | 관망 |
| D | < 30점 | 비추천 |

---

### 7. TOP 3 선별 — `selectSaveTop3()`, `selectAlertTop3()`

텔레그램 알림에 포함할 상위 3개 종목 선별.

**필터**: (매수고래(🐋) OR 기관≥3일 OR 외국인≥3일) + 과열 등급 아님 + `|등락률| < 25%` + `이격도 < 150`

**시총 단계적 확대** (v3.63): 시총 ≤ 1조 종목 우선 선별 → 3개 미달 시 시총 무제한으로 확대. 90일 성과 데이터 기반: 시총 1000-5000억 +10% 도달률 61.2% vs 1조+ 24.0%.

**스윗스팟 우선순위** (v3.38, 데이터 기반):

| 순위 | 점수 구간 | 근거 (고래 종목 실적) |
|------|----------|---------------------|
| 1순위 | 50-69점 | 승률 72%, 평균 +18.7%, 163개 |
| 2순위 | 80-89점 | 승률 78%, 평균 +21.1%, 9개 |
| 3순위 | 90+점 | 샘플 부족 |
| 4순위 | 70-79점 | 승률 47%, 중앙값 -0.4%, 최후 보충 |

각 시총 티어 내에서 스윗스팟 순서대로 선별. 1조 이하에서 3개 채워지면 끝, 부족하면 시총 무제한으로 확대.

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

## 📈 v2 스코어링 (데이터 기반, 병렬 비교 중)

**v3.37에서 추가.** 116개 종목/30일 실제 수익률 상관관계 분석 기반 재설계. v1과 병렬 계산되어 DB에 `total_score_v2`, `is_top3_v2`로 저장.

```
v2 Total(0-100) = Base(0-15) + Whale(0/15/30) + Supply(0-25) + Momentum(0-20) + Trend(0-10) + SignalAdj
```

### v2 설계 근거 (상관관계 데이터)

| 지표 | 수익률 상관계수 r | v1 배점 | v2 배점 | 변경 사유 |
|------|-----------------|---------|---------|----------|
| 기관+외국인 합산 | **+0.21** | 0-5 (기관진입가속만) | **0-25** (Supply) | 최강 알파, 쌍방수급 94.7% 승률 |
| 연속 상승일 | +0.12 | 0-15 (중복) | 0-12 | 양의 상관 유지, 중복 제거 |
| RSI 50-70 존 | +(zone) | 0 | 0-5 | 63.4% 승률 구간 |
| 거래량 비율 | -0.04 | 0-8 (전체) | 0-6 (스윗스팟) | 1.0-1.5x만 고수익 |
| 거래량 가속 | **-0.10** | 0-30 (중복) | 0-10 | 음의 상관, 대폭 축소 |

### v2 컴포넌트 상세

**Base(0-15)**: 거래량 스윗스팟(0-6, 1.0-1.5x최적) + VPD(0-5) + 시총(-3~+4)
**Supply(0-25)**: 기관매수일(0-10) + 외국인매수일(0-8) + 쌍방보너스(0-7)
**Momentum(0-20)**: 연속상승(0-12) + RSI존(0-5) + 기관진입가속(0-3) + 급등페널티
**Trend(0-10)**: 장기 거래량 가속도 (v1의 15점→10점 축소)
**Whale, SignalAdj**: v1과 동일

### v2 TOP3 선별

**필터**: (기관 ≥ 1일 OR 외국인 ≥ 1일 OR 매수고래) + 비과열
**정렬**: v2 총점 내림차순 → 상위 3개

---

## 🛡️ 방어 전략 스코어링 (Defense Strategy)

**v3.34에서 추가.** 기존 모멘텀 전략과 병렬 운영되는 하락장/조정기 방어 전략.

**핵심 철학**: "충분히 빠진 + 기관이 사는 = 안전한 반등 종목" (기관 수급 의존)

```
DefenseTotal = Recovery(0-30) + SmartMoney(0-25) + Stability(0-25) + Safety(0-20) + SignalAdj
```

### 1. Recovery Score (0-30점) — 과매도 반등 신호

- **RSI 과매도 (0-12점)**: RSI 25-34 → 12점(반등 확률 최고), 20-24 → 10, 35-44 → 9, <20 → 8, 45-49 → 4, ≥50 → 0
- **MFI 회복 (0-10점)**: MFI 20-29 → 10, 15-19 → 7, 30-39 → 7, <15 → 5, 40-49 → 3, else → 0
- **이격도 할인 (0-8점)**: 90-94 → 8(20일선 대비 5-10% 할인), 85-89 → 7, <85 → 6, 95-97 → 5, 98-99 → 2, ≥100 → 0

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
| 과열 상태 | 등급 무효화 | RSI>85 AND 이격도>120 |

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

**자격**: 기관≥2일 OR 외국인≥2일, 비폭락, 비과열, 시총≥5000억

| 우선순위 | 조건 |
|---------|------|
| 1순위 | 55-84점 + 쌍방수급(기관+외국인 ≥ 2일) |
| 2순위 | 55점+ |
| 3순위 | 40점+ |

**텔레그램 표시 조건**: KOSPI 또는 KOSDAQ **한쪽이라도 불안 이하**(불안/공포)일 때 또는 **해외 예측 score ≤ -0.5**일 때 방어 TOP 3 추가 표시

### 방어 손절 기준

| 시총 | 주의 | 손절 |
|------|------|------|
| ≥ 5조 | -4% | -6% |
| < 5조 | -3% | -5% |

---

## 🌏 해외 지수 기반 시장 방향 예측 (Overnight Predictor)

**v3.47에서 추가, v3.60에서 선물 로직 및 밴드 최적화.** 전날 미국장 마감 데이터 + 선물 데이터를 기반으로 가중 스코어를 계산하여 한국 시장 당일 방향을 예측한다.

### 모듈: `backend/overnightPredictor.js`

**데이터 소스**: Yahoo Finance chart API v8 직접 호출 (API 키 불필요, Vercel 서버리스 호환)

### 가중치 (DEFAULT_WEIGHTS) — 12개 팩터

다중공선성 제거 후 독립적 정보만 유지. KOSPI200F 야간선물이 가장 최신 데이터(~06:00 KST)를 반영하므로 최대 가중치 부여.

| 구분 | 티커 | 이름 | 가중치 | 비고 |
|------|------|------|--------|------|
| 선물 | KOSPI200F | 코스피200선물 | +0.20 | KIS API (정규/야간), 만기일 자동 롤오버 |
| 선물 | KOSDAQ150F| 코스닥150선물 | +0 | KIS API (정규/야간), 관측용 |
| 선물 | ES=F | S&P500 선물 | +0.10 | 장후 최신 |
| 선물 | NQ=F | 나스닥 선물 | +0.11 | 기술주 선행 |
| 선물 | HG=F | 구리 선물 | +0.07 | 경기 선행지표 |
| 선물 | GC=F | 금 선물 | +0.08 | |
| 현물 | ^SOX | SOX 반도체 | +0.18 | 삼성/하이닉스 연동 |
| 현물 | ^VIX | VIX 공포 | -0.10 | 역상관 |
| 현물 | USDKRW=X | 달러/원 | -0.04 | 원화 약세 = 하락 |
| 현물 | ^TNX | 미국10년물 | 0 | r≈0, 관측용 |
| 현물 | ^N225 | 닛케이 | 0 | 18h 시차, 관측용 |
| 현물 | EWY | 한국ETF | 0 | 관측용 (KOSPI200F와 중복) |
| 현물 | CL=F | WTI 원유 | -0.11 | |

**제거됨** (다중공선성): ^GSPC(ES=F r=0.96), ^IXIC(NQ=F r=0.99), ^DJI(^GSPC r=0.84), DX-Y.NYB(USDKRW=X r=0.56), ^KS200(한국장 시간대 지수)

**양의 가중치(+)**: 해당 지수 상승 → KOSPI↑ (동행)
**음의 가중치(-)**: 해당 지수 상승 → KOSPI↓ (역행). 예: VIX -10%는 VIX가 오르면 KOSPI가 내린다는 의미

### 스코어 계산 (z-score 정규화)

```
z-score(ticker)      = (변동률 - 60일평균) / 60일표준편차
기여도(contribution) = z-score × 가중치
스코어(score)        = Σ(모든 기여도)
```
- 10일 미만 데이터 시 raw 변동률 × 가중치로 fallback
- **z-score 정규화 및 아웃라이어 댐핑 (v3.60)**:
    - z-score 정규화로 변동성 큰 지표(VIX 등)의 과대 대표 문제 해결.
    - **아웃라이어 클램핑**: 개별 팩터의 z-score를 ±3.0σ 범위로 제한하여 특정 지표(예: 유가 폭등)가 전체 예측을 독점적으로 왜곡하는 현상 방지.
    - 변동성 데이터 미충분 시 raw 변동률 ±10% 클램핑.

| 스코어 | 신호 | 이모지 |
|--------|------|--------|
| ≥ +1.4 | strong_bullish | 🟢🟢 |
| +0.2 ~ +1.4 | mild_bullish | 🟢 |
| -0.8 ~ +0.2 | neutral | ⚪ |
| -2.0 ~ -0.8 | mild_bearish | 🔴 |
| < -2.0 | strong_bearish | 🔴🔴 |

임계점은 39건 스코어 분포(평균 -0.32, σ=1.70) 기반 σ 비례 설정 (2026-03-08)

**VIX 스파이크**: VIX 변동 ≥ +15% → 별도 경고

### 예측 KOSPI 범위 (OLS 회귀 기반)

EWMA 가중 OLS 회귀로 score→KOSPI 변동률 관계를 모델링:
```
effectiveScore = |score|>2 ? sign×(2+√(|score|-2)) : score  // 극단값 sqrt 감쇠
center         = clamp(slope × effectiveScore + intercept, ±5%)
// 밴드 폭 최적화 (v3.60): ±0.67σ (약 50% 확률 범위 / IQR 수준)
expectedChange = { min: max(center - 0.67×σ, -8%), max: min(center + 0.67×σ, 8%) }
estimatedKospi = previousKospi × (1 + expectedChange / 100)
```
- `DEFAULT_REGRESSION = { slope: 0.78, intercept: 0.77, sigma: 3.44 }`
- 20일+ 데이터부터 `getRegressionParams()`로 EWMA(λ=0.94) 가중 OLS 회귀 동적 보정
- 클램핑: slope [0.1, 2.0], intercept [-3, 3], sigma [1.5, 4.0]
- center ±5% 클램핑, 최종 변동률 ±8% 클램핑 (서킷브레이커 수준 초과 방지)

### 가중치·회귀·z-score 자동 보정

- 10일 미만: raw 변동률 사용, 20일 미만: `DEFAULT_WEIGHTS`/`DEFAULT_REGRESSION` 사용
- 10일 이상: `getFactorVolatility()` — 팩터별 60일 mean/std → z-score 정규화
- 30일 이상(가중치): 각 팩터와 KOSPI 개장 변동률의 피어슨 상관계수 → 부호 보존, 절대값 비례 → 합계 1.0 정규화 (v3.55: 60일→30일 완화)
- 20일 이상(회귀): score→KOSPI 종가 변동률 EWMA 가중 OLS 회귀 → slope/intercept/sigma 산출
- **야간선물 캐시 시스템 (v3.62, v3.64 수정)**:
    - 04:55 KST cron (`night-futures` 모드): 마켓코드 `CM`(야간선물) + 정규선물 코드(10100000/10600000)로 야간선물 종가 조회 → Supabase 캐시 저장. `CM`은 장 마감 후에도 야간선물 종가를 유지하므로 시간에 무관하게 조회 가능.
    - 08:00 KST alert 모드: `loadNightFutures()`로 캐시 우선 로드 → 유효 데이터 있으면 정규선물 대신 사용.
    - 캐시 무효: 날짜 불일치, failed, change=0 → 정규선물 fallback.
- **선물 롤오버 (v3.60)**:
    - 만기일 당일 00:00 KST부터 차근월물(6월/9월/12월/3월) 자동 조회.
    - 정규 선물 시세가 0이거나 stale할 경우 CME/Eurex 야간 선물 코드(A01/A06) 자동 추적.
- 팩터 수 변경 시 캐시 자동 무효화

### 팩터 신뢰도

- 데이터 수집 실패한 팩터를 `failed` 플래그로 추적
- `reliability` = 유효 팩터 수 / 활성 팩터 수 × 100%
- 프론트엔드: 100% 미만 시 경고 표시 (70% 미만 빨간, 이상 노란)
- 스크리닝 탭: 하락/강한하락 예측 시 상단에 경고 배너 표시

### 적중률 추적

- **save 모드 (16:10 KST)**: `updateActualResult()` 호출 → KOSPI/KOSDAQ 실제 변동률 + hit 판정
- **hit 기준**: 예측 방향(bullish→up, bearish→down, neutral→flat) 일치 여부
- `overnight_predictions` 테이블에 기록, 누적 적중률 조회

### 히스토리 차트

- `getRecentHistory(previousKospi)`: 최근 30일 예측 데이터 + KOSPI 절대 지수 역산
- KOSPI 절대 지수: 최신 전일 종가에서 역방향으로 변동률 적용하여 30일간 근사 종가 계산
- 각 날짜에 `expectedChange` (스코어 기반 예측 범위) 포함
- 프론트엔드: Canvas 기반 꺾은선 차트 (예측 스코어 파란 선 + KOSPI 실제 회색 선 + 적중/미적중 점)
- 툴팁: 예측 스코어, 예측 범위(%), 예측 KOSPI 지수, 실제 변동률, 실제 KOSPI 종가, 적중여부

### 캐시 무효화 조건

1. 캐시된 factors가 모두 0 (API 실패) → 재조회
2. 캐시된 factor 수 ≠ 현재 DEFAULT_WEIGHTS 수 (팩터 구성 변경) → 재조회

### 데이터 흐름

```
04:55 KST (night-futures 모드):
  saveNightFutures() → getKospi200FuturesPrice() / getKosdaq150FuturesPrice() → Supabase 캐시

08:00 KST (alert 모드):
  fetchAndPredict() → loadNightFutures(캐시) + Yahoo Finance × 11개
  → 가중 스코어 계산 → OLS 회귀 예측 범위 → Supabase 저장 → 텔레그램 전송

16:10 KST (save 모드):
  updateActualResult() → KOSPI/KOSDAQ 실제 변동률 기록 → hit 판정

프론트엔드 (prediction API):
  fetchAndPredict() (캐시) → prediction + history 반환 → 전망 카드 + 차트
```

---

## 📡 API 엔드포인트

### 스크리닝
```
GET /api/screening/recommend?market=ALL&limit=10   # 종합집계 (모멘텀+방어 통합 + prediction)
GET /api/screening/analyze?codes=005930,000660      # 종목 분석 (최대 15개, 단일 프로세스 순차 처리)
```
`recommend` 응답에 `prediction` 필드 포함 (해외 시장 기반 전망 + 히스토리 차트 데이터 + reliability + scoreMethod)

### 성과 추적
```
GET /api/recommendations/performance?days=30       # 성과 조회
GET /api/recommendations/performance?momentum=true # 장중 모멘텀 분석 (v3.71)
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
| 06:35 | 15:35 | save | 결산: 스크리닝 → Supabase 저장 + 텔레그램 |
| 07:05 | 16:05 | update-prices | 전체 종목 종가 업데이트 (장 마감 후) |
| 07:20 | 16:20 | post-market | 장후 통합 처리 (패턴 수집 → 기대수익 산출) |
| 19:55 | 04:55 | night-futures | 야간선물 종가 캐시 (야간장 마감 5분 전) |
| 23:00 | 08:00 | alert | 실시간 스크리닝 TOP 3 알림 + 해외 전망 |
| 01:00 | 10:00 | track | 장중 주가 추적 |
| 02:30 | 11:30 | track | 장중 주가 추적 |
| 04:30 | 13:30 | track | 장중 주가 추적 |
| 06:00 | 15:00 | track | 장중 주가 추적 |

### 추천 종목 매수 타이밍

`recommended_price` = 결산 시점의 종가. 동일 가격으로 매수 가능한 시간대:

| 시간대 (KST) | 매매 방식 | 매수 가격 | 비고 |
|-------------|----------|----------|------|
| 15:40~16:00 (당일) | 시간외 종가매매 | 당일 종가 = 추천가 | 결산 메시지 도착 ~15:35, 약 25분 여유 |
| 08:30~08:40 (익일) | 시간외 종가매매 | 전일 종가 = 추천가 | 08:00 ALERT 메시지 확인 후 매수 |
| 09:00~ (익일) | 정규장 매수 | 시가 (변동 가능) | 추천가와 다를 수 있음 |
| 16:00~18:00 (당일) | 시간외 단일가매매 | 종가 ±10% 변동 | 추천가와 다를 수 있음 |

**권장**: 당일 시간외 종가매매(15:40~16:00) 또는 익일 아침 시간외 종가매매(08:30~08:40)

### 텔레그램 웹훅 수동 명령어

| 명령어 | 모드 | 설명 |
|--------|------|------|
| `/알림` `/alert` | alert | 실시간 스크리닝 TOP 3 |
| `/추적` `/track` | track | 현재 추적 종목 주가 |
| `/결산` `/save` | save | 오늘의 결산 (장중: 메시지만, 장후: DB 저장+메시지) |
| `/도움` `/help` | - | 명령어 안내 |

**장중 가드**: `/결산`을 장중(09:00-15:30 KST)에 실행하면 DB 저장 건너뛰고 메시지만 전송. 15:40 cron이 최종 결산 처리.

---

## 🗄️ Supabase 성과 추적

### 테이블 구조
- `screening_recommendations`: 추천 종목 이력 (20개+ 지표 포함)
- `recommendation_daily_prices`: 일별 가격 추적 + 체크포인트별 거래량 (volume_t1~t4)
- `expected_return_stats`: 등급×고래별 기대수익 통계 (v3.46)
- `stock_expected_returns`: 종목별 유사 매칭 기대수익 (v3.66)
- `overnight_predictions`: 해외 지수 기반 시장 방향 예측 + 적중률 (v3.47)
- `sector_outlook_stats`: 업종별 해외전망 버킷별 승률/수익률 + 모멘텀 상관계수 (v3.69)
- `success_patterns`: +10% 달성 종목 지표 특징
- `recommendation_statistics` (뷰): 종목별 성과 통계
- `overall_performance` (뷰): 전체 성과 요약

### 저장 기준
- B등급(50점) 이상 전체 저장
- Golden Zones 감지 종목도 예외 저장

### 실시간 성과 조회
```
GET /api/recommendations/performance?days=30
```
- 추천가 대비 현재 수익률
- 등급별 승률/평균 수익률
- 연속 급등주 감지 (2일+ 연속 상승)

### 성공 패턴 분석 (`/api/patterns`)

**수집** (`POST`): `recommendation_daily_prices`에서 +10% 달성 종목을 탐색하여 `success_patterns` 테이블에 추천 시점 지표 특징 저장. 배치 쿼리로 최적화 (N+1 문제 해결).

**조회** (`GET`): 수집된 패턴 통계 분석 + 스코어링 임계값 튜닝 인사이트 생성.

인사이트 항목 (최대 18개):

| 카테고리 | 인사이트 | 분석 내용 |
|---------|---------|----------|
| 거래량 | 거래량 비율 | 성공 종목의 최적 거래량 배수 구간 |
| 거래량 | 비대칭 비율 | 매수세/매도세 비율과 성공 상관 |
| 거래량 | 거래량 가속도 | 가속 패턴 비율과 성공 상관 |
| 거래량 | VPD 원시값 | 거래량-가격 괴리 최적 구간 |
| 고래 | 고래 감지율 | 성공 종목 중 고래 감지 비율 |
| 고래 | 확인 vs 미확인 | +30점/+15점 차등의 실효성 검증 |
| 시세 | RSI | 과열 기준(85) 적정성 |
| 시세 | MFI | 강한유입 기준 적정성 |
| 시세 | 이격도 | 과열 기준(120) 적정성 |
| 시세 | 윗꼬리 비율 | 30% 페널티 기준 검증 |
| 시세 | 당일 등락률 | 최적 진입 등락률 구간 |
| 시세 | 탈출속도 | +5점 가점의 실효성 |
| 수급 | 기관 매수일 | 기관 연속매수와 성공 상관 |
| 수급 | 외국인 매수일 | 외국인 연속매수와 성공 상관 |
| 수급 | 쌍방수급 | 동시 매수 vs 단독 매수 성과 비교 |
| 종합 | 연속 상승일 | 최적 진입 타이밍 |
| 종합 | 시가총액 | 시총 구간별 성공률 |
| 종합 | 점수 구간별 수익률 | TOP3 우선순위 검증 |
| 종합 | 달성 소요일 | 추적 기간 적정성 |

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

## 🔮 To-Do 검토 리스트

데이터 축적 후 검증이 필요한 개선 후보. 섣불리 적용하지 말고 데이터 기반으로 판단할 것.

### 1. TOP3 기관매수 필터 강화 (대기: 25건+ 데이터 필요)

- **내용**: TOP3 선별 시 `기관매수일 ≥ 1일` 필터 추가
- **근거**: TOP1 분석(2026-02-23, 14건)에서 기관≥1일 필터 적용 시 승률 100% (8/8)
- **리스크**: 샘플 14건으로 통계적 신뢰도 부족. 필터 추가 시 TOP3가 없는 날 발생 가능
- **검증 방법**: `scripts/analyze-top1-performance.js` 재실행 → 25건+ 데이터에서 기관≥1일 승률 90%+ 유지 시 적용
- **적용 범위**: TOP3 선별(`selectTop3`, `selectSaveTop3`, `selectAlertTop3`)에만 적용, 전체 스코어링은 변경 없음

### 2. 업종별 베타 반영 (보류)

- **내용**: 업종 지수 대비 종목 민감도(베타)를 스크리닝/TOP3에 활용
- **보류 사유**: API 호출 +20~40개 증가, Vercel 60초 타임아웃 리스크, 단기(1-3일) 전략에서 베타 유효성 미검증
- **대안**: v3.69에서 업종 전망 뱃지(sector_outlook_stats) 구현 완료. 업종 분산은 뱃지 기반으로 사용자가 판단.
- **검증 결과**: 같은 업종 TOP3 동시 선정 시 대안 없어 전부 하락한 사례 확인 (2026-03-03). 다른 업종 대안 있을 때 TOP1 하락→대안 상승 55%.

### 3. 오늘의 동향(check-today.js) 로직 진단 결합 (진행 예정)

- **내용**: `check-today.js`의 당일 동향 분석 로직을 텔레그램 결산(`save`) 메시지 코멘트 및 웹 프론트엔드 통찰력 배지로 통합
- **세부 작업**:
  1. **수급 데이터 조건 반영**: 외인/기관 순매수 수급을 진단 로직(if문)에 포함 (예: 주가 하락에도 메이저 수급 유입 시 긍정적 해석 추가)
  2. **상승/횡보 시그널 추가**: 하락 외에 상승 시그널(+3% 초과 등) 발생 시 거래량 동반 여부에 따른 강한 추세 형성 판단 로직 보강
  3. **비교 기준선 다각화**: 전일 단일 거래량 비교의 노이즈를 줄이기 위해 '최근 5일 평균 거래량' 등을 비교 기준에 추가하여 안정화
  4. **모듈화 및 파이프라인 연동**: 해당 로직을 모듈형태로 분리하여 `api/cron/save-daily-recommendations.js`의 TOP3 매핑 단계에서 코멘트(🛡️,⚠️,📊)로 산출되도록 연동
- **기대 효과**: 추천 종목의 당일 종가 변동에 대한 실질적인 매매/홀딩 판단 기준(A/S)을 제공하여 투자 심리 안정 및 분석 신뢰도 대폭 향상

---

## 📝 변경 이력

### v3.75 (2026-03-26)
- **신호 합의(Agreement) 기반 시장 심리 판정**: `calculateMarketSentiment()` 전면 개편. 기존 합산 점수(-8~+6) → 4개 지표의 방향 합의(bearish/neutral/bullish) 기반. 데드존 도입으로 노이즈 제거 (이격도 97~103, RSI 35~65, 추세 99.5~100.5%, 3일변동 ±3%). 3개 동의=강한확신(fear/extreme), 2개 동의+반대0=중간확신(anxiety/optimism), 그 외=neutral.
- **레짐 결정 로직 정밀화**: `determineMarketRegime()` 개편. 양쪽 시장 조합을 5단계로 분류: 양쪽 하락→defense, 한쪽 하락+중립→prediction 보조 판단, 상충→sideways, neutral+neutral→sideways(pred≤-0.8이면 defense), bullish 포함→momentum. 기존 "한쪽만 불안이면 무조건 defense" 문제 해결.

### v3.74 (2026-03-26)
- **레짐 기반 메인 TOP3 전환**: 하락장→방어 TOP3, 횡보장→횡보 TOP3, 상승장→모멘텀 TOP3가 결산/알림 메시지의 메인 섹션으로 표시. 기존 모멘텀 TOP3는 참고용으로 하단에 표시. `determineMarketRegime()` 함수 추가.
- **Track 레짐 연동**: D-1/D-2/D-3 추적 시 해당 날짜의 저장된 `market_regime`에 따라 올바른 TOP3를 추적. `getRegimeTop3FromDb()` 헬퍼 추가. 추적 메시지에 레짐 태그(🛡️방어/⚖️횡보) 표시.
- **`market_regime` DB 컬럼**: `screening_recommendations` 테이블에 추가. SAVE 시 sentiment+prediction 기반으로 'momentum'/'defense'/'sideways' 저장. 이전 데이터는 'momentum' 기본값.
- **방어 필터 동기화**: screening.js `selectDefenseTop3()`의 기관/외인 조건을 ≥3일 → ≥2일로 완화 (v3.55 cron 측 완화와 동기화).
- **Fallback 처리**: 레짐별 TOP3가 비어있으면 모멘텀 TOP3로 자동 fallback + 경고 표시.

### v3.73 (2026-03-24)
- **횡보장 전략 TOP 3 신규**: 시장 심리 중립(neutral)일 때 활성화되는 별도 선별 로직. 데이터 분석 기반 3대 필터: MFI<93(자금 포화 차단) + RSI<82(과매수 차단) + 등락률≥5%(이미 움직이는 종목만). 듀얼수급(기관+외인 동시 매수) 최우선 정렬.
- **3단계 시장 레짐**: 기존 2단계(공격/방어) → 3단계(모멘텀/횡보/방어). `isMarketSideways()` 함수 추가. 심리 등급 neutral+optimism 조합이면 횡보장 판정.
- **프론트엔드 횡보 탭**: 스크리닝 탭에 `⚖️ 횡보` 전략 필터 추가. 각 전략(모멘텀/횡보/방어) 제목 옆에 적합한 시장 조건 기준 명시.
- **텔레그램 횡보장 TOP3**: SAVE/ALERT 메시지에서 시장 중립 시 `⚖️ 횡보장 TOP 3` 섹션 자동 표시.
- **DB 플래그**: `is_sideways_top3` 컬럼 추가하여 횡보장 TOP3 종목 마킹.
- **선별 함수 4종 추가**: `selectSidewaysTop3()` (screening.js), `selectSidewaysSaveTop3()`, `selectSidewaysAlertTop3()` (cron), 각각 camelCase/snake_case 대응.

### v3.72 (2026-03-24)
- **분봉 체결강도 버그 수정 (치명)**: `getMinuteChart()` 응답의 `prdy_ctrt` 필드가 `output2`에 존재하지 않아 `changeRate`가 항상 `NaN` → 모든 분봉이 중립 처리 → 체결강도가 항상 100%로 고정되던 문제. `stck_oprc`(시가) vs `stck_prpr`(종가) 비교로 분봉별 양봉/음봉 판단하도록 수정.
- **전일 거래량 fallback 버그 수정 (치명)**: `prevVolumes` 조회 시 `volume_t{N}`(동시간대 거래량)이 NULL이면 `volume`(전일 총 거래량)으로 fallback → 장중 일부 시점 거래량과 전일 전체 거래량을 비교하여 항상 음수(-40% 등)가 나오던 문제. 동시간대 데이터 없으면 0으로 두어 해당 차원을 건너뛰도록 수정. cron/performance.js 양쪽 모두 수정.
- **TR_ID 수정**: `getMinuteChart()`의 TR_ID를 `FHKST01010600` → `FHKST03010200`(주식당일분봉조회 정확한 TR_ID)로 변경. 누락된 `FID_ETC_CLS_CODE` 필수 파라미터 추가.
- **분봉 데이터 필드 확장**: `getMinuteChart()` 반환값에 `open`, `high`, `low` 필드 추가 (기존: time, price, volume, changeRate만 반환).
- **텔레그램 수급 정보 표시**: SAVE/ALERT/TRACK 메시지에 `🏛️ 연속매수: 기관 N일 | 외인 N일` 라인 추가. 기관/외인 1일 이상이면 표시.
- **웹 수급 뱃지 임계값 완화**: 기관/외인 뱃지 표시 조건을 ≥3일 → ≥1일로 변경하여 모든 수급 정보 노출.

### v3.71 (2026-03-23)
- **성과 검증 탭 장중 모멘텀 UI**: 성과 검증 탭 상단에 `⚡ 장중 모멘텀 분석` 섹션 추가. D-1/D-2/D-3 TOP3 종목의 6차원 모멘텀을 실시간 분석, 장중 여러 번 갱신 가능.
- **모멘텀 API 통합**: `GET /api/recommendations/performance?momentum=true` — 별도 API 파일 없이 performance.js에 통합 (Vercel Hobby plan 12함수 제한 대응).
- **`backend/momentumAnalyzer.js` 모듈 분리**: `analyzeIntradayMomentum` 함수를 cron과 performance API에서 공용 사용.
- **모멘텀 뱃지 툴팁**: 종합판정(strong~exit) 및 세부지표(거래량변화/체결강도/가격위치/거래량가속도/가격-거래량관계/윗꼬리) 전체에 title 속성으로 의미 설명 표시.
- **closing_price=0 버그 수정**: track 모드 거래량 DB insert 시 closing_price=0 저장 → performance.js에서 -100% 수익률 계산되던 문제. (1) insert 시 실제 current_price 사용, (2) performance.js에서 closing_price=0 레코드 필터링.

### v3.70 (2026-03-23)
- **장중 모멘텀 분석**: track 모드(10:00/11:30/13:30/15:00)에서 6차원 복합 시그널로 매수세 유지/이탈 판단. (1) 전일 동시간대 대비 거래량 변화율, (2) 가격-거래량 관계(상승확인/매도압력/얇은상승/조용한하락), (3) 분봉 체결강도(매수틱/매도틱 거래량 비율), (4) 윗꼬리 비율, (5) 장중 거래량 가속도, (6) 장중 가격 위치. 종합 점수(-4.5~+3.5)로 5단계 판정: 🔥매수세 강력 / 💪매수세 유지 / ➖중립 / ⚠️매수세 약화 / 🚨매수세 이탈.
- **체크포인트별 거래량 저장**: `recommendation_daily_prices`에 `volume_t1~t4` 컬럼 추가. 같은 시간대끼리 비교하여 시간대별 거래량 분포 차이로 인한 오판 방지.
- **분봉 체결강도**: 오늘 TOP3에 `getMinuteChart()` 호출(+3 API), 양봉/음봉 분봉별 거래량으로 실제 매수/매도 비율 산출. cron 슬롯 추가 없음.
- **텔레그램 track 메시지 확장**: 오늘 추천 종목에 모멘텀 시그널 라인 추가 (시그널 + 거래량변화% + 체결강도% + 가격위치% + 가속도 + 윗꼬리%).
- **D-1/D-2 모멘텀 확장**: 전체 추적 종목에 모멘텀 분석 적용, minuteCache로 중복 종목 분봉 API 1회만 호출.
- **수동 /추적 체크포인트 자동 결정**: 현재 KST 시각 기반으로 가장 가까운 이전 체크포인트 자동 선택, DB 덮어쓰기 방지.

### v3.69 (2026-03-23)
- **업종 전망 시스템**: 해외 예측 스코어 버킷(상승/중립/하락)별 업종 D+1 승률·평균수익을 90일 롤링으로 동적 산출. 업종 모멘텀(전일→익일 피어슨 상관계수) 동시 계산. 데이터 축적에 따라 자동 정밀화.
- **`sector_outlook_stats` 테이블 추가**: sector_name PK, 3개 버킷별 승률/샘플수/평균수익 + 모멘텀 r/전일수익률 + 전체 통계. post-market cron(16:20)에서 매일 UPSERT.
- **TOP3 업종 뱃지**: "📈 업종 유리"(녹색, 해당 버킷 승률≥55% N≥10), "📉 업종 불리"(빨강, 승률<35% N≥10), "🔄 업종 모멘텀"(파랑, 상관r>0.3+전일 양봉 N≥10). 툴팁으로 업종명/버킷/승률/샘플수 표시.
- **recommend API 확장**: `sectorOutlook` 필드를 전 종목·TOP3·방어TOP3에 부착. 현재 prediction score로 버킷 자동 결정.
- **sector_name 백필**: 기존 319개 종목 중 317개 업종명 KIS API로 일괄 업데이트 완료.
- **TOP3 수급 tiebreak**: 같은 스윗스팟 구간·동일 점수 내에서 수급 우선순위로 정렬 (쌍방수급 > 기관≥3 > 외인≥3 > 고래만). v1/v2 비교 분석 결과, 점수 보너스(A안)는 역효과(-3건), tiebreak(C안)가 TOP1 D+1 +0.84%→+1.52% 개선. v2 스코어링은 TOP3 전체 성과는 우수하나 TOP1 순위 결정력이 약해(37% 최선) 폐기 보류, 병렬 유지.

### v3.68 (2026-03-23)
- **월요일 현물지수 0% 버그 수정**: Yahoo Finance `range=5d`가 현물 지수/ETF(^SOX, EWY, ^VIX, ^TNX 등)에 대해 금요일 데이터를 2개 엔트리(장중+장마감후)로 반환 → 마지막 2개가 동일 날짜여서 change=0% 계산되는 문제. UTC 날짜 기준 중복 엔트리 제거(dedup) 로직 추가. 선물(ES=F, NQ=F 등)은 일요일 밤부터 거래되어 영향 없었음. ^SOX(-2.45%), ^VIX(+11.3%) 등 가중치 합 28%가 매주 월요일마다 누락되던 문제 해소.
- **alert 크론 선물 최신가 반영**: alert 모드(08:00 KST)에서 `fetchAndPredict(true)` (bypassCache)로 변경. 사용자가 07:30에 웹 조회하여 캐시가 생성되어도 08:00 alert 시 최신 선물가(ES=F, NQ=F 등)로 예측 재생성. 현물 지수(SOX, VIX 등)는 미국장 마감 후 변동 없으므로 동일.

### v3.67 (2026-03-19)
- **종목 분석 실시간 유사 매칭**: analyze API에서 분석된 종목의 지표(점수/고래/기관매수일/시총/거래량비율/RSI)를 `similarityMatcher.js`로 실시간 유사 매칭. 사전 계산된 `stock_expected_returns` 없는 종목도 기대수익 산출 가능. 3단계 fallback: 사전계산 유사매칭 → 실시간 유사매칭 → 등급 기반.

### v3.66 (2026-03-19)
- **종목별 유사 매칭 기대수익**: 기존 등급×고래 일괄 기대수익 → 종목별 6차원 유사 매칭(점수구간/고래/기관매수일/시총/거래량비율/RSI)으로 개별 기대수익 산출. 최소 20개 유사 샘플 필요, 차원을 점진적으로 완화(RSI→거래량→시총→기관 순 제거)하여 매칭률 확보, fallback은 기존 등급 기반.
- **`stock_expected_returns` 테이블 추가**: `recommendation_date + stock_code` 복합키, match_method/match_dimensions 메타데이터 저장. `post-market` cron(16:20)에서 당일 추천 종목 대상 산출.
- **기대수익 조회 우선순위 변경**: `getExpectedReturn()`, `recommend.js`, `analyze.js` — 종목별 유사 매칭 → 등급 기반 fallback 2단계. `matchMethod` 필드로 출처 구분.
- **야간선물 CM 직접 조회**: 04:55 Supabase 캐시 의존 → 08:00 alert 시 CM 마켓코드로 야간선물 최종 종가 직접 조회. 마감 전 1시간 오차 해소.
- **alert cron 중복 전송 방지**: `overnight_predictions.alert_sent_at` 필드 추가. cron 재실행 시 이미 전송했으면 스킵 (웹훅 `/알림` 수동 명령은 허용).

### v3.65 (2026-03-18)
- **Cron 슬롯 통합**: `patterns`(16:20 KST) + `calc-expectations`(16:30 KST) → `post-market`(16:20 KST) 단일 cron으로 통합. 패턴 수집 → 기대수익 산출 순차 실행. Vercel cron 11/12 → 10/12 (2슬롯 확보).
- **Tier 1 — getCurrentPrice 미사용 필드 활용**: 기존 API 응답에서 `bstp_kor_isnm`(업종명), `hts_frgn_ehrt`(외인소진율), `per`, `pbr`, `pgtr_ntby_qty`(프로그램매매) 추출. 추가 API 호출 없이 종목카드/모달에 업종·외인비중·PER·PBR 표시.
- **Tier 2 — 기관/외인 순매수 랭킹 통합**: `getInstitutionalRanking()` 신규 (TR_ID: FHPTJ04400000). 스크리닝 완료 후 기관/외인 순매수 상위 KOSPI+KOSDAQ 4회 호출 → 종목에 랭킹 매칭. 카드에 "기관순매수 N위"/"외인순매수 N위" 뱃지 표시.
- **Tier 2 — 상세 투자자매매동향 API**: `getDetailedInvestorData()` 신규 (TR_ID: FHPTJ04160001). 13개 투자자 유형(증권/투신/사모/은행/보험/종금/기금 등) 세분화 순매수 데이터. 향후 스크리닝 정밀화에 활용 예정.

### v3.64 (2026-03-18)
- **야간선물 캐시 버그 수정**: 마켓코드가 `F`(정규장)였던 것이 원인 — `CM`(야간선물)이 정답. KIS API `FID_COND_MRKT_DIV_CODE` 값: F=지수선물, CM=야간선물, JF=주식선물, EU=야간옵션. 기존 `101W9000` 종목코드도 비표준으로 제거, 정규선물 코드(10100000/10600000) + `CM` 마켓코드 조합으로 변경.
- **야간선물 cron 시간 변경**: 05:10 → 04:55 KST. `CM`은 장 마감 후에도 데이터를 유지하지만, 안전하게 마감 전 캡처.
- **TOP3 뱃지 개선**: "저장구간" 뱃지 제거, 선정 기준 매칭 뱃지로 교체 (매수고래/기관N일/외인N일/시총≤1조/스윗스팟).

### v3.63 (2026-03-17)
- **TOP3 시총 단계적 필터**: 시총 ≤1조 종목 우선 선별, 3개 미달 시 시총 무제한 확대. 90일 성과 분석 기반 — 시총 1000-5000억 +10% 도달률 61.2%(평균피크 +31.9%) vs 1조+ 24.0%(+7.9%). S등급 승률 7.7%의 원인이 대형주(삼성전자우, 신한지주 등) 독점이었음을 확인.
- **종목 분석 매수 판단 규칙 기반 전환**: Gemini API → 규칙 기반 `generateRuleBasedEvaluation()`. 등급+고래+수급+과열 조합으로 적극매수/매수/관망/비추천 판단. `@google/generative-ai` 의존성 제거, 응답 속도 개선.
- **프론트엔드**: "AI 종목 평가" → "종목 매수 판단", TOP3 기준에 "시총≤1조 우선" 표시

### v3.62 (2026-03-17)
- **야간선물 종가 캐시 시스템**: 마켓코드 `CM`(야간선물) + 정규선물 코드로 야간선물 종가 조회 → Supabase 캐시. 08:00 alert 시 캐시 우선 사용.
- **야간선물 cron 추가**: `night-futures` 모드 (19:55 UTC = 04:55 KST).
- **fetchOvernightData 선물 로직 개선**: 야간선물 캐시(`loadNightFutures()`) → 정규선물 실시간 조회 2단계 fallback. 야간선물 유효 데이터 있으면 정규선물 조회 생략.

### v3.61 (2026-03-16)
- **기대수익 통계 90일 롤링 윈도우**: 전체 히스토리 → 최근 90일 데이터만 사용하도록 변경. 시장 상황 변화에 따라 기대수익 구간이 동적으로 업데이트됨
- **최소 샘플 수 완화**: 30개 → 10개 (90일 윈도우에 맞춤)
- **기대수익 갱신일 표시**: 프론트엔드 카드/모달에 통계 갱신 날짜 표시
- **TOP3 기준 프론트엔드 표시**: 이격도<150 필터 조건 UI에 반영

### v3.60 (2026-03-12)
- **선물 롤오버 로직 개선**: 선물 만기일 당일 00:00 KST부터 차근월물 데이터를 즉시 사용하도록 개선. 롤오버 공백기 시세 오류 해결.
- **CME/Eurex 야간 선물 지원**: KOSPI 200 및 KOSDAQ 150 모두에 대해 야간 선물(prefixes A01, A06) 추적 로직 적용. 정규장 마감 후에도 실시간 선물 가격 반영.
- **ETF 프록시 로직 제거**: 예측 정확도 향상을 위해 선물 대용치(KODEX 200 등) 사용을 중단하고 100% 실제 선물 데이터만 사용.
- **아웃라이어 댐핑 (Factor Damping)**: 개별 지표의 비정상적 급등락(±3σ 이상)이 전체 스코어를 왜곡하지 않도록 z-score 클램핑 도입.
- **예측 범위(Expected Range) 슬림화**: 기존 1.0σ(표준편차) 밴드를 0.67σ로 축소하여 더 실무적이고 집중된 예측 범위 제공 (신뢰도 약 50% 구간).

### v3.55 (2026-03-09)
- **방어 Recovery 역전 버그 수정**: 극단 과매도 구간에서 점수가 역전되는 논리 오류 수정. RSI<20: 2→8점, RSI 20-24: 6→10점, MFI<15: 0→5점, MFI 15-19: 5→7점, 이격도<85: 1→6점, 이격도 85-89: 6→7점
- **방어 TOP3 자격 완화**: 기관/외국인 연속매수 3일→2일. 하락장에서 방어 추천 발생 확률 향상
- **결산(SAVE) 메시지에 해외 전망 추가**: ALERT 메시지와 동일하게 `formatPredictionLine()` 표시. cached 경로에서도 prediction 조회
- **가중치 자동보정 최소 데이터 60일→30일**: 피어슨 상관계수 유의성 검정에 30개 샘플 충분. source 이름 `calibrated_60d` → `calibrated`
- **시장전망 UI 5가지 개선**: (1) 모바일 팩터 테이블 2줄 구성(지수명+종가+변동률+상관+가중+기여도 / 기준시각+다음갱신), (2) 지수명에 출처 하이퍼링크 통합(출처 열 제거), (3) 지표 설명 줄바꿈(합산/임계점 분리), (4) 날짜 통일(상단 헤더→해외장 마감일 기준), (5) 하락 신호 색상 red→amber(모멘텀 전략과 구분)

### v3.54 (2026-03-08)
- **z-score 정규화**: `getFactorVolatility()` 신규 — 팩터별 60일 mean/std 조회 후 z-score = (change - mean) / std 기반 기여도 계산. VIX ±15%(일상적) vs S&P ±2%(이례적)을 동일 척도로 비교. 10일 미만 시 raw 변동률 fallback
- **신호 임계점 재조정**: 39건 스코어 분포(평균 -0.32, σ=1.70) 분석 기반. ±0.75 → +1.4/+0.2/-0.8/-2.0 (σ 비례). 기존 강한등급 64% 집중 → 13%/28%/26%/15%/18% 균형 분포
- **극단 스코어 감쇠**: |score|>2 구간에서 sqrt 압축 적용. 선형 외삽 과대 예측 방지 (예: -4.39 → effective -3.55)
- **밴드 클램핑 강화**: slope [0.1, 2.0], intercept [-3, 3], sigma [1.5, 4.0]. center ±5%, 최종 ±8% 클램핑
- **팩터 신뢰도**: 실패 팩터 추적 + reliability % 프론트엔드 표시. 70% 미만 빨간 경고
- **스크리닝 연동**: 하락/강한하락 예측 시 스크리닝 탭 상단에 경고 배너 표시
- **AI fallback 임계점 동기화**: `generateRuleBriefing()` 하드코딩 임계점 → SIGNAL_TABLE 참조로 변경
- **시장전망 탭 16가지 개선**: 차트 aria-label, 터치 감지 40px, AI 실패 판별 isAiFailure(), DEFAULT_CLOSE_TIMES 외부화, 관측 지표 흐림 제거, 상관계수 폰트색 단순화, 스코어→변동률 공식 4단계 표시

### v3.53 (2026-03-06)
- **회귀 기반 예측 밴드 전환**: 기존 `score × beta ± σ` 비대칭 밴드 → `slope × score + intercept ± σ` OLS 회귀 대칭 밴드로 교체. 스코어 -2.5일 때 기존 밴드(-14.7%~+0.04%)가 비현실적이던 문제 해결 → 새 밴드(-7.2%~+0.8%)로 현실적 범위 제공
- **`getRegressionParams()` 신규**: `getKospiBeta()` + `getRecentVolatility()` 통합 대체. EWMA(λ=0.94) 가중 OLS 회귀로 slope/intercept/sigma 동시 산출. 20일+ 데이터부터 동적 보정, 미만 시 DEFAULT_REGRESSION(slope=0.78, intercept=0.77, σ=3.44%) 사용
- **클램핑**: slope [0.1, 5.0], intercept [-5, 5], sigma [1.0, 10.0]
- **프론트엔드 동기화**: 계산법 설명 `score × β ± σ` → `slope × score + intercept ± σ` 변경

### v3.52 (2026-03-06)
- **KOSPI200F 가중치 복원 (v1.7)**: EWY 단독 최대 가중치(+0.21) → KOSPI200F(+0.20, 최대) + EWY(0, 관측용)로 재조정. EWY와 KOSPI200F는 둘 다 한국 시장 프록시라 가중치 동시 부여 시 이중 반영 문제 발생. 야간선물이 06:00 KST까지 거래되어 가장 최신 데이터를 반영하므로 단독 사용.
- **Supabase 스키마 업데이트**: `overnight_predictions` 테이블에 누락 컬럼 7개 추가 (`ai_interpretation`, `weights_source`, `previous_kospi`, `kospi_beta`, `expected_change`, `previous_kospi_date`, `us_market_date`). 컬럼 부재로 인해 savePrediction upsert가 PGRST204 에러로 실패하던 문제 해결.
- **AI 프롬프트 동기화**: 12개 팩터 반영, KOSPI200F/EWY 시간대 차이 설명 추가, "노이즈 필터링" 항목을 선물-EWY 괴리 판단으로 개선

### v3.51 (2026-03-05)
- **방어 로직 반응성 개선 (v3.34.3)**: 폭락장 초기 지연 대응 문제 해결
  - 급락 부스터: 3일 누적 하락률 -5% 이상 시 시장 심리 점수 -2점 패널티 (RSI/20일선 후행성 극복)
  - SAVE 모드 알림: 해외 예측 스코어 ≤ -0.5 시에도 결산 메시지에 방어 TOP3 표시
  - 텔레그램 로그: 방어 로직 활성화 사유(심리지수 불안/공포 또는 해외예측 악화) 명시
- **해외 지수 예측 스케일링 최적화 (v1.5)**: 백테스트 기반 Beta 증가 속도 완화(×1.5), 범위 확장 완화(×1.8) 적용. 기존 v1.4 대비 아웃라이어 커버리지와 범위적중률(45.5%) 모두 향상
- **AI 시장 브리핑 Fallback (v1.5)**: Gemini API 할당량/오류 대비 다중 모델 순차 시도(`gemini-2.5-flash` → `2.5-pro` → `2.0-flash`), 429 오류 시 12초 대기 후 재시도, Supabase 자체 캐싱 기능 도입

### v3.50 (2026-03-05)
- **EWMA 베타 도입**: `getKospiBeta()` — OLS 균등 회귀 → EWMA(λ=0.94) 가중 회귀로 변경. 최근 데이터에 지수적 가중치 부여하여 급변장 반영 속도 3~4배 향상. 최소 20일 데이터부터 보정 시작 (기존 60일). 클램핑 0.5~8.0 (기존 3.0)
- **동적 밴드(σ) 도입**: `getRecentVolatility()` — 최근 20일 KOSPI 일일 변동률 표준편차를 ±밴드로 사용 (기존 고정 ±0.5%). 급변장에서 자동 확대 (클램핑 0.5~10.0%)
- **KOSPI 전일 종가 버그 수정**: `range=2d` + `previousClose`/`chartPreviousClose` 방식 → `range=5d` + timestamp 기반 오늘 제외 마지막 종가 선택. 장중/장외 무관하게 정확한 전일 종가 반환
- **예측 변동폭 공식**: `center ± 0.5%` → `center ± σ` (center = score × β)

### v3.50 (2026-03-06)
- **KOSPI 예측 밴드 한계치 설정 (v1.6)**: 극단적인 변동성(스코어 -3.6 등) 발생 시 예상 변동률이 비현실적으로 폭주하던 선형 산식을 개선.
  - 가속 구간(스코어 > 1.2)에서 베타 오버슈팅 방지를 위해 `Math.sqrt()` 기반 제곱근 감쇠(Dampening) 도입.
  - 밴드폭 역시 선형 무한 확장이 아닌 제곱근 곡선으로 제한하여 서킷브레이커(-8%) 수준의 현실적 예측력 확보.
  - 시장 지표 `KOSPI200F`를 0.0의 가중치로 부활시켜 관측용 보조 지표로 노출.

### v3.49 (2026-03-05)
- **다중공선성 제거 (15→11개 팩터)**: ^GSPC(ES=F와 r=0.96), ^IXIC(NQ=F와 r=0.99), ^DJI(^GSPC와 r=0.84), DX-Y.NYB(USDKRW=X와 r=0.56), ^KS200(한국장 시간대 지수) 제거
- **EWY(한국ETF) 추가**: ^KS200 대신 미국장에서 거래되는 iShares MSCI South Korea ETF — 야간 KOSPI 프록시 역할
- **KOSPI 베타(멀티플) 적용**: `DEFAULT_KOSPI_BETA = 1.3` — KOSPI는 해외 합산 스코어 대비 1.3배 크게 반응 (신흥국 베타 효과)
- **동적 베타 보정 구현**: `getKospiBeta()` — 60일 예측 히스토리에서 score→KOSPI 개장 변동률 OLS 회귀 기울기 계산, 0.5~3.0 클램핑
- **예측 변동폭 공식 변경**: `center = score` → `center = score × beta` (±0.5% 밴드 유지)
- **프론트엔드 동기화**: "15개 지수"→"11개 지수", 계산법 안내에 베타 설명·동적 값 표시 추가

### v3.48 (2026-03-04)
- **선물 지수 4개 추가**: ES=F(S&P500 선물), NQ=F(나스닥 선물), GC=F(금 선물), HG=F(구리 선물) — 총 14개 팩터
- **선물 가중치 우선**: 선물이 장 마감 후 최신 움직임 반영 → 현물보다 높은 가중치 (ES=F +18% > ^GSPC +10%)
- **yahoo-finance2 제거**: ESM 전용 라이브러리 Vercel 호환 문제 → Yahoo Finance chart API v8 직접 호출로 전환 (API 키 불필요)
- **예측 범위 축소**: 고정 신호별 범위(strong_bearish -2.5%~-0.5%) → 스코어 기반 동적 범위(score±0.5%, 범위 1%)
- **차트 툴팁 강화**: 예측 스코어 + 예측 범위(%) + 예측 KOSPI 지수 + 실제 변동률 + 실제 KOSPI 종가 + 적중여부
- **KOSPI 절대 지수 역산**: 최신 전일 종가에서 역방향 변동률 적용하여 30일간 근사 종가 계산
- **팩터 수 변경 캐시 무효화**: 캐시된 factor 수 ≠ 현재 DEFAULT_WEIGHTS 수 → 자동 재조회
- **예측 계산법 UI 설명**: 기여도·스코어·가중치 부호 의미를 파란 안내 박스로 상세 설명
- **"오늘의 시장전망" 탭 1순위 배치**: 기본 탭으로 설정, 예측 결과(적중/미적중) 표시 추가

### v3.47 (2026-03-03)
- **해외 지수 기반 시장 방향 예측**: 전날 미국장 마감 데이터(S&P500, NASDAQ, VIX 등 10개)로 한국 시장 당일 방향 예측
- **`backend/overnightPredictor.js` 신규**: 가중 스코어 계산 → Supabase 저장
- **가중치 자동 보정**: 60일 데이터 축적 후 각 팩터와 KOSPI 개장 변동률의 피어슨 상관계수 기반 가중치 실시간 재계산
- **적중률 추적**: save 모드(16:10)에서 `updateActualResult()` 호출 → KOSPI/KOSDAQ 실제 변동률 + hit 판정
- **`overnight_predictions` 테이블 추가**: prediction_date, score, signal, factors, weights, 실제 변동률, hit
- **텔레그램 알림 통합**: alert 모드(08:00) 메시지에 `🌏 해외 시장 기반 전망` 블록 추가 (스코어, 요약, 적중률)
- **방어 TOP3 연동**: 해외 예측 score ≤ -0.5 시에도 방어 TOP 3 표시
- **recommend API**: 응답에 `prediction` 필드 추가 (캐시 활용 — 당일 중복 호출 시 Supabase 읽기)
- **프론트엔드 전망 카드**: 상승/하락/중립별 배경색, 팩터 바 차트(기여도 비례), 반응형(모바일 4개/PC 10개)
- **예측 히스토리 꺾은선 차트**: Canvas 기반, 예측 스코어(파란 선) + KOSPI 실제(회색 선) + 적중 점(초록/빨강), 최근 30일

### v3.46 (2026-02-27)
- **기대수익 구간 기능**: 등급별×고래여부별 실제 수익률 분포(p25/median/p75) 산출 → 손절가와 세트로 기대수익 구간 + 손익비(Risk-Reward) + 승률 제공
- **`expected_return_stats` 테이블 추가**: grade, whale_detected, optimal_days, p25, median, p75, win_rate, sample_count
- **`calc-expectations` 크론 모드**: 16:30 KST, SAVE 완료 후 실행. **90일 롤링 윈도우**로 최근 추천/가격 조회 → grade×whale×day별 그룹핑 → median 최고 day를 optimal_days로 선택 → UPSERT. 최소 샘플 10개
- **`getExpectedReturn()` 헬퍼**: 정확 매칭(grade+whale) → median ≤ 0이면 반대 whale로 fallback → N<30이면 null
- **텔레그램 메시지 기대수익 표시**: SAVE/ALERT 모드에 `📈 기대수익(N일): +p25% ~ +median% ~ +p75%` + `⚖️ 손익비 1:X | 승률 Y%` 라인 추가, TRACK 모드에 `📈 기대수익 진행: X%` 표시
- **recommend/analyze API**: `expectedReturn` 필드 매칭 (각 종목에 days/p25/median/p75/winRate/sampleCount 부착)
- **프론트엔드 UI**: RecommendationCard에 초록 그라데이션 기대수익 카드(3컬럼 p25/median/p75 + 원화 금액 + 손익비 + 승률 바), StockDetailModal에 상세 기대수익 섹션 추가
- **기대수익 매칭 fallback 버그 수정**: 정확 매칭 존재 시 median ≤ 0이어도 fallback 안 타던 문제 수정

### v3.45 (2026-02-25)
- **종목 풀 5-API 체계 전환**: 시장 루프 제거(동일 결과 중복 조회 해소), 거래회전율+등락률 추가 → API 6→5회, 풀 49→76개
- **KIS API 반환 한계 발견**: 거래량순위 API는 1회 최대 30개 반환, 페이지네이션 미지원. limit 파라미터 무의미 확인
- **등락률 API 필드명 버그 수정**: `mksc_shrn_iscd` → `stck_shrn_iscd` (TR_ID별 필드명 차이)
- **종목코드 기반 시장 태깅**: `FID_DIV_CLS_CODE` 미작동 → `0xxxxx`=KOSPI 방식으로 전환
- **패턴 분석 인사이트 18개로 확장**: 기관/외국인/쌍방수급, VPD, 탈출속도, 시총, 점수구간 등 11개 추가
- **패턴 수집 N+1 쿼리 최적화**: 종목별 개별 쿼리 → 배치 일괄 조회 (타임아웃 해결)
- **패턴 분석 API null 크래시 수정**: calcStats 반환값 optional chaining 추가
- **패턴 수집 버튼 UX 개선**: 로딩/에러/결과 피드백 추가
- **스크리닝 소요 시간 표시**: 결과 메타데이터 바에 소요 시간(초) 표시
- **종목 분석 탭 전략 토글**: 모멘텀/방어 전환 버튼 추가
- **과열 필터 완화**: RSI 80→85, 이격도 115→120
- **고래 감지 임계값 완화**: 소형주 2.5→2.0배, 중형주 2.0→1.5배, 대형주 1.5→1.2배
- **병렬 배치 처리**: BATCH_SIZE 3으로 스크리닝 속도 개선
- **방어 전략 카드 크래시 수정**: defenseBreakdown 객체 직접 렌더링 → `.total` 접근자 추가
- **모멘텀 카드에서 방어 필드 제거**: 전략별 카드 표시 분리

### v3.43 (2026-02-24)
- **TOP3 불일치 해결**: 알림/추적/과거성과에서 `selectAlertTop3()` 재선별 → DB `is_top3` 플래그 직접 사용 (`getTop3FromDb()` 헬퍼)
- **`isTradingDay()` UTC 타임존 버그 수정**: Vercel(UTC)에서 `getDay()`가 KST 날짜를 전날로 판정 → `Date.UTC()` + `getUTCDay()`로 수정
- **알림 과거 추천성과 D-1 가격 0% 수정**: DB에 최신 종가 미업데이트 시 KIS API 실시간가 fallback 추가
- **종목 분석 탭 종목명 안정화**: 8개 랭킹 API 제거 → Supabase 일괄 조회 + KIS `getStockName` fallback, Supabase 컬럼명 오타 수정 (`recommended_date` → `recommendation_date`)

### v3.42 (2026-02-23)
- **종목 분석 탭 API 최적화**: 불필요한 8개 랭킹 API 동시호출 제거 → Supabase + getCurrentPrice 내장 종목명으로 대체 (종목당 11→3 API)
- **Supabase 1000행 제한 대응**: performance.js, patterns/index.js, update-prices.js 페이지네이션 + .in() 배치 분할 추가
- **Enter 키 중복 호출 방지**: 종목 분석 탭 handleKeyDown에 loading 가드 추가
- **TOP1 성과 분석 스크립트**: `scripts/analyze-top1-performance.js` 추가 (순위별 승률, 지표 상관관계, 필터 시뮬레이션)

### v3.41 (2026-02-23)
- **TOP3 로직 완전 통일**: `selectTop3`(백엔드)와 `selectSaveTop3`(텔레그램)을 스윗스팟 우선순위(v3.38)로 통합
- **결산 cron 시간 조정**: 15:40 → **16:10 KST**로 변경 (16:00 시간외 종가 마감 후 확정 데이터 사용)
- **프론트엔드 UI 동기화**: 스크리닝 탭도 본문 버튼 클릭 시 실행되도록 변경 (성과검증/DNA 탭과 통일)
- **강제 새로고침 강화**: 헤더 새로고침 버튼 클릭 시 브라우저 캐시를 무시하는 `window.location.reload(true)` 적용
- **종목 분석 탭 디자인**: 오렌지-레드 그라데이션 헤더 디자인 적용으로 UI 일관성 확보

### v3.40 (2026-02-20)
- **종목 분석 탭**: 종목코드 입력 → 스크리닝 엔진 분석 결과 표시 (RecommendationCard 재사용)
- **종목 분석 API 단일 호출 전환**: 종목별 개별 API → `?codes=` 한 번 호출로 전환 (Rate Limiter 공유)
- **종목명 3단계 fallback**: KIS `hts_kor_isnm` → KIS `CTPF1002R` → Supabase 일괄 사전조회
- **점수 상세 툴팁**: Base/Momentum/Trend 항목에 (i) 아이콘 + 컬러풀 JSX 툴팁 추가
- **StockDetailModal 수정**: dailyRisePenalty 객체→숫자 변환, sticky header z-index 수정
- **결산 cron 15:50→15:40**: 시간외 종가매매(15:40~16:00) 당일 매수 가능하도록 변경

### v3.39 (2026-02-19)
- **KRX 휴장일 체크**: `KRX_HOLIDAYS` Set + `isKRXHoliday()` + `isTradingDay()` — 공휴일 cron 스킵, 웹훅은 허용
- **거래일 기준 필터링**: `filterTradingDays()` — 텔레그램 D-1/D-2/D-3 날짜를 영업일 기준으로 조회
- **TOP3 급등 과열 필터**: `|change_rate| < 25` AND `disparity < 150` 자격 조건 추가
- **점수 상세 분석 UI**: 5-컬럼 구성(Base+Whale+Momentum+Trend+Signal), Base/Whale 서브 컴포넌트 표시
- **Base 서브 컴포넌트**: `_baseDetail` — 거래량비율(0-8), VPD(0-7), 시총(-5~+7), 되돌림(-3~0), 연속상승(0-5)
- **signal_adjustment DB 컬럼 추가**: 시그널 가감 점수 Supabase 저장
- **텔레그램 cached 경로 보강**: nextTop3에 changeRate/radarScore/scoreBreakdown 추가, 최근주가 fallback

### v3.38 (2026-02-12)
- **TOP3 스윗스팟 우선순위**: 50-69 → 80-89 → 90+ → 70-79 (최후 보충)
- 고래 종목 점수 구간별 실적 분석: 50-69점 승률 72%, 70-79점 승률 47%
- 수익률 추적 데이터 백필: 174건 → 548건 (100% 커버리지)

### v3.37 (2026-02-12)
- **데이터 기반 v2 스코어링 재설계**: 상관관계 분석 결과 반영
- v2 공식: `Base(0-15) + Whale(0/15/30) + Supply(0-25) + Momentum(0-20) + Trend(0-10) + SignalAdj`
- **Supply(0-25) 신설**: 기관 연속매수일(0-10) + 외국인 연속매수일(0-8) + 쌍방수급 보너스(0-7)
  - 상관관계: 기관+외국인 합산 r=+0.21 (최강 알파 시그널)
  - 쌍방수급(기관2+외국인2): 승률 94.7%, 평균수익 +15.67%
- 거래량 비율 스윗스팟 반영: 1.0-1.5x → 6점 (승률 68.8%, 수익 +20.57%)
- RSI 50-70 존 보너스 추가 (승률 63.4%)
- 거래량 가속 배점 축소: 15점→10점 (r=-0.10 음의 상관)
- v2 TOP3 선별: 매수고래 필터 → Supply(기관/외국인) 기반 필터로 변경
- 미사용 지표 제거: anomaly, confluence, freshness, breakoutConfirmation
- 기관/외국인 매수일 필드명 불일치 수정 (`institution.consecutiveBuyDays` → `institutionDays`)
- 백필 스크립트 추가: `scripts/backfill-investor-days.js`

### v3.35 (2026-02-11)
- **고래 감지 탭 제거**: 모멘텀 스코어링이 고래 감지를 이미 포함하므로 중복 탭 제거
- `CategoryFilter` 컴포넌트, `selectedCategory` 상태, `handleCategoryChange` 제거
- `fetchRecommendations` 카테고리 파라미터 제거 (항상 종합집계 API만 호출)
- 데이터 캐싱 구조 단순화 (카테고리별 → 단일 캐시)

### v3.34 (2026-02-11)
- **방어 전략 병렬 운영**: 기존 모멘텀 전략과 별도로 하락장/조정기 대비 방어 전략 스코어링 추가
- `calculateDefenseScore()`, `getDefenseRecommendation()` — screening.js
- `detectBottomFormation()` 재활성화 — advancedIndicators.js
- `selectDefenseSaveTop3()`, `selectDefenseAlertTop3()`, `isMarketDefensive()` — save-daily-recommendations.js
- 텔레그램: KOSPI 또는 KOSDAQ 한쪽이라도 불안 이하일 때 방어 TOP 3 추가 표시
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
