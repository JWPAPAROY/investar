# Investar 운영 상태 (자동 생성)

> ⚠️ 이 파일은 매주 일요일 22:00 KST `weekly-diagnostic` cron에 의해 **덮어쓰기**됩니다.
> 수동 편집하지 마세요. CLAUDE.md(설계 문서)와 분리된 자동 운영 상태 파일입니다.

**최종 갱신**: 2026-05-04 (asOf 기준 주의 시작일)

---

## 현재 운영 파라미터

| 항목 | 값 |
|------|-----|
| **권장 매수일** | D+? 종가 |
| **권장 매도일** | D+? 종가 |
| **점수 모델 건강도** | ✅ 양호 (r=0.80) |
| **TOP1 알파 (현재 D+0,D+3)** | +1.69%p |
| **TOP1 알파 (권장 timing)** | N/A |

## 진단 표본

- **강신호 종목 T+3 평균**: -4.58% (n=59)
- **권장 timing in-sample 평균**: N/A
- **권장 timing 최저주**: N/A
- **in-sample 기간**: 8주 / 표본 null건
- **평가 대상 추천 수**: 1511

## 진단 신뢰도 (meta-monitor)

- 데이터 누적 중 (4주 후부터 표시)

## ⚠️ 경고

- no (k,n) all-positive in in-sample
- meta-monitor: 4주 전 진단 없음 (데이터 누적 필요)


---

## Phase 3 상태 (자동 적용 운영 중)

- **현재**: 주간진단 권장 timing이 현재 정책과 다르면 `active_policy` 자동 갱신.
- **이력**: [WEEKLY_DIAGNOSTICS.md](./WEEKLY_DIAGNOSTICS.md)
