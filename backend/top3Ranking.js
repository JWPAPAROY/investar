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
/** DB 행(snake_case)용 accessor */
const DB_ACCESSORS = {
  instDays:     s => s.institution_buy_days || 0,
  frgnDays:     s => s.foreign_buy_days || 0,
  score:        s => s.total_score || 0,
  hasBuyWhale:  s => !!s.whale_detected,   // 저장 시 매수고래만 담긴다(save-daily hasBuyWhale)
  disparity:    s => s.disparity || 100,
  isOverheated: s => s.recommendation_grade === '과열',
  changeRate:   s => s.change_rate || 0,
  marketCap:    s => s.market_cap || 0,
};
/** 스크리닝 결과(camelCase)용 accessor */
/** 스크리닝 결과(camelCase)용 accessor */
const SCREENING_ACCESSORS = {
  instDays:     s => s.institutionalFlow?.institutionDays || 0,
  frgnDays:     s => s.institutionalFlow?.foreignDays || 0,
  score:        s => s.totalScore || 0,
  hasBuyWhale:  s => (s.advancedAnalysis?.indicators?.whale || []).some(w => w.type?.includes('매수')),
  disparity:    s => s.overheatingV2?.disparity || 100,
  isOverheated: s => s.recommendation?.grade === '과열',
  changeRate:   s => s.changeRate || 0,
  marketCap:    s => s.marketCap || 0,
};
/**
 * TOP3 공통 자격 (v3.96).
 *
 * 왜 여기로 올렸나: 같은 술어가 세 벌 있었다 —
 *   ① save-daily selectAlertTop3(DB 행) ② save-daily selectSaveTop3(스크리닝 결과)
 *   ③ screening.js selectTop3(웹 경로).
 * 2026-08-25 시점에 셋의 의미는 동일했지만, v3.94가 고친 사고 두 건이 정확히
 * "사본이 갈라진 것"이었다(웹만 폐기된 v3.85 정렬 + 시총 플로어 누락).
 * 정렬(sortByTop3Order)·플로어(applyMomentumCapFloor)는 이미 이 파일로 모았으니 자격도 모은다.
 */
function isTop3Eligible(s, get) {
  const hasSupply = get.hasBuyWhale(s) || get.instDays(s) >= 3 || get.frgnDays(s) >= 3;
  const score = get.score(s);
  const isS89Trap = score >= 80 && score <= 89 && get.disparity(s) >= 120;
  return hasSupply
    && !get.isOverheated(s)
    && Math.abs(get.changeRate(s)) < 25
    && score >= 45
    && !isS89Trap;
}

/**
 * 자격 통과분을 이격도 단계 컷(130 → 140 → 150)으로 추린다 (v3.96, 3벌 통합).
 * 3개 이상 확보되는 첫 티어에서 멈춘다. 끝까지 3개 미만이면 마지막 티어 결과를 그대로 쓴다.
 * @returns {{eligible: Array, tier: number}}
 */
function selectEligibleWithTiers(stocks, get) {
  const tiers = [130, 140, 150];
  let eligible = [], tier = 150;
  for (const t of tiers) {
    const filtered = (stocks || []).filter(s => isTop3Eligible(s, get) && get.disparity(s) < t);
    eligible = filtered; tier = t;
    if (filtered.length >= 3) break;
  }
  return { eligible, tier };
}

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

/**
 * momentum 레짐 TOP3 시총 플로어 (5조+ 우선 → 부족 시 1조+ 폴백 → 그래도 없으면 무픽).
 *
 * 근거(2026-06-21 성과분석, D+1→D+10): 대형주 주도 급등장에서 마이크로캡(<3천억, 풀의 47%)이
 *   -4.4%/승20%로 책을 깎음. KOSPI&5조+ +2.8%/승49%, TOP3 내 5조+ +3.8% vs 5조미만 -3.6%.
 * v3.91: regime이 'broad'면 우회 — 소형주 참여장에선 플로어가 해로움.
 * v3.92: 원본 폴백 제거 — 1조+ 후보가 없으면 무픽(빈 배열). 폴백이 플로어가 배제하려던
 *   소형주를 그대로 통과시켰음(6/22 나노캠텍 275억 D+1→D+10 -19.1%). 후보 전멸로 자연
 *   무픽이던 6/23이 -8.9% 폭락일 = 무픽이 옳았음. "추천 없음"도 풀이 나쁘다는 신호.
 * v3.94: save-daily-recommendations.js 안에만 있어 웹 경로(selectTop3)가 적용받지 못했다.
 *   공용 모듈로 이동 — 웹/텔레그램/DB가 같은 TOP3를 보도록.
 *
 * @param {Array} eligible - 자격 필터를 통과한 후보
 * @param {Function} capOf - 종목 → 시가총액(원)
 * @param {'momentum'|'broad'} regime
 */
function applyMomentumCapFloor(eligible, capOf, regime) {
  if (!eligible || eligible.length === 0) return eligible;
  if (regime !== 'momentum') return eligible;                 // broad 레짐 우회
  let pool = eligible.filter(s => (capOf(s) || 0) >= 5e12);   // 5조+ 우선
  if (pool.length < 3) pool = eligible.filter(s => (capOf(s) || 0) >= 1e12); // 1조+ 폴백
  // v3.96: 픽이 3개 미만인 날의 **이유를 남긴다**. 2026-06-15~08-24 49거래일 중 28일이
  //   TOP3 미달(0개인 날 5일 포함)이었는데 로그·알림·주간진단 어디에도 이유가 없어
  //   "모델이 죽었나"와 "플로어가 설계대로 걸렀나"를 구분할 수 없었다.
  //   실측: 미달의 원인은 공통 자격 필터가 아니라 거의 전부 이 시총 플로어다.
  if (pool.length < 3) {
    const c5 = eligible.filter(s => (capOf(s) || 0) >= 5e12).length;
    console.log('📵 momentum 시총 플로어: 자격 ' + eligible.length + '개 중 5조+ ' + c5
      + '개 / 1조+ ' + pool.length + '개 → TOP' + pool.length
      + (pool.length === 0 ? ' (무픽 — 소형주 폴백 제거, v3.92)' : ' (플로어 통과분만)'));
  }
  return pool;
}

module.exports = {
  isTop3Eligible,
  selectEligibleWithTiers,
  ORDER_VERSION,
  bandRank,
  supplyRank,
  sortByTop3Order,
  resolveTop3Order,
  applyMomentumCapFloor,
  DB_ACCESSORS,
  SCREENING_ACCESSORS,
};
