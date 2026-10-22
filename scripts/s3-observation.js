/**
 * s3-observation.js — S3 시총 쏠림 가속 실시간 관측 (2026-10-23)
 *
 * 규칙·판정은 S3_OBSERVATION.md 에 관측 시작 전 등록했다. 여기서 바꾸지 말 것.
 * 계산은 scripts/index-breadth-test.js 의 S3 와 같다:
 *   유가 보통주(코드 끝자리 '0') 시총 중 상위 2종목 비중 → 60거래일 변화 → 직전 250거래일 백분위 ≥ 90% 면 켜짐(현금)
 *   종목 수 300 미만인 날은 건너뛴다(수집 누락 방어).
 *
 * 실행: node scripts/s3-observation.js [--seed] [--no-alert]
 *   --seed     로컬 data/krx-daily-2010.jsonl(collect-krx-daily.js --out=krx-daily-2010.jsonl)로 테이블 시드
 *   기본       마지막 저장일 이후를 KRX stk_bydd_trd 로 채우고 상태를 텔레그램으로 보낸다
 * 테이블: supabase-market-concentration.sql
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');

const SEED = process.argv.includes('--seed');
const NO_ALERT = process.argv.includes('--no-alert');
const VERDICT_DATE = '2028-10-23';
const MIN_N = 300, W_CHANGE = 60, W_RANK = 250, Q = 0.9;
const TABLE = 'market_concentration_daily';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const num = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };

/** [[code, cap], ...] → 테이블 행 */
function summarize(d, rows) {
  const caps = rows.map(r => r[1]).sort((a, b) => b - a);
  const sum = k => caps.slice(0, k).reduce((a, b) => a + b, 0);
  return { trade_date: iso(d), n_stocks: caps.length, total_cap: sum(caps.length), top1_cap: sum(1), top2_cap: sum(2), top3_cap: sum(3), top5_cap: sum(5) };
}
async function upsert(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(TABLE).upsert(rows.slice(i, i + 500), { onConflict: 'trade_date' });
    if (error) throw new Error(`${TABLE} upsert: ${error.message}`);
  }
}
async function fetchAll() {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await orderByPk(sb.from(TABLE).select('trade_date,n_stocks,total_cap,top2_cap'), TABLE).range(from, from + 999);
    if (error) throw new Error(`${TABLE}: ${error.message}`);
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function seed() {
  const file = path.resolve(__dirname, '../data/krx-daily-2010.jsonl');
  if (!fs.existsSync(file)) throw new Error('data/krx-daily-2010.jsonl 없음 — collect-krx-daily.js --from=20100101 --out=krx-daily-2010.jsonl 먼저');
  const rows = [];
  for await (const l of readline.createInterface({ input: fs.createReadStream(file) })) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    rows.push(summarize(r.d, r.s.filter(x => x[8] === 'K' && x[0].endsWith('0')).map(x => [x[0], x[7]])));
  }
  rows.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  await upsert(rows);
  console.log(`🌱 시드 ${rows.length}일 (${rows[0].trade_date} ~ ${rows.at(-1).trade_date})`);
}

/** 마지막 저장일 다음 평일 ~ 어제(KST). KRX 는 D 일자를 D+1 아침에 게시한다. 빈 응답(휴장·미게시)은 저장 안 함 */
async function update(lastIso) {
  const key = process.env.KRX_AUTH_KEY;
  if (!key) throw new Error('KRX_AUTH_KEY 없음');
  const d = new Date(lastIso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  const yday = new Date(Date.now() + 9 * 3600e3 - 864e5).toISOString().slice(0, 10);
  const added = [];
  for (; d.toISOString().slice(0, 10) <= yday; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6 === 0) continue;
    const basDd = d.toISOString().slice(0, 10).replace(/-/g, '');
    const r = await axios.get('http://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd',
      { headers: { AUTH_KEY: key }, params: { basDd }, timeout: 30000, validateStatus: () => true });
    if (r.status !== 200) throw new Error(`KRX ${basDd} HTTP ${r.status}`);   // 조용히 넘기면 이력이 비어도 모른다
    const rows = (r.data?.OutBlock_1 || []).filter(x => num(x.TDD_CLSPRC) > 0 && String(x.ISU_CD).endsWith('0')).map(x => [x.ISU_CD, num(x.MKTCAP)]);
    if (rows.length) added.push(summarize(basDd, rows));
    await sleep(400);
  }
  if (added.length) await upsert(added);
  return added.length;
}

function state(all) {
  const s = all.filter(r => r.n_stocks >= MIN_N).map(r => ({ d: r.trade_date, share: r.top2_cap / r.total_cap }));
  const ch = s.map((x, i) => i >= W_CHANGE ? x.share - s[i - W_CHANGE].share : NaN);
  const i = s.length - 1;
  const past = ch.slice(i - W_RANK, i).filter(Number.isFinite);
  if (past.length < W_RANK * 0.8 || !Number.isFinite(ch[i])) throw new Error(`이력 부족 (${s.length}일)`);
  const pct = past.filter(v => v < ch[i]).length / past.length;
  // 최근 전환일: 상태가 마지막으로 바뀐 날
  let since = s[i].d;
  for (let j = i - 1; j >= W_CHANGE + W_RANK; j--) {
    const pj = ch.slice(j - W_RANK, j).filter(Number.isFinite), on = pj.filter(v => v < ch[j]).length / pj.length >= Q;
    if (on !== pct >= Q) break; since = s[j].d;
  }
  return { d: s[i].d, share: s[i].share, ch: ch[i], pct, on: pct >= Q, since };
}

async function telegram(text) {
  if (NO_ALERT) { console.log('\n[알림 미발송]\n' + text); return; }
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { console.log('⚠️ 텔레그램 설정 없음 — 콘솔 출력만\n' + text); return; }
  const res = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`텔레그램 전송 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log('📨 텔레그램 발송');
}

(async () => {
  if (SEED) await seed();
  let all = await fetchAll();
  if (!all.length) throw new Error(`${TABLE} 비어 있음 — --seed 먼저`);
  const n = await update(all.at(-1).trade_date);
  if (n) all = await fetchAll();
  const s = state(all);
  const left = Math.ceil((Date.parse(VERDICT_DATE) - Date.now()) / 864e5);
  const pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const msg = [
    `📡 S3 시총 쏠림 관측 (${s.d} 종가)`,
    `상위2 비중 ${(s.share * 100).toFixed(1)}% · 60일 변화 ${pp(s.ch)} (1년 중 백분위 ${(s.pct * 100).toFixed(0)})`,
    `→ ${s.on ? '🔴 켜짐 (규칙상 현금)' : '⚪ 꺼짐 (보유)'} · ${s.since}부터`,
    `관측 전용, 매매 신호 아님 · 판정일 ${VERDICT_DATE} (D-${left})`,
  ].join('\n');
  console.log(`[s3-observation] 신규 ${n}일 · 이력 ${all.length}일`);
  await telegram(msg);
})().catch(e => { console.error(e); process.exit(1); });
