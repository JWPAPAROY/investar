/**
 * build-portfolio.js — 저PBR·저변동 포트폴리오 리밸런싱 (v3.97, 2026-08-26)
 *
 * 왜: 현행 추천 풀(KIS 순위 API 5종 = 전부 주목도 축)이 2026-08-08 측정에서
 *   풀 전체 매칭초과 −7.39%(D+10). "문제는 랭킹이 아니라 풀"이라는 결론의 대안이다.
 *   구성 근거·검증 수치·일부러 뺀 것들은 backend/portfolio.js 헤더 참고.
 *
 * ⚠️ **현행 추천 경로와 완전히 분리돼 있다.** screening_recommendations / active_policy /
 *    텔레그램 알림 어디에도 영향을 주지 않는다. 프론트엔드에 별도 탭으로만 보인다.
 *
 * 동작: 20거래일마다 리밸런싱. 마지막 리밸런싱 이후 거래일이 그만큼 지났으면 새로 산출.
 *   멱등 — 같은 신호일로 여러 번 돌려도 upsert라 한 행이다.
 *
 * 실행:
 *   node scripts/build-portfolio.js            # 조건 되면 리밸런싱
 *   node scripts/build-portfolio.js --force    # 주기 무시하고 강제 산출
 *   node scripts/build-portfolio.js --dry      # DB 미기록, 결과만 출력
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const P = require('../backend/portfolio');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const sb = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);

async function fetchAll(table, cols, filter) {
  let out = [], from = 0;
  while (true) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

(async () => {
  const o = P.DEFAULTS;

  // ── 1. 가격·시총 시계열 ──────────────────────────────────────────────
  // 필요한 최소 구간은 look+1 거래일이지만, 리밸런싱 주기 판단과 성과 계산을 위해 넉넉히.
  const since = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const flow = await fetchAll('market_flow_daily',
    'stock_code,trade_date,close,market_cap,krx_market_cap,krx_listed_shares,trading_value', q => q.gte('trade_date', since));
  if (!flow.length) throw new Error('market_flow_daily 비어 있음');

  const days = [...new Set(flow.map(r => r.trade_date))].sort();
  const series = new Map();
  for (const r of flow) {
    let s = series.get(r.stock_code);
    if (!s) { s = []; s.byDate = new Map(); series.set(r.stock_code, s); }
    // v3.97: 시총은 **KRX 실측 우선**.
    //   market_cap 은 KIS 역산 근사치라 어긋난다(NAVER −3.1%, 018700 +42.7%).
    //   백테스트(strategy-search.js)가 KRX MKTCAP으로 검증됐으므로 실운용도 같은 정의를 써야
    //   순위가 일치하고 성과 비교가 성립한다.
    //   ⚠️ KRX는 다음 날 공표라 **당일치가 비어 있다** → 아래에서 주식수×종가로 메운다.
    const rec = {
      date: r.trade_date, close: r.close, tradingValue: r.trading_value,
      marketCap: r.krx_market_cap ?? null,
      krxShares: r.krx_listed_shares ?? null,
      kisMarketCap: r.market_cap ?? null,
    };
    s.push(rec); s.byDate.set(r.trade_date, rec);
  }
  // 시총 보정: KRX 실측이 없는 날(주로 당일)은 **최신 상장주식수 × 그날 종가**로 계산한다.
  //   상장주식수는 자주 안 바뀌므로 KIS의 시총 역산보다 훨씬 정확하다.
  //   주식수조차 없으면 KIS 근사치로 폴백하고 몇 건인지 보고한다(조용히 섞이면 안 된다).
  let capKrx = 0, capShares = 0, capKis = 0;
  for (const arr of series.values()) {
    let lastShares = null;
    for (const rec of arr) {
      if (rec.krxShares > 0) lastShares = rec.krxShares;
      if (rec.marketCap > 0) { rec._src = 'krx'; capKrx++; continue; }
      if (lastShares > 0 && rec.close > 0) { rec.marketCap = Math.round(lastShares * rec.close); rec._src = 'shares'; capShares++; continue; }
      rec.marketCap = rec.kisMarketCap; rec._src = 'kis'; if (rec.marketCap > 0) capKis++;
    }
  }
  // 전체 건수는 오해를 부른다 — 순위에 실제로 쓰이는 건 **신호일 하루치**뿐이다
  //   (과거 행의 시총은 vol20·거래대금 계산에 안 쓰인다).
  const sigDate = days[days.length - 1];
  let sK = 0, sS = 0, sI = 0;
  for (const arr of series.values()) {
    const r = arr.byDate.get(sigDate); if (!r) continue;
    if (r._src === 'krx') sK++; else if (r._src === 'shares') sS++; else if (r.marketCap > 0) sI++;
  }
  console.log(`🏛️ 시총 출처(신호일 ${sigDate}) — KRX 실측 ${sK} / 주식수×종가 ${sS} / KIS 근사 폴백 ${sI}`);
  if (sI > sK + sS) console.log('   ⚠️ KIS 근사 폴백이 과반 — KRX 수집이 밀렸는지 확인할 것');

  const idx = days.length - 1;
  const signalDate = days[idx];
  console.log(`📅 거래일 ${days.length}일 (${days[0]} ~ ${signalDate}) / 종목 ${series.size}`);

  if (idx < o.look + 1) throw new Error(`이력 부족: ${days.length}일 (최소 ${o.look + 2}일 필요)`);

  // ── 2. 리밸런싱 시점인가 ────────────────────────────────────────────
  const { data: lastRows, error: lastErr } = await sb.from('portfolio_rebalances')
    .select('rebalance_date').order('rebalance_date', { ascending: false }).limit(1);
  if (lastErr) throw new Error(`portfolio_rebalances 조회 실패: ${lastErr.message} (supabase-portfolio.sql 실행했는지 확인)`);
  const last = lastRows && lastRows[0] ? lastRows[0].rebalance_date : null;

  if (last) {
    const li = days.indexOf(last);
    const elapsed = li >= 0 ? idx - li : null;
    if (elapsed == null) {
      console.log(`⚠️ 마지막 리밸런싱(${last})이 현재 거래일 배열 밖 — 주기 판단 불가, 강제 산출로 진행`);
    } else if (elapsed < o.hold && !FORCE) {
      console.log(`⏸ 마지막 리밸런싱 ${last} 이후 ${elapsed}거래일 (주기 ${o.hold}일) — 아직 아님`);
      console.log(`   다음 예정: ${days[li + o.hold] || `약 ${o.hold - elapsed}거래일 뒤`}`);
      return;
    } else if (FORCE) {
      console.log(`🔁 --force: 주기(${elapsed}/${o.hold}일) 무시하고 재산출`);
    }
  } else {
    console.log('🆕 첫 리밸런싱');
  }

  // ── 3. 재무(point-in-time) ──────────────────────────────────────────
  const fin = await fetchAll('stock_financials', 'stock_code,stac_yymm,bps,eps');
  const finIdx = P.buildFinancialIndex(fin);
  console.log(`💰 재무 ${fin.length}행 / ${finIdx.size}종목`);

  // ── 4. 유니버스 + 선택 ──────────────────────────────────────────────
  const top = P.buildUniverse(series, idx, days, finIdx.bpsAt, o);
  const withPbr = top.filter(r => r.pbr != null).length;
  console.log(`🌐 유니버스 ${top.length}종목 (PBR 확보 ${withPbr})`);
  if (top.length < o.univ * 0.5) throw new Error(`유니버스 이상: ${top.length}종목 (기대 ${o.univ})`);

  const picks = P.selectPicks(top, o);
  if (picks.length < o.k) console.log(`⚠️ 선택 ${picks.length}/${o.k}종목 — PBR 결측 등으로 부족`);

  const names = new Map((await fetchAll('stock_master', 'stock_code,stock_name'))
    .map(r => [r.stock_code, r.stock_name]));

  const eqW = picks.length ? 1 / picks.length : 0;
  const holdings = picks.map(r => ({
    code: r.code, name: names.get(r.code) || r.code,
    close: r.close, cap: r.cap, pbr: +r.pbr.toFixed(3), vol20: +r.vol20.toFixed(3),
    score: +r.score.toFixed(4), weight: +r.weight.toFixed(5), weightEq: +eqW.toFixed(5),
  }));

  console.log(`\n📦 ${signalDate} 포트폴리오 (${o.factor}, K=${o.k}, ${o.hold}거래일, ${o.weight}가중)`);
  holdings.forEach((h, i) => console.log(
    `  ${String(i + 1).padStart(2)}. ${h.name.padEnd(14)} PBR ${h.pbr.toFixed(2)} σ20 ${h.vol20.toFixed(2)}% ` +
    `시총 ${(h.cap / 1e12).toFixed(1)}조 비중 ${(h.weight * 100).toFixed(1)}%`));

  if (DRY) { console.log('\n[DRY] DB 미기록'); return; }

  const buyDate = days[idx + 1] || null;   // 신호일 다음 거래일 종가로 매수 가정
  const nextDate = days[idx + o.hold] || null;
  const { error } = await sb.from('portfolio_rebalances').upsert({
    rebalance_date: signalDate, buy_date: buyDate, next_date: nextDate,
    params: o, holdings, universe_size: top.length,
  }, { onConflict: 'rebalance_date' });
  if (error) throw new Error(`저장 실패: ${error.message}`);
  console.log(`\n✅ 저장 완료 — 다음 리밸런싱 ${nextDate || `${o.hold}거래일 뒤`}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
