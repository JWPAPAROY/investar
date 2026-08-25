/**
 * render-operating-state.js — OPERATING_STATE.md / WEEKLY_DIAGNOSTICS.md 렌더러 (v3.96)
 *
 * 왜 분리했나 (2026-08-25):
 *   두 문서는 weekly-diagnostic.js 안에서 직접 쓰였고, 그 쓰기는 `if (!process.env.VERCEL)`로
 *   감싸여 있었다. 그런데 실제 주간진단 cron은 **Vercel에서 돈다**(vercel.json의
 *   `?mode=weekly-diagnostic`). 즉 프로덕션 실행에서는 파일 쓰기가 항상 스킵됐다.
 *   결과: DB에는 진단이 17주치 쌓였는데 OPERATING_STATE.md는 2026-06-15에 얼어붙은 채
 *   "권장 매수일 D+1 / 건강도 ✅ 양호"를 계속 표시했다 — 그 사이 정책은 D+2로 자동 변경됐고
 *   건강도는 주마다 뒤집히고 있었다. 문서 상단은 "매주 덮어쓰기됩니다"라고 주장했다.
 *
 * 설계:
 *   - **DB가 단일 출처**다. weekly_diagnostics / active_policy를 읽어 두 문서를 통째로 다시 만든다
 *     (append 아님 → 재실행해도 중복·표류 없음).
 *   - 어디서 돌려도 된다. 프로덕션 갱신은 .github/workflows/render-operating-state.yml이 맡는다.
 *   - 권장(recommendation)과 **실제 적용 중인 정책**(active_policy)을 반드시 나눠 적는다.
 *     둘을 한 칸에 뭉뚱그린 것이 "D+1인 줄 알았는데 D+2였다"의 원인이었다.
 *
 * 실행: node scripts/render-operating-state.js [--weeks=20]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const repoRoot = path.resolve(__dirname, '..');
const sign = (v, suffix = '%') => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}${suffix}`;

/** 라벨 → 표시. v3.96부터 '_weak' 접미(밴드 부족)가 붙을 수 있다. */
function healthLabel(label, corr, bands) {
  const base = String(label || '').replace(/_weak$/, '');
  const map = { healthy: '✅ 양호', broken: '⚠️ 깨짐', inverted: '⛔ 역전', unknown: '❓ 미상' };
  const weak = String(label || '').endsWith('_weak') ? ' *(밴드 부족 — 참고용)*' : '';
  const b = bands ? `, 밴드 ${bands}개` : '';
  return `${map[base] || base} (ρ=${corr?.toFixed(2) ?? 'N/A'}${b})${weak}`;
}

function renderOperatingState(row, policy, history) {
  const basis = row.raw_json?.scoreHealthBasis === 'monotone'
    ? '단조축(점수 높을수록 좋은가)'
    : '스윗스팟축 (v3.96 이전 기준)';
  const appliedLine = policy
    ? `D+${policy.buy_offset_day} 종가 매수 → D+${policy.sell_offset_day} 종가 매도`
    : 'N/A';
  const differs = policy && row.optimal_buy_d != null
    && (policy.buy_offset_day !== row.optimal_buy_d || policy.sell_offset_day !== row.optimal_sell_d);
  const kst = (t) => new Date(new Date(t).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const cell = (v) => String(v == null ? '' : v).split('|').join('/');

  const histRows = (history || []).map(h =>
    '| ' + kst(h.changed_at) + ' | D+' + h.prev_buy_offset_day + '→D+' + h.prev_sell_offset_day
    + ' | D+' + h.buy_offset_day + '→D+' + h.sell_offset_day + ' | ' + cell(h.set_by)
    + ' | ' + cell(h.change_reason) + ' |').join('\n') || '| — | | | | |';

  const meta = row.meta_past_buy_d != null
    ? `- **${row.meta_lookback_weeks}주 전 권장**: D+${row.meta_past_buy_d} → D+${row.meta_past_sell_d}
- **가상 운영 평균**: ${sign(row.meta_backtest_avg_return)} (n=${row.meta_backtest_sample_n}, 승률 ${row.meta_backtest_win_rate?.toFixed(0) ?? '?'}%)
- **baseline 대비 알파**: ${sign(row.meta_alpha_vs_baseline, '%p')} ${row.meta_alpha_vs_baseline >= 1 ? '✅ 진단 효과 확인' : row.meta_alpha_vs_baseline >= 0 ? '⚪ baseline 동등' : '⚠️ baseline 미달'}`
    : '- 데이터 누적 중 (4주 후부터 표시)';

  const warn = row.warnings && row.warnings.length
    ? '## ⚠️ 경고\n\n' + row.warnings.map(w => '- ' + w).join('\n') + '\n'
    : '';

  return `# Investar 운영 상태 (자동 생성)

> ⚠️ 이 파일은 **DB(weekly_diagnostics / active_policy)에서 통째로 렌더**됩니다.
> 수동 편집하지 마세요 — 다음 렌더에서 덮어쓰입니다.
> 갱신 주체: \`.github/workflows/render-operating-state.yml\` (일요일 진단 cron 이후) 또는
> 로컬 \`node scripts/render-operating-state.js\`.
> ※ Vercel cron은 read-only FS라 이 파일을 쓰지 못합니다. 그래서 갱신을 CI로 분리했습니다.

**최종 렌더**: ${kst(Date.now())} KST
**최신 진단 주**: ${row.week_start} (asOf 기준 주의 시작일)

---

## 🔴 실제 적용 중인 매매 정책 (active_policy)

| 항목 | 값 |
|------|-----|
| **적용 중** | ${appliedLine} |
| **적용 시작** | ${policy?.since_date ?? 'N/A'} |
| **설정 주체** | ${policy?.set_by ?? 'N/A'} |
| **사유** | ${cell(policy?.change_reason)} |

${differs ? `> ⚠️ 최신 진단의 권장(D+${row.optimal_buy_d}→D+${row.optimal_sell_d})과 **다릅니다**. 게이트 미충족으로 보류 중입니다.\n` : ''}
## 최신 진단 권장값

| 항목 | 값 |
|------|-----|
| **권장 매수일** | D+${row.optimal_buy_d ?? '?'} 종가 |
| **권장 매도일** | D+${row.optimal_sell_d ?? '?'} 종가 |
| **점수 모델 건강도** | ${healthLabel(row.score_health_label, row.score_health_corr, row.raw_json?.scoreHealthBands)} |
| **건강도 판정축** | ${basis} |
| **TOP1 알파 (적용 중 timing)** | ${sign(row.top1_alpha_current_timing, '%p')} |
| **TOP1 알파 (권장 timing)** | ${sign(row.top1_alpha_optimal_timing, '%p')} |

## 진단 표본

- **권장 timing in-sample 평균**: ${sign(row.optimal_avg_return)}
- **권장 timing 최저주**: ${sign(row.optimal_min_return)}
- **OOS 검증 수익**: ${sign(row.oos_avg_return)} (n=${row.oos_sample_n ?? 0})
- **in-sample 기간**: ${row.in_sample_weeks}주 / 표본 ${row.optimal_sample_n}건
- **평가 대상 추천 수**: ${row.total_recs_evaluated}

## 진단 신뢰도 (meta-monitor)

${meta}

${warn}---

## Phase 3 (자동 적용) 이력

- **규칙**: quality=robust면 즉시, majority면 **2주 연속 동일 권고**일 때 \`active_policy\` 자동 갱신.
  v3.95부터 판정은 절대 부호가 아니라 **현행 정책 대비 상대 우열**이라, 하락 레짐에서는
  "덜 잃는 쪽"으로도 게이트가 열린다(채택안의 in-sample 평균이 음수일 수 있음).
- **주간 상세**: [WEEKLY_DIAGNOSTICS.md](./WEEKLY_DIAGNOSTICS.md)

| 변경 시각(KST) | 이전 | 이후 | 주체 | 사유 |
|---|---|---|---|---|
${histRows}
`;
}

function renderWeeklyLog(rows) {
  const head = `# Investar 주간 진단 이력 (auto-append)

> **DB(weekly_diagnostics)에서 통째로 렌더**됩니다. 최신 항목이 맨 위.
> 갱신: \`node scripts/render-operating-state.js\` 또는 render-operating-state 워크플로.

---
`;
  const cell = (v) => String(v == null ? '' : v).split('|').join('/');
  const body = rows.map(row => `
## ${row.week_start}

| 항목 | 값 |
|------|-----|
| 권장 timing | D+${row.optimal_buy_d ?? '?'} → D+${row.optimal_sell_d ?? '?'} |
| 그 주 적용 정책 | ${row.active_buy_offset_day != null ? 'D+' + row.active_buy_offset_day + ' → D+' + row.active_sell_offset_day : 'N/A'} |
| in-sample 평균 / 최저주 | ${sign(row.optimal_avg_return)} / ${sign(row.optimal_min_return)} |
| OOS 검증 | ${sign(row.oos_avg_return)} (n=${row.oos_sample_n ?? 0}) |
| 점수 건강도 | ${row.score_health_label} (ρ=${row.score_health_corr?.toFixed(2) ?? 'N/A'}${row.raw_json?.scoreHealthBasis ? ', ' + row.raw_json.scoreHealthBasis : ''}) |
| TOP1 알파 (현재 / 권장) | ${sign(row.top1_alpha_current_timing, '%p')} / ${sign(row.top1_alpha_optimal_timing, '%p')} |
${row.warnings?.length ? '| 경고 | ' + row.warnings.map(cell).join('; ') + ' |\n' : ''}`).join('\n');
  return head + body + '\n';
}

async function render({ weeks = 20 } = {}) {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY
  );
  const { data: rows, error } = await sb.from('weekly_diagnostics')
    .select('*').order('week_start', { ascending: false }).limit(weeks);
  if (error) throw new Error('weekly_diagnostics 조회 실패: ' + error.message);
  if (!rows || !rows.length) throw new Error('weekly_diagnostics 행 없음 — 렌더할 것이 없다');

  const { data: pol } = await sb.from('active_policy').select('*').eq('id', 1).limit(1);
  const { data: hist } = await sb.from('active_policy_history')
    .select('*').order('changed_at', { ascending: false }).limit(10);

  // 이력은 한 번의 적용에 2행씩 남는다(명시적 insert + 트리거 추정). 같은 시각·같은 값은 접는다.
  const seen = new Set();
  const history = (hist || []).filter(h => {
    const k = String(h.changed_at).slice(0, 19) + '|' + h.buy_offset_day + '|' + h.sell_offset_day;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  fs.writeFileSync(path.join(repoRoot, 'OPERATING_STATE.md'),
    renderOperatingState(rows[0], pol && pol[0], history), 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'WEEKLY_DIAGNOSTICS.md'),
    renderWeeklyLog(rows), 'utf8');
  return { weekStart: rows[0].week_start, rows: rows.length };
}

module.exports = { render };

if (require.main === module) {
  const a = process.argv.find(s => s.startsWith('--weeks='));
  render({ weeks: a ? +a.split('=')[1] : 20 })
    .then(r => console.log('✅ 렌더 완료 — 최신 진단 ' + r.weekStart + ', 이력 ' + r.rows + '주'))
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}
