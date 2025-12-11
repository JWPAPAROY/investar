# 🤖 Investar - AI 기반 주식 스크리닝 시스템

**한국투자증권 OpenAPI 기반 Volume-Price Divergence 시스템**

"거래량 폭발 + 가격 미반영" 신호로 급등 "예정" 종목 선행 발굴

🌐 **배포 URL**: https://investar-xi.vercel.app
📚 **상세 문서**: [CLAUDE.md](./CLAUDE.md)

---

## 🎯 핵심 기능

### 📊 3개 카테고리 스크리닝

**1. 🏆 종합집계**
모든 지표 종합 점수 순위 (30점 이상)

**2. 🐋 고래 감지**
거래량 2.5배 + 가격 3% 상승 (기관/외국인 매수 신호)

**3. 🤫 조용한 매집**
가격 횡보 + 거래량 증가 (세력 물량 모으기, 선행 지표)

---

## 📈 종합 점수 시스템 (v3.5 - Volume-Price Divergence)

**핵심 철학**: "거래량 증가율 높은데 급등 안 한 주식 = 최고 점수"

```
S등급 (75점+): 🔥 최우선 매수 (급등 예정)
A등급 (58-74): 🟢 적극 매수
B등급 (42-57): 🟡 매수 고려
C등급 (25-41): ⚪ 주목

최대 100점 (기본 20 + 선행지표 80)

Volume-Price Divergence:
- 거래량 3배+ && 가격 ±10% → 최고 점수 (28-35점)
- 가격 20%+ 급등 → 페널티 (-15~-25점)
```

---

## 🚀 빠른 시작

```bash
# 저장소 클론
git clone https://github.com/knwwhr/investar.git
cd investar

# 의존성 설치
npm install

# 환경변수 설정 (.env)
KIS_APP_KEY=your_app_key
KIS_APP_SECRET=your_app_secret

# 로컬 서버 실행
npm start
# http://localhost:3001
```

---

## 📡 API 엔드포인트

```bash
# 종합집계
GET /api/screening/recommend?market=ALL&limit=10

# 고래 감지
GET /api/screening/whale?market=KOSPI&limit=5

# 조용한 매집
GET /api/screening/accumulation?market=ALL&limit=5
```

---

## 🗄️ 주요 기능 (v3.5)

- ✅ **Volume-Price Divergence**: 거래량 폭발 + 가격 미반영 신호 ⭐ NEW
- ✅ **동적 종목 풀**: KIS API 4개 순위 기반 53개 종목 확보
- ✅ **ETF/ETN 필터링**: 15개 키워드로 특수 펀드/파생상품 차단
- ✅ **선행 지표 통합**: 패턴+DNA 하이브리드 시스템
- ✅ **거래량 DNA 시스템**: 과거 급등주 패턴 추출 및 현재 종목 매칭
- ✅ **Supabase 성과 추적**: 추천 종목 실시간 성과 모니터링
- ✅ **Vercel Serverless**: 자동 배포 및 Cron Job

---

## 📁 프로젝트 구조 (v3.4 업데이트)

```
investar/
├── api/                       # Vercel Serverless Functions
│   ├── screening/            # 스크리닝 API
│   ├── patterns/             # 패턴 분석 API
│   ├── recommendations/      # 성과 추적
│   └── cron/                 # 정기 작업
├── backend/                  # 백엔드 로직
│   ├── kisApi.js            # KIS OpenAPI 클라이언트
│   ├── screening.js         # 스크리닝 엔진
│   ├── leadingIndicators.js # 선행지표 통합 (패턴+DNA)
│   ├── volumeIndicators.js  # 거래량 지표
│   ├── smartPatternMining.js # D-5 선행 패턴
│   └── volumeDnaExtractor.js # 거래량 DNA 추출
├── index.html               # React SPA 프론트엔드
├── server.js                # 로컬 개발 서버
├── CLAUDE.md                # 상세 문서
└── README.md                # 이 문서
```

---

## ⚙️ 주요 설정

### 환경변수 (Vercel)

```
# 필수
KIS_APP_KEY=<한국투자증권 앱 키>
KIS_APP_SECRET=<한국투자증권 앱 시크릿>

# 선택 (Supabase 성과 추적 시)
SUPABASE_URL=<Supabase 프로젝트 URL>
SUPABASE_KEY=<Supabase Anon Key>
```

### API 제한

- KIS API: 초당 18회 (안전 마진)
- 토큰 발급: 1분당 1회
- Vercel Timeout: 최대 60초
- 순위 API: 최대 30건/호출

---

## ⚠️ 투자 주의사항

**본 시스템은 투자 참고용 도구이며, 투자 결정의 책임은 전적으로 투자자에게 있습니다.**

1. 과열 경고 확인 (거래량 10배 이상)
2. 윗꼬리 주의 (고가 대비 낙폭 30% 이상)
3. 분산 투자 (상위 5-10개 종목)
4. 손절 설정 (-5~7% 권장)

---

## 📝 최신 업데이트

### v3.12.1 (2025-12-11) - ⚠️ 복합 신호 페널티 시스템
- ✅ **백테스트 기반 복합 신호 필터링**
  - 복합 신호(고래+조용한매집): 승률 11.1%, 평균 -9.54% ❌
  - 고래 단독: 승률 64.7%, 평균 +20.31% ✅
- ✅ **-15점 페널티 적용**
  - "이미 급등 시작" 종목 자동 제외
  - Base Score 복합 신호 시 0점 하락
- ✅ **선행 지표 정확도 향상**
  - 복합 신호 종목 저장 제외 (45점 미만)

### v3.5 (2025-11-12) - 🎯 Volume-Price Divergence 시스템
- ✅ **Volume-Price Divergence 철학 확립**
  - "거래량 증가율 높은데 급등 안 한 주식 = 최고 점수"
  - divergence = volumeRatio - priceRatio
  - 조용한 매집 (Quiet Accumulation) 우선 발굴
- ✅ **공매도 로직 완전 제거**
  - KRX API가 공매도 데이터 미제공 확인
  - 관련 파일 및 점수 체계 제거
- ✅ **점수 체계 복원**: 120점 → 100점
  - S: 75+, A: 58-74, B: 42-57, C: 25-41
- ✅ **이미 급등한 종목 페널티**: -15~-25점

### v3.4 (2025-11-06) - 선행 지표 통합
- ✅ **패턴+DNA 통합**
  - smartPatternMining + volumeDnaExtractor 통합
  - leadingIndicators.js 모듈 생성
  - 패턴 50% + DNA 50% 하이브리드 점수

---

## 📚 참고 자료

- **상세 문서**: [CLAUDE.md](./CLAUDE.md) - 전체 시스템 설명
- **Supabase 설정**: [SUPABASE_SETUP.md](./SUPABASE_SETUP.md)
- **KIS Developers**: https://apiportal.koreainvestment.com
- **Vercel Docs**: https://vercel.com/docs/functions
- **GitHub**: https://github.com/knwwhr/investar

---

## 🎉 v3.5 주요 특징

- 🔥 **Volume-Price Divergence**: 거래량 폭발 + 가격 미반영 신호
- 🎯 **선행 지표**: 패턴+DNA 하이브리드 시스템
- 📊 **100점 만점**: S등급 75점 이상 (급등 예정)
- ⚡ **이미 급등한 종목 페널티**: -15~-25점 차감
- ✨ **조용한 매집 우선 발굴**: Quiet Accumulation 신호

---

**Version**: 3.5 (Volume-Price Divergence)
**Author**: Claude Code with @knwwhr
**Last Updated**: 2025-11-12

**✨ "거래량 폭발 + 가격 미반영 = 급등 예정" - Volume-Price Divergence로 선행 발굴**
