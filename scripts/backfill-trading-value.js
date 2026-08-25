/**
 * backfill-trading-value.js — market_flow_daily.trading_value 를 KRX로 채운다 (v3.96)
 *
 * 왜 (2026-08-25 발견):
 *   trading_value 컬럼이 **100% NULL**이었다(8월 38,301행 전부, 전체 161,516행 전부).
 *   원인은 collect-market-flow.js 주석이 이미 알고 있었다 — KIS 일봉 TR(FHKST01010400)
 *   응답에 acml_tr_pbmn 필드가 없어 parseInt(undefined)=NaN → num()이 null로 정규화.
 *   즉 "수집하는 척"만 하고 있었다. 죽은 컬럼이 스키마에 남아 있으면 언젠가 누가 쓴다.
 *
 * 해법: KRX 오픈API 일별매매정보의 ACC_TRDVAL(누적 거래대금, 원)로 채운다.
 *   - 로컬 data/krx-daily.jsonl 에 이미 2022-01~2026-08-21이 있으니 API 없이 채운다.
 *   - 없는 날짜만 KRX API를 호출한다(하루 2콜: 유가증권 + 코스닥).
 *
 * ⚠️ 수급(투자자별 순매수)은 KRX 오픈API에 **없다**(404, 승인 문제 아님).
 *    inst_net_value 등은 KIS가 유일한 출처이고, 43%가 0인 것은 결측이 아니라
 *    실제로 그날 그 종목에 기관 매매가 없었던 것이다(거래 자체가 없는 종목 포함).
 *
 * 실행:
 *   node scripts/backfill-trading-value.js            # 전체(누락분만)
 *   node scripts/backfill-trading-value.js --from=2026-05-22
 *   node scripts/backfill-trading-value.js --dry
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const has = k => process.argv.includes('--' + k);
const DRY = has('dry');
const FROM = arg('from', '2026-01-01');
const KRX_BASE = 'http://data-dbg.krx.co.kr/svc/apis';
const LOCAL = path.resolve(__dirname, '../data/krx-daily.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const x = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(x) ? x : null; };

/** data/krx-daily.jsonl → Map<'YYYYMMDD', Map<code, tradingValue>> */
async function loadLocal() {
  const idx = new Map();
  if (!fs.existsSync(LOCAL)) return idx;
  const rl = readline.createInterface({ input: fs.createReadStream(LOCAL), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = new Map();
    for (const row of o.s || []) m.set(row[0], row[6]);  // [code,o,h,l,c,vol,val,mktcap]
    idx.set(o.d, m);
  }
  return idx;
}

/** KRX 오픈API에서 하루치 거래대금 (유가증권 + 코스닥). 실패 시 null. */
async function fetchKrxTradingValue(basDd, key = process.env.KRX_AUTH_KEY) {
  if (!key) return null;
  const out = new Map();
  for (const p of ['/sto/stk_bydd_trd', '/sto/ksq_bydd_trd']) {
    for (let t = 1; t <= 3; t++) {
      try {
        const r = await axios.get(KRX_BASE + p, {
          headers: { AUTH_KEY: key }, params: { basDd }, timeout: 30000, validateStatus: () => true,
        });
        if (r.status === 200) {
          for (const row of r.data?.OutBlock_1 || []) {
            const v = num(row.ACC_TRDVAL);
            if (row.ISU_CD && v != null) out.set(String(row.ISU_CD).trim(), v);
          }
          break;
        }
        if (r.status === 401) { console.error('❌ KRX 401 — AUTH_KEY/승인 확인'); return null; }
        if (t === 3) console.warn('⚠️ KRX ' + basDd + ' ' + p + ' HTTP ' + r.status);
        await sleep(1200 * t);
      } catch (e) {
        if (t === 3) console.warn('⚠️ KRX ' + basDd + ' ' + p + ' ' + (e.code || e.message));
        await sleep(1200 * t);
      }
    }
  }
  return out.size ? out : null;
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);

  // 1) 채울 대상 = trading_value 가 null 인 행 (stock_code, trade_date)
  console.log('📥 대상 조회 중 (trading_value IS NULL, ' + FROM + ' 이후)...');
  const targets = new Map(); // 'YYYY-MM-DD' -> [code]
  let from = 0, total = 0;
  while (true) {
    const { data, error } = await sb.from('market_flow_daily')
      .select('stock_code,trade_date')
      .is('trading_value', null)
      .gte('trade_date', FROM)
      .order('trade_date').order('stock_code')
      .range(from, from + 999);
    if (error) throw new Error('조회 실패: ' + error.message);
    if (!data || !data.length) break;
    for (const r of data) {
      if (!targets.has(r.trade_date)) targets.set(r.trade_date, []);
      targets.get(r.trade_date).push(r.stock_code);
    }
    total += data.length;
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log('   대상 ' + total + '행 / ' + targets.size + '일');
  if (!total) { console.log('✅ 채울 것 없음'); return; }

  // 2) 로컬 KRX 스냅샷 우선, 없는 날만 API
  const local = await loadLocal();
  console.log('   로컬 krx-daily.jsonl: ' + local.size + '일');

  let filled = 0, missDate = 0, missCode = 0, apiDays = 0;
  for (const [date, codes] of [...targets.entries()].sort()) {
    const basDd = date.replace(/-/g, '');
    let vals = local.get(basDd);
    if (!vals) {
      vals = await fetchKrxTradingValue(basDd);
      if (vals) { apiDays++; await sleep(400); }
    }
    if (!vals) { missDate++; console.warn('⚠️ ' + date + ' KRX 데이터 없음 — 건너뜀 (' + codes.length + '행)'); continue; }

    const rows = [];
    for (const code of codes) {
      const v = vals.get(code);
      if (v == null) { missCode++; continue; }   // 상폐·우선주 등 KRX 미매칭
      rows.push({ stock_code: code, trade_date: date, trading_value: v });
    }
    if (!rows.length) { console.log('   ' + date + ': 매칭 0건'); continue; }

    if (DRY) {
      console.log('   [DRY] ' + date + ': ' + rows.length + '행 (' + codes.length + '행 중)');
      filled += rows.length;
      continue;
    }
    // 기존 행만 대상이므로 upsert는 trading_value 컬럼만 갱신한다(PostgREST 부분 upsert).
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await sb.from('market_flow_daily')
        .upsert(batch, { onConflict: 'stock_code,trade_date' });
      if (error) throw new Error('upsert 실패(' + date + '): ' + error.message);
      filled += batch.length;
    }
    console.log('   ' + date + ': ' + rows.length + '행 갱신 (누적 ' + filled + ')');
  }

  console.log('\n✅ 완료 — 갱신 ' + filled + '행 / API 호출일 ' + apiDays
    + ' / KRX에 없는 날 ' + missDate + ' / 종목 미매칭 ' + missCode + '행');
  if (missCode) console.log('   ※ 미매칭은 대부분 우선주·리츠 등 KRX 일별매매 목록 밖 종목이다.');
}

module.exports = { fetchKrxTradingValue };

if (require.main === module) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}
