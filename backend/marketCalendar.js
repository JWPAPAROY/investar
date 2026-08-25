/**
 * KRX 거래일/휴장일 공용 모듈 (v3.94)
 *
 * 이 파일이 휴장일의 유일한 출처(single source of truth)다.
 * 이전엔 save-daily-recommendations.js와 performance.js에 KRX_HOLIDAYS Set이 각각
 * 복사돼 있었고, 한쪽만 갱신되는 드리프트가 실제로 발생했다
 * (2026-07-17 제헌절이 performance.js 사본에만 누락 → 휴장일 판정 불일치).
 * 휴장일 추가는 반드시 여기서만 할 것.
 *
 * ⚠️ 하드코딩 목록이므로 매년 초 KRX 휴장일 공지 확인 후 갱신 필요.
 *    선거일·임시공휴일은 연중에도 추가되므로 공지 시점에 바로 반영할 것.
 */

const KRX_HOLIDAYS = new Set([
  // ── 2022~2024 (2026-08-25 추가) ──────────────────────────────────────────
  // 왜 뒤늦게 넣나: 이 목록을 KRX 실거래일(data/krx-daily.jsonl, 1,133일)과 대조했더니
  //   **2022~2025에서 50일이 누락**돼 있었다(2026년은 오류 0건). 목록이 2025부터 시작해서다.
  //   실害도 확인됐다 — 2025-12-31(연말 휴장)이 거래일로 취급돼 update-prices가 직전 종가를
  //   복제한 유령 행 260개를 남겼고, v3.94 비거래일 정리(2026-07-17)가 바로 이 목록을
  //   기준으로 돌았기 때문에 그때 걸러지지 않았다.
  //   소급 분석이 2022~2024를 훑을 때 같은 함정에 빠지지 않도록 전 구간을 채운다.
  '2022-01-31', '2022-02-01', '2022-02-02', // 설 연휴
  '2022-03-01', // 삼일절
  '2022-03-09', // 제20대 대통령선거
  '2022-05-05', // 어린이날
  '2022-06-01', // 제8회 전국동시지방선거
  '2022-06-06', // 현충일
  '2022-08-15', // 광복절
  '2022-09-09', '2022-09-12', // 추석 연휴
  '2022-10-03', // 개천절
  '2022-10-10', // 한글날 대체휴일
  '2022-12-30', // 연말 휴장일
  '2023-01-23', '2023-01-24', // 설 연휴
  '2023-03-01', // 삼일절
  '2023-05-01', // 근로자의 날
  '2023-05-05', // 어린이날
  '2023-05-29', // 부처님오신날 대체휴일
  '2023-06-06', // 현충일
  '2023-08-15', // 광복절
  '2023-09-28', '2023-09-29', // 추석 연휴
  '2023-10-02', // 임시공휴일
  '2023-10-03', // 개천절
  '2023-10-09', // 한글날
  '2023-12-25', // 크리스마스
  '2023-12-29', // 연말 휴장일
  '2024-01-01', // 신정
  '2024-02-09', '2024-02-12', // 설 연휴
  '2024-03-01', // 삼일절
  '2024-04-10', // 제22대 국회의원선거
  '2024-05-01', // 근로자의 날
  '2024-05-06', // 어린이날 대체휴일
  '2024-05-15', // 부처님오신날
  '2024-06-06', // 현충일
  '2024-08-15', // 광복절
  '2024-09-16', '2024-09-17', '2024-09-18', // 추석 연휴
  '2024-10-01', // 국군의 날 (임시공휴일)
  '2024-10-03', // 개천절
  '2024-10-09', // 한글날
  '2024-12-25', // 크리스마스
  '2024-12-31', // 연말 휴장일
  // ── 2025 누락분 (2026-08-25 추가) ────────────────────────────────────────
  '2025-01-27', // 임시공휴일
  '2025-06-03', // 제21대 대통령선거
  '2025-12-31', // 연말 휴장일 ← 유령 가격행 260개의 원인
  // 2025
  '2025-01-01', // 신정
  '2025-01-28', '2025-01-29', '2025-01-30', // 설 연휴
  '2025-03-01', // 삼일절
  '2025-03-03', // 삼일절 대체휴일
  '2025-05-01', // 근로자의 날
  '2025-05-05', // 어린이날
  '2025-05-06', // 부처님오신날
  '2025-06-06', // 현충일
  '2025-08-15', // 광복절
  '2025-10-03', // 개천절
  '2025-10-06', '2025-10-07', '2025-10-08', // 추석 연휴
  '2025-10-09', // 한글날
  '2025-12-25', // 크리스마스
  // 2026
  '2026-01-01', // 신정
  '2026-02-16', '2026-02-17', '2026-02-18', // 설 연휴
  '2026-03-02', // 삼일절 대체휴일
  '2026-05-01', // 근로자의 날
  '2026-05-05', // 어린이날
  '2026-05-25', // 부처님오신날
  '2026-06-03', // 제9회 전국동시지방선거
  '2026-07-17', // 제헌절 (2026년 공휴일 재지정)
  '2026-08-17', // 광복절 대체휴일
  '2026-09-24', '2026-09-25', // 추석 연휴
  '2026-09-28', // 추석 대체휴일 (연휴 9/26이 토요일과 겹침)
  '2026-10-05', // 개천절 대체휴일
  '2026-10-09', // 한글날
  '2026-12-25', // 크리스마스
  '2026-12-31', // 연말 휴장일
]);

function isKRXHoliday(dateStr) {
  return KRX_HOLIDAYS.has(dateStr);
}

/**
 * 거래일 여부 판별 (주말 + KRX 공휴일 제외)
 * v3.43: getUTCDay() 사용 — Vercel(UTC 서버)에서 getDay()는 로컬 타임존 기반이라
 *        KST +09:00 날짜가 UTC로 전날로 변환되어 요일이 틀려지는 버그가 있었음.
 * @param {string} dateStr - 'YYYY-MM-DD' (KST 날짜)
 */
function isTradingDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (day === 0 || day === 6) return false;
  return !KRX_HOLIDAYS.has(dateStr);
}

function filterTradingDays(dates) {
  return dates.filter(d => isTradingDay(d));
}

/**
 * 오늘 날짜 (KST 기준 'YYYY-MM-DD')
 * 서버 로컬 타임존과 무관하게 동작 — UTC epoch에 +9h를 더해 KST 벽시계를 만든 뒤 날짜만 절취.
 */
function getTodayDateKST() {
  const kstOffset = 9 * 60 * 60 * 1000;
  return new Date(Date.now() + kstOffset).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → UTC 자정 Date (요일/일수 계산 전용) */
function toUTCDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** UTC Date → 'YYYY-MM-DD' */
function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

/** n일 뒤/앞 날짜 (달력일) */
function addCalendarDays(dateStr, n) {
  const d = toUTCDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return toDateStr(d);
}

/**
 * 추천일 대비 경과 거래일 수 (D+N의 N).
 *
 * 추천일 당일 = 0, 그 다음 거래일 = 1, ... (주말/휴장일은 세지 않음)
 *
 * v3.94: 기존 update-prices.js는 달력일 차이(`(today - recDate)/86400000`)를 썼는데,
 *   행은 거래일에만 생성되므로 D+N에 구조적 구멍이 생겼다. 실측(2026-04-01~07-05, n=2131):
 *     - 금요일 추천 → D+1이 토요일 → D+1 행 존재율 0%
 *     - 수/목요일 추천 → D+10이 토/일 → D+10 행 존재율 0%
 *   weekly-diagnostic이 pIdx[recId][k]로 직접 인덱싱하므로 해당 건은 조용히 탈락했고,
 *   active_policy(D+1 매수 → D+10 매도) 평가가 월·화 추천(≈39%)만으로 이뤄지고 있었다.
 *   거래일 기준으로 세면 요일과 무관하게 D+N이 항상 존재한다.
 *
 * @param {string} fromDate - 추천일 'YYYY-MM-DD'
 * @param {string} toDate   - 관측일 'YYYY-MM-DD'
 * @returns {number} 경과 거래일 수 (toDate <= fromDate 이면 0)
 */
function tradingDaysSince(fromDate, toDate) {
  if (toDate <= fromDate) return 0;
  let count = 0;
  let cursor = addCalendarDays(fromDate, 1);
  while (cursor <= toDate) {
    if (isTradingDay(cursor)) count++;
    cursor = addCalendarDays(cursor, 1);
  }
  return count;
}

/**
 * 기준일로부터 n거래일 뒤 날짜 (n=0이면 기준일 그대로).
 * 프론트엔드가 표시하는 "평일 N일 후"의 서버측 대응.
 */
function addTradingDays(dateStr, n) {
  if (n <= 0) return dateStr;
  let cursor = dateStr;
  let left = n;
  while (left > 0) {
    cursor = addCalendarDays(cursor, 1);
    if (isTradingDay(cursor)) left--;
  }
  return cursor;
}

module.exports = {
  KRX_HOLIDAYS,
  isKRXHoliday,
  isTradingDay,
  filterTradingDays,
  getTodayDateKST,
  addCalendarDays,
  tradingDaysSince,
  addTradingDays,
};
