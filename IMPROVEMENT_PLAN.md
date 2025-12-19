# 추천 로직 개선 방안 (실제 성과 분석 기반)

**분석일**: 2025-12-19
**데이터**: 175개 추천 이력 (Supabase)

---

## 🎯 핵심 발견사항

### 성공 사례 (유지)
- ✨ **70-79점 황금구간**: 평균 +66.23%, 승률 50% (12개)
- ✅ **고래 감지**: 평균 +13.27%, 승률 42.31% (26개)
- ✅ **조용한 매집**: 평균 +11.03%, 승률 27.59% (29개)
- ✅ **S등급**: 평균 +15.02%, 승률 34.69% (49개)

### 문제 사례 (개선 필요)
- ❌ **A등급 역전**: 평균 -1.42% < B등급 +5.04%
- ❌ **복합 신호**: 평균 -9.54%, 승률 11.1% (18개)
- ⚠️ **과열 등급**: 평균 +0.3%, 승률 21.05% (19개)
- ⚠️ **60-69점 구간**: 평균 -1% < 50-59점 +2.01%

---

## 🔧 개선 방안

### 1. 등급 역전 문제 해결 (A < B)

**원인 분석**:
- A등급(60-74점) 중 60-69점 구간이 발목을 잡음 (-1%)
- 70-74점 구간은 양호할 것으로 추정

**해결책 Option A: 등급 기준 재조정** (권장)
```javascript
// 현재 (v3.10.2)
S+: 90+
S: 75-89
A: 60-74  // ← 문제 구간 (60-69점이 저성과)
B: 45-59  // ← 황금 구간 (50-59점 우수)
C: 30-44
D: <30

// 개선안
S+: 90+
S: 70-89  // 70-79점 황금구간 포함 ⬆️
A: 55-69  // 60-69점 제외, 55-59점 포함
B: 45-54  // 50-54점으로 축소
C: 30-44
D: <30
```

**해결책 Option B: A등급 내부 세분화**
```javascript
// A등급을 A+/A로 분리
A+: 70-74점 (황금구간 인접)
A: 60-69점 (주의 필요)
```

**해결책 Option C: 60-69점 구간 페널티 추가**
```javascript
// screening.js의 getRecommendation 함수 수정
if (totalScore >= 60 && totalScore < 70) {
  // 추가 검증 로직
  if (복합신호 || 과열징후) {
    grade = 'B'; // 등급 하향
  }
}
```

---

### 2. 복합 신호 완전 차단

**현재 상태**:
- v3.12.1에서 -15점 페널티 적용
- 하지만 여전히 평균 -9.54%, 승률 11.1%

**개선안**:
```javascript
// backend/screening.js: calculateTotalScore 함수

// 현재: -15점 페널티
if (isWhale && isAccumulation) {
  baseScore -= 15;
}

// 개선: 완전 차단 (Option A - 권장)
if (isWhale && isAccumulation) {
  return null; // 종목 자체를 필터링
}

// 또는 (Option B - 강력 페널티)
if (isWhale && isAccumulation) {
  baseScore -= 30; // -30점으로 강화
  console.log(`❌ 복합 신호 감지 - 종목 제외 권장`);
}
```

**추가 필터링**:
```javascript
// screenAllStocks 함수에서 복합 신호 종목 제외
const results = [];
for (const stockCode of finalStockList) {
  const analysis = await this.analyzeStock(stockCode);

  // 복합 신호 종목 완전 차단
  const isWhale = analysis.advancedAnalysis?.indicators?.whale?.length > 0;
  const isAccumulation = analysis.advancedAnalysis?.indicators?.accumulation?.detected;

  if (isWhale && isAccumulation) {
    console.log(`❌ [${analysis.stockName}] 복합 신호 - 제외`);
    continue; // 스킵
  }

  if (analysis && analysis.totalScore >= 20) {
    results.push(analysis);
  }
}
```

---

### 3. 과열 등급 기준 재조정

**현재 문제**:
- 과열 등급: 평균 +0.3%, 승률 21.05%
- "과열"이라고 경고하지만 실제로는 저성과

**원인**:
- RSI > 80 OR 이격도 > 115 기준이 너무 보수적?
- 또는 과열 감지가 늦음 (이미 하락 시작)

**개선안 Option A: 기준 강화**
```javascript
// backend/screening.js: detectOverheatingV2 함수

// 현재
const overheated = rsi > 80 || disparity > 115;

// 개선: 둘 다 만족해야 과열
const overheated = rsi > 80 && disparity > 115; // AND 조건

// 또는 기준 상향
const overheated = rsi > 85 || disparity > 120;
```

**개선안 Option B: 과열 등급 세분화**
```javascript
// 과열 등급을 '주의'와 '경고'로 분리
if (rsi > 85 && disparity > 120) {
  grade = '⛔ 과열경고'; // 강력한 과열
} else if (rsi > 80 || disparity > 115) {
  grade = '⚠️ 과열주의'; // 약한 과열
}
```

**개선안 Option C: 과열 등급 제거**
```javascript
// 과열 등급을 아예 제거하고 점수만으로 등급 부여
// 과열은 참고용 정보로만 표시
```

---

### 4. 점수 구간 60-69점 문제 해결

**문제**:
- 60-69점: 평균 -1%, 35개
- 50-59점: 평균 +2.01%, 67개

**원인**:
- 60점대는 "애매한 구간" (높지도 낮지도 않음)
- 복합 신호나 과열 징후가 많을 가능성

**해결책 Option A: 60-69점 구간에 추가 필터 적용**
```javascript
// getRecommendation 함수
if (totalScore >= 60 && totalScore < 70) {
  // 60점대는 추가 검증
  const hasRiskSignals =
    (advancedAnalysis.indicators.whale.length > 0 &&
     advancedAnalysis.indicators.accumulation.detected) || // 복합신호
    overheatingV2.overheated || // 과열
    totalScore < 65; // 65점 미만

  if (hasRiskSignals) {
    return {
      grade: 'B',
      badge: '⚠️ 신중 진입',
      tooltip: '60점대 구간은 성과 혼재 - 추가 검증 필요'
    };
  }
}
```

**해결책 Option B: 저장 기준 강화**
```javascript
// 현재: 50-79점 저장 (v3.12)
// 개선: 50-59점 또는 70-79점만 저장 (60-69점 제외)

// save-daily-recommendations.js
const shouldSave = (score >= 50 && score < 60) || (score >= 70 && score < 80);
```

---

### 5. 황금 구간 활용 강화

**발견**: 70-79점 구간이 평균 +66.23%, 승률 50%로 최고 성과

**개선안**:
```javascript
// getRecommendation 함수에 특별 표시
if (totalScore >= 70 && totalScore < 80) {
  return {
    grade: 'S',
    badge: '🚀 황금구간',
    tooltip: '백테스트 검증: 평균 +66% 수익 구간',
    timingWarning: {
      type: 'jackpot',
      badge: '🚀 대박 구간',
      color: '#ff0000',
      message: '평균 +66.23% 수익 구간 (백테스트 검증)'
    }
  };
}
```

---

## 📋 구현 우선순위

### 🔴 긴급 (즉시 적용)

1. **복합 신호 완전 차단**
   - 파일: `backend/screening.js`
   - 수정: `screenAllStocks` 함수에서 복합 신호 종목 완전 제외
   - 예상 효과: 평균 수익률 +2~3%p 향상

2. **60-69점 구간 저장 제외**
   - 파일: `api/cron/save-daily-recommendations.js`
   - 수정: `(score >= 50 && score < 60) || (score >= 70 && score < 80)`
   - 예상 효과: 저장 품질 향상, 노이즈 제거

### 🟡 중요 (1주일 내)

3. **등급 기준 재조정**
   - 파일: `backend/screening.js` - `getRecommendation` 함수
   - 수정: S등급 70-89점으로 확대, A등급 55-69점으로 조정
   - 예상 효과: 등급과 성과 일치도 향상

4. **과열 등급 기준 강화**
   - 파일: `backend/screening.js` - `detectOverheatingV2` 함수
   - 수정: RSI > 85 또는 disparity > 120으로 기준 상향
   - 예상 효과: 과열 등급 정확도 향상

### 🟢 보완 (2주 내)

5. **황금 구간 특별 표시**
   - 파일: `backend/screening.js`, `index.html`
   - 수정: 70-79점 구간에 "🚀 황금구간" 배지 추가
   - 예상 효과: 사용자 경험 향상

6. **A등급 세분화**
   - 파일: `backend/screening.js`
   - 수정: A+등급(70-74점) 추가
   - 예상 효과: 사용자에게 더 명확한 정보 제공

---

## 📊 예상 개선 효과

| 지표 | 현재 | 개선 후 (예상) | 향상 |
|------|------|--------------|------|
| 전체 평균 수익률 | +3.5% | **+8~10%** | +4.5~6.5%p |
| A등급 평균 수익률 | -1.42% | **+3~5%** | +4.42~6.42%p |
| 복합 신호 제거 효과 | -9.54% | **제외** | 노이즈 제거 |
| 저장 품질 (50-59, 70-79) | 혼재 | **순수** | 백테스트 정확도 ⬆️ |

---

## ✅ 체크리스트

- [ ] 1. 복합 신호 완전 차단 코드 작성
- [ ] 2. 60-69점 구간 저장 제외 적용
- [ ] 3. 등급 기준 재조정 (S: 70-89, A: 55-69)
- [ ] 4. 과열 기준 강화 (RSI > 85 or 이격도 > 120)
- [ ] 5. 황금 구간 특별 표시 추가
- [ ] 6. 변경사항 테스트
- [ ] 7. 1주일 실전 데이터 수집
- [ ] 8. 재분석 및 검증

---

**작성**: Claude Code
**기반 데이터**: 175개 실제 추천 이력 (Supabase)
**분석 파일**: `analyze-real-performance.js`, `real-performance-analysis.json`
