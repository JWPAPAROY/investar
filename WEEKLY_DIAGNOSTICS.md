# Investar 주간 진단 이력 (auto-append)

> **DB(weekly_diagnostics)에서 통째로 렌더**됩니다. 최신 항목이 맨 위.
> 갱신: `node scripts/render-operating-state.js` 또는 render-operating-state 워크플로.

---

## 2026-08-24

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+9 |
| 그 주 적용 정책 | D+2 → D+10 |
| in-sample 평균 / 최저주 | -0.85% / -21.06% |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | broken (ρ=-0.20, monotone) |
| TOP1 알파 (현재 / 권장) | -3.48%p / -5.25%p |
| 경고 | score_health: 밴드 4개짜리 상관 — 라벨은 참고용(주간 널뛰기 정상); 최신 in-sample 주(2026-08-17) 표본<3으로 권고 산출에서 제외 — 권고가 최근 레짐 미반영일 수 있음; optimal timing quality=majority (현행 대비 우세 주 비율 86% (edge 평균 2.33%p, 최저주 -1.66%p)) — 연속 1주(<2)로 자동적용 보류, 권고만 |


## 2026-08-17

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+10 |
| 그 주 적용 정책 | D+2 → D+10 |
| in-sample 평균 / 최저주 | -4.63% / -30.70% |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | healthy (ρ=0.40) |
| TOP1 알파 (현재 / 권장) | -1.06%p / -1.82%p |
| 경고 | optimal timing quality=majority (현행 대비 우세 주 비율 86% (edge 평균 1.64%p, 최저주 -3.28%p)) — 권고만, 자동적용 보류; 최신 in-sample 주(2026-08-10) 표본<3으로 권고 산출에서 제외 — 권고가 최근 레짐 미반영일 수 있음 |


## 2026-08-10

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+10 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | -5.83% / -30.70% |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | broken (ρ=0.00) |
| TOP1 알파 (현재 / 권장) | -1.34%p / -2.78%p |
| 경고 | optimal timing quality=majority (현행 대비 우세 주 비율 86% (edge 평균 1.80%p, 최저주 -3.28%p)) — 권고만, 자동적용 보류; 최신 in-sample 주(2026-08-03) 표본<3으로 권고 산출에서 제외 — 권고가 최근 레짐 미반영일 수 있음 |


## 2026-08-03

| 항목 | 값 |
|------|-----|
| 권장 timing | D+0 → D+2 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | -0.58% / -7.73% |
| OOS 검증 | -3.13% (n=11) |
| 점수 건강도 | inverted (ρ=-0.60) |
| TOP1 알파 (현재 / 권장) | -2.66%p / -0.58%p |
| 경고 | optimal timing quality=majority (현행 대비 우세 주 비율 71% (edge 평균 9.67%p, 최저주 -1.16%p)) — 권고만, 자동적용 보류 |


## 2026-07-27

| 항목 | 값 |
|------|-----|
| 권장 timing | D+1 → D+2 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | -1.47% / -5.38% |
| OOS 검증 | -5.38% (n=7) |
| 점수 건강도 | healthy (ρ=1.00) |
| TOP1 알파 (현재 / 권장) | -0.44%p / +0.87%p |
| 경고 | optimal timing quality=least_bad (전주 +비율 25%) — 권고만, 자동적용 보류 |


## 2026-07-20

| 항목 | 값 |
|------|-----|
| 권장 timing | D+1 → D+2 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | -1.02% / -4.49% |
| OOS 검증 | -2.62% (n=4) |
| 점수 건강도 | inverted (ρ=-0.80) |
| TOP1 알파 (현재 / 권장) | +7.11%p / +1.23%p |
| 경고 | optimal timing quality=least_bad (전주 +비율 25%) — 권고만, 자동적용 보류 |


## 2026-07-13

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+3 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | +0.45% / -3.22% |
| OOS 검증 | +1.18% (n=7) |
| 점수 건강도 | inverted (ρ=-1.00) |
| TOP1 알파 (현재 / 권장) | +4.89%p / +1.12%p |
| 경고 | optimal timing quality=least_bad (전주 +비율 63%) — 권고만, 자동적용 보류 |


## 2026-07-06

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+3 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | +3.08% / -1.26% |
| OOS 검증 | -0.92% (n=6) |
| 점수 건강도 | healthy (ρ=0.50) |
| TOP1 알파 (현재 / 권장) | -0.66%p / +0.31%p |
| 경고 | optimal timing quality=least_bad (전주 +비율 43%) — 권고만, 자동적용 보류; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-06-29

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+3 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | +3.75% / -1.26% |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | healthy (ρ=0.50) |
| TOP1 알파 (현재 / 권장) | -1.58%p / -1.28%p |
| 경고 | optimal timing quality=least_bad (전주 +비율 50%) — 권고만, 자동적용 보류; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-06-22

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+3 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | +3.75% / -1.26% |
| OOS 검증 | +7.93% (n=5) |
| 점수 건강도 | healthy (ρ=0.80) |
| TOP1 알파 (현재 / 권장) | -0.58%p / -0.40%p |
| 경고 | optimal timing quality=least_bad (전주 +비율 50%) — 권고만, 자동적용 보류; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-06-15

| 항목 | 값 |
|------|-----|
| 권장 timing | D+1 → D+10 |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | +1.58% / -18.44% |
| OOS 검증 | +0.43% (n=6) |
| 점수 건강도 | healthy (ρ=0.80) |
| TOP1 알파 (현재 / 권장) | -0.25%p / -3.36%p |
| 경고 | optimal timing quality=majority (전주 +비율 75%) — 권고만, 자동적용 보류; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-06-08

| 항목 | 값 |
|------|-----|
| 권장 timing | D+? → D+? |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | N/A / N/A |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | inverted (ρ=-0.50) |
| TOP1 알파 (현재 / 권장) | -2.24%p / N/A |
| 경고 | no (k,n) all-positive in in-sample; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-06-01

| 항목 | 값 |
|------|-----|
| 권장 timing | D+? → D+? |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | N/A / N/A |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | broken (ρ=0.00) |
| TOP1 알파 (현재 / 권장) | -1.78%p / N/A |
| 경고 | no (k,n) all-positive in in-sample; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-05-25

| 항목 | 값 |
|------|-----|
| 권장 timing | D+? → D+? |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | N/A / N/A |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | broken (ρ=0.00) |
| TOP1 알파 (현재 / 권장) | -1.91%p / N/A |
| 경고 | no (k,n) all-positive in in-sample |


## 2026-05-18

| 항목 | 값 |
|------|-----|
| 권장 timing | D+? → D+? |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | N/A / N/A |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | broken (ρ=0.00) |
| TOP1 알파 (현재 / 권장) | -0.10%p / N/A |
| 경고 | no (k,n) all-positive in in-sample; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-05-11

| 항목 | 값 |
|------|-----|
| 권장 timing | D+? → D+? |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | N/A / N/A |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | broken (ρ=0.20) |
| TOP1 알파 (현재 / 권장) | -0.52%p / N/A |
| 경고 | no (k,n) all-positive in in-sample; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-05-04

| 항목 | 값 |
|------|-----|
| 권장 timing | D+? → D+? |
| 그 주 적용 정책 | D+1 → D+10 |
| in-sample 평균 / 최저주 | N/A / N/A |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | healthy (ρ=0.40) |
| TOP1 알파 (현재 / 권장) | +1.28%p / N/A |
| 경고 | no (k,n) all-positive in in-sample; meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |


## 2026-04-27

| 항목 | 값 |
|------|-----|
| 권장 timing | D+2 → D+10 |
| 그 주 적용 정책 | D+2 → D+10 |
| in-sample 평균 / 최저주 | +6.03% / +1.01% |
| OOS 검증 | N/A (n=0) |
| 점수 건강도 | healthy (ρ=1.00) |
| TOP1 알파 (현재 / 권장) | -1.19%p / +7.80%p |
| 경고 | meta-monitor: 4주 전 진단 없음 (데이터 누적 필요) |

