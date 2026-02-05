# Supabase 추천 종목 성과 추적 시스템 설정 가이드

## 📋 개요

이 가이드는 Investar 시스템에 Supabase 데이터베이스를 연동하여 추천 종목의 실시간 성과를 추적하는 방법을 설명합니다.

## 🎯 주요 기능

1. **자동 추천 저장**: 종합집계 조회 시 B등급(40점) 이상 종목 자동 저장
2. **실시간 성과 추적**: 저장된 종목의 현재 가격 및 수익률 실시간 계산
3. **연속 급등주 감지**: 2일 이상 연속 상승 중인 종목 자동 표시
4. **일별 가격 기록**: 매일 장 마감 후 자동으로 종가 저장
5. **통계 분석**: 승률, 평균 수익률, 등급별 성과 등 자동 계산

## 🚀 설정 단계

### 1. Supabase 프로젝트 생성

1. [Supabase](https://supabase.com)에 가입 및 로그인
2. 새 프로젝트 생성
   - Organization: 선택 또는 생성
   - Name: `investar-tracking` (원하는 이름)
   - Database Password: 안전한 비밀번호 설정
   - Region: `Northeast Asia (Seoul)` 선택
3. 프로젝트 생성 완료 대기 (약 2분)

### 2. 데이터베이스 스키마 생성

1. Supabase 대시보드에서 **SQL Editor** 메뉴 선택
2. **New Query** 클릭
3. 다음 SQL 파일들을 순서대로 실행:
   - `supabase-recommendations-schema.sql` - 기본 테이블
   - `supabase-expand-recommendations.sql` - 지표 컬럼 확장
   - `supabase-success-patterns.sql` - 성공 패턴 분석 테이블
4. **Run** 버튼 클릭하여 스키마 생성

생성되는 테이블:
- `screening_recommendations`: 추천 종목 이력 (모든 지표 포함)
- `recommendation_daily_prices`: 일별 가격 추적
- `success_patterns`: +10% 수익 달성 종목의 지표 데이터
- `recommendation_statistics` (뷰): 종목별 성과 통계
- `overall_performance` (뷰): 전체 성과 요약
- `volume_indicator_analysis` (뷰): 거래량 지표 통계
- `price_indicator_analysis` (뷰): 시세 지표 통계
- `institutional_indicator_analysis` (뷰): 수급 지표 통계
- `success_pattern_insights` (뷰): 성공 패턴 종합 인사이트

### 3. API 키 확인

1. Supabase 대시보드에서 **Settings** > **API** 메뉴 선택
2. 다음 값 복사:
   - `Project URL`: `https://xxxxx.supabase.co`
   - `anon public key`: `eyJhb...` (긴 JWT 토큰)

### 4. 환경변수 설정

#### 로컬 개발 환경

`.env` 파일에 추가:

```bash
# Supabase Configuration
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Vercel 배포 환경

1. Vercel 프로젝트 대시보드 접속
2. **Settings** > **Environment Variables** 메뉴 선택
3. 다음 변수 추가:
   - `SUPABASE_URL`: Supabase Project URL
   - `SUPABASE_ANON_KEY`: Supabase anon public key
4. 모든 환경(Production, Preview, Development)에 적용
5. **Redeploy** 필요

### 5. 의존성 설치

```bash
npm install
```

`@supabase/supabase-js` 패키지가 자동으로 설치됩니다.

## 📡 API 엔드포인트

### 1. 추천 종목 저장

**POST** `/api/recommendations/save`

Request:
```json
{
  "stocks": [
    {
      "stockCode": "005930",
      "stockName": "삼성전자",
      "currentPrice": 70000,
      "totalScore": 85.5,
      "recommendation": { "grade": "S" },
      "changeRate": 2.3,
      "volume": 12000000,
      "marketCap": 400000000000000
    }
  ]
}
```

Response:
```json
{
  "success": true,
  "saved": 5,
  "date": "2025-11-03",
  "recommendations": [...]
}
```

### 2. 성과 조회

**GET** `/api/recommendations/performance?days=30`

Response:
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
      "days_since_recommendation": 5,
      "consecutive_rise_days": 3,
      "is_winning": true,
      "is_rising": true
    }
  ],
  "statistics": {
    "totalRecommendations": 15,
    "winningCount": 9,
    "losingCount": 6,
    "risingCount": 4,
    "avgReturn": 1.35,
    "winRate": 60.0,
    "maxReturn": 5.8,
    "minReturn": -3.2
  }
}
```

### 3. 일별 가격 업데이트 (Cron)

**POST** `/api/recommendations/update-prices`

- Vercel Cron으로 자동 실행: 매주 월~금 오후 4시 (장 마감 후)
- Schedule: `0 16 * * 1-5`

Response:
```json
{
  "success": true,
  "date": "2025-11-03",
  "total": 20,
  "updated": 18,
  "failed": 2
}
```

## 🔄 자동 저장 플로우

1. 사용자가 **종합집계** 탭에서 "🔄 새로고침" 클릭
2. 스크리닝 API 호출 → 종목 분석
3. 40점(B등급) 이상 종목만 필터링
4. Supabase에 자동 저장 (중복 시 업데이트)
5. 콘솔에 저장 결과 출력

```javascript
✅ 5개 추천 종목 저장 완료 (2025-11-03)
```

## 📊 성과 추적 화면

### 1. 전체 요약 카드

- 전체 승률
- 평균 수익률
- 최고 수익
- 분석 샘플 수

### 2. 연속 급등주 섹션 🔥

- 2일 이상 연속 상승 중인 종목만 표시
- 추천가 vs 현재가 비교
- 수익률 및 연속 상승일 표시

### 3. 등급별 성과 테이블

- S, A, B, C 등급별 통계
- 등급별 승률, 평균 수익률, 최고 수익

## ⚙️ 고급 설정

### Supabase RLS (Row Level Security) 정책

현재 설정:
- **SELECT**: 모든 사용자 읽기 가능 (public)
- **INSERT/UPDATE**: 서비스만 쓰기 가능 (API Key 사용)

추후 사용자 인증 추가 시:
```sql
-- 사용자별 데이터 접근 제어 예시
CREATE POLICY "Users can see their own data" ON screening_recommendations
  FOR SELECT USING (auth.uid() = user_id);
```

### 성능 최적화

인덱스가 자동으로 생성됩니다:
- `idx_recommendations_date`: 날짜순 조회
- `idx_recommendations_active`: 활성 종목 필터링
- `idx_recommendations_stock`: 종목 코드 검색
- `idx_daily_prices_date`: 일별 가격 조회

### 데이터 보관 정책

현재: 무제한 보관

자동 삭제 정책 추가 (선택사항):
```sql
-- 90일 이전 비활성 추천 자동 삭제
DELETE FROM screening_recommendations
WHERE is_active = false
  AND closed_at < NOW() - INTERVAL '90 days';
```

## 🐛 문제 해결

### "Supabase not configured" 에러

**원인**: 환경변수 미설정

**해결**:
1. `.env` 파일 또는 Vercel 환경변수 확인
2. `SUPABASE_URL`, `SUPABASE_ANON_KEY` 값 확인
3. 로컬: 서버 재시작
4. Vercel: Redeploy

### "Database error" 발생

**원인**: 스키마 미생성 또는 권한 문제

**해결**:
1. Supabase SQL Editor에서 스키마 재실행
2. RLS 정책 확인
3. Supabase Logs 확인 (Dashboard > Logs)

### 데이터가 저장되지 않음

**원인**: 점수 40점 미만 종목만 존재

**해결**:
- 40점(B등급) 이상 종목만 자동 저장됨
- 콘솔 로그 확인: `저장할 추천 종목 없음 (40점 이상 없음)`

### 성과 조회가 느림

**원인**: 종목 수가 많고 현재가 조회 지연

**해결**:
- `days` 파라미터 줄이기 (기본 30일 → 7일)
- Supabase 인덱스 확인
- KIS API Rate Limit 확인

## 📊 성공 패턴 분석 시스템 (v2)

### 개요

+10% 수익률 달성 종목들의 추천 시점 지표를 분석하여 "성공하는 종목"의 공통 특징을 추출합니다.

### 작동 방식

1. **데이터 수집** (매일 16:10 KST)
   - 추천 종목 저장 시 모든 지표 값 함께 저장
   - 거래량/시세/수급 지표 20개+

2. **패턴 수집** (매일 16:20 KST)
   - 과거 추천 중 +10% 달성 종목 자동 추출
   - `success_patterns` 테이블에 저장

3. **통계 분석**
   - 뷰를 통해 지표별 평균/중앙값/분포 자동 계산
   - 현재 임계값과 실제 성공 패턴 비교

### API 엔드포인트

**GET** `/api/patterns` - 패턴 분석 결과 조회

**GET** `/api/patterns?collect=true` - 수동 패턴 수집 실행

### 분석 뷰

```sql
-- 거래량 지표 통계
SELECT * FROM volume_indicator_analysis;

-- 시세 지표 통계
SELECT * FROM price_indicator_analysis;

-- 수급 지표 통계
SELECT * FROM institutional_indicator_analysis;

-- 종합 인사이트
SELECT * FROM success_pattern_insights;
```

### 저장되는 지표

**거래량 기준**: volume_ratio, asymmetric_ratio, obv_trend, volume_acceleration, whale 정보
**시세 기준**: rsi, mfi, disparity, vwap_divergence, escape_velocity, upper_shadow_ratio
**수급 기준**: institution_buy_days, foreign_buy_days
**복합 지표**: vpd_score, accumulation_detected

---

## 📈 향후 개선 사항

### Phase 2
- [ ] 사용자별 워치리스트
- [ ] 알림 설정 (목표가 도달 시 알림)
- [ ] 포트폴리오 시뮬레이션

### Phase 3
- [ ] 백테스팅 결과 저장
- [ ] AI 학습 데이터로 활용
- [ ] 승률 분석 리포트 자동 생성

## 📚 참고 자료

- [Supabase 공식 문서](https://supabase.com/docs)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/introduction)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)

## 🔒 보안 주의사항

⚠️ **절대 노출 금지**:
- `SUPABASE_URL`: 공개 가능 (프론트엔드 사용)
- `SUPABASE_ANON_KEY`: 공개 가능 (RLS로 보호)
- `SUPABASE_SERVICE_ROLE_KEY`: **절대 노출 금지** (서버 전용, 필요 시 사용)

✅ **현재 시스템**: anon key만 사용하여 안전

---

**Last Updated**: 2026-02-06
**Version**: 3.29 (Success Pattern Analysis v2)
**Author**: Claude Code with @knwwhr
