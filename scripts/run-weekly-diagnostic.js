// run-weekly-diagnostic.js — 주간진단 실행 + 텔레그램 보고 (GitHub Actions 진입점)
//
// 왜 여기서 도나 (2026-10-06):
//   Vercel cron(`?mode=weekly-diagnostic`)이 60초 함수 한도를 넘어 2026-08-30부터
//   매주 FUNCTION_INVOCATION_TIMEOUT으로 죽었다. 6주간 weekly_diagnostics가 비었는데
//   OPERATING_STATE.md는 매주 렌더돼 "멈춘 진단"이 정상처럼 보였다.
//   Actions에는 시간 한도가 없으니 계산·저장·알림을 여기로 옮긴다.
//   (텔레그램 /진단 명령은 여전히 Vercel에서 돌아 같은 한도에 걸릴 수 있다.)
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { runDiagnostic } = require('./weekly-diagnostic.js');
const { formatWeeklyDiagnosticMessage, sendTelegramMessage } = require('../api/cron/save-daily-recommendations.js');

(async () => {
  const row = await runDiagnostic({ dryRun: false });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data } = await sb.from('weekly_diagnostics')
    .select('week_start,optimal_buy_d,optimal_sell_d,top1_alpha_optimal_timing,score_health_label')
    .lt('week_start', row.week_start)
    .order('week_start', { ascending: false })
    .limit(1);

  const sent = await sendTelegramMessage(formatWeeklyDiagnosticMessage(row, data?.[0] || null));
  console.log(`[run-weekly-diagnostic] week_start=${row.week_start} telegram_sent=${sent}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
