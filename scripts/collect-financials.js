/**
 * collect-financials.js — 분기 재무 → stock_financials (2026-11-26, DART 로 교체)
 *
 * 왜 교체했나: KIS 재무비율 API(FHKST66430300)가 2026-11-11 16:00 부터 404 다(KIS 가 종목분석 API 를 막음).
 *   11-14·11-21 주간 수집이 2,577종목 전부 실패하고 30분 제한에 걸려 취소됐다.
 *   지금은 DART 로 같은 뜻의 값을 만든다(계산은 backend/dartFinancials.js, KIS 값 대조는 scripts/dart-financials-check.js).
 *
 * 무엇을 받나: 공시 시기가 된 분기(분기말 +30일 ~ +150일)마다
 *   1) 주요계정(fnlttMultiAcnt) — 이번 분기·1년 전 같은 분기·직전 사업보고서, 100개 회사씩
 *   2) 연결 회사만 전체 재무제표(fnlttSinglAcntAll) — 지배주주 몫 자본·순이익, 회사당 1호출
 *   3) 주식수 — 지금 상장주식수(market_flow_daily.krx_listed_shares, 보통주) × 그 분기 보고서의 유통/발행 비율
 *      (stockTotqySttus, 자기주식 제외). KIS 도 과거 분기 BPS 를 수집일 주식수로 다시 나눴다 —
 *      분기말 주식수로 나누면 그 뒤 분할·무상증자한 종목의 PBR 이 분할 배수만큼 틀어진다(2026-11-26 대조).
 *   4) 외화로 공시한 회사(950xxx 등 USD)는 분기말 환율(FRED)로 주당 값만 원화 환산
 *   5) 주식수 변화 보정 — 이 스크립트가 쓴 최근 분기 행은, 쓴 날 이후 상장주식수가 1% 넘게 바뀌면
 *      bps·eps·sps 를 그 비율로 다시 나눈다(분할·무상증자 뒤에도 PBR = 종가 ÷ BPS 가 맞도록).
 *   이미 행이 있는 (종목, 결산년월)은 건너뛴다 → 첫 실행 뒤로는 늦게 공시한 회사만 받는다.
 *   KIS 시절 행(~202606)은 덮지 않는다. --refresh 면 다시 계산해 덮는다.
 *
 * 실패 처리: 첫 DART 묶음이 실패하거나 묶음의 절반 넘게 실패하면 바로 exit 1 (KIS 때처럼 30분 헛돌지 않게).
 *
 * 실행:
 *   node scripts/collect-financials.js --dry            # 계산만, 표본 출력
 *   node scripts/collect-financials.js --push           # stock_financials upsert
 *   node scripts/collect-financials.js --push --ym=202609 --refresh
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const supabase = require('../backend/supabaseClient');
const { orderByPk } = require('../backend/supabasePaging');
const DF = require('../backend/dartFinancials');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const PUSH = args.includes('--push');
const REFRESH = args.includes('--refresh');
const YM_ARG = (args.find(a => a.startsWith('--ym=')) || '').slice(5);
const KEY = process.env.DART_API_KEY;
const LIMIT = +((args.find(a => a.startsWith('--limit=')) || '').slice(8)) || 0;   // 시험용: 대상 회사 수 제한

const isExcluded = (name) => /스팩|SPAC/i.test(name || '');

// 공시 시기가 된 분기: 분기말 +30일 ~ +150일 (사업보고서 마감 90일 + 정정·지각 여유)
function targetQuarters(today = new Date()) {
  const out = [];
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3 * back, 1));
    const q = Math.floor(d.getUTCMonth() / 3) * 3 + 3;            // 그 분기의 마지막 달 (3,6,9,12)
    const end = new Date(Date.UTC(d.getUTCFullYear(), q, 0));
    const age = (today - end) / 864e5;
    const ym = `${end.getUTCFullYear()}${String(q).padStart(2, '0')}`;
    if (age >= 30 && age <= 150 && !out.includes(ym)) out.push(ym);
  }
  return out.sort();
}

async function pageAll(build, table) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await orderByPk(build(), table).range(f, f + 999);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// 기준일(이하) 마지막 거래일의 보통주 상장주식수. market_flow_daily 엔 우선주 코드가 없다.
async function sharesAt(end) {
  const from = new Date(Date.parse(end) - 10 * 864e5).toISOString().slice(0, 10);
  const rows = await pageAll(() => supabase.from('market_flow_daily')
    .select('stock_code,trade_date,krx_listed_shares').gte('trade_date', from).lte('trade_date', end)
    .not('krx_listed_shares', 'is', null), 'market_flow_daily');
  const last = new Map();
  for (const r of rows) { const p = last.get(r.stock_code); if (!p || r.trade_date > p.trade_date) last.set(r.stock_code, r); }
  const dates = [...new Set([...last.values()].map(r => r.trade_date))].sort();
  return { get: c => (last.get(c) ? +last.get(c).krx_listed_shares : null), size: last.size, date: dates[dates.length - 1] };
}

async function report(corps, year, reprt) {
  const r = await DF.fetchReport(KEY, corps, year, reprt, { log: console.log });
  const batches = Math.ceil(corps.length / 100);
  console.log(`  주요계정 ${year}/${reprt}: ${r.byCode.size}종목, 호출 ${r.calls}, 실패 묶음 ${r.errors}/${batches}`);
  if (r.errors > batches / 2) throw new Error(`DART 주요계정 ${year}/${reprt} 묶음 절반 넘게 실패 — 중단`);
  return r.byCode;
}

// 연결 회사의 지배주주 몫을 못 받으면 그 회사는 이번에 쓰지 않는다 — 자본총계(비지배 포함)로
// 대신 계산하면 지주회사 BPS 가 4~5배가 된다(2026-11-26 1차 대조). 다음 주 실행이 다시 받는다.
const ctrlFailed = new Set();
async function controlling(pairs, year, reprt) {
  if (!pairs.length) return new Map();
  const t0 = Date.now();
  const r = await DF.fetchControlling(KEY, pairs, year, reprt, { log: console.log });
  console.log(`  연결 지배주주 몫 ${year}/${reprt}: ${r.byCode.size}/${pairs.length}, 호출 ${r.calls}, 빈 응답 ${r.empty}, 실패 ${r.errors} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const c of r.failed) ctrlFailed.add(c);
  if (r.errors > pairs.length / 2) throw new Error(`DART 연결 재무 ${year}/${reprt} 절반 넘게 실패 — 중단`);
  return r.byCode;
}

const shFailed = new Set();
async function shareCounts(pairs, year, reprt) {
  const t0 = Date.now();
  const r = await DF.fetchShareCounts(KEY, pairs, year, reprt, { log: console.log });
  console.log(`  주식총수(유통/발행) ${year}/${reprt}: ${r.byCode.size}/${pairs.length}, 호출 ${r.calls}, 빈 응답 ${r.empty}, 실패 ${r.errors} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const c of r.failed) shFailed.add(c);
  if (r.errors > pairs.length / 2) throw new Error(`DART 주식총수 ${year}/${reprt} 절반 넘게 실패 — 중단`);
  return r.byCode;
}

// 5) 이 스크립트가 쓴 행(updated_at 기록)의 주식수 변화 보정
async function rescaleForShareChanges(yms, now) {
  const rows = await pageAll(() => supabase.from('stock_financials').select('stock_code,stac_yymm,bps,eps,sps,updated_at')
    .in('stac_yymm', yms).gte('updated_at', '2026-11-26'), 'stock_financials');
  const byDate = new Map();
  for (const r of rows) { const d = r.updated_at.slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(r); }
  const fixes = [];
  for (const [d, list] of byDate) {
    const then = await sharesAt(d);
    for (const r of list) {
      const a = then.get(r.stock_code), b = now.get(r.stock_code);
      if (!(a > 0 && b > 0) || Math.abs(b / a - 1) <= 0.01) continue;
      const k = a / b;
      fixes.push({ stock_code: r.stock_code, stac_yymm: r.stac_yymm, bps: r.bps != null ? Math.round(r.bps * k) : null,
        eps: r.eps != null ? Math.round(r.eps * k) : null, sps: r.sps != null ? Math.round(r.sps * k) : null, updated_at: new Date().toISOString() });
    }
  }
  console.log(`\n🔁 주식수 변화 보정: 검사 ${rows.length}행, 보정 ${fixes.length}행`);
  if (fixes.length && PUSH && !DRY) {
    for (const x of fixes) {
      const { error } = await supabase.from('stock_financials').update(x).eq('stock_code', x.stock_code).eq('stac_yymm', x.stac_yymm);
      if (error) throw new Error(`보정 실패 ${x.stock_code}: ${error.message}`);
    }
  } else if (fixes.length) console.table(fixes.slice(0, 10));
}

(async () => {
  if (!KEY) throw new Error('DART_API_KEY 필요');
  const t0 = Date.now();

  // 빨리 실패: 키·한도를 먼저 확인한다.
  const probe = await DF.fetchReport(KEY, ['00126380'], 2025, '11011', { delayMs: 0 });
  if (probe.errors || !probe.byCode.size) throw new Error('DART 시험 호출 실패 — 키·한도 확인');

  const master = (await pageAll(() => supabase.from('stock_master').select('stock_code,stock_name'), 'stock_master'))
    .filter(s => !isExcluded(s.stock_name));
  const cc = await DF.fetchCorpCodes(KEY);
  let universe = master.filter(s => cc[s.stock_code]);
  if (LIMIT) universe = universe.filter(s => ['005930', '000660', '035720', '000150', '000880', '008700', '950130'].includes(s.stock_code)).concat(universe.slice(0, LIMIT));
  console.log(`📊 종목 ${master.length} / corp_code 있음 ${universe.length}`);

  const yms = YM_ARG ? YM_ARG.split(',') : targetQuarters();
  console.log(`🗓️ 대상 분기: ${yms.join(', ') || '없음'}`);
  const allRows = [];
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const shNow = await sharesAt(today);
  console.log(`📈 상장주식수 ${shNow.size}종목 (기준일 ${shNow.date})`);
  if (shNow.size < 2000) throw new Error('market_flow_daily 최근 주식수가 너무 적음 — 수집 확인');
  // 주식수 변화 보정은 새 행을 쓰기 전에 (방금 쓴 행은 오늘 주식수라 보정 대상이 아니다)
  await rescaleForShareChanges(yms.length ? yms : ['000000'], shNow);

  for (const ym of yms) {
    const have = REFRESH ? new Set() : new Set((await pageAll(() => supabase.from('stock_financials')
      .select('stock_code,stac_yymm').eq('stac_yymm', ym), 'stock_financials')).map(r => r.stock_code));
    const todo = universe.filter(s => !have.has(s.stock_code));
    console.log(`\n━━ ${ym}: 이미 있음 ${have.size} / 받을 대상 ${todo.length}`);
    if (!todo.length) continue;

    const y = +ym.slice(0, 4), rp = DF.REPRT[ym.slice(4, 6)], annual = rp === '11011';
    const corps = todo.map(s => cc[s.stock_code]);
    const cur = await report(corps, y, rp);
    const filed = [...cur.keys()].filter(c => todo.some(s => s.stock_code === c));
    if (!filed.length) { console.log('  아직 공시한 회사 없음'); continue; }
    const filedCorps = filed.map(c => cc[c]);
    const ago = annual ? null : await report(filedCorps, y - 1, rp);
    const fy = annual ? null : await report(filedCorps, y - 1, '11011');

    const pairs = filed.filter(c => { const o = cur.get(c); return o.CFS && o.CFS.eq != null; }).map(c => [c, cc[c]]);
    console.log(`  연결 회사 ${pairs.length}곳`);
    const ctrl = {
      cur: await controlling(pairs, y, rp),
      yearAgo: annual ? null : await controlling(pairs, y - 1, rp),
      prevFY: annual ? null : await controlling(pairs, y - 1, '11011'),
    };

    const shc = await shareCounts(filed.map(c => [c, cc[c]]), y, rp);
    // 분기보고서는 주식총수 표를 '-' 로 비워 내는 회사가 많다(3분기 표본 26곳 중 15곳) → 직전 보고서 값으로.
    //   유통/발행 비율(자기주식 비중)은 천천히 바뀐다.
    const prevReports = { '11014': [[y, '11012'], [y, '11013'], [y - 1, '11011']], '11012': [[y, '11013'], [y - 1, '11011']],
      '11013': [[y - 1, '11011'], [y - 1, '11014']], '11011': [[y, '11014'], [y, '11012']] }[rp];
    for (const [py, prp] of prevReports) {
      const miss = filed.filter(c => !shc.has(c) && !shFailed.has(c));
      if (!miss.length) break;
      const more = await shareCounts(miss.map(c => [c, cc[c]]), py, prp);
      for (const [c, v] of more) shc.set(c, v);
    }
    const fx = await DF.fxToKrw(ym);
    console.log(`  환율(${ym} 말): ${JSON.stringify(fx.rates)}`);
    const sharesOf = c => { const b = shNow.get(c), t = shc.get(c); return b && t ? b * t.distb / t.istc : null; };
    const { rows, skipped } = DF.buildRows(ym, cur, ago, fy, sharesOf, ctrl, fx);
    const todoSet = new Set(todo.map(s => s.stock_code));
    const held = r => (r.fs === 'CFS' && ctrlFailed.has(r.code)) || shFailed.has(r.code);
    const mine = rows.filter(r => todoSet.has(r.code) && !held(r));
    console.log(`  계산 ${mine.length}행 | 제외 ${JSON.stringify(skipped)} | 조회 실패로 보류 ${rows.filter(held).length} | 외화 ${mine.filter(r => r.cur !== 'KRW').length}`);
    ctrlFailed.clear(); shFailed.clear();
    allRows.push(...mine);
  }

  if (DRY || !PUSH) {
    console.log('\n[미기록] 표본:');
    console.table(allRows.filter(r => ['005930', '000660', '035720', '000150'].includes(r.code)));
    console.log(`총 ${allRows.length}행 — 기록하려면 --push`);
    return;
  }
  const batch = allRows.map(r => ({
    stock_code: r.code, stac_yymm: r.ym, revenue_growth: r.grs, op_profit_growth: r.opInc,
    net_income_growth: r.niInc ?? null, roe: r.roe, eps: r.eps, sps: r.sps, bps: r.bps,
    reserve_rate: null, debt_ratio: r.debt ?? null, updated_at: new Date().toISOString(),
  }));
  for (let f = 0; f < batch.length; f += 1000) {
    const { error } = await supabase.from('stock_financials').upsert(batch.slice(f, f + 1000), { onConflict: 'stock_code,stac_yymm' });
    if (error) throw new Error(`upsert 실패: ${error.message}`);
  }
  console.log(`☁️  stock_financials upsert ${batch.length}행 (${((Date.now() - t0) / 60000).toFixed(1)}분)`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
