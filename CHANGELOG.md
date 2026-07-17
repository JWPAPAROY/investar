# Investar 변경 이력

> 설계 문서는 [CLAUDE.md](./CLAUDE.md), 운영 상태는 [OPERATING_STATE.md](./OPERATING_STATE.md), 주간 진단은 [WEEKLY_DIAGNOSTICS.md](./WEEKLY_DIAGNOSTICS.md) 참고.

## 📝 변경 이력

### v3.94 (2026-07-17)
- **웹과 텔레그램이 서로 다른 TOP3를 내보내고 있었음 → 통일**: `screening.js:selectTop3`(웹 `/api/screening/recommend` → 프론트 `top3Meta` 경로)가 **v3.85에 멈춰 있었다**.
  - 정렬이 폐기된 `isV2Priority → total_score → 수급`. CLAUDE.md는 v3.86에서 "v385(isV2Priority) 성과 최하위(+4.40%)로 복귀 결정"이라 기록했으나 웹 경로엔 미반영.
  - **`applyMomentumCapFloor`(v3.90~3.92)가 아예 없었다** → 텔레그램이 무픽인 날에도 웹은 마이크로캡을 추천. 2026-07-17 실측: 웹 TOP3 = 삼성공조(1,104억)·파세코(1,606억) — 둘 다 1조 플로어 탈락 대상이고, v3.92가 "나노캠텍 -19.1%" 때문에 제거한 바로 그 종류. 무픽은 "풀이 나쁘다"는 신호인데 웹만 그 신호를 무력화했다.
  - `backend/marketRegime.js` 신설(레짐 판정이 save-daily 안에만 있어 웹이 못 씀), `applyMomentumCapFloor`를 `top3Ranking.js`로 이동. selectTop3는 async로 전환.
- **`getTop3FromDb`가 제5의 정렬을 쓰고 있었음**: "점수 1차 → 수급 2차"(v3.83)로 정렬하면서 주석은 "selectSaveTop3/selectAlertTop3과 동일"이라 주장. 알림(08:00)·추적 메시지가 이 함수를 쓰므로 **15:35 결산이 매긴 🥇🥈🥉가 다음날 아침엔 다른 순서로 표시될 수 있었다**. `resolveTop3Order`로 교체(저장된 `top3_rank` 우선, 없으면 v387 재구성).
- **배점표 대조 결과 — CLAUDE.md와 코드 완전 일치** (거래량비율/VPD/시총/되돌림/연속상승/Base cap/등급컷/과열). 다만 코드 내 주석이 부패: `calculateTotalScore` 위 "거래량 비율 0-3점, OBV 0-3, VWAP 0-3, 비대칭 0-4"(v3.23 이전), `getRecommendation` 위 "Radar Scoring 0-92점 (Base 17 + Momentum 45 + Trend 40)"(v3.21) — 실제와 무관.
- **문서-실제 불일치 정정**: `leadingIndicators.js`(구조도에 있으나 미존재, 실제는 `similarityMatcher.js`), `api/screening/[category].js`(미존재), `check-today.js`(To-Do #3 참조, `.gitignore`의 `check-*.js`로 유실 — `performance.js:492~568`에 `diagnosis`로 이미 구현됨).
- **죽은 코드 705줄 제거**: 호출 0회 확인 후 삭제 (`screening.js` 2058→1502줄, `save-daily` 3519→3380줄).
  - 정렬 사본 보유(부활 시 드리프트 위험): `selectSidewaysTop3`(124줄)·`selectSidewaysAlertTop3`(59)·`selectSidewaysSaveTop3`(54)·`screenByCategory`(61, `[category].js` 부재)
  - v3.23/v3.24에서 개념이 제거됐으나 함수만 남아 있던 것: `calcVolumeAccelerationScore`·`calcVPDImprovementScore`·`calcPatternStrengtheningScore`·`analyzeShortTermVolumeMomentum`·`analyzeInstitutionalAccumulation`·`analyzeVolatilityContraction`·`analyzeVPDStrengthening`
  - 기타: `findGradualAccumulationStocks`·`selectWhaleStocks`·`getYesterdayDateKST`
  - `clearCache`는 캐시 유틸이라 보존. 삭제 후 로드·단위검증(무픽/스윗스팟/수급우선) 통과.
- **주석 부패 정리**: CLAUDE.md는 정확했으나 **코드 바로 옆 주석이 실제와 달라** 읽는 사람을 오도했다.
  - `calculateTotalScore`: "거래량 0-3 / OBV 0-3 / VWAP 0-3 / 비대칭 0-4"(v3.21) → 실제 거래량 0-8, OBV·VWAP·비대칭은 Base 미반영
  - `getRecommendation`: "0-92점 (Base 17 + Momentum 45 + Trend 40 + MultiSignal 6)", 과열 "RSI>80 AND 이격도>115"(v3.21) → 실제 0-100, 과열 RSI>85 AND 이격도>120
  - `calculate5DayMomentum`: "0-45점, VPD 개선도 0-20점"(v3.20) → 실제 0-30, VPD는 v3.23에서 제거
  - `calculateTrendScore`: "0-40점 + 이미 제거된 4개 컴포넌트"(v3.20) → 실제 0-15
  - `save-daily` 파일 헤더: "alert 08:30", "TOP3 선별: 1순위 매수고래 + 황금구간(50-89점)"(v3.32, 폐기된 전략) → 실제 08:00 / v387
- **CLAUDE.md cron 표 정정**: track 4회차가 **15:00이 아니라 14:30 KST**(`vercel.json` `30 5 * * 1-5` = 05:30 UTC).
- **`backend/top3Ranking.js` 신설 — TOP3 순위(🥇🥈🥉) 단일 출처**: v387 정렬(수급등급→기관매수일→스윗스팟)이 `selectSaveTop3`(camelCase)·`selectAlertTop3`(snake_case)에 각각 복사돼 있었고, `weekly-diagnostic.js`는 제3의 기준(`total_score` 내림차순)으로 순위를 재구성하고 있었다. 스윗스팟 밴드는 50-59점을 90+점보다 선호하므로 점수 정렬과 순서가 뒤집힌다 → **실측 57%의 날에 진단의 TOP1 ≠ 실제 🥇**(2026-06-01~, n=23). TOP1 알파 진단이 존재한 적 없는 종목을 측정하고 있었음. 리팩터 동등성 검증 완료(43일 전부 일치 — 추천 동작 불변). (k,n) 스캔·Score Health는 TOP3 3개를 통째로 평균 내므로 영향 없음.
- **`top3_rank` 저장 (`supabase-top3-rank.sql`)**: 순위가 저장되지 않아 사후 재구성에 의존했다. 정렬 로직이 v376→v384→v385→v387로 바뀌어 왔으므로 재구성으로는 "그날 실제 순서"를 복원할 수 없다 → 사실로 저장. 과거는 NULL 유지(백필하면 그날 보여진 순서와 달라짐), 분석은 `resolveTop3Order()`가 저장된 순위 우선·없으면 현재 comparator로 일관 평가. 컬럼 존재를 런타임 감지(`supportsTop3Rank`)해 마이그레이션 전에도 배포 안전.
- **주간진단 "현재 정책"이 하드코딩 `(0,3)`이었음**: 컬럼명(`top1_alpha_current_timing`)과 텔레그램 라벨은 "현재 정책 (D+0매수)"라 말하는데 실제 `active_policy`는 D+1→D+10(2026-05-05~). Score Health는 이미 active_policy를 따랐으므로 TOP1 알파도 통일. CLAUDE.md v3.89 "평가는 active_policy 지평으로 — D+3 평가 금지" 위반이었음.
- **⚠️ 위 수정 + D+N 정정의 결과로 진단 결론 2개가 뒤집힘** (2026-07-13주 dry-run):
  - `score_health`: 4주 연속 `healthy` → **`inverted`(ρ=-0.80)**. 최선호 밴드 50-59가 -16.77%로 전 구간 최악, 최하 선호 45-49가 -9.31%로 최선. 기존 `healthy`는 편향 표본(월·화 39%)이 만든 착시였음. 단 전 구간이 음수인 폭락 윈도우라 신호 역전이 아니라 베타일 수 있음(표본 n=5~26).
  - `top1_alpha_current_timing`: 4주 연속 음수(-0.25~-1.58) → **+1.15%p**. 실제 🥇는 TOP3 평균을 상회. To-Do #4("TOP2 최하위, TOP3>TOP1")의 전제 재검토 필요.
- **D+N을 거래일 기준으로 정정 (평가 표본 61% 누락 수정)**: `update-prices.js`가 `days_since_recommendation`을 달력일 차이로 계산했으나 행은 거래일에만 생성 → D+N에 구조적 구멍. 실측(2026-04-01~07-05, n=2131): **금요일 추천의 D+1 존재율 0%**(토요일), **수·목요일 추천의 D+10 존재율 0%**(토·일). `weekly-diagnostic.js`가 `pIdx[recId][k]`로 직접 인덱싱해 해당 건이 에러 없이 탈락 → **active_policy(D+1→D+10) 평가가 월·화 추천(≈39%)만으로 수행되고 있었음**. 요일 편향이라 무작위 누락이 아님. `backfill-missing-days.js`의 주석("day 1 = 다음 거래일")이 원래 의도가 거래일 기준이었음을 확인시켜줌 — 구현만 달력일로 어긋나 있었다. 기존 90,492행 중 73,109행(81%)이 재번호 대상 → `scripts/renumber-trading-days.js`(멱등).
- **`backend/marketCalendar.js` 신설 — 거래일/휴장일 단일 출처**: `save-daily-recommendations.js`와 `performance.js`에 `KRX_HOLIDAYS` 사본이 각각 있어 한쪽만 갱신되는 드리프트가 실제 발생(후자에 4건 누락). 두 사본 제거 후 모듈로 통일. `tradingDaysSince()` / `addTradingDays()` / `getTodayDateKST()` 제공.
- **`update-prices.js` 휴장일 가드 추가**: 가드가 없어 휴장일에도 실행 → 전 거래일 종가가 복제된 "유령 관측"이 누적(주말 5,938행 + 휴장일 3,475행 = 9,413행, 전체 가격행의 10.4%). 유령 행은 D+N 한 칸을 차지해 이후 전부 하루씩 밀어버림. 주말분은 v3.43 타임존 수정 이전 잔재(2025-12-06~2026-02-08), 휴장일분은 이번까지 계속 누적.
- **`update-prices.js` 날짜 KST 정정**: `new Date().toISOString()`(UTC)을 쓰고 있었음. 16:05 KST cron에서는 우연히 일치했으나 00:00~09:00 KST 실행 시 전날로 기록. `getTodayDateKST()`로 교체.
- **휴장일 목록 누락 4건 보완**: `KRX_HOLIDAYS`에 2026-06-03(지방선거), 2026-07-17(제헌절, 공휴일 재지정), 2026-09-28(추석 대체 — 연휴 9/26이 토요일과 겹침), 2026-12-31(연말 휴장일) 추가. 누락으로 6/3에 휴장일 추천 23행(TOP3 삼성전자우/SK텔레콤/한온시스템 포함)이 실제 저장됐고, 7/17 08:00 alert도 발송됨. 하드코딩 Set이라 매년 초 KRX 공지 확인 필요 — 특히 선거일/임시공휴일은 연중 추가되므로 주의.
- **무픽 시 결산 메시지 침묵 수정**: save 모드가 `saveTop3`/`morningResults`가 모두 비면 메시지를 전송하지 않던 가드 제거. v3.92 무픽 도입 후 무픽이 연속되면 (무픽 → 익일 D-1 성과 대상도 없음) 결산 자체가 사라져 장애와 구분 불가했음(7/15~7/16 실제 발생). 포맷터는 이미 빈 TOP3를 "조건을 충족하는 종목이 없습니다."로 렌더링하므로 alert 모드와 동일하게 무조건 전송. "추천 없음"도 풀이 나쁘다는 신호이므로 전달되어야 함.

### v3.93 (2026-07-06)
- **전 상장종목 일별 수급+가격 수집 파이프라인 ("깔때기 뒤집기" 검증용)**: 구조 진단 결론이 "현행 풀(거래량 순위 top30 = 주목 정점 이후 표본, 4~6월 D+1→D+10 -2.0%/승30%)로는 알파 불가" → 전 종목에서 "순위에 뜨기 전" 매집 흔적(기관/외인 연속 순매수 + 거래량 점증 + 가격 횡보)을 찾는 가설을 검증하기 위해 전 종목 시계열 축적 시작.
  - `market_flow_daily` 테이블 (`supabase-market-flow.sql`): (종목, 날짜) PK, OHLCV + 기관/외인/개인 순매수(수량=주, 대금=백만원) + 시총 근사(상장주식수 역산×각일 종가) + 업종명.
  - `scripts/collect-market-flow.js`: stock_master 유니버스(~2,575, 스팩 제외) × KIS 3콜(투자자 30일/일봉/경량 현재가). 멱등 upsert(7일 창 자가복구), 부분실패 스키마별 버퍼 격리, 간헐 500 1회 재시도. `--backfill`(30일)/`--limit`/`--dry`.
  - GitHub Actions `collect-market-flow.yml`: 평일 17:50 KST, ~22분(러너 해외 지연). 종목 실패율 20% 초과 시 exit 1 → 실패 알림.
  - 30일 백필 시드 완료(77,201행, 2026-01-27~07-06). **검증 스크립트는 2026-07-20 전후 작성 예정** (신호 형성 깊이 + D+10 평가 코호트 확보 시점).
- **주의(운영)**: GH Actions secrets를 PowerShell 5.1에서 stdin 파이프로 설정하면 UTF-8 BOM이 값 앞에 붙어 오염됨 → `gh secret set NAME --body <값>` 인자 방식 필수.

### v3.92 (2026-07-06)
- **시총 플로어 원본 폴백 제거 (무픽 허용)**: momentum 레짐에서 1조+ 후보가 없으면 소형주 원본으로 후퇴하지 않고 빈 TOP3 반환. 근거(7/6 성과점검): 폴백 픽 나노캠텍(275억) D+1→D+10 **-19.1%** 완성 = 플로어 후 유일 완성표본이자 최악, 반면 후보 전멸로 자연 무픽이던 6/23이 -8.9% 폭락일 = 무픽이 옳았음. "추천 없음"도 풀이 나쁘다는 신호.
- **broad 레짐 판정에 상승장 조건 추가**: `detectMarketRegime()`이 spread<0이면 무조건 'broad'(플로어 OFF)였으나, v3.91 캘리브레이션은 상승장 데이터 — 폭락장의 spread<0은 소형주 랠리가 아니라 "대형주가 더 빠지는 위험회피"(7/2~3 실사례: 8일 -16% 폭락 중 broad 판정 → 소형주 3픽). **spread<0 AND KOSPI 10일 누적 >0일 때만 broad**, 하락장 spread<0은 momentum 유지.
- **주간진단 경고 보강**: 최신 in-sample 주가 주별 표본<3으로 권고 산출에서 탈락하면 경고 표시. (6/28·7/5 진단의 D+2→D+3 권고 수치가 15자리 동일했던 원인 = 버그 아니라 최신 주 탈락으로 유효 주 집합(5/11~6/15) 동결 — 권고가 최근 레짐 미반영일 수 있음을 명시.)
- **성과 점검(7/6, 기록)**: 정책지평 월별 4월 +6.4%/승59% → 5월 -0.6%/34% → 6월(플로어前) -4.3%/27%, **건당 알파는 전 기간 -6~-7.5%p 일관**(4월 절대수익도 베타). 반도체 4월 +9.4%/73% → 6월 -9.2%/승0%. 시총 버킷 전기간: 5~20조 +4.9%/47% vs <3천억 -4.7%/32%. 플로어後 부분성과 알파 -2.1%p/알파승률 57%(n=7, 관찰 지속).

### v3.91 (2026-06-21)
- **시장 레짐 탐지 부활 (KOSPI−KOSDAQ 폭) → 시총 플로어 조건부화**: `detectMarketRegime()` — 직전 10거래일 누적 (KOSPI−KOSDAQ) 스프레드 ≥0 → 'momentum'(플로어 ON), <0 → 'broad'(플로어 OFF). 데이터는 overnight_predictions(kospi_close/kosdaq_close). 캘리브레이션: spread<0에서 소형 +4.6% > 대형 +3.3%, ≥0에서 대형 +3~9%p 우위 — 임계값 0에서 부호 전환. save 모드가 레짐 탐지 → `market_regime` 컬럼 저장 + 선별 주입.

### v3.90 (2026-06-21)
- **momentum 레짐 TOP3 시총 플로어**: `selectSaveTop3`/`selectAlertTop3` 정렬 직전 5조+ 우선(3개 미달 시 1조+ 폴백) 필터. 근거(6/21 진단): 최근 레짐 풀 전체 -2.0%/승30%, 전 특징 |r|<0.1로 무력한 가운데 시총만 변별(<3천억 -4.4%/승20% vs 20조+ +4.5%/승54%). 게이트 백테스트 풀 -2.0% → KOSPI&5조+ +2.8%. 일별 재현 백테스트 +1.1%→+4.6%/승41%→49%.
- (동시 배포) 주간진단 3단 점진 완화(robust→majority→least_bad) + 자동적용 게이트, score_health 스윗스팟-aware 교체, kospi_close_change 오염 12행 재계산 + 근본수정.

### v3.89 (2026-05-31)
- **업종지수 매핑 버그 픽스 (커버리지 32%→98%)**: `SECTOR_INDEX_MAP`(save-daily-recommendations.js)이 KIS 업종지수 키워드(반도체/자동차…)와 점 없는 이름('전기전자')만 매칭해, DB의 KRX 세분류명(가운뎃점 포함, '전기·전자' 등)을 잡지 못했음. **반도체 등 dominant 섹터가 leading_score=0으로 처리돼 "🔥 주도업종" 뱃지가 한 번도 안 떴던 버그.**
  - 맵 8개 → 17개로 확장, KRX 세분류명을 keywords에 직접 포함(`전기·전자`/`기계·장비`/`운송·창고`/`운송장비·부품`/`유통`/`섬유·의류`/`음식료·담배` 등). `find()` 첫 매칭 특성상 구체적 항목을 일반 항목보다 먼저 배치(예: 운송장비·부품/0015 → 운송·창고/0019 앞).
  - KIS 업종 코드 라이브 검증 완료. 0010(비금속)/0022(은행)/0024(증권)/0025(보험)은 500/빈값 → 상위분류(0011 철강금속/0021 금융업)로 폴백.
  - TOP3 전체 추천 2,392건 기준 매핑 성공 98%(이전 32%), 죽은 코드 0.
- **⚠️ 부진업종 경고 뱃지 신규**: ALERT/SAVE 메시지에서 `leading_score < -0.5`(KOSPI 대비 약세 섹터) 픽에 경고 표시. fail-safe(조회 실패/미매핑 시 leading_score=0 → 뱃지 미표시).
  - **근거**: 2026-05-31 성과 진단(Supabase 실데이터). 부진 섹터 픽은 정책(D+1→D+10) 기준 중앙 -0.76%/승률 41%로 부진(백테스트 n=68). 주도 섹터 픽은 중앙 +0.9%/승률 52%.
- **섹터 게이트(자동 제외)는 보류**: leading_score는 1~3일 단기 초과수익이라 게이트로는 임계값 0("뒤처진 섹터 회피")만 약하게 유효. 임계값 1.0+로 조이면 추격매수가 돼 **역전**(차단군 > 통과군). 자동 제외 대신 사용자 판단 보조(뱃지)로만 노출. **선별 로직(selectSaveTop3/selectAlertTop3) 변경 없음.**
- **성과 진단 결론(참고)**: TOP3 손익의 67~69%가 전기·전자(반도체), 비반도체는 3개월 내내 매달 손실(중앙 -1~-2%/승률 30~35%). 단일 구조적 리스크 = 반도체 편중. 평가는 반드시 active_policy 지평(D+1→D+10)에서 — D+3로 보면 멀쩡한 전략이 죽은 것처럼 보임.
- **분석 스크립트**: `scripts/perf-final.js`(D+1→D+10 성과), `scripts/validate-new-map.js`(매핑검증), `scripts/sim-leading-gate-v2.js`(게이트 백테스트), `scripts/probe-index-codes.js`(KIS 코드 검증).

### v3.88 (2026-05-25)
- **시장 레짐 / 강신호 T+3 진단 완전 폐기**: v3.87에서 defense 레짐 분기 운영을 제거한 뒤에도 `weekly-diagnostic`이 strong-signal(volR≥3 + VPD≥2) T+3 평균으로 regime을 계산·저장·표시해왔으나, 이 값이 어떤 운영 결정에도 입력되지 않는 좀비 지표 상태였음. v3.87의 의도(전면 제거)와 일치하도록 잔재 일괄 정리.
  - `scripts/weekly-diagnostic.js`: REGIME 블록 삭제 (line 209-227 영역), `regime` / `strong_signal_t3_avg` / `strong_signal_n` INSERT 필드 제거. 진단 구성 4개 → 3개(점수 건강도 / 권장 timing / TOP1 알파). 섹션 번호 재배치(1→5).
  - `api/cron/save-daily-recommendations.js`: `getRegimeTop3FromDb()` 죽은 래퍼 함수 삭제 → 호출자 4곳을 `getTop3FromDb()` 직호출로 교체. `getLatestDiagnostic()` / meta-monitor select / weekly-diagnostic 모드 응답 JSON에서 `regime` / `strong_signal_*` 제거. `formatDiagnosticLine` / `formatWeeklyDiagnosticMessage`는 이미 정리되어 있었음.
  - `api/screening/recommend.js`, `api/recommendations/performance.js`: `weekly_diagnostics` select에서 `regime` / `strong_signal_*` 제거. performance.js의 handleDiagnostics에 `oos_sample_n` 추가.
  - `OPERATING_STATE.md` / `WEEKLY_DIAGNOSTICS.md` 출력 템플릿에서 "강신호 종목 T+3 평균" 행 제거. OOS 검증 수익 행 추가.
  - CLAUDE.md: "4가지 진단" → "3가지 진단", 시장 레짐 섹션 / 6개 섹션 메시지 설명 / 진단 이력 테이블 컬럼 설명 갱신.
  - **DB 컬럼은 유지** (`weekly_diagnostics.regime`, `strong_signal_t3_avg`, `strong_signal_n`): 기존 데이터 보존. 신규 INSERT부터 NULL이 들어감. 잔재 컬럼 drop은 별도 마이그레이션.

### v3.87 (2026-05-06)
- **방어 레짐 전면 제거**: 투자 성과 미개선 + 운영 진단 데이터 오염 확인으로 defense 전략 일체 제거.
  - `calculateDefenseScore()`, `getDefenseRecommendation()`, `selectDefenseTop3/SaveTop3/AlertTop3()`, `determineMarketRegime()`, `reselectAlertTop3ForRegime()`, `formatDefenseTop3Section()` 함수 삭제
  - ALERT/SAVE 텔레그램 메시지: 방어 TOP3 분기 제거, 항상 모멘텀 TOP3만 표시
  - 진단 시스템 레짐: momentum / sideways / unknown 3단계로 단순화 (defense 제거)
  - DB `is_defense_top3`, `defense_score`, `defense_grade`, `market_regime` 컬럼은 기존 데이터 보존을 위해 유지 (신규 저장에서만 미사용)
  - **근거**: 방어 레짐 기간 DB에 쌓인 방어 종목이 주간 진단 타이밍 분석을 오염시켜 `D+? → D+?` (권장 타이밍 결정 불가) 반복 발생. 레짐 자체의 성과 개선 효과도 미확인.

### v3.86 (2026-04-28)
- **자동 운영 진단 시스템 도입 (Phase 1+2+3)**: 매주 일요일 22:00 KST `weekly-diagnostic` cron이 4가지 진단(시장 레짐/점수 모델 건강도/권장 매매 타이밍/TOP1 알파)을 자동 산출. 진단의 신뢰도를 검증하는 meta-monitor(4주 전 권장의 후향 백테스트) 포함.
- **active_policy 테이블 (수동 변경 only)**: 매매 정책(D+k 매수, D+n 매도)은 사용자만 변경 가능. 자동 변경 절대 없음 — v3.55→v3.85의 매주 룰 변경 churn 재발 방지. 6주 연속 동일 권고 시 적용 권고 알림(임계값 임의값).
- **텔레그램**: 일일 메시지 끝에 진단 한 줄 / 일요일에 풀 진단 6개 섹션 / `/진단`, `/policy show`, `/policy D+k D+n [사유]` 명령 추가.
- **프론트엔드**: 추천 카드에 매수/매도 D+N 날짜 표시 / "📊 운영 진단" 탭 신규(시계열 12주 + 정책 이력) / 성과 검증 탭에 진입 시점 토글(D+0/D+1/active).
- **자동 생성 문서**: `OPERATING_STATE.md`(덮어쓰기), `WEEKLY_DIAGNOSTICS.md`(append). CLAUDE.md(설계 문서)와 분리.
- **설계 원칙 (재확인)**: 관측은 자주, 변경은 드물게. 표본 부족 + 단일 백테스트 결과로 룰을 매주 바꾸는 패턴(v3.55-v3.85)이 4월 TOP1 알파 붕괴(-3.59%p)의 한 원인이었음을 분석으로 확인. 진단은 매주, 정책 변경은 사용자 수동.

### v3.84 (2026-04-16)
- **TOP3 선별 단순화 — 점수 내림차순 단일 정렬**: v3.63 tier1(시총 1조 이하 우선) + v3.76 수급 1차 + 스윗스팟 구간 우선순위(50-59 → 60-69 → 80-89 → 90+ → 70-79 → 45-49) 전부 제거. 필터(수급 + 비과열 + |등락률|<25 + 이격도<150 + 점수≥45) 통과 풀에서 점수 내림차순 → 수급 tiebreak → 업종 주도도 tiebreak 후 `slice(0, 3)`만 수행.
- **변경 근거**: POST 기간(2026-03-26~04-15, 15일) 백테스트에서 5개 변형 비교:
  - 실제(v3.76~v3.82 수급1차+tier1): 금메달 최종 -1.08%, 승률 36%, 합산 -1.35%
  - A(v3.83 점수1차+tier1+구간): 금메달 -3.40%, 합산 -0.66%
  - B1(tier1 제거+구간 유지): 금메달 +2.30%, 합산 +0.95%
  - **B2(tier1+구간 모두 제거) ★ 채택: 금메달 -0.66% 승률 57%, 합산 +2.68%, -5% 손실 29%**
  - B3(전체 풀+구간 유지): B1과 동일 결과
- **백테스트 스크립트**: `scripts/backtest-v383.js`, `scripts/backtest-v383b.js`, `scripts/analyze-v376-impact.js`
- **오늘(2026-04-15 추천) TOP3 재선별**: 대한해운(45점, 6순위 최후보충) 제외 → 아주IB투자(68점, 2위) 추가. 최종: GS건설(69)/아주IB투자(68)/강스템바이오텍(61).
- **적용 범위**: `selectAlertTop3`, `selectSaveTop3`, `screening.js::selectTop3` 3곳 동기화. `getTop3FromDb`는 이미 점수 1차 정렬로 호환.
- **방어 TOP3 / 횡보 TOP3**: 별도 로직이므로 변경 없음.

### v3.81 (2026-04-02)
- **ALERT 레짐 변경 시 TOP3 재선별**: 기존 v3.80은 레짐 변경 시 저장된 풀 간 전환만 수행 → 해당 풀이 비어있으면 0개 표시되는 문제. 레짐이 바뀌면 전체 종목 풀(is_active 무관)에서 `selectAlertTop3()`/`selectDefenseAlertTop3()`/`selectSidewaysAlertTop3()` 재실행. DB에 저장된 change_rate/mfi/rsi/market_cap 활용하여 스크리닝 재실행 없이 재선별. DB 플래그(is_top3/is_defense_top3/is_sideways_top3/is_active/market_regime) 일괄 업데이트.
- **`reselectAlertTop3ForRegime()` 함수 추가**: ALERT 전체 풀로 3개 레짐 TOP3를 동시 재선별하는 헬퍼.
- **ALERT 전체 풀 조회**: `is_active=true` 필터 제거 → 전체 종목 로드 후 active 필터는 메모리에서 적용. 재선별 시 비활성 종목도 새 레짐 필터로 재평가.
- **모멘텀 TOP3 45-49점 최후 보충 (6순위)**: 기존 50점 이상만 선정 대상 → 45-49점(B등급 하단)을 6순위 최후 보충으로 추가. 급등장에서 당일급등 페널티로 50점 미만으로 밀린 수급 좋은 종목(예: 대우건설 46점 기관3d+외인2d)이 선정 가능. 90일 데이터: 45-49점 승률 53%/+10%도달 21%로 50-59점(70%/45%)보다 열등하므로 최후 보충으로만 사용. SAVE/ALERT 양쪽 동기화.
- **횡보 TOP3 `changeRate >= 5%` 필터 제거**: 최근 7일간 횡보 TOP3가 한 번도 채워지지 않은 원인. 대부분 정상 종목의 일일 등락률이 5% 미만이라 풀이 극단적으로 줄어듦. 제거 후에도 수급≥2일/MFI<93/RSI<82 필터가 모멘텀과 독립적 차별성 유지. screening.js/cron SAVE/ALERT 3곳 동기화.

### v3.80 (2026-04-01)
- **방어/횡보 TOP3 is_active 버그 수정**: 방어/횡보 TOP3 종목의 모멘텀 점수가 45점 미만이면 `is_active=false`로 저장 → ALERT/TRACK에서 `.eq('is_active', true)` 필터에 의해 방어/횡보 TOP3가 통째로 누락 → 모멘텀 fallback되던 치명적 버그 수정. TOP3로 마킹된 종목은 `is_active=true` 보장. 기존 데이터도 백필 완료.
- **ALERT 레짐 아침 재판정**: 기존에는 전날 SAVE(15:35) 시점 레짐을 DB에서 그대로 읽었으나, 야간 미국장 급등/급락을 반영하지 못하는 문제. ALERT(08:00)에서 최신 해외 전망(`fetchAndPredict`) + 시장 심리로 `determineMarketRegime()` 재호출하여 레짐 재판정. 변경 시 DB도 갱신하여 TRACK이 올바른 TOP3 추적.
- **ALERT TOP3 풀 전체 보완**: 기존에는 저장 레짐에 해당하는 TOP3만 `supplementStockInfo` 호출 → 레짐 변경 시 새 primary TOP3에 종목명/시장 정보 누락. 모든 TOP3 풀(모멘텀/방어/횡보)을 사전 보완하도록 변경.

### v3.78 (2026-03-27)
- **방어 전략 탈수급 재설계**: 하락장에서 기관/외인이 매도 우위라 SmartMoney 자격 조건(연속매수≥2일)이 충족 불가 → 방어 TOP3가 거의 발동하지 않던 구조적 문제 해결. (1) SmartMoney를 자격 조건에서 **점수 보너스로 전환** (25→10점), (2) Recovery 배점 확대 (30→35점, 과매도 반등이 방어의 핵심), (3) 과열 자격 필터 제거 (방어점수 자체가 과열종목에 0점 부여하므로 이중 필터 불필요), (4) 등급 하한 비례 조정 (만점 90점 기준).
- **방어 TOP3 점수 하한 제거**: 3월 데이터 검증 결과, 방어점수 상위3 종목이 모멘텀TOP3 하락일 8회 중 7회(87.5%) 선방. 방어상위3 승률 69%/평균D+1 +3.29% vs 모멘텀TOP3 40%/+0.92%. 점수가 낮아도 "풀 내 가장 방어적인 종목"이 하락장에서 실제로 방어 효과를 보이므로 하한 없이 내림차순 top3 선별. 시총 구간별 선별/구간별 하한 로직 모두 제거하여 단순화.

### v3.77 (2026-03-26)
- **심리 판정 1일 급변 오버라이드**: `calculateMarketSentiment()`의 3일 변동률 데드존(±3%)이 당일 급락(-3.22%)을 희석하는 문제 수정. 당일 변동률 ≤-2%(또는 ≥+2%) AND 3일 변동률이 같은 방향이면 데드존을 뚫고 bearish/bullish 판정. 나머지 3개 지표 데드존은 유지.
- **레짐 판정 fear 즉시 방어 전환**: `determineMarketRegime()`에서 한쪽 시장이 `fear`(3개 bearish 합의)이면 prediction score와 무관하게 즉시 defense. 기존에는 anxiety와 동일하게 pred≤-0.8 조건을 요구하여, 전날 해외 시장이 정상이면 당일 한국 급락에도 sideways 판정되던 문제 해결.
- **방어 TOP3 선별 3대 개선**: (1) 시총 하한 5000억→**1000억** 완화 (기존 삼성전자 등 5조+ 대형주 독점, +10%도달률 0% 문제), (2) **시총 1조 이하 우선** 선별 후 fallback 무제한 (모멘텀 TOP3와 동일 전략), (3) **수급 1차 정렬** (외인2d+ 최우선→쌍방→기관→외인1d→기타). screening.js, cron SAVE/ALERT 3곳 동기화.

### v3.76 (2026-03-26)
- **급등 패널티 구간 재설계 (데이터 기반)**: 90일 533건 성과 데이터 분석 결과 반영. 기존 일률적 패널티(+10%=-15, high+15%=-30)를 구간별 차등으로 변경. (1) 종가+20%(상한가): -30→**-10** (73%승률/+29.5%max, 모멘텀 유지), (2) 고가+20%(종가미달): -30→**-20** (장중급등후 pullback), (3) 종가+15%: **-15** 신규 (56%승률/+2.7%final, 최위험구간), (4) 고가+15%: -30→**-15**, (5) 종가+10-15%: -15→**-5** (72%승률/+11.9%max, 과대처벌 해소). 종가 기준 우선 판정으로 전환하여 실제 마감 강도 반영.
- **스윗스팟 1순위 구간 축소 50-69→50-59**: 90일 472건 분석 결과 50-59(+31.0%max, 61%도달, 중앙값+18.0%)이 60-69(+21.4%, 59%, +12.4%)보다 유의미하게 우수. 60-69를 2순위로 분리. 횡보장 TOP3에도 동일 적용. 후보 부족 시 fallback 체인 유지(60-69→80-89→90+→70-79).
- **TOP3 정렬 수급 1차 전환**: 같은 스윗스팟 구간 내에서 기존 "점수 내림차순→수급 tiebreak"를 **"수급 1차→점수 2차"**로 변경. 50-59 내 점수별 성과에 패턴 없음(r≈0) 반면, 수급별 차이 극명: 외인2d+(+40.6%/72%) > 쌍방(+21.8%/61%) > 기관(+28.0%/56%) > 고래만(+24.4%/51%). 외인 단독 2d+를 최우선 정렬.

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
