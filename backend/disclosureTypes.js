/**
 * disclosureTypes.js — 공시 유형 분류 단일 출처 (2026-09-07)
 *
 * DISCLOSURE_VERDICT.md에 **사전 등록된 4군 11종**을 그대로 구현한다.
 *
 * 🚨 **유형을 추가하거나 세분화하면 사전 등록 위반이다.** 판정을 리셋하고
 *    DISCLOSURE_VERDICT.md의 변경 이력에 사실과 이유를 남겨야 한다.
 *    여기서 고쳐도 되는 것은 **등록된 유형을 더 정확히 잡는 것**뿐이다
 *    (놓친 표기 변형을 잡거나, 유형에 속하지 않는 것을 걷어내는 일).
 *    2026-09-07 실데이터 17,035건 감사로 정한 규칙은 아래 주석에 근거를 남겼다.
 *
 * 제목 표기 함정 (실측):
 *   - DART는 가운뎃점으로 **ㆍ(U+318D)**를 쓴다. ·(U+00B7)와 다르다.
 *   - 정정은 제목 앞에 [기재정정]/[첨부정정]/[첨부추가]/[연장결정]이 붙는다.
 *     이 접두가 붙으면 ^ 앵커가 깨지므로 normalize()에서 떼어낸다.
 *   - 같은 공시가 공백 있는 판/없는 판으로 섞여 온다.
 *
 * 판정에서 제외되는 두 축 (버리지 않고 표시만 한다):
 *   - amended  : 정정·철회·해제. 원본 이벤트의 재공시라 같은 사건을 두 번 세게 된다.
 *   - subsidiary: "(자회사의 주요경영사항)" / "(종속회사의주요경영사항)".
 *                 공시 주체(stock_code)가 아니라 그 자회사의 이벤트다. 신호 강도도
 *                 유출 구조도 다르다. 실측 비중이 작지 않다 — B2 16%, C1 13%, B1 7.6%.
 */

/** [기재정정] 등 접두 태그 제거 + 공백 제거 + 가운뎃점 통일. 매칭 전 항상 통과시킨다. */
function normalize(name) {
  return String(name || '')
    .replace(/^\s*\[[^\]]{1,12}\]\s*/, '') // [기재정정] [첨부정정] [첨부추가] [연장결정] ...
    .replace(/[ㆍ·•‧・]/g, '') // 가운뎃점 변형 전부 제거
    .replace(/\s+/g, '') // 공백 제거
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'));
}

/**
 * 정정·철회·해제 여부. 원본 이벤트의 재공시이므로 이벤트 스터디에서 제외한다.
 * 접두 태그(앞)와 본문 표현(뒤) 양쪽을 본다 — "유상증자결정 철회"처럼 뒤에 오는 경우가 있다.
 */
function isAmendment(reportNm, rm) {
  const raw = String(reportNm || '');
  if (/^\s*\[(기재정정|첨부정정|첨부추가|연장결정|변경등록|정정)\]/.test(raw)) return true;
  const n = normalize(raw);
  if (/(철회|해제|해지|취소)/.test(n)) return true; // 결정철회 / 계약해제ㆍ취소등 / 신탁계약해지
  if (/정정(명령부과|신고서제출요구)/.test(n)) return true; // 금감원발 정정 요구
  if (/^(기재정정|정정)/.test(normalize(rm))) return true;
  return false;
}

/** 자회사·종속회사의 이벤트를 모회사가 대신 공시한 건. */
function isSubsidiary(reportNm) {
  return /(자회사|종속회사)의?주요경영사항/.test(normalize(reportNm));
}

/**
 * 사전 등록 4군 11종. 순서가 곧 우선순위다 — 위에서 먼저 맞는 것을 쓴다.
 * group: A(유출 통로 짧음) / B(유출 통로 김) / C(악재) / Z(통제군)
 */
const TYPES = [
  // ── A군 — 유출 통로가 짧음 (살아있을 수 있음) ──────────────────────
  // 유무상증자(유상+무상 동시)는 순수 무상증자가 아니므로 제외.
  { type: 'A1_무상증자', group: 'A', re: /(?<!유)무상증자결정/ },
  // 처분·해지·결과보고서는 취득 결정이 아니다. 취득 결정과 신탁계약 체결만.
  { type: 'A2_자기주식취득', group: 'A', re: /자기주식취득(결정|신탁계약체결결정)/ },
  { type: 'A3_주식소각', group: 'A', re: /주식소각결정/ },

  // ── B군 — 유출 통로가 김 (기각 예상) ───────────────────────────────
  { type: 'B1_공급계약', group: 'B', re: /단일판매공급계약체결/ },
  // 처분·양도는 반대 이벤트다. 취득·양수만.
  { type: 'B2_타법인주식취득', group: 'B', re: /타법인주식및출자증권(취득|양수)결정/ },
  // 담보제공계약은 최대주주가 지분을 담보로 잡혔다는 뜻이지 변경이 아니다(실측 B3의 절반).
  // 실제 변경과 변경을 수반하는 양수도계약만 남긴다.
  { type: 'B3_최대주주변경', group: 'B', re: /^최대주주변경$|^최대주주변경\(|최대주주변경을수반하는주식양수도계약체결/ },
  { type: 'B4_공개매수', group: 'B', re: /공개매수(신고서|설명서)/ },

  // ── C군 — 악재 (매도/청산 축) ──────────────────────────────────────
  { type: 'C1_유상증자', group: 'C', re: /유상증자결정/ },
  { type: 'C2_사채발행', group: 'C', re: /(전환사채권|신주인수권부사채권|교환사채권)발행결정/ },
  { type: 'C3_감사배임', group: 'C', re: /(횡령|배임)(혐의발생|사실확인)|감사(의견)?(거절|한정)|감사범위제한/ },

  // ── 통제군 — 재료 없음, 척도 검증용 ────────────────────────────────
  { type: 'Z1_정기보고서', group: 'Z', re: /^(사업보고서|반기보고서|분기보고서)/ },
];

/**
 * @returns {{type, group, amended, subsidiary}}
 *   사전 등록 11종에 없으면 type=null (판정 대상 아님, 저장은 한다).
 *   amended·subsidiary는 유형이 붙어도 이벤트 스터디에서 제외된다.
 */
function classify(reportNm, rm) {
  const amended = isAmendment(reportNm, rm);
  const subsidiary = isSubsidiary(reportNm);
  const n = normalize(reportNm);
  // "기타주요경영사항 (제3자배정 유상증자결정 철회)" / "기타시장안내 ('25사업연도 감사의견
  //  거절 관련 상장폐지 절차 미진행)" 처럼 **자유서술 래퍼**는 제목 매칭이 신뢰되지 않는다.
  //  등록된 11종은 모두 정형 공시명이므로, 래퍼는 유형을 붙이지 않는다.
  if (/^기타(주요경영사항|시장안내|안내사항)/.test(n)) return { type: null, group: null, amended, subsidiary };
  for (const t of TYPES) {
    if (t.re.test(n)) return { type: t.type, group: t.group, amended, subsidiary };
  }
  return { type: null, group: null, amended, subsidiary };
}

module.exports = { classify, normalize, isAmendment, isSubsidiary, TYPES };
