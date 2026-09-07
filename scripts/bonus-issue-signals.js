/**
 * bonus-issue-signals.js — 무상증자 실전 신호 파이프라인 (2026-09-07)
 *
 * 근거: DISCLOSURE_VERDICT.md 2회차 판정에서 A1_무상증자가 ①②를 모두 통과한 **유일한** 유형.
 *   D+1 종가 매수 → D+5 종가 매도. 매칭초과 중앙 +1.25%, 비용 차감 +0.87%p.
 *   n=248 / 신호일 224 / 독립블록 56. 연 약 56건.
 *
 * 🚨 권리락이 최대 위험이다. 실측 중앙 **D+10**(10%분위 D+9)에 −20% 이하 급락 —
 *    매도일(D+5) 뒤 겨우 5거래일이다. 백테스트에서는 주 판정 창 오염이 2%였지만,
 *    실전에서는 평균이 아니라 **건별**로 막아야 한다.
 *    `fricDecsn`의 신주배정기준일(nstk_asstd)로 권리락일을 미리 계산해 자격에서 거른다.
 *
 * 타이밍: 저녁 배치가 **다음 거래일에 할 일**을 알린다.
 *   D0 저녁 → "내일(D+1) 종가 매수" / D+4 저녁 → "내일(D+5) 종가 매도"
 *   따라서 GitHub Actions의 스케줄 지연(실측 중앙 4시간, 최악 05:25 KST)이 문제가 되지 않는다.
 *   장 시작 전에만 도착하면 된다.
 *
 * 가격 출처는 `market_flow_daily`(매일 갱신)다. 로컬 KRX 파일은 정지된 스냅샷이라 실전에 쓰지 않는다.
 *
 * 실행:
 *   node scripts/bonus-issue-signals.js            # 감지 + 자격판정 + 성과갱신 + 알림
 *   node scripts/bonus-issue-signals.js --no-alert # 텔레그램 안 보냄
 *   node scripts/bonus-issue-signals.js --dry      # DB 미기록, 알림 안 보냄
 *   node scripts/bonus-issue-signals.js --backfill # 과거 A1 전건 소급 기록(알림 없음)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NO_ALERT = args.includes('--no-alert') || DRY;
const BACKFILL = args.includes('--backfill');

const BUY_OFFSET = 1;      // D+1 종가 매수  (사전 등록 판정과 동일)
const SELL_OFFSET = 5;     // D+5 종가 매도
const MIN_VALUE_20D = 5e8; // 20일 평균 거래대금 5억 — 체결 가능성 하한
const COST = 0.35;         // 이 계정 실비용: 매도세 0.15 + 슬리피지 0.10x2 (수수료 무료)

const KEY = process.env.DART_API_KEY;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[,\s]/g, '');
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const date = (v) => {
  if (!v) return null;
  const m = String(v).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const fmt = (n) => (n == null ? '—' : n.toLocaleString());
const pct = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');

async function fetchAll(table, cols, filter) {
  let out = [], from = 0;
  for (;;) {
    let q = orderByPk(sb.from(table).select(cols), table).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
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
  if (!res.ok) console.log(`⚠️ 텔레그램 전송 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  else console.log('📨 텔레그램 발송');
}

(async () => {
  // ── 거래일 달력 + 가격·시총 (실전은 market_flow_daily 를 쓴다) ─────────
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const flow = await fetchAll('market_flow_daily',
    'stock_code,trade_date,close,krx_market_cap,market_cap,trading_value',
    q => q.gte('trade_date', since));
  const days = [...new Set(flow.map(r => r.trade_date))].sort();
  const dIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();   // stock_code → Map(date → {close, cap, value})
  for (const r of flow) {
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, {
      close: r.close, cap: r.krx_market_cap ?? r.market_cap ?? null, value: r.trading_value ?? null,
    });
  }
  const lastDay = days[days.length - 1];
  console.log(`📅 거래일 ${days.length}일 (${days[0]} ~ ${lastDay}) / 종목 ${px.size.toLocaleString()}`);

  /** 날짜 이상인 첫 거래일 인덱스 */
  const idxOnOrAfter = (d) => {
    if (dIdx.has(d)) return dIdx.get(d);
    let lo = 0, hi = days.length - 1, f = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] >= d) { f = m; hi = m - 1; } else lo = m + 1; }
    return f;
  };
  /** 날짜 미만인 마지막 거래일 (권리락일 = 신주배정기준일 직전 거래일) */
  const dayBefore = (d) => {
    const i = idxOnOrAfter(d);
    if (i < 0) return days[days.length - 1] || null;   // 아직 달력 밖 → 미래
    return i > 0 ? days[i - 1] : null;
  };

  // 테이블 존재 확인 (anon 키로는 CREATE TABLE 이 안 된다)
  {
    const { error } = await sb.from('bonus_issue_signals').select('rcept_no').limit(1);
    if (error && /schema cache|does not exist/i.test(error.message)) {
      console.error('\n❌ bonus_issue_signals 테이블이 없습니다.');
      console.error('   Supabase SQL Editor에서 supabase-bonus-signals.sql 을 먼저 실행하세요.');
      process.exit(1);
    }
    if (error) throw new Error(`bonus_issue_signals 확인 실패: ${error.message}`);
  }

  // ── 신규 A1 감지 ───────────────────────────────────────────────────────
  const a1 = await fetchAll('disclosures', 'rcept_no,rcept_dt,corp_code,corp_name,stock_code',
    q => q.eq('report_type', 'A1_무상증자').eq('is_amendment', false).eq('is_subsidiary', false));
  const known = new Set((await fetchAll('bonus_issue_signals', 'rcept_no')).map(r => r.rcept_no));
  const fresh = a1.filter(r => !known.has(r.rcept_no) && r.stock_code)
    .filter(r => BACKFILL || r.rcept_dt >= days[Math.max(0, days.length - 30)]);
  console.log(`무상증자 공시 ${a1.length}건 / 기록됨 ${known.size}건 / 신규 ${fresh.length}건`);

  // ── 상세 조회 → 자격 판정 ──────────────────────────────────────────────
  const rows = [];
  const byCorp = new Map();
  for (const r of fresh) { if (!byCorp.has(r.corp_code)) byCorp.set(r.corp_code, []); byCorp.get(r.corp_code).push(r); }
  for (const [corp, evs] of byCorp) {
    let list = [];
    try {
      const url = `https://opendart.fss.or.kr/api/fricDecsn.json?crtfc_key=${KEY}`
        + `&corp_code=${corp}&bgn_de=20220101&end_de=20301231`;
      const j = await (await fetch(url)).json();
      if (j.status === '000') list = j.list || [];
      else if (j.status !== '013') console.log(`  ⚠️ fricDecsn ${corp}: status=${j.status}`);
    } catch (e) { console.log(`  ⚠️ fricDecsn ${corp}: ${e.message}`); }
    await sleep(220);

    for (const ev of evs) {
      const d = list.find(x => x.rcept_no === ev.rcept_no) || null;
      const recordDate = d ? date(d.nstk_asstd) : null;
      const ratio = d ? num(d.nstk_ascnt_ps_ostk) : null;
      const exRights = recordDate ? dayBefore(recordDate) : null;

      const i0 = idxOnOrAfter(ev.rcept_dt);
      const buyDate = i0 >= 0 ? days[i0 + BUY_OFFSET] || null : null;
      const sellDate = i0 >= 0 ? days[i0 + SELL_OFFSET] || null : null;

      const snap = px.get(ev.stock_code)?.get(days[i0]) || null;
      const cap = snap?.cap ?? null;
      // 20일 평균 거래대금
      let vals = [];
      for (let k = Math.max(0, i0 - 19); k <= i0; k++) {
        const v = px.get(ev.stock_code)?.get(days[k])?.value;
        if (v > 0) vals.push(v);
      }
      const avg20 = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      // 시총 분위 (신호일 전체 종목 대비) — 등급 표시용
      let quint = null;
      if (cap > 0) {
        const all = [];
        for (const [, m] of px) { const s = m.get(days[i0]); if (s?.cap > 0) all.push(s.cap); }
        all.sort((a, b) => a - b);
        const rank = all.findIndex(v => v >= cap);
        if (rank >= 0) quint = Math.min(5, Math.floor((rank / all.length) * 5) + 1);
      }

      // ── 자격 (하드 조건만. 시총 분위는 등급 표시이지 자격이 아니다) ──
      const reasons = [];
      if (!snap || !(snap.close > 0)) reasons.push('KRX 가격 없음');
      if (!buyDate || !sellDate) reasons.push('거래일 달력 밖(미래 일정)');
      if (!recordDate) reasons.push('신주배정기준일 미확인');
      else if (exRights && sellDate && exRights <= sellDate) reasons.push(`권리락(${exRights})이 매도일(${sellDate}) 이전`);
      if (avg20 != null && avg20 < MIN_VALUE_20D) reasons.push(`유동성 부족(20일 평균 ${(avg20 / 1e8).toFixed(1)}억 < 5억)`);

      rows.push({
        rcept_no: ev.rcept_no, stock_code: ev.stock_code, corp_name: ev.corp_name,
        disclosure_date: ev.rcept_dt, ratio, record_date: recordDate, ex_rights_date: exRights,
        listing_date: d ? date(d.nstk_lstprd) : null,
        buy_date: buyDate, sell_date: sellDate,
        market_cap: cap, cap_quintile: quint, avg_value_20d: avg20,
        eligible: reasons.length === 0, reject_reason: reasons.join(' / ') || null,
        raw: d, updated_at: new Date().toISOString(),
      });
    }
  }
  if (rows.length && !DRY) {
    const { error } = await sb.from('bonus_issue_signals').upsert(rows, { onConflict: 'rcept_no' });
    if (error) throw new Error(`저장 실패: ${error.message} (supabase-bonus-signals.sql 실행했는지 확인)`);
  }
  if (rows.length) {
    console.log(`\n신규 ${rows.length}건 판정:`);
    for (const r of rows) console.log(`  ${r.disclosure_date} ${r.corp_name}(${r.stock_code}) `
      + `${r.ratio ? `1:${r.ratio}` : '비율?'} 기준일 ${r.record_date || '?'} 권리락 ${r.ex_rights_date || '?'} `
      + `→ ${r.eligible ? '✅ 자격' : '❌ ' + r.reject_reason}`);
  }

  // ── 성과 갱신: 매수·매도일이 지난 건의 실제 가격 채우기 ────────────────
  const open = await fetchAll('bonus_issue_signals',
    'rcept_no,stock_code,buy_date,sell_date,buy_price,sell_price,eligible',
    q => q.eq('eligible', true).is('sell_price', null));
  const upd = [];
  for (const s of open) {
    const m = px.get(s.stock_code); if (!m) continue;
    const bp = s.buy_price ?? (s.buy_date && s.buy_date <= lastDay ? m.get(s.buy_date)?.close ?? null : null);
    const sp = s.sell_date && s.sell_date <= lastDay ? m.get(s.sell_date)?.close ?? null : null;
    if (bp == null && sp == null) continue;
    const ret = (bp > 0 && sp > 0) ? ((sp - bp) / bp) * 100 : null;
    upd.push({ rcept_no: s.rcept_no, buy_price: bp, sell_price: sp, return_pct: ret, updated_at: new Date().toISOString() });
  }
  if (upd.length && !DRY) {
    const { error } = await sb.from('bonus_issue_signals').upsert(upd, { onConflict: 'rcept_no' });
    if (error) throw new Error(`성과 갱신 실패: ${error.message}`);
  }
  if (upd.length) console.log(`\n성과 갱신 ${upd.length}건`);

  if (BACKFILL) { console.log('\n[--backfill] 알림 없이 종료'); return; }

  // ── 알림: "다음 거래일에 할 일" ────────────────────────────────────────
  const nextIdx = dIdx.get(lastDay) + 1;
  const next = days[nextIdx] || null;   // 달력에 아직 없으면 null → 날짜 문자열로 비교
  const all = await fetchAll('bonus_issue_signals',
    'rcept_no,stock_code,corp_name,disclosure_date,ratio,record_date,ex_rights_date,buy_date,sell_date,market_cap,cap_quintile,eligible,notified_buy,notified_sell,buy_price');

  const toBuy = all.filter(s => s.eligible && !s.notified_buy && s.buy_date && s.buy_date > lastDay);
  const toSell = all.filter(s => s.eligible && !s.notified_sell && s.sell_date && s.sell_date > lastDay
    && s.buy_date && s.buy_date <= lastDay);

  if (!toBuy.length && !toSell.length) {
    console.log('\n알릴 내용 없음 (다음 거래일에 매수·매도 예정 없음)');
    return;
  }

  const L = [];
  L.push('🎁 <b>무상증자 신호</b>');
  L.push(`<i>D+1 종가 매수 → D+5 종가 매도 · 백테스트 순초과 +0.87%p(n=248)</i>`);
  if (toBuy.length) {
    L.push('\n<b>🟢 매수 (해당일 종가)</b>');
    for (const s of toBuy) {
      const capEok = s.market_cap ? (s.market_cap / 1e8).toFixed(0) : '?';
      const warn = s.cap_quintile === 1 ? '  ⚠️소형(Q1은 백테스트에서 효과 없었음)' : '';
      L.push(`• <b>${s.corp_name}</b> (${s.stock_code})  ${s.ratio ? `1:${s.ratio}` : ''}`);
      L.push(`  매수 ${s.buy_date} · 매도 ${s.sell_date} · 시총 ${capEok}억 Q${s.cap_quintile ?? '?'}${warn}`);
      L.push(`  권리락 ${s.ex_rights_date || '?'} (매도 후 ${s.ex_rights_date && s.sell_date ? '안전' : '확인要'})`);
    }
  }
  if (toSell.length) {
    L.push('\n<b>🔴 매도 (해당일 종가)</b>');
    for (const s of toSell) {
      L.push(`• <b>${s.corp_name}</b> (${s.stock_code})  매도 ${s.sell_date}`
        + (s.buy_price ? ` · 매수가 ${fmt(s.buy_price)}` : ''));
      L.push(`  ⚠️ 권리락 ${s.ex_rights_date || '?'} — 미루지 말 것`);
    }
  }
  L.push(`\n<i>비용 가정 왕복 ${COST}% (수수료 무료 계정)</i>`);
  await telegram(L.join('\n'));

  if (!DRY) {
    const mark = [
      ...toBuy.map(s => ({ rcept_no: s.rcept_no, notified_buy: true, updated_at: new Date().toISOString() })),
      ...toSell.map(s => ({ rcept_no: s.rcept_no, notified_sell: true, updated_at: new Date().toISOString() })),
    ];
    if (mark.length) {
      const { error } = await sb.from('bonus_issue_signals').upsert(mark, { onConflict: 'rcept_no' });
      if (error) console.log(`⚠️ 알림 플래그 저장 실패: ${error.message}`);
    }
  }

  // ── 누적 실전 성적 (백테스트와 같은 눈으로) ────────────────────────────
  const done = all.filter(s => s.eligible).length;
  const closed = (await fetchAll('bonus_issue_signals', 'return_pct', q => q.eq('eligible', true).not('return_pct', 'is', null)))
    .map(r => r.return_pct);
  if (closed.length) {
    const sorted = [...closed].sort((a, b) => a - b);
    const m = sorted[sorted.length >> 1];
    const win = closed.filter(v => v > COST).length;
    console.log(`\n📊 실전 누적 — 자격 ${done}건 / 청산 ${closed.length}건 / `
      + `원수익 중앙 ${pct(m)} / 비용차감 ${pct(m - COST)} / 승률(비용 초과) ${(100 * win / closed.length).toFixed(0)}%`);
    console.log(`   백테스트 기준선: 매칭초과 중앙 +1.25% / 비용차감 +0.87%p`);
  }
})();
