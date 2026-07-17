/**
 * TOP3 순위 결정 공용 모듈 (v3.94)
 *
 * 이 파일이 TOP3 정렬(🥇🥈🥉 순서)의 유일한 출처다.
 *
 * 왜 필요했나 (2026-07-17):
 *   정렬 로직이 selectSaveTop3(camelCase)와 selectAlertTop3(snake_case)에 각각 복사돼
 *   있었고, weekly-diagnostic.js는 아예 다른 기준(total_score 내림차순)으로 순위를
 *   재구성하고 있었다. 스윗스팟 밴드는 50-59점을 90+점보다 선호하므로 점수 정렬은
 *   실제 순서와 전혀 다르다 — 실측 결과 **57%의 날에 진단의 TOP1 ≠ 실제 🥇**였고,
 *   TOP1 알파 진단이 존재한 적 없는 종목을 측정하고 있었다.
 *   (같은 계열 사고: KRX_HOLIDAYS 사본 드리프트 → backend/marketCalendar.js 참고)
 *
 * ⚠️ 정렬 기준을 바꿀 때는 반드시 이 파일에서만 바꾸고, ORDER_VERSION을 올릴 것.
 *    과거 추천의 순위를 재구성할 때 "그날 실제로 보여진 순서"와 달라질 수 있으므로,
 *    screening_recommendations.top3_rank(저장된 사실)가 있으면 그쪽을 우선한다.
 *
 * v387 정렬: 수급등급(sg) 1차 → 기관매수일 2차 → 스윗스팟 구간 3차
 *   근거(2026-05-05): 504개 3키 정렬 조합 전수 탐색(n=58, D+1→D+10)에서 승률 71%로 최상위.
 */

const ORDER_VERSION = 'v387';

/**
 * 스윗스팟 구간 선호도 (작을수록 우선).
 * 단조가 아니다 — 50-59가 90+보다 우선. 점수 내림차순 정렬과 절대 같지 않다.
 */
function bandRank(score) {
  if (score >= 50 && score <= 59) return 1;
  if (score >= 60 && score <= 69) return 2;
  if (score >= 80 && score <= 89) return 3;
  if (score >= 90) return 4;
  if (score >= 70 && score <= 79) return 5;
  return 6; // 45-49
}

/** 수급등급 (클수록 우선): 외인 단독 > 쌍방 > 기관 > 외인1일 > 고래만 */
function supplyRank(instDays, frgnDays) {
  const inst = instDays || 0;
  const frgn = frgnDays || 0;
  if (frgn >= 2 && inst < 2) return 5;
  if (inst >= 2 && frgn >= 2) return 4;
  if (inst >= 2) return 3;
  if (frgn >= 1) return 2;
  return 1;
}

/** DB 행(snake_case)용 accessor */
const DB_ACCESSORS = {
  instDays: s => s.institution_buy_days || 0,
  frgnDays: s => s.foreign_buy_days || 0,
  score:    s => s.total_score || 0,
};

/** 스크리닝 결과(camelCase)용 accessor */
const SCREENING_ACCESSORS = {
  instDays: s => s.institutionalFlow?.institutionDays || 0,
  frgnDays: s => s.institutionalFlow?.foreignDays || 0,
  score:    s => s.totalScore || 0,
};

/**
 * v387 순서로 정렬한 새 배열 반환 (입력 불변).
 * @param {Array} stocks
 * @param {{instDays:Function, frgnDays:Function, score:Function}} get - accessor 집합
 */
function sortByTop3Order(stocks, get) {
  return [...(stocks || [])].sort((a, b) => {
    const sd = supplyRank(get.instDays(b), get.frgnDays(b))
             - supplyRank(get.instDays(a), get.frgnDays(a));
    if (sd !== 0) return sd;
    const id = get.instDays(b) - get.instDays(a);
    if (id !== 0) return id;
    return bandRank(get.score(a)) - bandRank(get.score(b));
  });
}

/**
 * 저장된 순위(top3_rank)가 있으면 그것을, 없으면 v387로 재구성.
 * 과거 데이터(top3_rank NULL)와 신규 데이터를 함께 다루는 분석 코드용.
 * @returns {Array} rank 오름차순 정렬된 배열
 */
function resolveTop3Order(stocks, get = DB_ACCESSORS) {
  const list = stocks || [];
  const allRanked = list.length > 0 && list.every(s => s.top3_rank != null);
  if (allRanked) return [...list].sort((a, b) => a.top3_rank - b.top3_rank);
  return sortByTop3Order(list, get);
}

module.exports = {
  ORDER_VERSION,
  bandRank,
  supplyRank,
  sortByTop3Order,
  resolveTop3Order,
  DB_ACCESSORS,
  SCREENING_ACCESSORS,
};
