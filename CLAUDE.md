# Investar - AI 기반 주식 스크리닝 시스템

> **현재 운영 파라미터** (자동 갱신): [OPERATING_STATE.md](./OPERATING_STATE.md)
> **주간 진단 이력** (auto-append): [WEEKLY_DIAGNOSTICS.md](./WEEKLY_DIAGNOSTICS.md)

## 프로젝트 개요

**Investar**는 한국투자증권 OpenAPI를 활용한 거래량 기반 주식 종목 발굴 시스템입니다.

- **목적**: 거래량 지표로 급등 "예정" 종목 선행 발굴 (Volume-Price Divergence)
- **기술 스택**: Node.js, React (CDN), Vercel Serverless, KIS OpenAPI, Supabase
- **배포 URL**: https://investar-xi.vercel.app
- **버전**: 3.87
- **최종 업데이트**: 2026-05-06

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

| 조건 | 페널티 | 근거 (90일 데이터) |
|------|--------|-------------------|
| closeChange ≥ 20% | -10점 | 73%승률, +29.5%max (상한가 모멘텀) |
| highChange ≥ 20% (종가 미달) | -20점 | 장중 급등 후 pullback = 매도 압력 |
| closeChange ≥ 15% | -15점 | 56%승률, +2.7%final (최위험 구간) |
| highChange ≥ 15% | -15점 | 장중 급등 위험 구간 |
| closeChange ≥ 10% | -5점 | 72%승률, +11.9%max (양호 구간) |
| closeChange ≤ -10% | -20점 (급락) | |
| closeChange ≤ -5% | -10점 (하락) | |
| 그 외 | 0점 | |

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

**필터**: (매수고래(🐋) OR 기관≥3일 OR 외국인≥3일) + 과열 등급 아님 + `|등락률| < 25%` + `이격도 < 150` + `총점 ≥ 45`

**정렬** (v3.87, sg→inst→band 전략): 수급등급 1차 → 기관매수일 2차 → 스윗스팟 구간 3차. (tier1 시총 필터 없음)
1. **수급등급(sg)**: 외인≥2d 단독(5) > 쌍방≥2d(4) > 기관≥2d(3) > 외인≥1d(2) > 고래만(1)
2. **기관매수일**: 내림차순
3. **스윗스팟 구간**: 50-59점(1) > 60-69점(2) > 80-89점(3) > 90+점(4) > 70-79점(5) > 45-49점(6)

**근거** (v3.87, 2026-05-05): 504개 3키 정렬 조합 전수 탐색(n=58, D+1→D+10). sg→inst→band가 승률 71%로 최상위. 현재 전략(v376NT, band→sg→score)은 95위/504개, 승률 66%. 손실 발생 시 손실평균 -8.04% vs 현재 -7.24%로 약간 크나 5%ile(-15.49%) 동일. 오라클 분석에서 실제 최고수익 종목의 81%가 고래, 66%가 50-59구간으로 수급 신호가 핵심임 확인.

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
| +0.15 ~ +1.4 | mild_bullish | 🟢 |
| -0.4 ~ +0.15 | neutral | ⚪ |
| -2.0 ~ -0.4 | mild_bearish | 🔴 |
| < -2.0 | strong_bearish | 🔴🔴 |

임계점은 54건 적중률 시뮬레이션 기반 재조정 (2026-04-06). neutral 구간 축소(-0.8→-0.4, +0.2→+0.15)로 기존 0% → 80% 적중률 개선. flat 판정 ±0.2% → ±1.0% 완화. direction_lean 모드(neutral도 score 부호 방향 적중 인정)

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

### Cron 스케줄

**Cloudflare Workers** (`C:\Users\knoww\investar-cron`, 정시 실행):

| UTC | KST | 모드 | 동작 |
|-----|-----|------|------|
| 23:00 (sun-thu) | 08:00 | alert | 실시간 스크리닝 TOP 3 알림 + 해외 전망 |
| 06:35 (mon-fri) | 15:35 | save | 결산: 스크리닝 → Supabase 저장 + 텔레그램 |

**Vercel** (`vercel.json`, 딜레이 가능):

| UTC | KST | 모드 | 동작 |
|-----|-----|------|------|
| 19:55 | 04:55 | night-futures | 야간선물 종가 캐시 (야간장 마감 5분 전) |
| 01:00 | 10:00 | track | 장중 주가 추적 |
| 02:30 | 11:30 | track | 장중 주가 추적 |
| 04:30 | 13:30 | track | 장중 주가 추적 |
| 06:00 | 15:00 | track | 장중 주가 추적 |
| 07:05 | 16:05 | update-prices | 전체 종목 종가 업데이트 (장 마감 후) |
| 07:20 | 16:20 | post-market | 장후 통합 처리 (패턴 수집 → 기대수익 산출) |

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

## 🔁 자동 운영 진단 시스템 (v3.86, 2026-04-28)

매주 일요일 22:00 KST(13:00 UTC) `weekly-diagnostic` cron이 4가지 진단을 자동 산출하여 `weekly_diagnostics` 테이블에 누적. **관측·권고만 — 룰/타이밍 자동 변경 없음**. v3.55→v3.85의 churn 재발 방지 위해 모든 변경은 사용자 수동 적용.

### 4가지 주간 진단

1. **시장 레짐**: 강신호 종목(volR≥3 + VPD≥2)의 최근 30일 T+3 평균
   - `> +1%` → momentum / `≤ +1%` → sideways (v3.87: defense 레짐 제거)
2. **점수 모델 건강도**: 점수 구간(45-55/55-65/65-75/≥75) × T+3 평균의 Spearman r
   - `> 0.3` healthy / `-0.3 ~ 0.3` broken / `< -0.3` inverted
3. **권장 매매 타이밍**: in-sample 8주 (k,n) 매트릭스 스캔. 모든 주에서 + 평균인 (k,n) 중 최저주 알파 최대화 (robust)
4. **TOP1 알파**: 최근 30일 TOP1 vs TOP3 평균 알파, 현재 timing(D+0,D+3) vs 권장 timing 두 가지

### 진단 진단 (meta-monitor)

매주 진단 시 4주 전 진단이 권장한 (k,n)으로 후속 4주 가상 운영했다면 어땠을지 후향 계산.
`meta_alpha_vs_baseline` 누적이 양수이면 진단의 예측력 작동 중. 음수 누적 시 진단 자체 의심.

### 운영 정책 (active_policy)

`active_policy` 단일 행 테이블 (default `D+0매수, D+3매도`). 변경 트리거로 `active_policy_history` 자동 기록.

**자동 변경 절대 없음.** 수동 변경 방법 3가지:
- 텔레그램: `/policy D+1 D+10 [사유]`
- Supabase 대시보드 직접 update
- 6주 연속 동일 권고 + 정책과 차이 시 텔레그램 적용 권고 알림 (사용자가 적용 결정)

**6주 임계값은 임의값**임을 명시 (통계적 정당화는 27주 이상 필요하나 운영 현실 고려한 타협). `APPLY_THRESHOLD_WEEKS` 상수 1줄로 조정 가능.

### 텔레그램 메시지

- **일일 ALERT/SAVE 끝 한 줄**: `📊 주간진단(M/D): 🛡 방어 | 권장 D+2매수→D+10매도 | 점수건강 양호 | TOP1알파 +9.8%p ⚠️ 적용중 D+0→D+3 (1주 차이)`
- **일요일 풀 진단** (cron 직후): 6개 섹션 (시장 레짐 / 권장 매매 타이밍 / 점수 모델 건강도 / TOP1 알파 / 진단 신뢰도 / 운영 정책 비교 / 검토 권고)

### 텔레그램 명령어 추가
- `/진단` — 주간 진단 즉시 실행 (재실행 시 같은 주는 upsert)
- `/policy show` — 현재 매매 정책 + 최신 진단 비교 조회
- `/policy D+1 D+10 [사유]` — 정책 수동 변경 (또는 `/policy 1 10 사유`)

### 자동 생성 파일 (Vercel runtime에서는 skip)
- `OPERATING_STATE.md` (덮어쓰기): 현재 운영 파라미터 단일 페이지
- `WEEKLY_DIAGNOSTICS.md` (append): 주간 진단 시계열 이력

### 프론트엔드 추가

- **추천 카드**: 매수 D+N(MM/DD) 종가 / 매도 D+N(MM/DD) 종가 표시 (active_policy 기준, 평일 N일 후)
- **TOP3 헤더**: 현재 매매 정책 박스 + 진단 권장과 차이 시 노란 경고
- **신규 탭 "📊 운영 진단"**:
  - 현재 정책 카드
  - 차이 알림 (진단 권장 ≠ active_policy)
  - 주간 진단 이력 테이블 (12주, regime/강신호/권장 timing/점수건강/TOP1알파/meta알파/정책일치)
  - 정책 변경 이력 테이블 (active_policy_history)
- **성과 검증 탭 토글**: TOP3 카드에 진입 시점 토글 `D+0 / D+1 / 정책 D+N` — 통계 카드(승률/평균수익/최대수익) 즉시 재계산. `daily_prices.cumulative_return` 기반 클라이언트 환산.

### 데이터베이스 추가

- `weekly_diagnostics`: 주간 진단 누적 (47개 컬럼 — 4 진단 + active 비교 4 + meta 7 + warnings 등)
- `active_policy`: 단일 행 매매 정책 (수동 update only)
- `active_policy_history`: 정책 변경 이력 (trigger 자동 기록)

SQL 파일: `supabase-weekly-diagnostics.sql`, `supabase-active-policy.sql`, `supabase-policy-diff.sql`, `supabase-meta-monitor.sql`

### Cron 스케줄

| 시각 (KST) | 모드 | 비고 |
|----------|------|------|
| 일 22:00 | `weekly-diagnostic` | Phase 1 진단 INSERT + 풀 메시지 발송 |

(alert/save는 Cloudflare Workers로 이관. 12함수 한도 회피 위해 `save-daily-recommendations.js`에 mode 통합.)

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

**Platform**: Windows (C:\Users\knoww\investar)
**공식**: Base(0-25) + Whale(0/15/30) + Momentum(0-30) + Trend(0-15) + SignalAdj = Total(0-100)

> 변경 이력은 [CHANGELOG.md](./CHANGELOG.md) 또는 `git log` 참고.
