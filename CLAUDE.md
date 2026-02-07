# Investar - AI 기반 주식 스크리닝 시스템

## 프로젝트 개요

**Investar**는 한국투자증권 OpenAPI를 활용한 거래량 기반 주식 종목 발굴 시스템입니다.

- **목적**: 거래량 지표로 급등 "예정" 종목 선행 발굴 (Volume-Price Divergence)
- **기술 스택**: Node.js, React (CDN), Vercel Serverless, KIS OpenAPI, Supabase
- **배포 URL**: https://investar-xi.vercel.app
- **버전**: 3.30
- **최종 업데이트**: 2026-02-06

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
```
KIS API 4가지 순위 조회 (KOSPI + KOSDAQ)
├─ 등락률 상승 50개 × 2 = 100개
├─ 거래량 증가율 50개 × 2 = 100개
├─ 거래량 순위 50개 × 2 = 100개
└─ 거래대금 순위 50개 × 2 = 100개
= 400개 → ETF 필터링 → 중복 제거 → ~80-90개
```

### Phase 2: 종목별 데이터 수집
각 종목마다 3가지 API 호출 (일봉 30일 기준):
- `getCurrentPrice()`: 현재가, 거래량, 시총
- `getDailyChart(30)`: 최근 30일 OHLCV
- `getInvestorData(5)`: 기관/외국인 수급

### Phase 3: 지표 분석
- **기본 지표** (`volumeIndicators.js`): 거래량 비율, OBV, VWAP, MFI
- **고급 지표** (`advancedIndicators.js`): 고래 감지, 탈출 속도, 비대칭 거래량
- **선행 지표** (`leadingIndicators.js`): 패턴 매칭 + 거래량 DNA
- **VPD**: divergence = volumeRatio - priceRatio (거래량↑ 가격→ = 고득점)

### Phase 4: 점수 계산 및 등급
```
총점 = Base(0-25) + Whale(0/15/30) + Momentum(0-30) + Trend(0-15) + SignalAdj

등급: ⚠️과열(RSI>80 AND 이격도>115) > S+(90+) > S(75-89) > A(60-74) > B(45-59) > C(30-44) > D(<30)
저장: B등급(50점) 이상만 Supabase 저장
```

---

## 📊 점수 체계 (Scoring System)

### Base Score (0-25점)
거래량 비율(0-8) + VPD raw(0-7) + 시총 보정(-5~+7) + 되돌림 페널티(-3~0) + 연속상승(0-5)

### Whale Score (0/15/30점)
- 확인된 매수고래(🐋) + 확인 조건 충족 → +30점
- 미확인 매수고래 → +15점
- 매도고래(🐳) → 0점 (가점 없음)
- **확인 조건**: 탈출 속도 달성 / 강한 매수세 / 거래량 가속 패턴 (1개 이상)

### Momentum Score (0-30점)
거래량 가속도(0-15) + 연속 상승일(0-10) + 기관 진입 가속(0-5)

### Trend Score (0-15점)
30일 거래량 점진 증가 패턴

### Signal Adjustments
| 신호 | 점수 | 근거 |
|------|------|------|
| 탈출 속도 달성 | +5 | 승률 100%, 수익 +23.58% |
| 윗꼬리 과다 | -10 | 승률 66.7%, 수익 +0.83% |
| 매도고래 3일 내 | -10 | 대량 매도 압력 |

### TOP 3 선별 전략
```
공통 필터: 매수고래(🐋) + 과열 아님
1순위: 매수고래 + 황금구간(50-79점)
2순위: 매수고래 + 70점+
3순위: 매수고래 + 40점+
```

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
| 07:00 | 16:00 | save | 결산: 스크리닝 → Supabase 저장 + 텔레그램 |
| 07:15 | 16:15 | update-prices | 전체 종목 가격 업데이트 |
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
