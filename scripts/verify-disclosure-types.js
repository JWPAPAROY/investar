/**
 * verify-disclosure-types.js — 공시 분류 규칙 회귀 테스트 (2026-09-07)
 *
 * 아래 제목들은 전부 **DART 실데이터 17,035건 감사에서 실제로 나온 것**이다.
 * 규칙을 고칠 때마다 여기부터 돌린다 — 유형 정의가 조용히 넓어지거나 좁아지는 것을 막는다.
 *
 * 이 파일이 곧 "무엇을 제외하기로 했는가"의 기록이다:
 *   처분/양도/해지/결과보고서 = 취득의 반대이거나 후속. 이벤트가 아니다.
 *   담보제공계약 = 최대주주가 지분을 담보로 잡힌 것이지 변경이 아니다(실측 B3의 절반).
 *   유무상증자 = 유상이 섞였으므로 순수 무상증자가 아니다.
 *   기타주요경영사항/기타시장안내 = 자유서술 래퍼라 제목 매칭이 신뢰되지 않는다.
 *
 * 실행: node scripts/verify-disclosure-types.js   (실패 시 exit 1)
 */
const { classify } = require('../backend/disclosureTypes');

// 2026-09-07 실데이터 감사에서 실제로 나온 제목들. 기대값을 손으로 못 박는다.
const CASES = [
  // [제목, 기대 type, 기대 amended, 기대 subsidiary]
  ['주요사항보고서(무상증자결정)', 'A1_무상증자', false, false],
  ['[기재정정]주요사항보고서(무상증자결정)', 'A1_무상증자', true, false],
  ['[기재정정]주요사항보고서(유무상증자결정)', null, true, false],          // 유상 혼합 → 제외
  ['주요사항보고서(자기주식취득결정)', 'A2_자기주식취득', false, false],
  ['주요사항보고서(자기주식취득신탁계약체결결정)', 'A2_자기주식취득', false, false],
  ['주요사항보고서(자기주식취득신탁계약해지결정)', null, true, false],      // 해지 → 제외
  ['주요사항보고서(자기주식처분결정)', null, false, false],                 // 처분 → 제외
  ['자기주식취득결과보고서', null, false, false],                           // 결과보고 → 제외
  ['주식소각결정', 'A3_주식소각', false, false],
  ['주식소각결정(자회사의 주요경영사항)', 'A3_주식소각', false, true],
  ['단일판매ㆍ공급계약체결', 'B1_공급계약', false, false],
  ['[기재정정]단일판매ㆍ공급계약체결', 'B1_공급계약', true, false],
  ['단일판매ㆍ공급계약체결(자율공시)', 'B1_공급계약', false, false],
  ['단일판매ㆍ공급계약체결(자회사의 주요경영사항)', 'B1_공급계약', false, true],
  ['타법인주식및출자증권취득결정', 'B2_타법인주식취득', false, false],
  ['주요사항보고서(타법인주식및출자증권양수결정)', 'B2_타법인주식취득', false, false],
  ['타법인주식및출자증권처분결정', null, false, false],                     // 처분 → 제외
  ['주요사항보고서(타법인주식및출자증권양도결정)', null, false, false],     // 양도 → 제외
  ['타법인주식및출자증권취득결정(종속회사의주요경영사항)', 'B2_타법인주식취득', false, true],
  ['최대주주변경', 'B3_최대주주변경', false, false],
  ['최대주주변경을수반하는주식양수도계약체결', 'B3_최대주주변경', false, false],
  ['[기재정정]최대주주변경을수반하는주식담보제공계약체결', null, true, false],  // 담보제공 → 제외
  ['최대주주변경을수반하는주식담보제공계약해제ㆍ취소등', null, true, false],
  ['최대주주등소유주식변동신고서', null, false, false],
  ['공개매수신고서', 'B4_공개매수', false, false],
  ['공개매수설명서', 'B4_공개매수', false, false],
  ['주요사항보고서(유상증자결정)', 'C1_유상증자', false, false],
  ['유상증자결정(종속회사의주요경영사항)', 'C1_유상증자', false, true],
  ['기타주요경영사항 (제3자배정 유상증자결정 철회)', null, true, false],    // 철회 → 제외
  ['유상증자1차발행가액결정', null, false, false],                          // 후속 → 제외
  ['권리락 (유상증자)', null, false, false],
  ['주요사항보고서(전환사채권발행결정)', 'C2_사채발행', false, false],
  ['주요사항보고서(교환사채권발행결정)', 'C2_사채발행', false, false],
  ['주요사항보고서(신주인수권부사채권발행결정)', 'C2_사채발행', false, false],
  ['횡령ㆍ배임혐의발생', 'C3_감사배임', false, false],
  ['횡령ㆍ배임사실확인(자회사의 주요경영사항)', 'C3_감사배임', false, true],
  ["기타시장안내 ('25사업연도 감사의견 거절 관련 상장폐지 절차 미진행)", null, false, false],
  ['사업보고서 (2025.12)', 'Z1_정기보고서', false, false],
  ['[기재정정]사업보고서 (2025.12)', 'Z1_정기보고서', true, false],         // 앵커 버그 수정 확인
  ['[첨부추가]반기보고서 (2026.06)', 'Z1_정기보고서', true, false],
  ['분기보고서 (2026.03)', 'Z1_정기보고서', false, false],
  ['임원ㆍ주요주주특정증권등소유상황보고서', null, false, false],
  ['정정명령부과( 2026.08.26. 제출 주요사항보고서(회사합병 결정) )', null, true, false],
];

let pass = 0;
const fails = [];
for (const [nm, wantType, wantAmend, wantSub] of CASES) {
  const c = classify(nm, '');
  const ok = c.type === wantType && c.amended === wantAmend && c.subsidiary === wantSub;
  if (ok) pass++;
  else fails.push({ nm, got: `${c.type} / amend=${c.amended} / sub=${c.subsidiary}`,
                    want: `${wantType} / amend=${wantAmend} / sub=${wantSub}` });
}
console.log(`${pass}/${CASES.length} 통과`);
if (fails.length) {
  console.log('\n❌ 실패:');
  for (const f of fails) console.log(`  ${f.nm}\n     got  ${f.got}\n     want ${f.want}`);
  process.exit(1);
}
console.log('✅ 전부 기대대로');
