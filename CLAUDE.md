# Investar - AI 기반 주식 스크리닝 시스템

## 프로젝트 개요

**Investar**는 한국투자증권 OpenAPI를 활용한 거래량 기반 주식 종목 발굴 시스템입니다.

- **목적**: 거래량 지표로 급등 "예정" 종목 선행 발굴 (Volume-Price Divergence)
- **기술 스택**: Node.js, React (CDN), Vercel Serverless, KIS OpenAPI, Supabase
- **배포 URL**: https://investar-xi.vercel.app
- **버전**: 3.52
- **최종 업데이트**: 2026-03-06

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
├── backend/                      # 백엔드 로직
│   ├── kisApi.js                # KIS OpenAPI 클라이언트
│   ├── screening.js             # 스크리닝 엔진 (점수 계산 핵심)
│   ├── leadingIndicators.js     # 선행지표 통합 (패턴+DNA)
│   ├── volumeIndicators.js      # 거래량 지표 (OBV, VWAP, MFI)
│   ├── advancedIndicators.js    # 고급 지표 (고래, 탈출속도, 비대칭)
│   ├── smartPatternMining.js    # D-5 선행 패턴 마이닝
│   ├── volumeDnaExtractor.js    # 거래량 DNA 추출
│   ├── overnightPredictor.js     # 해외 지수 기반 시장 방향 예측
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

**필터**: 매수고래(🐋) 존재 + 과열 등급 아님

**스윗스팟 우선순위** (v3.38, 데이터 기반):

| 순위 | 점수 구간 | 근거 (고래 종목 실적) |
|------|----------|---------------------|
| 1순위 | 50-69점 | 승률 72%, 평균 +18.7%, 163개 |
| 2순위 | 80-89점 | 승률 78%, 평균 +21.1%, 9개 |
| 3순위 | 90+점 | 샘플 부족 |
| 4순위 | 70-79점 | 승률 47%, 중앙값 -0.4%, 최후 보충 |

각 순위 내에서 점수 내림차순. 1순위에서 3개 채워지면 끝, 부족하면 다음 순위로.

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

**자격**: 기관≥3일 OR 외국인≥3일, 비폭락, 비과열, 시총≥5000억

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

**v3.47에서 추가, v3.49에서 다중공선성 제거·베타 적용.** 전날 미국장 마감 데이터 + 선물 데이터를 기반으로 가중 스코어를 계산하여 한국 시장 당일 방향을 예측한다.

### 모듈: `backend/overnightPredictor.js`

**데이터 소스**: Yahoo Finance chart API v8 직접 호출 (API 키 불필요, Vercel 서버리스 호환)

### 가중치 (DEFAULT_WEIGHTS) — 12개 팩터

다중공선성 제거 후 독립적 정보만 유지. KOSPI200F 야간선물이 가장 최신 데이터(~06:00 KST)를 반영하므로 최대 가중치 부여.

| 구분 | 티커 | 이름 | 가중치 | 비고 |
|------|------|------|--------|------|
| 선물 | KOSPI200F | 코스피200선물 | +0.20 | KIS API 야간선물, 최대 가중치 |
| 선물 | ES=F | S&P500 선물 | +0.10 | 장후 최신 |
| 선물 | NQ=F | 나스닥 선물 | +0.11 | 기술주 선행 |
| 선물 | HG=F | 구리 선물 | +0.07 | 경기 선행지표 |
| 선물 | GC=F | 금 선물 | +0.08 | |
| 현물 | ^SOX | SOX 반도체 | +0.15 | 삼성/하이닉스 연동 |
| 현물 | ^VIX | VIX 공포 | -0.10 | 역상관 |
| 현물 | USDKRW=X | 달러/원 | -0.03 | 원화 약세 = 하락 |
| 현물 | ^TNX | 미국10년물 | -0.01 | 금리 상승 = 하락 |
| 현물 | ^N225 | 닛케이 | +0.03 | 아시아 연동 |
| 현물 | EWY | 한국ETF | +0.08 | 미국장 KOSPI 프록시, 보조 |
| 현물 | CL=F | WTI 원유 | -0.11 | |

**제거됨** (다중공선성): ^GSPC(ES=F r=0.96), ^IXIC(NQ=F r=0.99), ^DJI(^GSPC r=0.84), DX-Y.NYB(USDKRW=X r=0.56), ^KS200(한국장 시간대 지수)

**양의 가중치(+)**: 해당 지수 상승 → KOSPI↑ (동행)
**음의 가중치(-)**: 해당 지수 상승 → KOSPI↓ (역행). 예: VIX -10%는 VIX가 오르면 KOSPI가 내린다는 의미

### 스코어 계산

```
기여도(contribution) = 해당 지수 변동률 × 가중치
스코어(score)        = Σ(모든 기여도) = Σ(변동률 × 가중치)
```

| 스코어 | 신호 | 이모지 |
|--------|------|--------|
| ≥ +0.5 | strong_bullish | 🟢🟢 |
| +0.2 ~ +0.5 | mild_bullish | 🟢 |
| -0.2 ~ +0.2 | neutral | ⚪ |
| -0.5 ~ -0.2 | mild_bearish | 🔴 |
| ≤ -0.5 | strong_bearish | 🔴🔴 |

**VIX 스파이크**: VIX 변동 ≥ +15% → 별도 경고

### 예측 KOSPI 범위

KOSPI 베타(멀티플)를 적용하여 예측 변동폭 산출:
```
center = score × kospiBeta
expectedChange = { min: center - 0.5, max: center + 0.5 }
estimatedKospi = previousKospi × (1 + expectedChange / 100)
```
- `DEFAULT_KOSPI_BETA = 1.3` (KOSPI는 해외 합산 스코어 대비 1.3배 크게 반응)
- 60일 데이터 축적 후 `getKospiBeta()`로 OLS 회귀 기울기 기반 동적 보정 (0.5~3.0 클램핑)

### 가중치·베타 자동 보정

- 60일 미만 데이터: `DEFAULT_WEIGHTS`, `DEFAULT_KOSPI_BETA` 사용
- 60일 이상: **매 호출 시**
  - **가중치**: 각 팩터와 KOSPI 개장 변동률의 피어슨 상관계수 → 부호 보존, 절대값 비례 → 합계 1.0 정규화
  - **베타**: score→KOSPI 개장 변동률 OLS 회귀 기울기 → 0.5~3.0 클램핑
- 팩터 수 변경 시 캐시 자동 무효화

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
08:00 KST (alert 모드):
  fetchAndPredict() → Yahoo Finance chart API × 11개
  → 가중 스코어 계산 × KOSPI 베타 → Supabase 저장 → 텔레그램 전송

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
`recommend` 응답에 `prediction` 필드 포함 (해외 시장 기반 전망 + 히스토리 차트 데이터 + kospiBeta)

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
| 07:10 | 16:10 | save | 결산: 스크리닝 → Supabase 저장 + 텔레그램 |
| 07:05 | 16:05 | update-prices | 전체 종목 종가 업데이트 (장 마감 후) |
| 07:20 | 16:20 | patterns | 성공 패턴 수집 |
| 07:30 | 16:30 | calc-expectations | 기대수익 통계 산출 (grade×whale별) |
| 23:00 | 08:00 | alert | 실시간 스크리닝 TOP 3 알림 + 해외 전망 |
| 01:00 | 10:00 | track | 장중 주가 추적 |
| 02:30 | 11:30 | track | 장중 주가 추적 |
| 04:30 | 13:30 | track | 장중 주가 추적 |
| 06:00 | 15:00 | track | 장중 주가 추적 |

### 추천 종목 매수 타이밍

`recommended_price` = 결산 시점의 종가. 동일 가격으로 매수 가능한 시간대:

| 시간대 (KST) | 매매 방식 | 매수 가격 | 비고 |
|-------------|----------|----------|------|
| 15:40~16:00 (당일) | 시간외 종가매매 | 당일 종가 = 추천가 | 결산 메시지 도착 ~15:45, 약 15분 여유 |
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
- `recommendation_daily_prices`: 일별 가격 추적
- `expected_return_stats`: 등급×고래별 기대수익 통계 (v3.46)
- `overnight_predictions`: 해외 지수 기반 시장 방향 예측 + 적중률 (v3.47)
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
- **대안**: 업종 분산(같은 업종 TOP3 제한)만 가볍게 적용하는 방안 검토 가능
- **선행 조건**: Supabase 데이터에서 "같은 업종 TOP3 동시 선정 시 성과 저하" 여부 사후 분석 필요

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

### v3.52 (2026-03-06)
- **KOSPI200F 가중치 복원 (v1.7)**: EWY 단독 최대 가중치(+0.21) → KOSPI200F(+0.20, 최대) + EWY(+0.08, 보조)로 재조정. 야간선물이 미국장 마감 후에도 06:00 KST까지 거래되어 EWY보다 6~8시간 최신 데이터를 반영. 두 지표가 괴리 시 야간선물이 더 정확.
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
- **`calc-expectations` 크론 모드**: 16:30 KST, SAVE 완료 후 실행. 페이지네이션으로 전체 추천/가격 조회 → grade×whale×day별 그룹핑 → median 최고 day를 optimal_days로 선택 → UPSERT
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
