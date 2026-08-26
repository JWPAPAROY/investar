/**
 * compare-sources.js — KIS ↔ KRX 대조 (v3.97, 2026-08-26)
 *
 * 왜: 오늘 하루에만 출처가 조용히 갈라진 사례가 셋 나왔다.
 *   ① KIS 미확정 당일 행이 수급 스트릭을 0으로 붕괴시킴 (추천의 59~95%)
 *   ② 거래대금이 전 구간 NULL — TR 하나가 필드를 안 줘서
 *   ③ market_cap 이 KIS 역산 근사치라 실측과 어긋남 (NAVER −3.1%, 018700 +42.7%)
 *   **아무도 두 출처를 나란히 놓고 보지 않았다.** 이 스크립트가 그 자리다.
 *
 * 대조 가능한 것 / 불가능한 것 (2026-08-26 확인):
 *   종가·거래량·거래대금·시총 → 양쪽 다 있음, 대조 가능
 *   수급(투자자별)             → KRX OpenAPI에 **경로 자체가 없음**(404, 승인 문제 아님).
 *                                KIS 단일 출처. data.krx.co.kr 웹 CSV는 별도 경로.
 *   PBR/BPS                    → KIS 재무만. KRX 일별매매정보에 없음.
 *
 * 실행: node scripts/compare-sources.js [--date=2026-08-21] [--top=10]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { fetchKrxTradingValue } = require('./backfill-trading-value');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TOP = +arg('top', 10);
const SAVE = process.argv.includes('--save');   // v3.97: source_reconciliation 에 기록
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);

async function fetchAll(t, c, f) {
  let o = [], x = 0;
  while (true) {
    let q = sb.from(t).select(c).range(x, x + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    o = o.concat(data);
    if (data.length < 1000) break;
    x += 1000;
  }
  return o;
}

(async () => {
  let date = arg('date', null);
  if (!date) {
    // KRX는 다음 날 공표 → 기본은 **전 거래일**.
    //   ⚠️ trade_date만 400행 뽑으면 하루에 2,545종목이라 전부 같은 날짜다(2026-08-26 발견).
    //   유동성 좋은 단일 종목의 시계열로 거래일 배열을 만든다.
    const { data } = await sb.from('market_flow_daily').select('trade_date')
      .eq('stock_code', '005930')
      .order('trade_date', { ascending: false }).limit(10);
    const days = [...new Set((data || []).map(r => r.trade_date))].sort();
    date = days[days.length - 2] || days[days.length - 1];
  }
  console.log(`📊 KIS ↔ KRX 대조 — ${date}\n`);

  const kis = await fetchAll('market_flow_daily',
    'stock_code,close,volume,trading_value,market_cap,krx_market_cap', q => q.eq('trade_date', date));
  const krx = await fetchKrxTradingValue(date.replace(/-/g, ''));
  if (!krx) { console.log('❌ KRX 데이터 없음 (당일이면 아직 미공표)'); return; }
  console.log(`KIS ${kis.length}종목 / KRX ${krx.size}종목`);

  const fields = [
    ['종가',          'close',         r => r.close,         k => k.close,        0.001],
    ['거래량',        'volume',        r => r.volume,        k => k.volume,       0.001],
    ['거래대금',      'tradingValue',  r => r.trading_value, k => k.tradingValue, 0.005],
    ['시총(KIS역산)', 'marketCapKis',  r => r.market_cap,     k => k.marketCap,   0.03],
    ['시총(KRX저장)', 'marketCapKrx',  r => r.krx_market_cap, k => k.marketCap,   0.001],
  ];

  const summary = {}, worstAll = {};
  for (const [name, key, getA, getB, tol] of fields) {
    let n = 0, eq = 0, diffs = [], worst = [];
    for (const r of kis) {
      const k = krx.get(r.stock_code); if (!k) continue;
      const a = getA(r), b = getB(k);
      if (a == null || b == null || !(b > 0)) continue;
      n++;
      const d = Math.abs(a - b) / b;
      if (d <= tol) eq++; else { diffs.push(d * 100); worst.push([r.stock_code, a, b, d * 100]); }
    }
    worst.sort((x, y) => y[3] - x[3]);
    const med = diffs.length ? [...diffs].sort((x, y) => x - y)[diffs.length >> 1] : 0;
    const pct = n ? (100 * eq / n).toFixed(2) : '-';
    console.log(`\n${name.padEnd(14)} 대조 ${n} | 일치 ${eq} (${pct}%) | 불일치 ${diffs.length} 중앙 ${med.toFixed(2)}%`);
    if (worst.length) {
      console.log('   최악:', worst.slice(0, TOP).map(w =>
        `${w[0]} ${Number(w[1]).toLocaleString()}≠${Number(w[2]).toLocaleString()}(${w[3].toFixed(1)}%)`).join('  '));
    }
    summary[key] = { n, eq, mismatch: diffs.length, medianPct: +med.toFixed(3) };
    worstAll[key] = worst.slice(0, 5).map(w => ({ code: w[0], kis: w[1], krx: w[2], diffPct: +w[3].toFixed(2) }));
  }

  if (SAVE) {
    const compared = Math.max(...Object.values(summary).map(v => v.n), 0);
    const { error } = await sb.from('source_reconciliation').upsert({
      trade_date: date, compared, fields: summary, worst: worstAll,
    }, { onConflict: 'trade_date' });
    if (error) console.error('⚠️ 저장 실패:', error.message, '(supabase-reconciliation.sql 실행했는지 확인)');
    else console.log(`
💾 저장 완료 — source_reconciliation ${date}`);
  }
  console.log('\n※ 수급(투자자별)은 KRX OpenAPI에 경로가 없어 대조 불가 — KIS 단일 출처.');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
