/**
 * backfill-krx-close.js — market_flow_daily.krx_close 소급 채우기 (2026-09-07)
 *
 * 왜: `close`(KIS 유래)는 권리락 구간에 **수정주가가 부분적으로 덮인다**.
 *   수집이 최근 20일 창을 다시 채우기 때문에 [재수집 창 시작, 권리락일 직전] 이
 *   1/N 값으로 갈아끼워진다. 로컬 KRX 대조로 확정(비비안 07-23: KRX 7,080 vs close 3,544).
 *
 * KRX 일별매매정보의 TDD_CLSPRC 를 별도 컬럼에 채운다. `close` 는 지우지 않는다 —
 *   두 출처의 괴리 자체가 감시 지표다(source_reconciliation 과 같은 원칙).
 *
 * 하루 2콜(유가/코스닥). 100거래일이면 200콜, 수 분이면 끝난다.
 *
 * 실행:
 *   node scripts/backfill-krx-close.js                       # krx_close 가 빈 날짜 전부
 *   node scripts/backfill-krx-close.js --from=2026-05-01
 *   node scripts/backfill-krx-close.js --dry
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');
const { fetchKrxTradingValue } = require('./backfill-trading-value');

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const DRY = process.argv.includes('--dry');
const FROM = arg('from', '2022-01-01');
const MIN_STOCKS = 2000;   // 하루 종목 수가 이보다 적으면 실사용 구간이 아니다(CLAUDE.md)

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

(async () => {
  if (!process.env.KRX_AUTH_KEY) throw new Error('.env 에 KRX_AUTH_KEY 가 없습니다');

  // 컬럼 존재 확인
  {
    const { error } = await sb.from('market_flow_daily').select('krx_close').limit(1);
    if (error && /krx_close|column/i.test(error.message)) {
      console.error('\n❌ krx_close 컬럼이 없습니다.');
      console.error('   Supabase SQL Editor에서 supabase-krx-close.sql 을 먼저 실행하세요.');
      process.exit(1);
    }
    if (error) throw new Error(`컬럼 확인 실패: ${error.message}`);
  }

  console.log(`\n🏛️ krx_close 소급 채우기 (${FROM} ~)`);
  const rows = await fetchAll('market_flow_daily', 'stock_code,trade_date,krx_close',
    q => q.gte('trade_date', FROM));
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, { codes: [], need: 0 });
    const b = byDate.get(r.trade_date);
    b.codes.push(r.stock_code);
    if (r.krx_close == null) b.need++;
  }
  const targets = [...byDate.entries()]
    .filter(([, b]) => b.codes.length >= MIN_STOCKS && b.need > 0)
    .map(([d]) => d).sort();
  const skipped = [...byDate.entries()].filter(([, b]) => b.codes.length < MIN_STOCKS).length;
  console.log(`날짜 ${byDate.size}일 / 실사용(종목 ${MIN_STOCKS}+) 중 미채움 ${targets.length}일`
    + (skipped ? ` / 희소일 ${skipped}일 제외` : ''));
  if (!targets.length) { console.log('채울 것 없음'); return; }

  const t0 = Date.now();
  let okDays = 0, wrote = 0, missDays = 0;
  for (let i = 0; i < targets.length; i++) {
    const date = targets[i];
    const vals = await fetchKrxTradingValue(date.replace(/-/g, ''));
    if (!vals) { missDays++; console.warn(`⚠️ ${date} KRX 응답 없음 — 건너뜀`); continue; }
    okDays++;
    const present = new Set(byDate.get(date).codes);
    const upd = [];
    for (const [code, v] of vals) {
      if (!present.has(code) || !(v.close > 0)) continue;
      upd.push({ stock_code: code, trade_date: date, krx_close: v.close });
    }
    if (!DRY) {
      for (let k = 0; k < upd.length; k += 500) {
        const { error } = await sb.from('market_flow_daily')
          .upsert(upd.slice(k, k + 500), { onConflict: 'stock_code,trade_date' });
        if (error) { console.warn(`⚠️ ${date} upsert 실패: ${error.message}`); break; }
        wrote += Math.min(500, upd.length - k);
      }
    } else wrote += upd.length;
    if ((i + 1) % 20 === 0 || i === targets.length - 1) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${date}  ${i + 1}/${targets.length}일  누적 ${wrote.toLocaleString()}행  `
        + `경과 ${(el / 60).toFixed(1)}분  ETA ${((el / (i + 1)) * (targets.length - i - 1) / 60).toFixed(1)}분`);
    }
    await sleep(400);
  }
  console.log(`\n📊 ${okDays}일 성공 / ${missDays}일 실패 / ${wrote.toLocaleString()}행 ${DRY ? '(DRY)' : '기록'}`);
})();
