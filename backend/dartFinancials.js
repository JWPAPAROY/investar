/**
 * dartFinancials.js — DART 다중회사 주요계정(fnlttMultiAcnt)으로 KIS 재무비율(FHKST66430300)과 같은 값을 만든다.
 *
 * 왜 (2026-11-26): KIS 가 2026-11-11 16:00 부터 종목분석 API 를 막아 financial-ratio 가 404 를 낸다
 *   (11-14·11-21 수집이 2,577종목 전부 실패). stock_financials 의 3분기 실적이 6종목뿐이라
 *   저PBR 포트폴리오가 2분기 재무로 계속 고르고 있었다.
 *
 * 만드는 값 (stock_financials 컬럼과 같은 뜻 — scripts/dart-financials-check.js 로 KIS 값과 대조):
 *   bps = 자본총계 ÷ 분기말 상장주식수
 *   eps = 누적 당기순이익 ÷ 분기말 상장주식수  (KIS 도 연초부터 누적)
 *   roe = 최근 4분기 순이익 ÷ 평균 자본(지금, 1년 전) × 100
 *         최근 4분기 = 올해 누적 + 직전 사업연도 − 전년 같은 기간 누적  (사업보고서면 그해 순이익)
 *   grs, opInc = 누적 매출액·영업이익의 전년 같은 기간 대비 증가율 %
 *   연결(CFS) 우선, 없으면 별도(OFS). 한 회사는 세 보고서에서 같은 구분을 쓴다.
 *
 * DART 호출: 보고서 하나당 100개 회사씩 → 분기 하나에 보고서 3개(이번 분기, 1년 전 같은 분기, 직전 사업보고서).
 */
const axios = require('axios');

const REPRT = { '03': '11013', '06': '11012', '09': '11014', '12': '11011' };
const num = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) && String(v ?? '').trim() !== '' && v !== '-' ? x : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** DART corpCode.xml → { stock_code: corp_code } (상장 회사만). zip 은 unzip 으로 푼다. */
async function fetchCorpCodes(key) {
  const { execFileSync } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path');
  const r = await axios.get('https://opendart.fss.or.kr/api/corpCode.xml', { params: { crtfc_key: key }, responseType: 'arraybuffer', timeout: 60000 });
  const zip = path.join(os.tmpdir(), `dart-corpcode-${process.pid}.zip`);
  fs.writeFileSync(zip, r.data);
  const xml = execFileSync('unzip', ['-p', zip], { maxBuffer: 1 << 28 }).toString('utf-8');
  fs.unlinkSync(zip);
  const map = {};
  for (const m of xml.matchAll(/<corp_code>(\d+)<\/corp_code>\s*<corp_name>[^<]*<\/corp_name>(?:\s*<corp_eng_name>[^<]*<\/corp_eng_name>)?\s*<stock_code>\s*(\d{6})\s*<\/stock_code>/g)) map[m[2]] = m[1];
  if (Object.keys(map).length < 2000) throw new Error(`corpCode 파싱 결과가 너무 적음: ${Object.keys(map).length}`);
  return map;
}

/**
 * 보고서 하나(사업연도·보고서 코드)를 회사 100개씩 받아 회사별 요약으로 만든다.
 * @returns {Map<stock_code, {CFS?:Acc, OFS?:Acc}>}  Acc = {eq, eqPrevFY, ni, niCum, niPrevCum, rev, revCum, revPrevCum, op, opCum, opPrevCum, end}
 */
async function fetchReport(key, corpCodes, year, reprt, { log = () => {}, delayMs = 150 } = {}) {
  const out = new Map();
  let calls = 0, errors = 0;
  for (let i = 0; i < corpCodes.length; i += 100) {
    const batch = corpCodes.slice(i, i + 100).join(',');
    let data = null;
    for (let t = 0; t < 3 && !data; t++) {
      try {
        const r = await axios.get('https://opendart.fss.or.kr/api/fnlttMultiAcnt.json',
          { params: { crtfc_key: key, corp_code: batch, bsns_year: String(year), reprt_code: reprt }, timeout: 60000 });
        calls++;
        if (r.data.status === '000' || r.data.status === '013') data = r.data;   // 013 = 조회 데이터 없음
        else if (r.data.status === '020') throw new Error('DART 사용 한도 초과(020)');
        else throw new Error(`DART ${r.data.status} ${r.data.message}`);
      } catch (e) {
        if (/020/.test(e.message)) throw e;
        if (t === 2) { errors++; log(`  ⚠️ ${year}/${reprt} 묶음 ${i / 100 + 1} 실패: ${e.message}`); }
        else await sleep(1500 * (t + 1));
      }
    }
    for (const x of (data && data.list) || []) {
      const code = (x.stock_code || '').trim();
      if (!/^\d{6}$/.test(code)) continue;
      if (!out.has(code)) out.set(code, {});
      const o = out.get(code);
      const a = o[x.fs_div] || (o[x.fs_div] = {});
      const nm = (x.account_nm || '').replace(/\s/g, '');
      if (x.sj_div === 'BS' && nm === '자본총계') {
        a.eq = num(x.thstrm_amount); a.eqPrevFY = num(x.frmtrm_amount);
        const m = String(x.thstrm_dt || '').match(/(\d{4})\.(\d{2})\.\d{2}/);
        if (m) a.end = m[1] + m[2];
        a.cur = (x.currency || 'KRW').trim() || 'KRW';   // 외국 회사(950xxx 등)·일부 국내사는 USD 로 낸다
      }
      if (x.sj_div === 'BS' && nm === '부채총계') a.liab = num(x.thstrm_amount);
      const isNm = nm.startsWith('당기순이익') ? 'ni' : nm === '매출액' ? 'rev' : nm === '영업이익' ? 'op' : null;
      if (x.sj_div === 'IS' && isNm && a[isNm] == null) {     // 당기순이익 행이 두 번 오는 경우가 있다 → 첫 행
        a[isNm] = num(x.thstrm_amount);
        a[isNm + 'Cum'] = num(x.thstrm_add_amount);
        a[isNm + 'PrevCum'] = num(x.frmtrm_add_amount);
        a[isNm + 'Prev'] = num(x.frmtrm_amount);
      }
    }
    if (delayMs) await sleep(delayMs);
  }
  return { byCode: out, calls, errors };
}

/**
 * 연결 재무제표 전체(fnlttSinglAcntAll, CFS)에서 지배기업 소유주 몫 자본·순이익을 받는다. 회사 하나당 1호출.
 * 주요계정 API 의 자본총계·당기순이익은 비지배지분을 포함한다 — 지주회사(두산·한화 등)는 KIS BPS 의 4~5배가 됐다.
 * @returns {Map<stock_code, {eq, eqPrevFY, ni, niCum, niPrevCum, niPrev}>}
 */
async function fetchControlling(key, pairs, year, reprt, { log = () => {}, delayMs = 120 } = {}) {
  const out = new Map();
  let calls = 0, errors = 0, empty = 0;
  const failed = new Set();   // 네트워크·서버 오류로 못 받은 회사 (빈 응답과 구분)
  for (const [code, corp] of pairs) {
    let data = null;
    for (let t = 0; t < 3 && !data; t++) {
      try {
        const r = await axios.get('https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json',
          { params: { crtfc_key: key, corp_code: corp, bsns_year: String(year), reprt_code: reprt, fs_div: 'CFS' }, timeout: 30000 });
        calls++;
        if (r.data.status === '000' || r.data.status === '013') data = r.data;
        else if (r.data.status === '020') throw new Error('DART 사용 한도 초과(020)');
        else throw new Error(`DART ${r.data.status} ${r.data.message}`);
      } catch (e) {
        if (/020/.test(e.message)) throw e;
        if (t === 2) { errors++; failed.add(code); log(`  ⚠️ ${code} ${year}/${reprt}: ${e.message}`); }
        else await sleep(1000 * (t + 1));
      }
    }
    const list = (data && data.list) || [];
    if (!list.length) { empty++; if (delayMs) await sleep(delayMs); continue; }
    const o = {};
    for (const x of list) {
      const id = x.account_id || '', nm = (x.account_nm || '').replace(/\s/g, '');
      if (x.sj_div === 'BS' && o.eq == null && (id === 'ifrs-full_EquityAttributableToOwnersOfParent' || /^지배기업(의)?소유주(에게)?(귀속)?(되는)?지분$|^지배기업소유주지분$/.test(nm))) {
        o.eq = num(x.thstrm_amount); o.eqPrevFY = num(x.frmtrm_amount);
      }
      if ((x.sj_div === 'IS' || x.sj_div === 'CIS') && o.ni == null && (id === 'ifrs-full_ProfitLossAttributableToOwnersOfParent' || /^지배기업(의)?소유주(에게)?(귀속)?(되는)?(당기)?순(이익|손익)/.test(nm))) {
        o.ni = num(x.thstrm_amount); o.niCum = num(x.thstrm_add_amount); o.niPrevCum = num(x.frmtrm_add_amount); o.niPrev = num(x.frmtrm_amount);
      }
    }
    if (o.eq != null || o.ni != null) out.set(code, o);
    if (delayMs) await sleep(delayMs);
  }
  return { byCode: out, calls, errors, empty, failed };
}

/**
 * 주식총수 현황(stockTotqySttus) — 보통주 발행주식수·유통주식수(자기주식 제외). 회사당 1호출.
 * KIS BPS 는 자기주식을 뺀 보통주로 나눈다(삼성전자 KIS/보통주 전체 = 0.988 ≈ 유통/발행 0.986).
 * @returns {Map<stock_code, {istc, distb}>}
 */
async function fetchShareCounts(key, pairs, year, reprt, { log = () => {}, delayMs = 120 } = {}) {
  const out = new Map(), failed = new Set();
  let calls = 0, errors = 0, empty = 0;
  for (const [code, corp] of pairs) {
    let data = null;
    for (let t = 0; t < 3 && !data; t++) {
      try {
        const r = await axios.get('https://opendart.fss.or.kr/api/stockTotqySttus.json',
          { params: { crtfc_key: key, corp_code: corp, bsns_year: String(year), reprt_code: reprt }, timeout: 30000 });
        calls++;
        if (r.data.status === '000' || r.data.status === '013') data = r.data;
        else if (r.data.status === '020') throw new Error('DART 사용 한도 초과(020)');
        else throw new Error(`DART ${r.data.status} ${r.data.message}`);
      } catch (e) {
        if (/020/.test(e.message)) throw e;
        if (t === 2) { errors++; failed.add(code); log(`  ⚠️ 주식수 ${code} ${year}/${reprt}: ${e.message}`); }
        else await sleep(1000 * (t + 1));
      }
    }
    // KIS 는 보통주+우선주 유통주식수로 나눈다(삼성전자 KIS BPS 86,052 = 지배 자본 ÷ 합계 유통 6,566,563,106).
    //   istc = 보통주 발행(KRX 보통주 상장주식수와 같은 기준), distb = 합계 유통(없으면 보통주 유통)
    //   → 주식수 = 지금 KRX 보통주 × distb / istc
    const list = (data && data.list) || [], se = x => (x.se || '').replace(/\s/g, '');
    const com = list.find(x => se(x) === '보통주'), tot = list.find(x => se(x) === '합계');
    const istc = com && num(com.istc_totqy);
    const distb = (tot && num(tot.distb_stock_co)) || (com && num(com.distb_stock_co));
    if (istc > 0 && distb > 0) out.set(code, { istc, distb });
    else if (data) empty++;
    if (delayMs) await sleep(delayMs);
  }
  return { byCode: out, calls, errors, empty, failed };
}

/**
 * 원화 환산 배수. FRED 일별 환율(분기말 이하 마지막 값). KRW 는 1.
 * USD: DEXKOUS(원/달러). JPY·CNY: DEXKOUS ÷ DEXJPUS·DEXCHUS. 그 외 통화는 null(행을 만들지 않음).
 */
async function fxToKrw(ym) {
  const end = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(4, 6), 0)).getUTCDate()}`;
  const last = async id => {
    const r = await axios.get('https://fred.stlouisfed.org/graph/fredgraph.csv', { params: { id, cosd: new Date(Date.parse(end) - 20 * 864e5).toISOString().slice(0, 10), coed: end }, timeout: 30000 });
    const v = String(r.data).trim().split(/\r?\n/).slice(1).map(l => l.split(',')).filter(([d, x]) => d <= end && Number.isFinite(+x) && x !== '').pop();
    if (!v) throw new Error(`FRED ${id} ${end} 값 없음`);
    return +v[1];
  };
  const usd = await last('DEXKOUS');
  const rates = { KRW: 1, USD: usd };
  try { rates.JPY = usd / await last('DEXJPUS'); } catch { /* 없으면 JPY 행 제외 */ }
  try { rates.CNY = usd / await last('DEXCHUS'); } catch { /* 없으면 CNY 행 제외 */ }
  return { rates, get: c => rates[c] ?? null };
}

// 연결 회사면 지배주주 몫으로 덮는다(값이 있는 필드만). 분기 보고서의 3개월 순이익은 누적이 있으면 그대로 둔다.
function overlay(a, c) {
  if (!c) return a;
  const m = { ...a };
  for (const k of ['eq', 'eqPrevFY', 'ni', 'niCum', 'niPrevCum', 'niPrev']) if (c[k] != null) m[k] = c[k];
  return m;
}

const growth = (now, prev) => (now != null && prev != null && prev !== 0) ? +(((now - prev) / Math.abs(prev)) * 100).toFixed(2) : null;

/**
 * 한 분기(ym)의 행을 만든다.
 * @param ym        'YYYYMM' (03/06/09/12)
 * @param cur       fetchReport(ym 의 연도, REPRT[mm]).byCode
 * @param yearAgo   fetchReport(연도−1, 같은 보고서).byCode  (분기 보고서일 때 1년 전 자본)
 * @param prevFY    fetchReport(연도−1, '11011').byCode      (분기 보고서일 때 직전 사업연도 순이익)
 * @param sharesOf  (code) => 분기말 상장주식수 | null
 */
function buildRows(ym, cur, yearAgo, prevFY, sharesOf, ctrl = {}, fx = { get: c => (c === 'KRW' || !c ? 1 : null) }) {
  const mm = ym.slice(4, 6), annual = mm === '12';
  const rows = [], skipped = { noShares: 0, noEquity: 0, otherFY: 0, currency: 0 };
  for (const [code, o] of cur) {
    const div = o.CFS && o.CFS.eq != null ? 'CFS' : (o.OFS && o.OFS.eq != null ? 'OFS' : null);
    if (!div) { skipped.noEquity++; continue; }
    const a = div === 'CFS' ? overlay(o[div], ctrl.cur && ctrl.cur.get(code)) : o[div];
    if (a.end && a.end !== ym) { skipped.otherFY++; continue; }          // 12월 결산이 아닌 회사
    const sh = sharesOf(code);
    if (!(sh > 0)) { skipped.noShares++; continue; }
    const k = fx.get(o[div].cur || 'KRW');                              // 주당 값만 원화로 (ROE·증가율은 비율이라 그대로)
    if (!(k > 0)) { skipped.currency++; continue; }

    const niCum = annual ? a.ni : a.niCum;
    let ttm = null, eqAgo = null;
    if (annual) { ttm = a.ni; eqAgo = a.eqPrevFY; }
    else {
      const f = prevFY && prevFY.get(code), p0 = f && (f[div] || f.CFS || f.OFS), p = div === 'CFS' ? overlay(p0, ctrl.prevFY && ctrl.prevFY.get(code)) : p0;
      if (niCum != null && a.niPrevCum != null && p && p.ni != null) ttm = niCum + p.ni - a.niPrevCum;
      const y = yearAgo && yearAgo.get(code), q0 = y && (y[div] || y.CFS || y.OFS), q = div === 'CFS' ? overlay(q0, ctrl.yearAgo && ctrl.yearAgo.get(code)) : q0;
      eqAgo = q ? q.eq : null;
    }
    const avgEq = eqAgo != null && eqAgo > 0 ? (a.eq + eqAgo) / 2 : a.eq;
    const revCum = annual ? a.rev : a.revCum, revPrev = annual ? a.revPrev : a.revPrevCum;
    const opCum = annual ? a.op : a.opCum, opPrev = annual ? a.opPrev : a.opPrevCum;
    rows.push({
      code, ym, fs: div,
      bps: Math.round(a.eq * k / sh),
      eps: niCum != null ? Math.round(niCum * k / sh) : null,
      sps: revCum != null ? Math.round(revCum * k / sh) : null,
      cur: o[div].cur || 'KRW',
      roe: ttm != null && avgEq > 0 ? +((ttm / avgEq) * 100).toFixed(2) : null,
      grs: growth(revCum, revPrev),
      opInc: growth(opCum, opPrev),
      niInc: growth(niCum, annual ? a.niPrev : a.niPrevCum),
      // 부채비율은 전체 자본 기준(비지배 포함) — 지배 몫으로 덮기 전 값
      debt: o[div].liab != null && o[div].eq > 0 ? +((o[div].liab / o[div].eq) * 100).toFixed(2) : null,
    });
  }
  return { rows, skipped };
}

module.exports = { REPRT, fetchCorpCodes, fetchReport, fetchControlling, fetchShareCounts, fxToKrw, buildRows };
