/**
 * collect-buyback-details.js — 자기주식취득 결정 상세 수집 (2026-09-07)
 *
 * 🚨 판정 조건은 BUYBACK_VERDICT.md에 **데이터를 보기 전에** 사전 등록돼 있다.
 *    이 스크립트는 판정하지 않는다 — 모으기만 한다. 값을 눈으로 훑고 기준을 조정하지 말 것.
 *
 * 두 실행 경로를 하나로 정규화한다:
 *   direct  tsstkAqDecsn          자기주식취득결정          — 3개월 내 직접 시장 매수
 *   trust   tsstkAqTrctrCnsDecsn  자기주식취득신탁계약체결결정 — 6개월~1년 위탁 분산 매수
 *
 * ⚠️ `tsstkAqTrctrCcDecsn` 은 이름이 비슷하지만 **해지** 엔드포인트다(cc_* 필드,
 *    "중도해지" 사유가 들어온다). 체결과 반대 사건이므로 쓰지 않는다.
 *    2026-09-07 실측으로 확인: 체결은 `...CnsDecsn`, 해지는 `...CcDecsn`.
 *
 * 호출 절약: 상세 API는 corp_code + 기간으로 조회되므로 **회사당 1콜**로 그 회사의
 *   전 기간 이력을 받아 rcept_no 로 조인한다. 건당 조회(2,293콜) 대신 회사당 조회.
 *
 * 실행:
 *   node scripts/collect-buyback-details.js          # 미수집분만
 *   node scripts/collect-buyback-details.js --all    # 전건 재수집(정규화 규칙 변경 시)
 *   node scripts/collect-buyback-details.js --dry    # DB 미기록
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ALL = args.includes('--all');
const KEY = process.env.DART_API_KEY;
const GAP_MS = 200;
const MIN_COVERAGE = 80; // BUYBACK_VERDICT.md 중단 조건: 확보율 80% 미만이면 멈춘다

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "10,000,000,000" → 10000000000 / "-" · "" → null */
const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[,\s]/g, '');
  if (!s || s === '-' || s === '해당사항없음') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
};
/** "2026년 03월 12일" · "2026.03.12" · "20260312" → "2026-03-12" */
const date = (v) => {
  if (!v) return null;
  const s = String(v);
  let m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

async function fetchEp(ep, corpCode) {
  const url = `https://opendart.fss.or.kr/api/${ep}.json?crtfc_key=${KEY}`
    + `&corp_code=${corpCode}&bgn_de=20220101&end_de=20260930`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      const txt = await res.text();
      let j; try { j = JSON.parse(txt); } catch (e) { throw new Error(`${ep}: JSON 아님 (HTTP ${res.status})`); }
      if (j.status === '000') return j.list || [];
      if (j.status === '013') return [];                       // 이력 없음 = 정상
      if (j.status === '020') throw new Error('DART 사용한도 초과 — 내일 재개할 것');
      if (j.status === '901') throw new Error('DART 인증키 오류');
      if (j.status === '101') throw new Error(`${ep}: 잘못된 URL — 엔드포인트 이름 확인`);
      throw new Error(`${ep} status=${j.status} ${j.message || ''}`);
    } catch (e) {
      if (/한도 초과|인증키 오류|잘못된 URL/.test(e.message) || attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

/** 두 경로를 공통 스키마로. 원본은 raw 에 그대로 남긴다. */
function normalize(row, method, ev) {
  const isDirect = method === 'direct';
  return {
    rcept_no: row.rcept_no,
    corp_code: row.corp_code || ev.corp_code,
    stock_code: ev.stock_code || null,
    rcept_dt: ev.rcept_dt,
    method,
    plan_amount: num(isDirect ? row.aqpln_prc_ostk : row.ctr_prc),
    plan_shares: isDirect ? num(row.aqpln_stk_ostk) : null,
    period_bgd: date(isDirect ? row.aqexpd_bgd : row.ctr_pd_bgd),
    period_edd: date(isDirect ? row.aqexpd_edd : row.ctr_pd_edd),
    purpose: (isDirect ? row.aq_pp : row.ctr_pp) || null,
    broker: (isDirect ? row.cs_iv_bk : row.ctr_cns_int) || null,
    daily_limit: isDirect ? num(row.d1_prodlm_ostk) : null,
    raw: row,
  };
}

async function fetchAll(table, cols, filter) {
  let out = [], from = 0;
  for (;;) {
    let q = orderByPk(sb.from(table).select(cols), table).range(from, from + 999);
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
  if (!KEY) throw new Error('.env에 DART_API_KEY가 없습니다');

  const events = await fetchAll('disclosures', 'rcept_no,rcept_dt,corp_code,stock_code,report_nm',
    q => q.eq('report_type', 'A2_자기주식취득').eq('is_amendment', false).eq('is_subsidiary', false));
  console.log(`A2 자기주식취득 이벤트 ${events.length.toLocaleString()}건`);

  // 테이블 존재 확인. anon 키로는 CREATE TABLE 이 안 되므로 안내만 한다.
  {
    const { error } = await sb.from('buyback_details').select('rcept_no').limit(1);
    if (error && /schema cache|does not exist/i.test(error.message)) {
      console.error('\n❌ buyback_details 테이블이 없습니다.');
      console.error('   Supabase SQL Editor에서 supabase-buyback.sql 을 먼저 실행하세요.');
      console.error('   (anon 키로는 CREATE TABLE 이 불가능합니다)');
      process.exit(1);
    }
    if (error) throw new Error(`buyback_details 확인 실패: ${error.message}`);
  }

  let done = new Set();
  if (!ALL) {
    const have = await fetchAll('buyback_details', 'rcept_no');
    done = new Set(have.map(r => r.rcept_no));
    if (done.size) console.log(`이미 수집 ${done.size.toLocaleString()}건 — 나머지만 받는다 (--all 로 전건 재수집)`);
  }

  const todo = events.filter(e => !done.has(e.rcept_no));
  const byCorp = new Map();
  for (const e of todo) {
    if (!byCorp.has(e.corp_code)) byCorp.set(e.corp_code, []);
    byCorp.get(e.corp_code).push(e);
  }
  const corps = [...byCorp.keys()];
  console.log(`대상 ${todo.length.toLocaleString()}건 / 회사 ${corps.length.toLocaleString()}곳 → 예상 ${(corps.length * 2 * GAP_MS / 60000).toFixed(1)}분\n`);

  const t0 = Date.now();
  let matched = 0, unmatched = 0, saved = 0;
  const byMethod = { direct: 0, trust: 0 };
  const noAmount = [];
  const buf = [];

  for (let ci = 0; ci < corps.length; ci++) {
    const corp = corps[ci];
    const rows = new Map();   // rcept_no → {row, method}
    for (const [ep, method] of [['tsstkAqDecsn', 'direct'], ['tsstkAqTrctrCnsDecsn', 'trust']]) {
      for (const r of await fetchEp(ep, corp)) if (!rows.has(r.rcept_no)) rows.set(r.rcept_no, { row: r, method });
      await sleep(GAP_MS);
    }
    for (const ev of byCorp.get(corp)) {
      const hit = rows.get(ev.rcept_no);
      if (!hit) { unmatched++; continue; }
      const n = normalize(hit.row, hit.method, ev);
      matched++; byMethod[hit.method]++;
      if (n.plan_amount == null) noAmount.push(ev.rcept_no);
      buf.push(n);
    }
    if (buf.length >= 300 && !DRY) {
      const { error } = await sb.from('buyback_details').upsert(buf, { onConflict: 'rcept_no' });
      if (error) throw new Error(`저장 실패: ${error.message} (supabase-buyback.sql 실행했는지 확인)`);
      saved += buf.length; buf.length = 0;
    }
    if ((ci + 1) % 50 === 0 || ci === corps.length - 1) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${ci + 1}/${corps.length}곳  매칭 ${matched.toLocaleString()} / 미매칭 ${unmatched.toLocaleString()}  `
        + `경과 ${(el / 60).toFixed(1)}분  ETA ${((el / (ci + 1)) * (corps.length - ci - 1) / 60).toFixed(1)}분`);
    }
  }
  if (buf.length && !DRY) {
    const { error } = await sb.from('buyback_details').upsert(buf, { onConflict: 'rcept_no' });
    if (error) throw new Error(`저장 실패: ${error.message}`);
    saved += buf.length;
  }

  const coverage = (100 * matched) / Math.max(1, todo.length);
  console.log(`\n📊 매칭 ${matched.toLocaleString()} / 미매칭 ${unmatched.toLocaleString()} = 확보율 ${coverage.toFixed(1)}%`);
  console.log(`   경로별 — 직접취득 ${byMethod.direct.toLocaleString()} / 신탁체결 ${byMethod.trust.toLocaleString()}`);
  console.log(`   취득금액 결측 ${noAmount.length.toLocaleString()}건 (${(100 * noAmount.length / Math.max(1, matched)).toFixed(1)}%)`);
  if (!DRY) console.log(`   저장 ${saved.toLocaleString()}건`); else console.log('   [DRY] DB 미기록');

  // BUYBACK_VERDICT.md 중단 조건 — 값이 아니라 데이터 품질만 본다
  console.log('\n[중단 조건 점검]');
  console.log(`  확보율 ${coverage.toFixed(1)}% ${coverage >= MIN_COVERAGE ? '✅' : '🚨 80% 미만 — 판정을 돌리지 말 것'}`);
  const amtMissRate = (100 * noAmount.length) / Math.max(1, matched);
  console.log(`  취득금액 결측 ${amtMissRate.toFixed(1)}% ${amtMissRate <= 20 ? '✅' : '🚨 20% 초과 — P1(용량-반응) 측정 불가'}`);
  console.log(`  신탁 표본 ${byMethod.trust.toLocaleString()}건 ${byMethod.trust >= 100 ? '✅' : '⚠️ 100건 미만 — P2는 측정 불가 처리'}`);
})();
