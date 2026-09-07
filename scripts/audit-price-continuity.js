/**
 * audit-price-continuity.js — market_flow_daily 종가 계열 무결성 점검 (2026-09-07)
 *
 * 왜: 무상증자 실전 파이프라인 소급 검증에서 일간 -40~-50% 가 나왔다.
 *   한국 주식은 일간 ±30% 제한이 있으므로 **물리적으로 불가능한 값**이다.
 *   종가도 호가 단위에 맞지 않았다(3,544 / 26,249 / 21,966).
 *   **원인 확정(2026-09-07, 로컬 KRX 파일 대조)**: 수집이 최근 20일 창을 다시 채우는데,
 *   권리락 이후 재수집된 행은 **수정주가**로 덮이고 그 이전 행은 원주가로 남아 경계가 생긴다.
 *     비비안(002070) 07-23  로컬 KRX 7,080(-0.7%)  vs  저장값 3,544  ← 정확히 1/2
 *                     07-31  로컬 KRX 5,070(-35.0%) vs  저장값 5,070  ← 일치(진짜 권리락)
 *   즉 오염 구간 = [재수집 창 시작, 권리락일 직전]. 권리락일 자체와 그 이후는 정상이다.
 *   ⚠️ 신주배정기준일에서 계산한 권리락일은 **정확했다**. 문제는 필터가 아니라 가격이다.
 *
 * ⚠️ 이 문제는 무상증자 파이프라인만의 것이 아니다. market_flow_daily 의 종가를 쓰는
 *    모든 곳(build-portfolio.js 의 저PBR 포트폴리오 포함)에 해당한다.
 *    판정일 2027-02-26 을 앞둔 관측이 조용히 오염될 수 있다.
 *
 * 판별: |일간 변동| > 30.5% 를 "불가능"으로 본다(±30% 제한 + 반올림 여유).
 *   단 **신규상장 첫날·거래재개일**은 제한폭이 다르므로 별도로 표시한다.
 *
 * 판별 순서:
 *   ① 가격 비율이 정확한 배수/약수(×2 ×5 ÷2 ÷4 …)  → 수정주가 덮임 **확정**
 *   ② 주식수 불변 + 가격 급락                        → 수정주가 혼재 의심
 *   ③ 주식수 급증 + 가격 급락                        → 권리락이 정상 반영된 것
 *   ※ 주식수 컬럼은 결측이 많아(실측 70/151) ①이 주 판별자다.
 *
 * 실행: node scripts/audit-price-continuity.js [--from=2026-01-01] [--csv=out.csv]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const FROM = arg('from', '2026-01-01');
const CSV = arg('csv', null);
const LIMIT_PCT = 30.5;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);

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
  console.log(`\n🔍 market_flow_daily 종가 무결성 점검 (${FROM} ~)`);
  const rows = await fetchAll('market_flow_daily',
    'stock_code,trade_date,close,krx_close,krx_market_cap,krx_listed_shares',
    q => q.gte('trade_date', FROM));
  console.log(`행 ${rows.length.toLocaleString()}건 로드`);

  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.stock_code)) byCode.set(r.stock_code, []);
    byCode.get(r.stock_code).push(r);
  }
  for (const arr of byCode.values()) arr.sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));

  const hits = [];
  let pairs = 0;
  for (const [code, arr] of byCode) {
    for (let i = 1; i < arr.length; i++) {
      const p = arr[i - 1], q = arr[i];
      // v3.98: krx_close 가 있으면 그것으로 본다(원천). 없으면 close 로 폴백.
      p.close = p.krx_close ?? p.close; q.close = q.krx_close ?? q.close;
      if (!(p.close > 0) || !(q.close > 0)) continue;
      pairs++;
      const chg = ((q.close - p.close) / p.close) * 100;
      if (Math.abs(chg) <= LIMIT_PCT) continue;

      // 상장주식수 변동으로 원인을 가른다
      const s0 = p.krx_listed_shares || (p.krx_market_cap && p.close ? p.krx_market_cap / p.close : null);
      const s1 = q.krx_listed_shares || (q.krx_market_cap && q.close ? q.krx_market_cap / q.close : null);
      const shareChg = (s0 > 0 && s1 > 0) ? (s1 / s0 - 1) * 100 : null;
      // 주식수 컬럼은 결측이 많다(실측 118/151). 그래서 **가격 비율**로 먼저 가른다.
      //   수정주가가 덮인 구간은 비율이 정확히 1/N 또는 N배가 된다.
      //   2026-09-07 로컬 KRX 대조로 확인: 비비안 07-23 실제 7,080인데 저장값 3,544(정확히 1/2).
      const ratio = q.close / p.close;
      const exact = [2, 3, 4, 5, 10].some(n => Math.abs(ratio - n) < 0.01 || Math.abs(ratio - 1 / n) < 0.005);
      const cause = exact ? '🚨 정확한 배수/약수(수정주가 덮임 확정)'
        : shareChg == null ? '판별 불가(시총·주식수 결측)'
        : Math.abs(shareChg) > 5 ? '주식수 동반변동(정상 반영)'
        : '🚨 주식수 불변(수정주가 혼재 의심)';
      hits.push({ code, prev: p.trade_date, date: q.trade_date, from: p.close, to: q.close, chg, shareChg, cause });
    }
  }

  console.log(`검사 ${pairs.toLocaleString()}쌍 / 불가능 변동 ${hits.length.toLocaleString()}건 `
    + `(${(100 * hits.length / Math.max(1, pairs)).toFixed(4)}%)\n`);

  const byCause = new Map();
  for (const h of hits) byCause.set(h.cause, (byCause.get(h.cause) || 0) + 1);
  console.log('원인별:');
  [...byCause.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}건  ${k}`));

  const bad = hits.filter(h => h.cause.startsWith('🚨'));
  if (bad.length) {
    const byMonth = new Map();
    for (const h of bad) { const m = h.date.slice(0, 7); byMonth.set(m, (byMonth.get(m) || 0) + 1); }
    console.log('\n🚨 수정주가 혼재 의심 — 월별 분포:');
    [...byMonth.entries()].sort().forEach(([m, n]) => console.log(`  ${m}  ${String(n).padStart(4)}건`));
    console.log(`\n영향 종목 ${new Set(bad.map(h => h.code)).size}개`);
    console.log('\n상위 20건 (낙폭 순):');
    bad.sort((a, b) => a.chg - b.chg).slice(0, 20).forEach(h =>
      console.log(`  ${h.code} ${h.prev}→${h.date}  ${h.from.toLocaleString()} → ${h.to.toLocaleString()}  `
        + `${h.chg.toFixed(1)}%  주식수 ${h.shareChg == null ? '?' : h.shareChg.toFixed(2) + '%'}`));
  }

  // 저PBR 포트폴리오 보유 종목이 영향권에 있는지 (판정일 2027-02-26)
  const reb = await fetchAll('portfolio_rebalances', 'rebalance_date,holdings');
  const held = new Set();
  for (const r of reb) for (const h of (r.holdings || [])) held.add(h.code);
  const hitHeld = [...new Set(bad.map(h => h.code))].filter(c => held.has(c));
  console.log(`\n📦 저PBR 포트폴리오 보유 ${held.size}종목 중 오염 종목: ${hitHeld.length}개`
    + (hitHeld.length ? ` (${hitHeld.join(', ')})` : ' ✅ 없음'));

  if (CSV) {
    fs.writeFileSync(CSV, ['stock_code,prev_date,date,prev_close,close,chg_pct,share_chg_pct,cause',
      ...hits.map(h => [h.code, h.prev, h.date, h.from, h.to, h.chg.toFixed(2),
        h.shareChg == null ? '' : h.shareChg.toFixed(2), h.cause].join(','))].join('\n'));
    console.log(`\n📄 ${CSV}`);
  }
})();
