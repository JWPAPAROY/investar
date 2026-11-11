/**
 * disclosure-digest.js — 자사주 취득·소각 공시 일일 요약 (정보용, 2026-11-11)
 *
 * ⚠️ 이건 **매수 신호가 아니다.** 두 유형 모두 사전 등록 판정에서 기각됐다.
 *   - A2_자기주식취득: ① +0.54%p 통과 → ② 잔여비율 기각 (DISCLOSURE_VERDICT.md)
 *                      강제 흐름 가설도 P2·P3 실패로 기각 (BUYBACK_VERDICT.md)
 *   - A3_주식소각:     ① 기각
 * 사용자 요청(2026-11-11)으로 "어떤 종목에 이런 공시가 났는지"를 모아 보여줄 뿐이다.
 * 매매 지시는 하지 않는다. 그래서 무상증자(bonus-issue-signals.js)와 달리 매수·매도일을 쓰지 않는다.
 *
 * ★ 표시: 취득예정금액 ÷ 시가총액 ≥ 3.56% (BUYBACK_VERDICT P1 의 상위 20% 하한).
 *   과거 그 분위의 D+1→D+5 초과 중앙값은 +2.19%p 였다(n=387). 단 그 축은 전체 판정에서
 *   기각됐으므로 **참고치**로만 쓴다. 경계값 출처: `node scripts/buyback-verdict.js`
 *   P1 표 (2026-11-11 재출력, 표본 1,936).
 *
 * 대상일: disclosures 테이블의 가장 최근 rcept_dt (공시 수집 체인 직후 실행 가정).
 *   ⚠️ 상태를 저장하지 않으므로 수동 재실행하면 같은 날 요약이 한 번 더 간다.
 *      체인이 하루 실패하면 그날 요약은 건너뛴다(수집은 다음 실행이 메우지만 요약은 최신일만).
 *
 * 실행: node scripts/disclosure-digest.js [--date=YYYY-MM-DD] [--no-alert]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const NO_ALERT = args.includes('--no-alert');
const KEY = process.env.DART_API_KEY;
const BIG_RATIO = 0.0356;   // BUYBACK_VERDICT P1 Q5 하한

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = v => {
  if (v == null) return null;
  const s = String(v).replace(/[,\s]/g, '');
  if (!s || s === '-') return null;
  const n = Number(s); return Number.isFinite(n) ? n : null;
};
const shorten = s => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > 24 ? t.slice(0, 24) + '…' : t; };
const eok = v => (v == null ? '-' : v >= 1e12 ? `${(v / 1e12).toFixed(1)}조` : `${Math.round(v / 1e8).toLocaleString()}억`);

async function dart(ep, corpCode, ymd) {
  const url = `https://opendart.fss.or.kr/api/${ep}.json?crtfc_key=${KEY}&corp_code=${corpCode}&bgn_de=${ymd}&end_de=${ymd}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const j = await (await fetch(url)).json();
      if (j.status === '000') return j.list || [];
      if (j.status === '013') return [];
      throw new Error(`${ep} status=${j.status} ${j.message || ''}`);
    } catch (e) {
      if (attempt === 3) { console.log(`⚠️ DART 상세 실패 ${corpCode}: ${e.message}`); return []; }
      await sleep(1000 * attempt);
    }
  }
}

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

(async () => {
  let day = arg('date', '');
  if (!day) {
    const { data, error } = await sb.from('disclosures').select('rcept_dt').order('rcept_dt', { ascending: false }).limit(1);
    if (error) throw new Error(`disclosures: ${error.message}`);
    day = data?.[0]?.rcept_dt;
  }
  if (!day) { console.log('공시 데이터 없음'); return; }

  const { data: evs, error } = await sb.from('disclosures')
    .select('rcept_no,rcept_dt,corp_code,corp_name,stock_code,corp_cls,report_nm,report_type')
    .eq('rcept_dt', day).in('report_type', ['A2_자기주식취득', 'A3_주식소각'])
    .eq('is_amendment', false).eq('is_subsidiary', false).not('stock_code', 'is', null);
  if (error) throw new Error(`disclosures: ${error.message}`);
  const listed = (evs || []).filter(e => ['Y', 'K'].includes(e.corp_cls));   // 코넥스·기타 제외
  console.log(`${day}: 취득·소각 공시 ${listed.length}건 (정정·자회사·비상장·코넥스 제외)`);
  if (!listed.length) return;   // 없는 날은 보내지 않는다

  // 시가총액: 공시일 이하 최근 거래일
  const codes = [...new Set(listed.map(e => e.stock_code))];
  const { data: caps } = await sb.from('market_flow_daily').select('stock_code,trade_date,krx_market_cap,market_cap')
    .in('stock_code', codes).lte('trade_date', day).gte('trade_date', new Date(Date.parse(day) - 14 * 864e5).toISOString().slice(0, 10))
    .order('trade_date', { ascending: false });
  const capOf = new Map();
  for (const r of caps || []) if (!capOf.has(r.stock_code)) capOf.set(r.stock_code, r.krx_market_cap || r.market_cap || null);

  // 취득 상세 (직접 / 신탁) — 회사당 최대 2콜
  const ymd = day.replace(/-/g, '');
  const buys = [], burns = [];
  for (const e of listed) {
    const cap = capOf.get(e.stock_code) || null;
    if (e.report_type === 'A3_주식소각') { burns.push({ ...e, cap }); continue; }
    const trust = /신탁/.test(e.report_nm);
    const rows = await dart(trust ? 'tsstkAqTrctrCnsDecsn' : 'tsstkAqDecsn', e.corp_code, ymd);
    await sleep(200);
    // 상세 API 의 rcept_no 가 목록과 다른 경우가 있다(2026-11-10 에스디바이오센서: 목록 …141, 상세 …158 —
    //   같은 날 재제출로 보임). 정확히 맞는 게 없고 그날 상세가 1건뿐이면 그것을 쓴다.
    const d = rows.find(r => r.rcept_no === e.rcept_no) || (rows.length === 1 ? rows[0] : null);
    const amount = d ? num(trust ? d.ctr_prc : d.aqpln_prc_ostk) : null;
    const purpose = d ? (trust ? d.ctr_pp : d.aq_pp) : null;
    buys.push({ ...e, cap, trust, amount, purpose, ratio: amount && cap ? amount / cap : null });
  }
  buys.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));

  const link = e => `<a href="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${e.rcept_no}">${esc(e.corp_name)}</a>`;
  const [, mm, dd] = day.split('-');
  const L = [`📋 <b>자사주 공시 요약 ${+mm}/${+dd}</b>`, '<i>정보용 — 매수 신호 아님 (두 유형 모두 검정 기각)</i>', ''];
  if (buys.length) {
    L.push(`<b>🛒 자기주식 취득 ${buys.length}건</b> (시총 대비 규모순)`);
    for (const b of buys) {
      const r = b.ratio != null ? `${(b.ratio * 100).toFixed(2)}%` : '규모 미확인';
      L.push(`${b.ratio != null && b.ratio >= BIG_RATIO ? '★ ' : '• '}${link(b)} ${eok(b.amount)} / 시총 ${eok(b.cap)} = ${r} · ${b.trust ? '신탁' : '직접'}`
        + (b.purpose ? ` · ${esc(shorten(b.purpose))}` : ''));
    }
    L.push('');
  }
  if (burns.length) {
    L.push(`<b>🔥 주식 소각 ${burns.length}건</b>`);
    for (const b of burns) L.push(`• ${link(b)} (시총 ${eok(b.cap)})`);
    L.push('');
  }
  L.push('<i>★ = 시총 대비 3.56%+ (과거 상위 20%, D+1→D+5 초과 중앙 +2.2%p — 기각된 축의 참고치)</i>');
  await telegram(L.join('\n'));
})().catch(e => { console.error('❌', e.message); process.exit(1); });
