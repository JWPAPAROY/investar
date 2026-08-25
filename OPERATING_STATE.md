# Investar 운영 상태 (자동 생성)

> ⚠️ 이 파일은 **DB(weekly_diagnostics / active_policy)에서 통째로 렌더**됩니다.
> 수동 편집하지 마세요 — 다음 렌더에서 덮어쓰입니다.
> 갱신 주체: `.github/workflows/render-operating-state.yml` (일요일 진단 cron 이후) 또는
> 로컬 `node scripts/render-operating-state.js`.
> ※ Vercel cron은 read-only FS라 이 파일을 쓰지 못합니다. 그래서 갱신을 CI로 분리했습니다.

**최종 렌더**: 2026-08-25 12:11 KST
**최신 진단 주**: 2026-08-17 (asOf 기준 주의 시작일)

---

## 🔴 실제 적용 중인 매매 정책 (active_policy)

| 항목 | 값 |
|------|-----|
| **적용 중** | D+2 종가 매수 → D+10 종가 매도 |
| **적용 시작** | 2026-08-23 |
| **설정 주체** | auto-diagnostic |
| **사유** | 주간진단(2026-08-17) 자동적용: D+2→D+10 (quality=majority, in-sample avg -4.63%, 2주 연속 권고) |


## 최신 진단 권장값

| 항목 | 값 |
|------|-----|
| **권장 매수일** | D+2 종가 |
| **권장 매도일** | D+10 종가 |
| **점수 모델 건강도** | ✅ 양호 (ρ=0.40) |
| **건강도 판정축** | 스윗스팟축 (v3.96 이전 기준) |
| **TOP1 알파 (적용 중 timing)** | -1.06%p |
| **TOP1 알파 (권장 timing)** | -1.82%p |

## 진단 표본

- **권장 timing in-sample 평균**: -4.63%
- **권장 timing 최저주**: -30.70%
- **OOS 검증 수익**: N/A (n=0)
- **in-sample 기간**: 8주 / 표본 55건
- **평가 대상 추천 수**: 1438

## 진단 신뢰도 (meta-monitor)

- **4주 전 권장**: D+1 → D+2
- **가상 운영 평균**: -1.13% (n=43, 승률 44%)
- **baseline 대비 알파**: +1.19%p ✅ 진단 효과 확인

## ⚠️ 경고

- optimal timing quality=majority (현행 대비 우세 주 비율 86% (edge 평균 1.64%p, 최저주 -3.28%p)) — 권고만, 자동적용 보류
- 최신 in-sample 주(2026-08-10) 표본<3으로 권고 산출에서 제외 — 권고가 최근 레짐 미반영일 수 있음
---

## Phase 3 (자동 적용) 이력

- **규칙**: quality=robust면 즉시, majority면 **2주 연속 동일 권고**일 때 `active_policy` 자동 갱신.
  v3.95부터 판정은 절대 부호가 아니라 **현행 정책 대비 상대 우열**이라, 하락 레짐에서는
  "덜 잃는 쪽"으로도 게이트가 열린다(채택안의 in-sample 평균이 음수일 수 있음).
- **주간 상세**: [WEEKLY_DIAGNOSTICS.md](./WEEKLY_DIAGNOSTICS.md)

| 변경 시각(KST) | 이전 | 이후 | 주체 | 사유 |
|---|---|---|---|---|
| 2026-08-23 22:42 | D+1→D+10 | D+2→D+10 | auto-diagnostic | 주간진단(2026-08-17) 자동적용 (quality=majority, 2주 연속, in-sample avg -4.63%, min -30.70%) |
| 2026-08-23 22:42 | D+1→D+10 | D+2→D+10 | auto-diagnostic | 주간진단(2026-08-17) 자동적용: D+2→D+10 (quality=majority, in-sample avg -4.63%, 2주 연속 권고) |
| 2026-05-05 11:54 | D+2→D+10 | D+1→D+10 | manual | v376복귀+D+1매수확인: 동일데이터 역대전략비교에서 v376 D+1→D+10 +11.48% 최고. D+1기준 최적 보유기간 스캔에서 D+10이 정점 확인. |
| 2026-04-30 19:24 | D+0→D+3 | D+2→D+10 | auto-diagnostic | 주간진단(2026-04-27) 자동적용 (in-sample avg 6.03%, min 1.01%) |
