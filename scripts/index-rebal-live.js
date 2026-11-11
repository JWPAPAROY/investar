/**
 * 정기변경 실시간 관측 알림 (INDEX_REBAL_LIVE.md). 관측 판정과는 무관한 편의 기능이다.
 *
 * 1) 발표 감지: Google 뉴스 RSS — 최근 30시간 "코스피200/코스닥150 + 편입/편출/교체" 기사(예상·전망 제외).
 *    명단이 data/index-rebal-live.json 에 이미 있으면 보내지 않는다.
 * 2) 매매일 알림: 다음 거래일이 A1 → "시가 매수", R → "종가 매도".
 *
 * 실행: node scripts/index-rebal-live.js [--no-alert] [--today=YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');
const { isTradingDay, addTradingDays, getTodayDateKST } = require('../backend/marketCalendar');

const args = process.argv.slice(2);
const NO_ALERT = args.includes('--no-alert');
const opt = n => (args.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const LIVE = JSON.parse(fs.readFileSync(opt('live') || path.resolve(__dirname, '../data/index-rebal-live.json'), 'utf-8')).events;

async function telegram(text) {
  if (NO_ALERT) { console.log('\n[알림 미발송]\n' + text); return; }
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { console.log('⚠️ 텔레그램 설정 없음 — 콘솔 출력만\n' + text); return; }
  const res = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`텔레그램 전송 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log('📨 텔레그램 발송');
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// 저녁 배치가 자정을 넘겨 돌 수 있다(Actions 지연 최악 05:25 KST) → 08시 전이면 "오늘"이 다음 매매일.
function nextSession() {
  const today = opt('today') || getTodayDateKST();
  const hourKST = new Date(Date.now() + 9 * 3600e3).getUTCHours();
  if (!opt('today') && hourKST < 8) return isTradingDay(today) ? today : addTradingDays(today, 1);
  return addTradingDays(today, 1);
}
const prevTradingDay = d => { let x = d; do { x = new Date(Date.parse(x) - 864e5).toISOString().slice(0, 10); } while (!isTradingDay(x)); return x; };

async function watch() {
  const recent = LIVE.some(e => (Date.now() - Date.parse(e.ann)) / 864e5 < 5);
  if (recent) { console.log('발표 감지: 최근 회차 명단이 이미 있음 — 건너뜀'); return; }
  const seen = new Map();
  for (const q of ['코스피200 정기변경', '코스닥150 정기변경']) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
    let xml = '';
    try { xml = await (await fetch(url, { headers: { 'User-Agent': 'investar-rebal-watch/1.0' } })).text(); }
    catch (e) { console.log(`RSS 실패 (${q}): ${e.message}`); continue; }
    for (const it of xml.split('<item>').slice(1)) {
      const title = unxml((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = unxml((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
      const pub = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
      if (!(Date.now() - pub < (+opt('hours') || 30) * 3600e3)) continue;
      if (!/(코스피\s?200|코스닥\s?150|KOSPI\s?200|KOSDAQ\s?150)/i.test(title)) continue;
      if (!/(편입|편출|교체|확정)/.test(title)) continue;
      if (/(예상|전망|후보|가능성|유력|앞두고|임박|관심|주목|\?)/.test(title)) continue;
      seen.set(title, link);
    }
  }
  console.log(`발표 감지: 후보 기사 ${seen.size}건`);
  if (!seen.size) return;
  const L = ['📣 <b>지수 정기변경 발표 기사 감지</b>', ''];
  for (const [t, l] of [...seen].slice(0, 6)) L.push(`• <a href="${esc(l)}">${esc(t)}</a>`);
  L.push('', '관측 규칙(INDEX_REBAL_LIVE): 편입 종목 <b>발표 다음 거래일 시가 매수 → 적용일 전 거래일 종가 매도</b>.',
    '명단은 아직 자동 입력되지 않습니다 — 기사로 확인하세요. Claude 에게 "정기변경 명단 넣어줘" 하면 data/index-rebal-live.json 에 추가합니다.',
    '<i>관측 중인 규칙입니다(채택 전). 백테스트 9회 평균 +4.4%p는 사후에 찾은 수치입니다.</i>');
  await telegram(L.join('\n'));
}

async function plan() {
  const next = nextSession();
  for (const e of LIVE) {
    const A1 = addTradingDays(e.ann, 1), R = prevTradingDay(e.eff);
    const ins = [...(e.k200_in || []).map(n => `${n} (K200)`), ...(e.k150_in || []).map(n => `${n} (K150)`)];
    if (next === A1) {
      await telegram([`🟢 <b>[관측] 내일(${A1}) 시가 매수 — 정기변경 편입 ${ins.length}종목</b>`, '',
        ...ins.map(x => '• ' + esc(x)), '', `매도: <b>${R} 종가</b> (적용일 ${e.eff} 전 거래일)`,
        '<i>관측 중인 규칙(INDEX_REBAL_LIVE) — 채택 전. 동일가중.</i>'].join('\n'));
    } else if (next === R) {
      await telegram([`🔴 <b>[관측] 내일(${R}) 종가 매도 — 정기변경 편입 ${ins.length}종목</b>`, '',
        '종가 동시호가(15:20~15:30). 리밸런싱 뒤 10일은 백테스트에서 시장 대비 −5.5%p였습니다(들고 가지 말 것).'].join('\n'));
    }
  }
  console.log(`매매일 알림: 다음 거래일 ${next}, 등록 회차 ${LIVE.length}`);
}

(async () => {
  await watch();
  await plan();
})().catch(e => { console.error(e); process.exit(1); });
