/**
 * 시장 흐름 탭 수집기 (2026-11-15, 2026-11-16 개정) — 연준 · 국면 · 업종 흐름 · 민감도 · 일정 · 정책 뉴스 · 정책 사건
 *
 *   node scripts/collect-macro.js            # 수집 → Supabase(macro_snapshot / policy_news / policy_events)
 *   node scripts/collect-macro.js --dry      # 수집만, 결과 요약 출력(DB 쓰기 없음. 캐시는 읽기만 한다)
 *   node scripts/collect-macro.js --dry --out=파일.json   # 화면 점검용으로 API 응답 모양 저장
 *
 * 데이터 출처(KRX 만 KRX_AUTH_KEY, 나머지 키 불필요):
 *   FRED fredgraph.csv — 기준금리(DFEDTARU/L), 점도표 중앙값(FEDTARMD, 장기 FEDTARMDLR), 3·6개월·1·2·10년물,
 *                        근원 PCE(PCEPILFE), CPI(CPIAUCSL), 실업률(UNRATE),
 *                        점도표 전망: 근원 PCE(JCXFEMD) · PCE(PCECTPIMD) · 실업률(UNRATEMD)
 *   FRED 발표 일정      — fred.stlouisfed.org/releases/calendar (CPI rid=10, 개인소득·PCE rid=54, 고용 rid=50)
 *   연준 FOMC 일정      — federalreserve.gov/monetarypolicy/fomccalendars.htm (* = 점도표 회의)
 *   Yahoo chart v8     — KOSPI(^KS11), S&P500(^GSPC), SOX, 원/달러, 미국 업종 ETF, 직접 구성 바구니 종목, 정책 사건 종목
 *   KRX OpenAPI        — 업종지수(idx/*_dd_trd), 전 종목 일별(sto/*_bydd_trd: 신규 상장일 판별)
 *   DART(Supabase disclosures) — [발행조건확정]증권신고서(지분증권) = 공모 상장 후보
 *   Google 뉴스 RSS    — 정책·국가자본주의·연준 기사 제목
 *
 * 원칙: 여기서 만든 숫자만 화면에 나간다. 매매 권고를 만들지 않는다(근거: 2026-11-15 측정 —
 *   정책 발표 후 20일 추세 6/12, 해외 신호 장중 적중 45%, 금리-주가 관계는 국면마다 부호가 바뀜).
 *
 * 2026-11-16 개정(점검 결과 반영):
 *   - 근원 PCE 옆 전망치가 헤드라인 PCE(PCECTPIMD)였다 → 근원 전망 JCXFEMD 로 교체
 *   - 2025-10 CPI 가 셧다운으로 결측이라 2026-10 전년비가 계산 안 돼 화면이 9월에 멈춤 → 최신월·결측 사유·3개월 연율 함께 저장
 *   - 국면: KOSPI 금요일 종가는 미국 금요일 장 전에 확정 → KOSPI 쌍은 미국 목요일 금리 변화와 맞춘다
 *   - 상관 판정 문턱을 ±0.2 고정 → 표본 수에서 계산한 5% 유의 경계(13주 ≈ 0.55)로
 *   - 'KRX 2차전지 TOP 10' 은 KRX API 에 없어 조용히 빠졌다 → 2차전지·조선·방산·원전·전력기기는 직접 구성 바구니(동일가중, Yahoo 수정주가)
 *   - 민감도(업종·바구니의 미 10년물·SOX·원/달러 주간 베타), 일정(FOMC·미 지표·선물 만기·보호예수 해제) 추가
 *   - 한국 정책 사건(target_kind=krx)도 결과가 비어 있으면 KRX 업종지수로 자동 계산
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const cal = require('../backend/marketCalendar');
const { newsPasses, rCrit, sensitivity } = require('../backend/macroShared');
const street = require('../backend/streetViews');

const DRY = process.argv.includes('--dry');
const KRX_KEY = process.env.KRX_AUTH_KEY;
const UA = { 'User-Agent': 'Mozilla/5.0 (investar-macro/1.1)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; if (i < tries - 1) await sleep(2000 * (i + 1)); }
  }
  throw new Error(`${url.slice(0, 80)}: ${last && last.message}`);
}

// ── 날짜 도우미 (KST 기준 YYYY-MM-DD) ─────────────────────────────────────────
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = (a, b) => (a && b ? (b / a - 1) * 100 : null);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function corr(x, y) {
  const n = x.length; if (n < 8) return null;
  const mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; }
  return b && c ? a / Math.sqrt(b * c) : null;
}
/** 시간대 tz 의 벽시계(날짜 d, hh:mm)를 KST 'YYYY-MM-DD HH:mm' 로 */
function zonedToKst(d, hh, mm, tz) {
  const guess = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), hh, mm);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date(guess)).find(p => p.type === 'timeZoneName').value;
  const m = off.match(/GMT([+-]\d+)(?::(\d+))?/); const offMin = m ? (+m[1]) * 60 + Math.sign(+m[1]) * (+(m[2] || 0)) : 0;
  return new Date(guess - offMin * 60e3 + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}
const addMonths = (d, m) => { const [y, mo, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + m, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(dd, last)); return t.toISOString().slice(0, 10); };
const tradingOnOrAfter = d => { let c = d; for (let i = 0; i < 15 && !cal.isTradingDay(c); i++) c = addDays(c, 1); return c; };
const tradingOnOrBefore = d => { let c = d; for (let i = 0; i < 15 && !cal.isTradingDay(c); i++) c = addDays(c, -1); return c; };
const tradingBefore = (d, n) => { let c = d, k = n; while (k > 0) { c = addDays(c, -1); if (cal.isTradingDay(c)) k--; } return c; };

// ── FRED ────────────────────────────────────────────────────────────────────
async function fred(id) {
  const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: UA });
  return t.trim().split('\n').slice(1).map(l => l.split(',')).filter(([, v]) => v && v.trim() !== '.' && v.trim() !== '').map(([d, v]) => [d, +v]);
}
const prevYearMonth = d => `${+d.slice(0, 4) - 1}${d.slice(4)}`;
const yoy = s => { const m = new Map(s); return s.map(([d, v]) => { const p = m.get(prevYearMonth(d)); return p ? [d, r2(pct(p, v))] : null; }).filter(Boolean); };
// 3개월 연율: (지수_t / 지수_t-3)^4 − 1. 연준 관측자들이 '최근 속도'로 쓰는 값이고, 전년비와 달리 1년 전 결측에 안 걸린다.
const ann3 = s => s.map(([d, v], i) => { const j = i - 3; if (j < 0) return null; const [d0, v0] = s[j]; const gap = (+d.slice(0, 4) - +d0.slice(0, 4)) * 12 + (+d.slice(5, 7) - +d0.slice(5, 7)); return gap === 3 ? [d, r2(((v / v0) ** 4 - 1) * 100)] : null; }).filter(Boolean);

// ── Yahoo (일봉 종가, 거래소 현지 날짜) ──────────────────────────────────────
const _y = new Map();
async function yahoo(sym, fromYear = 2010, tries = 3) {
  const key = sym + '@' + fromYear;
  if (_y.has(key)) return _y.get(key);
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000), p2 = Math.floor(Date.now() / 1000) + 86400;
  const t = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`, { headers: UA }, tries);
  const j = JSON.parse(t).chart.result[0];
  const off = j.meta.gmtoffset || 0, q = j.indicators.quote[0], adj = j.indicators.adjclose?.[0]?.adjclose;
  const c = adj && adj.length === q.close.length ? adj : q.close;   // 수정주가 우선(분할·배당 이음매 방지)
  const out = j.timestamp.map((ts, i) => [new Date((ts + off) * 1000).toISOString().slice(0, 10), c[i]]).filter(([, v]) => v != null);
  _y.set(key, out); await sleep(350);
  return out;
}
async function yahooKR(code, fromYear) {
  try { return await yahoo(`${code}.KS`, fromYear, 1); } catch { return yahoo(`${code}.KQ`, fromYear, 2); }
}
const lastOnOrBefore = (s, d) => { let lo = 0, hi = s.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m][0] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
const valAt = (s, d) => { const k = lastOnOrBefore(s, d); return k >= 0 ? s[k][1] : null; };

// ── KRX ─────────────────────────────────────────────────────────────────────
async function krxIndexDay(d, paths = ['idx/kospi_dd_trd', 'idx/krx_dd_trd']) {
  const basDd = d.replace(/-/g, ''), out = {};
  for (const p of paths) {
    const t = await get(`http://data-dbg.krx.co.kr/svc/apis/${p}?basDd=${basDd}`, { headers: { AUTH_KEY: KRX_KEY } });
    for (const x of JSON.parse(t).OutBlock_1 || []) { const v = +String(x.CLSPRC_IDX).replace(/,/g, ''); if (v > 0 && !(x.IDX_NM in out)) out[x.IDX_NM] = v; }
    await sleep(250);
  }
  return Object.keys(out).length ? out : null;
}
async function krxOnOrBefore(d, maxBack = 10) {
  for (let k = 0; k <= maxBack; k++) { const x = addDays(d, -k); if (!cal.isTradingDay(x)) continue; const m = await krxIndexDay(x); if (m && m['코스피']) return [x, m]; }
  return [null, null];
}
/** 그날 상장돼 거래된 전 종목 (유가 + 코스닥): Map(코드 → 종목명) */
async function krxCodesDay(d) {
  const basDd = d.replace(/-/g, ''), out = new Map();
  for (const p of ['sto/stk_bydd_trd', 'sto/ksq_bydd_trd']) {
    const t = await get(`http://data-dbg.krx.co.kr/svc/apis/${p}?basDd=${basDd}`, { headers: { AUTH_KEY: KRX_KEY } });
    for (const x of JSON.parse(t).OutBlock_1 || []) if (x.ISU_CD) out.set(x.ISU_CD, x.ISU_NM || x.ISU_ABBRV || '');
    await sleep(250);
  }
  return out;
}

// ── ① 연준 ──────────────────────────────────────────────────────────────────
async function fomcSchedule() {
  const html = await get('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { headers: UA });
  const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const out = [];
  const parts = html.split(/(\d{4}) FOMC Meetings<\/a>/);
  for (let i = 1; i < parts.length; i += 2) {
    const year = +parts[i], body = parts[i + 1].split(/FOMC Meetings<\/a>/)[0];
    const months = [...body.matchAll(/fomc-meeting__month[^>]*><strong>([^<]+)<\/strong>/g)].map(m => m[1].trim());
    const dates = [...body.matchAll(/fomc-meeting__date[^>]*>([^<]+)</g)].map(m => m[1].trim());
    for (let k = 0; k < Math.min(months.length, dates.length); k++) {
      if (/notation|unscheduled|conference call/i.test(dates[k])) continue;
      const ms = months[k].toLowerCase().split('/').map(x => MON[x.trim()]).filter(Boolean);
      const dm = dates[k].match(/(\d+)(?:\s*-\s*(\d+))?/); if (!ms.length || !dm) continue;
      const endDay = +(dm[2] || dm[1]), endMon = dm[2] && ms.length > 1 && +dm[2] < +dm[1] ? ms[1] : ms[0];
      const date = `${year}-${String(endMon).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
      out.push({ date, sep: dates[k].includes('*'), kst: zonedToKst(date, 14, 0, 'America/New_York') });   // 결정 발표 오후 2시(ET)
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
async function fredReleaseDates(rid) {
  const y = +kstToday().slice(0, 4), out = [];
  for (const yr of [y, y + 1]) {
    let html; try { html = await get(`https://fred.stlouisfed.org/releases/calendar?rid=${rid}&y=${yr}`, { headers: UA }); } catch { continue; }
    let cur = null;
    for (const m of html.matchAll(/font-weight: bold;">\w+day (\w+ \d+, \d{4})<\/span>|(\d{1,2}):(\d{2}) ([ap]m)\s*<\/td>\s*<td[^>]*>\s*<a href="\/release\?rid=(\d+)"/g)) {
      if (m[1]) { const t = new Date(m[1] + ' UTC'); cur = isNaN(t) ? null : t.toISOString().slice(0, 10); continue; }
      if (!cur || +m[5] !== rid) continue;
      let hh = +m[2] % 12; if (m[4] === 'pm') hh += 12;
      out.push({ date: cur, kst: zonedToKst(cur, hh, +m[3], 'America/Chicago') });   // FRED 일정표는 미 중부 시각
    }
    await sleep(400);
  }
  return [...new Map(out.map(x => [x.date, x])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── 연방기금 선물 ─────────────────────────────────────────────────────────────
// CBOT 30일 연방기금 선물(ZQ, Yahoo) 가격 = 100 − 그 달 평균 실효금리 예상. 시장이 돈을 걸고 매긴 금리 경로다.
// 회의별 반영 변화는 CME FedWatch 와 같은 방식: 회의가 있는 달 평균 = (회의 전 일수×이전 금리 + 회의 후 일수×새 금리)/월 일수.
//   회의가 월말에 가까워(회의 후 7일 미만) 그 달 계약으로 풀기 불안하면 다음 달 계약을 회의 후 금리로 쓴다.
//   1주·4주 전 경로도 같은 계약의 과거 종가로 다시 풀어, 수준보다 '바뀐 것'을 보여준다.
async function fedFutures(effr, meetings) {
  const MC = 'FGHJKMNQUVXZ';
  const today = kstToday();
  let y = +today.slice(0, 4), m = +today.slice(5, 7);
  const contracts = [];   // { ym, closes: [[d, rate]] }
  for (let k = 0; k < 10; k++) {
    const sym = `ZQ${MC[m - 1]}${String(y % 100).padStart(2, '0')}.CBT`;
    try {
      const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=3mo&interval=1d`, { headers: UA }, 2)).chart.result[0];
      const off = j.meta.gmtoffset || 0, c = j.indicators.quote[0].close;
      const closes = j.timestamp.map((ts, i) => [new Date((ts + off) * 1000).toISOString().slice(0, 10), c[i]]).filter(([, v]) => v > 50).map(([d, v]) => [d, Math.round((100 - v) * 1000) / 1000]);
      const p = j.meta.regularMarketPrice, pd = new Date(j.meta.regularMarketTime * 1000).toISOString().slice(0, 10);
      if (p > 50 && (!closes.length || closes.at(-1)[0] < pd)) closes.push([pd, Math.round((100 - p) * 1000) / 1000]);
      if (closes.length) contracts.push({ ym: `${y}-${String(m).padStart(2, '0')}`, closes });
    } catch { /* 거래 없는 원월물은 빠진다 */ }
    await sleep(250);
    if (++m > 12) { m = 1; y++; }
  }
  if (!contracts.length || effr == null) return null;
  const nextYm = ym => { let [a, b] = ym.split('-').map(Number); if (++b > 12) { b = 1; a++; } return `${a}-${String(b).padStart(2, '0')}`; };
  const prevYm = ym => { let [a, b] = ym.split('-').map(Number); if (--b < 1) { b = 12; a--; } return `${a}-${String(b).padStart(2, '0')}`; };
  // asOf 날짜(이하 마지막 종가) 기준 경로. start = 출발 금리(오늘은 실효금리, 과거는 첫 회의 전 달 계약)
  const solve = (asOf, start) => {
    const M = new Map(contracts.map(c => [c.ym, (c.closes.filter(([d]) => d <= asOf).at(-1) || [])[1]]).filter(([, v]) => v != null));
    let pre = start ?? M.get(prevYm(meetings[0]?.date.slice(0, 7) || '')) ?? effr;
    const s0 = pre, path = [];
    for (const mt of meetings) {
      const ym = mt.date.slice(0, 7), avg = M.get(ym);
      if (avg == null) break;
      const [yy, mm] = ym.split('-').map(Number), N = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      const d1 = +mt.date.slice(8, 10);   // 결정 다음 날부터 새 금리 → 결정일까지 d1 일은 이전 금리
      let post;
      if (N - d1 >= 7) post = (avg * N - pre * d1) / (N - d1);
      else { const nx = M.get(nextYm(ym)); if (nx == null) break; post = nx; }
      path.push({ date: mt.date, kst: mt.kst, sep: mt.sep, after: r2(post), changeBp: Math.round((post - pre) * 100), cumBp: Math.round((post - s0) * 100) });
      pre = post;
    }
    return path;
  };
  const asOf = contracts.map(c => c.closes.at(-1)[0]).sort().at(-1);
  const back = n => {
    const d = addDays(asOf, -n);
    const p = solve(d, null);
    return p.length ? { asOf: contracts[0].closes.filter(([x]) => x <= d).at(-1)?.[0] || d, path: p.map(x => ({ date: x.date, after: x.after })) } : null;
  };
  return {
    effr, asOf, path: solve(asOf, effr),
    months: contracts.map(c => ({ ym: c.ym, rate: c.closes.at(-1)[1] })),
    prev: { w1: back(7), m1: back(28) },
  };
}

async function buildFed() {
  const ids = ['DFEDTARU', 'DFEDTARL', 'FEDTARMD', 'FEDTARMDLR', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS10', 'PCEPILFE', 'CPIAUCSL', 'UNRATE', 'JCXFEMD', 'PCECTPIMD', 'UNRATEMD', 'DFF'];
  const S = {};
  for (const id of ids) { S[id] = await fred(id); await sleep(300); }
  const last = id => S[id].at(-1) || [null, null];
  const upper = last('DFEDTARU')[1], lower = last('DFEDTARL')[1], mid = (upper + lower) / 2;
  const year = +kstToday().slice(0, 4);
  const projFor = id => (S[id].find(([d]) => +d.slice(0, 4) === year) || [])[1] ?? null;
  const dots = S.FEDTARMD.map(([d, v]) => ({ year: +d.slice(0, 4), median: v }));
  const dotThisYear = (dots.find(x => x.year === year) || {}).median ?? null;
  const dotNextYear = (dots.find(x => x.year === year + 1) || {}).median ?? null;
  const sepDate = last('FEDTARMDLR')[0];
  // 점도표 원문(연준 SEP 표·그림). 회의 둘째 날 = FRED 의 SEP 날짜. 주소가 없으면 FOMC 일정 페이지로.
  let dotLink = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
  if (sepDate) {
    const u = `https://www.federalreserve.gov/monetarypolicy/fomcprojtabl${sepDate.replace(/-/g, '')}.htm`;
    try { await get(u, { headers: UA, method: 'HEAD' }, 1); dotLink = u; } catch { /* 일정 페이지 유지 */ }
  }
  const infl = (id) => {
    const s = S[id], y = yoy(s), a = ann3(s), raw = s.at(-1);
    const latestYoy = y.at(-1);
    return {
      last: latestYoy, series: y.slice(-24), ann3: a.at(-1) || null, ann3Series: a.slice(-24),
      latestMonth: raw ? raw[0] : null,
      // 최신월 전년비가 없는 이유(1년 전 값 결측). 2025-10 CPI 는 미 정부 셧다운으로 발표되지 않았다.
      yoyMissing: raw && latestYoy && raw[0] > latestYoy[0] ? { month: raw[0], base: prevYearMonth(raw[0]) } : null,
    };
  };
  const changes = []; let prev = null;
  for (const [d, v] of S.DFEDTARU) { if (prev != null && v !== prev) changes.push({ date: d, upper: v, change: r2(v - prev) }); prev = v; }
  const since = addDays(kstToday(), -730);
  const weekly = s => s.filter(([d]) => d >= since).filter((_, i, a) => i % 5 === 0 || i === a.length - 1).map(([d, v]) => [d, v]);
  const bill = id => ({ value: last(id)[1], date: last(id)[0], vsMid: r2(last(id)[1] - mid) });

  let fomc = [], fomcErr = null;
  try { fomc = await fomcSchedule(); } catch (e) { fomcErr = e.message; }
  const today = kstToday();
  const upcoming = fomc.filter(m => m.kst.slice(0, 10) >= today);
  let futures = null, futuresErr = null;
  try { futures = await fedFutures(last('DFF')[1], upcoming); } catch (e) { futuresErr = e.message; }
  return {
    asOf: today,
    futures: futures ? { ...futures, effrDate: last('DFF')[0] } : null, futuresErr,
    rate: { upper, lower, mid, since: (changes.at(-1) || {}).date || null, changes: changes.slice(-8) },
    dots, dotThisYear, dotNextYear, sepDate, dotLink,
    longRun: S.FEDTARMDLR.slice(-6).map(([d, v]) => ({ sep: d, value: v })),
    market: {
      y2: last('DGS2')[1], y2Date: last('DGS2')[0], y10: last('DGS10')[1], y10Date: last('DGS10')[0],
      y2MinusMid: r2(last('DGS2')[1] - mid),
      y2Series: weekly(S.DGS2), y10Series: weekly(S.DGS10), m3Series: weekly(S.DGS3MO),
      ladder: { m3: bill('DGS3MO'), m6: bill('DGS6MO'), y1: bill('DGS1'), y2: bill('DGS2') },
    },
    drivers: {
      corePce: { ...infl('PCEPILFE'), projThisYear: projFor('JCXFEMD') },
      cpi: infl('CPIAUCSL'),
      pceProjThisYear: projFor('PCECTPIMD'),
      unemp: { last: last('UNRATE'), series: S.UNRATE.slice(-24), projThisYear: projFor('UNRATEMD') },
    },
    impliedMoveThisYear: dotThisYear != null ? r2(dotThisYear - mid) : null,
    fomc: { next: upcoming[0] || null, remainingThisYear: upcoming.filter(m => +m.date.slice(0, 4) === year).length, upcoming: upcoming.slice(0, 4), error: fomcErr },
  };
}

// ── ② 국면: 금리 변화와 주가가 같은 방향인가 ─────────────────────────────────
// KOSPI 금요일 종가는 미국 금요일 장이 열리기 전에 확정된다 → KOSPI 쌍은 미국 '목요일' 금리, S&P 쌍은 금요일 금리.
async function buildRegime() {
  const us10 = await fred('DGS10');
  const ks = await yahoo('^KS11'), sp = await yahoo('^GSPC');
  const F = []; for (let t = Date.UTC(2010, 0, 8); t <= Date.now(); t += 7 * 864e5) F.push(new Date(t).toISOString().slice(0, 10));
  const val = (s, d) => { const k = lastOnOrBefore(s, d); return k >= 0 && Date.parse(d) - Date.parse(s[k][0]) < 7 * 864e5 ? s[k][1] : null; };
  const W = F.map(d => ({ d, r: val(us10, d), rThu: val(us10, addDays(d, -1)), k: val(ks, d), s: val(sp, d) }));
  const diffs = W.map((w, i) => (i ? {
    d: w.d,
    drS: w.r != null && W[i - 1].r != null ? w.r - W[i - 1].r : null,
    drK: w.rThu != null && W[i - 1].rThu != null ? w.rThu - W[i - 1].rThu : null,
    k: w.k && W[i - 1].k ? Math.log(w.k / W[i - 1].k) : null,
    s: w.s && W[i - 1].s ? Math.log(w.s / W[i - 1].s) : null,
  } : null));
  const pair = (q, key) => (q && q[key] != null && q[key === 'k' ? 'drK' : 'drS'] != null ? [q[key === 'k' ? 'drK' : 'drS'], q[key]] : null);
  const rolling = (key, i, n = 13) => { const P = []; for (let j = i - n + 1; j <= i; j++) { const p = pair(diffs[j], key); if (p) P.push(p); } return P.length >= 10 ? r2(corr(P.map(p => p[0]), P.map(p => p[1]))) : null; };
  const series = [];
  for (let i = Math.max(13, W.length - 156); i < W.length; i++) series.push([W[i].d, rolling('k', i), rolling('s', i)]);
  const years = [];
  for (let y = 2010; y <= +kstToday().slice(0, 4); y++) {
    const ix = W.map((w, i) => i).filter(i => W[i].d.startsWith(String(y)));
    if (!ix.length) continue;   // 새해 첫 금요일 전에는 그해 행이 없다
    const q = diffs.filter(x => x && x.d.startsWith(String(y)));
    const a = W[ix[0] - 1] || W[ix[0]], b = W[ix.at(-1)];
    const qk = q.map(x => pair(x, 'k')).filter(Boolean), qs = q.map(x => pair(x, 's')).filter(Boolean);
    years.push({ year: y, dRate: r2(b.r - a.r), kospi: r2(pct(a.k, b.k)), spx: r2(pct(a.s, b.s)),
      corrK: r2(corr(qk.map(p => p[0]), qk.map(p => p[1]))), corrS: r2(corr(qs.map(p => p[0]), qs.map(p => p[1]))), partial: y === +kstToday().slice(0, 4) });
  }
  const spikes = []; let lastI = -99;
  for (let i = 13; i < W.length; i++) {
    if (W[i].r == null || W[i - 13].r == null || W[i].r - W[i - 13].r < 0.75 || i - lastI < 13) continue;
    lastI = i; const j = Math.min(i + 13, W.length - 1);
    spikes.push({ from: W[i - 13].d, to: W[i].d, rateFrom: W[i - 13].r, rateTo: W[i].r,
      kospiDuring: r2(pct(W[i - 13].k, W[i].k)), spxDuring: r2(pct(W[i - 13].s, W[i].s)),
      kospiAfter: j > i ? r2(pct(W[i].k, W[j].k)) : null, spxAfter: j > i ? r2(pct(W[i].s, W[j].s)) : null, afterWeeks: j - i });
  }
  // 마지막 칸: 금리·주가가 모두 있는 최근 금요일
  let n = W.length - 1; while (n > 13 && (W[n].k == null || W[n].r == null)) n--;
  return {
    asOf: W[n].d, window: 13, rCrit: r2(rCrit(13)),
    now: { corrK: rolling('k', n), corrS: rolling('s', n), dRate13: r2(W[n].r - W[n - 13].r), kospi13: r2(pct(W[n - 13].k, W[n].k)), spx13: r2(pct(W[n - 13].s, W[n].s)) },
    series, years, spikes,
  };
}

// ── ③ 업종 흐름 ─────────────────────────────────────────────────────────────
const KRX_THEMES = ['KRX 반도체', 'KRX 정보기술', 'KRX 자동차', 'KRX 헬스케어', 'KRX 은행', 'KRX 증권', 'KRX 보험', 'KRX 에너지화학', 'KRX 철강', 'KRX 건설', 'KRX 기계장비', 'KRX 운송', 'KRX 방송통신', 'KRX K콘텐츠', 'KRX 유틸리티', 'KRX 경기소비재', 'KRX 필수소비재', '코스피 200 중공업'];
// KRX 지수에 없는 업종은 대표 종목 동일가중 바구니로 만든다(구성은 화면에 그대로 보인다).
const BASKETS = [
  { name: '2차전지', members: [['373220', 'LG에너지솔루션'], ['006400', '삼성SDI'], ['247540', '에코프로비엠'], ['086520', '에코프로'], ['003670', '포스코퓨처엠'], ['066970', '엘앤에프']] },
  { name: '조선', members: [['009540', 'HD한국조선해양'], ['329180', 'HD현대중공업'], ['042660', '한화오션'], ['010140', '삼성중공업']] },
  { name: '방산', members: [['012450', '한화에어로스페이스'], ['079550', 'LIG넥스원'], ['064350', '현대로템'], ['047810', '한국항공우주'], ['272210', '한화시스템']] },
  { name: '원전', members: [['034020', '두산에너빌리티'], ['052690', '한전기술'], ['051600', '한전KPS']] },
  { name: '전력기기', members: [['267260', 'HD현대일렉트릭'], ['010120', 'LS ELECTRIC'], ['298040', '효성중공업']] },
];
const US_ETF = [['XLK', '기술'], ['SMH', '반도체'], ['XLC', '커뮤니케이션'], ['XLY', '경기소비재'], ['XLF', '금융'], ['XLI', '산업재'], ['XLE', '에너지'], ['XLB', '소재'], ['XLV', '헬스케어'], ['XLP', '필수소비재'], ['XLU', '유틸리티'], ['XLRE', '부동산']];

async function loadBaskets() {
  const fromYear = +kstToday().slice(0, 4) - 2;
  for (const b of BASKETS) {
    b.series = [];
    for (const [code, name] of b.members) {
      try { b.series.push({ code, name, s: await yahooKR(code, fromYear) }); } catch (e) { console.log(`  바구니 ${b.name} ${name} 실패: ${e.message}`); }
    }
  }
}
/** 바구니 수익률(동일가중): 두 날짜 사이 구성 종목 수익의 평균 */
const basketRet = (b, a, c) => mean(b.series.map(m => pct(valAt(m.s, a), valAt(m.s, c))).filter(v => v != null && isFinite(v)));

async function buildSectors(ctx) {
  const out = { asOf: kstToday(), kr: null, us: null };
  if (KRX_KEY) {
    const [d0, m0] = await krxOnOrBefore(kstToday());
    if (d0) {
      ctx.krxLatest = d0;
      const [d1, m1] = await krxOnOrBefore(addDays(d0, -30));
      const [d3, m3] = await krxOnOrBefore(addDays(d0, -91));
      const kb1 = pct(m1?.['코스피'], m0['코스피']), kb3 = pct(m3?.['코스피'], m0['코스피']);
      const rows = KRX_THEMES.filter(n => m0[n]).map(n => {
        const a = pct(m1?.[n], m0[n]), c = pct(m3?.[n], m0[n]);
        return { name: n.replace(/^KRX /, ''), kind: 'index', r1m: r2(a), r3m: r2(c), x1m: r2(a - kb1), x3m: r2(c - kb3) };
      });
      for (const b of BASKETS) {
        if (!b.series.length) continue;
        const a = basketRet(b, d1, d0), c = basketRet(b, d3, d0);
        rows.push({ name: b.name, kind: 'basket', members: b.series.map(m => m.name), r1m: r2(a), r3m: r2(c), x1m: r2(a - kb1), x3m: r2(c - kb3) });
      }
      const missing = KRX_THEMES.filter(n => !m0[n]);
      out.kr = { date: d0, d1m: d1, d3m: d3, kospi1m: r2(kb1), kospi3m: r2(kb3), rows, missing };
    }
  }
  const spy = await yahoo('SPY', new Date().getUTCFullYear() - 1);
  const n = spy.length - 1, at = (s, k) => s[Math.max(0, s.length - 1 - k)][1];
  const b1 = pct(at(spy, 21), spy[n][1]), b3 = pct(at(spy, 63), spy[n][1]);
  const rows = [];
  for (const [sym, name] of US_ETF) {
    try { const s = await yahoo(sym, new Date().getUTCFullYear() - 1); const m = s.length - 1;
      rows.push({ sym, name, r1m: r2(pct(at(s, 21), s[m][1])), r3m: r2(pct(at(s, 63), s[m][1])), x1m: r2(pct(at(s, 21), s[m][1]) - b1), x3m: r2(pct(at(s, 63), s[m][1]) - b3) });
    } catch (e) { console.log(`  US ${sym} 실패: ${e.message}`); }
  }
  out.us = { date: spy[n][0], spy1m: r2(b1), spy3m: r2(b3), rows };
  return out;
}

// ── ④ 민감도: 업종·바구니 주간 수익 vs 미 10년물·SOX·원/달러 (최근 52주) ──────────
async function buildSensitivity(ctx, cache) {
  if (!ctx.krxLatest) throw new Error('KRX 최신일 없음');
  // 완결된 주의 마지막 거래일들 (KRX 최신일 이하)
  const dates = [];
  let f = ctx.krxLatest; while (new Date(f + 'T00:00:00Z').getUTCDay() !== 5) f = addDays(f, -1);
  for (let k = 52; k >= 0; k--) { const d = tradingOnOrBefore(addDays(f, -7 * k)); if (d <= ctx.krxLatest) dates.push(d); }
  const weeks = { ...(cache || {}) };
  let fetched = 0;
  for (const d of dates) {
    if (weeks[d]) continue;
    const m = await krxIndexDay(d); fetched++;
    if (!m || !m['코스피']) continue;
    weeks[d] = Object.fromEntries(['코스피', ...KRX_THEMES].filter(n => m[n]).map(n => [n, m[n]]));
  }
  for (const k of Object.keys(weeks)) if (k < dates[0]) delete weeks[k];   // 52주 밖은 버린다
  ctx.krxWeekly = weeks;
  const D = dates.filter(d => weeks[d]);
  const us10 = await fred('DGS10'), sox = await yahoo('^SOX', +kstToday().slice(0, 4) - 2), fx = await yahoo('KRW=X', +kstToday().slice(0, 4) - 2);
  const factors = D.map(d => ({ d, us10: valAt(us10, addDays(d, -1)), sox: valAt(sox, addDays(d, -1)), fx: valAt(fx, d) }));
  const rows = [];
  for (const n of ['코스피', ...KRX_THEMES]) {
    const closes = new Map(D.filter(d => weeks[d][n]).map(d => [d, weeks[d][n]]));
    if (closes.size < 10) continue;
    rows.push({ name: n.replace(/^KRX /, ''), kind: n === '코스피' ? 'bench' : 'index', ...sensitivity(factors, closes) });
  }
  for (const b of BASKETS) {
    if (!b.series.length) continue;
    // 동일가중 바구니 지수: 주마다 구성 종목 수익 평균을 이어 붙인다
    const closes = new Map(); let lvl = 100; closes.set(D[0], lvl);
    for (let i = 1; i < D.length; i++) { const r = basketRet(b, D[i - 1], D[i]); if (r == null) continue; lvl *= 1 + r / 100; closes.set(D[i], lvl); }
    rows.push({ name: b.name, kind: 'basket', ...sensitivity(factors, closes) });
  }
  console.log(`  민감도: ${D.length}주, KRX 새로 받은 날 ${fetched}`);
  return { asOf: D.at(-1), from: D[0], weeks: D.length - 1, rCrit: r2(rCrit(D.length - 1)), rows, factors };
}

// ── ⑤ 일정: FOMC · 미 지표 발표 · 선물 만기 · 보호예수 해제 ─────────────────────
const secondThursday = (y, m) => { const d = new Date(Date.UTC(y, m - 1, 1)); while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); };

// 공모 상장 후보 = DART 의 비상장(E)·코넥스(N) 회사 [발행조건확정]증권신고서(지분증권).
// Supabase disclosures 는 상장사(Y/K)만 수집해서 상장 전 회사의 신고서가 없다(2026-11-16 확인: 9월 이후 신규 상장 ~20건 중 1건만 잡힘).
async function dartIpoFilings(fromDate, toDate) {
  const key = process.env.DART_API_KEY; if (!key) throw new Error('DART_API_KEY 없음');
  const out = [];
  for (let a = fromDate; a <= toDate; a = addDays(a, 85)) {
    const b = addDays(a, 84) < toDate ? addDays(a, 84) : toDate;
    // corp_cls 를 지정하지 않는다: DART 의 corp_cls 는 '현재' 구분이라 이미 상장한 회사는 E 가 아니라 Y/K 로 나온다.
    for (let page = 1; page <= 20; page++) {
      const j = JSON.parse(await get(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${key}&bgn_de=${a.replace(/-/g, '')}&end_de=${b.replace(/-/g, '')}&pblntf_detail_ty=C001&page_count=100&page_no=${page}`));
      if (j.status !== '000') { if (j.status === '013') break; throw new Error(`DART ${j.status} ${j.message}`); }   // 013 = 조회 결과 없음
      for (const x of j.list || []) if (/발행조건확정/.test(x.report_nm) && /지분증권/.test(x.report_nm)) out.push({ name: x.corp_name, code: (x.stock_code || '').trim() || null, filed: `${x.rcept_dt.slice(0, 4)}-${x.rcept_dt.slice(4, 6)}-${x.rcept_dt.slice(6, 8)}` });
      await sleep(300);
      if (page >= (j.total_page || 1)) break;
    }
  }
  return out;
}
const normName = s => String(s || '').replace(/\(주\)|㈜|주식회사|\s/g, '').toUpperCase();

async function buildIpo(ctx, cache) {
  const today = kstToday();
  const filings = (await dartIpoFilings(addDays(today, -130), today)).filter(f => !/스팩|기업인수목적|리츠|REIT/i.test(f.name));
  // 첫 등장일 지도: scanStart 에 이미 있던 종목 = 기존 상장사. 그 뒤 처음 나타난 종목만 신규 상장 후보(이름도 저장).
  const st = cache && cache.scanStart ? cache : { scanStart: addDays(today, -140), scannedThrough: null, firstSeen: {}, names: {} };
  st.names = st.names || {};
  let d = st.scannedThrough ? addDays(st.scannedThrough, 1) : tradingOnOrAfter(st.scanStart);
  if (!st.scannedThrough) st.scanStart = d;
  let scanned = 0;
  while (d <= (ctx.krxLatest || today)) {
    if (cal.isTradingDay(d)) {
      const codes = await krxCodesDay(d); scanned++;
      if (!codes.size) break;           // 아직 공표 전 — 다음 실행 때 이어서
      for (const [c, nm] of codes) if (!st.firstSeen[c]) { st.firstSeen[c] = d; if (d > st.scanStart) st.names[c] = nm; }
      st.scannedThrough = d;
    }
    d = addDays(d, 1);
  }
  console.log(`  신규 상장 판별: KRX ${scanned}일 조회, ${st.scannedThrough}까지, DART 발행조건확정 ${filings.length}건`);
  ctx.ipoCache = st;
  // KRX 첫 등장(스캔 시작 이후) 종목 ↔ 같은 이름의 발행조건확정 신고서(상장 0~45일 전)
  const byName = new Map(), byStock = new Map();
  for (const f of filings) {
    const k = normName(f.name); if (!byName.has(k) || byName.get(k).filed < f.filed) byName.set(k, f);
    if (f.code && (!byStock.has(f.code) || byStock.get(f.code).filed < f.filed)) byStock.set(f.code, f);
  }
  const byCode = new Map(), matched = new Set();
  for (const [code, nm] of Object.entries(st.names)) {
    const fs = st.firstSeen[code], f = byStock.get(code) || byName.get(normName(nm));
    if (!f || f.filed > fs || Date.parse(fs) - Date.parse(f.filed) > 45 * 864e5) continue;
    byCode.set(code, { code, name: nm, filed: f.filed, list: fs }); matched.add(normName(f.name));
  }
  // 상장 예정 = 아직 KRX 에 없는 회사만(이미 상장된 코드의 신고서는 유상증자·분할 등)
  for (const f of byName.values()) if (!matched.has(normName(f.name)) && !(f.code && st.firstSeen[f.code]) && Date.parse(today) - Date.parse(f.filed) <= 30 * 864e5) byCode.set('p:' + f.name, { name: f.name, filed: f.filed, pending: true });
  const listed = [], pending = [];
  for (const x of byCode.values()) {
    if (x.pending) { pending.push(x); continue; }
    const u1 = tradingOnOrAfter(addMonths(x.list, 1)), u3 = tradingOnOrAfter(addMonths(x.list, 3));
    listed.push({ ...x, u1, u3, u1Window: [tradingBefore(u1, 1), cal.addTradingDays(u1, 5)], u3Window: [tradingBefore(u3, 1), cal.addTradingDays(u3, 5)], firstMonthEnd: u1 });
  }
  listed.sort((a, b) => b.list.localeCompare(a.list));
  return { listed: listed.filter(x => x.u3Window[1] >= today), pending, scannedThrough: st.scannedThrough };
}

async function buildCalendar(ctx, sb, ipoCache) {
  const today = kstToday(), y = +today.slice(0, 4);
  const items = [];
  const errors = [];
  for (const [rid, kind, title] of [[10, 'cpi', '미국 CPI'], [54, 'pce', '미국 개인소득·PCE 물가'], [50, 'jobs', '미국 고용보고서']]) {
    try { for (const r of (await fredReleaseDates(rid)).filter(r => r.kst.slice(0, 10) >= today).slice(0, 2)) items.push({ date: r.kst.slice(0, 10), kst: r.kst, kind, title }); }
    catch (e) { errors.push(`${title}: ${e.message}`); }
  }
  try {
    for (const m of (await fomcSchedule()).filter(m => m.kst.slice(0, 10) >= today).slice(0, 3))
      items.push({ date: m.kst.slice(0, 10), kst: m.kst, kind: 'fomc', title: `FOMC 금리 결정${m.sep ? ' + 점도표' : ''}`, detail: `미국 ${m.date}` });
  } catch (e) { errors.push('FOMC: ' + e.message); }
  // 분기 선물·옵션 동시 만기 = 3·6·9·12월 둘째 목요일(휴장이면 앞 거래일). 6·12월은 다음 거래일에 KOSPI200 정기변경 적용.
  for (const yy of [y, y + 1]) for (const m of [3, 6, 9, 12]) {
    let e = secondThursday(yy, m); while (!cal.isTradingDay(e)) e = addDays(e, -1);
    if (e < today) continue;
    items.push({ date: e, kind: 'expiry', title: `${m}월 선물·옵션 동시 만기` });
    if (m === 6 || m === 12) items.push({ date: tradingOnOrAfter(addDays(e, 1)), kind: 'rebal', title: `코스피200·코스닥150 정기변경 적용 (${m}월)` });
  }
  let ipo = null;
  try {
    ipo = await buildIpo(ctx, ipoCache);
    for (const x of ipo.listed) {
      if (x.u1 >= today) items.push({ date: x.u1, kind: 'lockup', title: `${x.name} 1개월 보호예수 해제`, detail: `상장 ${x.list} · 해제 전날~5거래일 뒤 ${x.u1Window[0]}~${x.u1Window[1]}`, code: x.code });
      if (x.u3 >= today) items.push({ date: x.u3, kind: 'lockup', title: `${x.name} 3개월 보호예수 해제`, detail: `상장 ${x.list} · 해제 전날~5거래일 뒤 ${x.u3Window[0]}~${x.u3Window[1]}`, code: x.code });
    }
  } catch (e) { errors.push('보호예수: ' + e.message); }
  items.sort((a, b) => (a.kst || a.date).localeCompare(b.kst || b.date));
  return { asOf: today, items: items.filter(x => x.date <= addDays(today, 75)), ipo, errors };
}

// ── ⑥ 정책 뉴스 ─────────────────────────────────────────────────────────────
const NEWS_Q = [
  ['kr_policy', 'ko', '밸류업 정책 증시'], ['kr_policy', 'ko', '상법 개정 주주'], ['kr_policy', 'ko', '자본시장 활성화 정부'], ['kr_policy', 'ko', '공매도 정책'],
  ['state_capital', 'ko', '정부 지분 투자 미국 기업'], ['state_capital', 'en', 'US government equity stake company'], ['state_capital', 'ko', '국민성장펀드'],
  ['fed', 'ko', 'FOMC 점도표'], ['fed', 'en', 'Fed dot plot'],
];
const unxml = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
async function buildNews() {
  const rows = new Map();
  for (const [tag, lang, q] of NEWS_Q) {
    const loc = lang === 'ko' ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en';
    let xml = '';
    try { xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:14d')}&${loc}`, { headers: UA }); }
    catch (e) { console.log(`  RSS 실패 (${q}): ${e.message}`); continue; }
    for (const it of xml.split('<item>').slice(1, 21)) {
      const title = unxml((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = unxml((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
      const pub = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
      const source = unxml((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
      if (!title || !link || !pub || Date.now() - pub > 14 * 864e5) continue;
      if (!newsPasses(tag, title)) continue;
      rows.set(link, { link, title, source, published_at: new Date(pub).toISOString(), tag });
    }
    await sleep(800);
  }
  return [...rows.values()];
}

// ── ⑥-2 월가 시각: 해외 기사 제목 → 기관·대상·방향·수치 (backend/streetViews.js) ──────────
// Google 뉴스 영문판(미국판)으로 해외 매체 제목을 모은다. 한국 매체 영문판은 뺀다. 본문은 받지 않는다.
// 규칙으로 못 정한 제목만 Gemini 로 구조화하고, 한 번 물은 제목은 캐시(macro_snapshot 'street_cache')에 남겨 다시 묻지 않는다.
const STREET_Q = [
  'Kospi target', 'Kospi Goldman OR "Morgan Stanley" OR JPMorgan OR UBS OR Nomura OR Citi',
  'Korea stocks overweight OR underweight OR upgrade OR downgrade', '"SK Hynix" price target', '"Samsung Electronics" price target',
  '"S&P 500" target strategist', 'memory chip stocks analyst downgrade OR upgrade', 'Asia stocks Goldman OR "Morgan Stanley" OR JPMorgan',
  'Fed forecast Goldman OR JPMorgan OR "Morgan Stanley" OR Citi', 'Korean won forecast',
];
async function buildStreet(sb, cache, ctx) {
  const titles = new Map();
  for (const q of STREET_Q) {
    let xml = '';
    try { xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:30d')}&hl=en-US&gl=US&ceid=US:en`, { headers: UA }); }
    catch (e) { console.log(`  RSS 실패 (${q}): ${e.message}`); continue; }
    for (const it of xml.split('<item>').slice(1, 41)) {
      const title = unxml((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = unxml((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
      const pub = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
      const source = unxml((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
      if (!title || !link || !pub || Date.now() - pub > 30 * 864e5 || street.KR_OUTLET.test(source) || street.JUNK_OUTLET.test(source)) continue;
      const t = street.cleanTitle(title);
      if (!titles.has(t)) titles.set(t, { title: t, link, source, published_at: new Date(pub).toISOString() });
    }
    await sleep(800);
  }
  const aiCache = { ...(cache?.ai || {}) };
  const articles = [], askAi = [];
  for (const a of titles.values()) {
    const r = street.extractRule(a.title);
    for (const x of r.recs) articles.push({ ...a, ...x });
    if (r.needsAi) { if (aiCache[a.title]) for (const x of aiCache[a.title].recs) articles.push({ ...a, ...x }); else askAi.push(a); }
  }
  let ai = { model: null, error: null, asked: 0 };
  if (askAi.length) {
    const batch = askAi.slice(0, 40);
    const r = await street.aiExtract(batch.map(a => a.title), process.env.GEMINI_API_KEY);
    ai = { model: r.model, error: r.error, asked: batch.length };
    for (const a of batch) {
      const recs = r.results[a.title]; if (!recs) continue;   // 실패하면 캐시하지 않고 다음 날 다시 묻는다
      aiCache[a.title] = { at: kstToday(), recs };
      for (const x of recs) articles.push({ ...a, ...x });
    }
  }
  // 캐시는 30일 지난 제목을 버린다
  const cutoff = addDays(kstToday(), -30);
  for (const k of Object.keys(aiCache)) if (aiCache[k].at < cutoff) delete aiCache[k];
  ctx.streetCache = { ai: aiCache };
  for (const a of articles) a.date = new Date(Date.parse(a.published_at) + 9 * 3600e3).toISOString().slice(0, 10);
  let existing = [];
  if (sb) {
    const { data, error } = await sb.from('street_views').select('*').gte('first_seen', addDays(kstToday(), -30));
    if (error) throw new Error('street_views 읽기: ' + error.message);
    existing = data || [];
  }
  const rows = street.cluster(articles, existing);
  // 기준 종가(첫 기사 직전 마감)와 목표치 상승여력. 예전 행도 비어 있으면 채운다.
  const need = [...rows, ...existing.filter(e => e.ref_level == null && !rows.some(r => r.id === e.id))];
  for (const r of need) {
    const P = street.PRICE[r.target]; if (!P) continue;
    r.first_pub = r.first_pub || (r.sources || []).map(s => s.published_at).sort()[0] || `${r.first_seen}T00:00:00Z`;
    let s; try { s = await yahoo(P.sym, 2025); } catch { continue; }
    const i = street.entryIndex(s, r.first_pub, P.close);
    const j = i < 0 ? s.length - 1 : i - 1;
    if (j < 0) continue;
    r.ref_date = s[j][0]; r.ref_level = s[j][1];
    r.target_num = street.targetNum(r.value);
    r.implied_pct = r.target_num && r.ref_level ? Math.round((r.target_num / r.ref_level - 1) * 1000) / 10 : null;
    if (!rows.includes(r)) rows.push(r);
  }
  return { rows, titles: titles.size, articles: articles.length, ai };
}

// ── ⑥-3 외국인 순매수 (말과 돈) ──────────────────────────────────────────────
// market_flow_daily(KIS 투자자별) 합계. 전 종목 수집은 2026-05-22 부터. 단위 억원.
async function buildFlows(sb) {
  const from = addDays(kstToday(), -200);
  const data = [];
  for (let a = from; a <= kstToday(); a = addDays(a, 30)) {   // anon 쿼리 제한(3초) 때문에 30일씩
    const { data: d, error } = await sb.rpc('frgn_market_daily', { p_from: a, p_to: addDays(a, 30) });
    if (error) throw new Error(`${a}: ${error.message}`);
    data.push(...(d || []));
  }
  const ser = mk => (data || []).filter(r => r.market === mk && r.n >= (mk === 'KOSPI' ? 700 : 1400)).map(r => [r.trade_date, Math.round(r.frgn / 100)]);
  const one = async code => {
    const { data: d, error: e } = await sb.from('market_flow_daily').select('trade_date, frgn_net_value').eq('stock_code', code).gte('trade_date', from).order('trade_date');
    if (e) throw new Error(e.message);
    return (d || []).filter(r => r.frgn_net_value != null).map(r => [r.trade_date, Math.round(r.frgn_net_value / 100)]);
  };
  const out = { kospi: ser('KOSPI'), kosdaq: ser('KOSDAQ'), samsung: await one('005930'), hynix: await one('000660') };
  out.asOf = out.kospi.at(-1)?.[0] || null;
  return out;
}

// ── ⑦ 정책 사건 결과 ───────────────────────────────────────────────────────
// 반응 = D-1 종가 → D 다음 첫 거래일 종가, 이후 = 그 종가부터 +5/10/20 거래일. 기준이 있으면 기준 대비 초과(%p).
function eventResult(t, bAt, D) {
  const i0 = lastOnOrBefore(t, addDays(D, -1)), i1 = t.findIndex(([d]) => d > D);
  if (i0 < 0 || i1 < 0) return null;
  const ex = (a, c) => { const v = pct(t[a][1], t[c][1]); if (!bAt) return v; const ba = bAt(t[a][0]), bc = bAt(t[c][0]); return ba && bc ? v - pct(ba, bc) : null; };
  const res = { reaction: r2(ex(i0, i1)) };
  for (const h of [5, 10, 20]) res['d' + h] = i1 + h < t.length ? r2(ex(i1, i1 + h)) : null;
  return res;
}
async function computeYahooEvent(e) {
  const t = await yahoo(e.target_sym, 2022), b = e.bench_sym ? await yahoo(e.bench_sym, 2022) : null;
  return eventResult(t, b ? d => valAt(b, d) : null, e.event_date);
}
async function computeKrxEvent(e) {
  const days = []; for (let d = addDays(e.event_date, -10); d <= addDays(e.event_date, 45) && d <= kstToday(); d = addDays(d, 1)) if (cal.isTradingDay(d)) days.push(d);
  const t = [], b = new Map();
  for (const d of days) {
    const m = await krxIndexDay(d, ['idx/kospi_dd_trd', 'idx/kosdaq_dd_trd', 'idx/krx_dd_trd']);
    if (!m) continue;
    if (m[e.target_sym]) t.push([d, m[e.target_sym]]);
    if (e.bench_sym && m[e.bench_sym]) b.set(d, m[e.bench_sym]);
  }
  if (t.length < 3) return null;
  return eventResult(t, e.bench_sym ? d => b.get(d) : null, e.event_date);
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);   // --dry 에서도 캐시·공시 읽기는 한다
  const errors = [];
  const step = async (name, fn) => { try { const v = await fn(); console.log(`✅ ${name}`); return v; } catch (e) { errors.push(`${name}: ${e.message}`); console.log(`❌ ${name}: ${e.message}`); return null; } };
  const { data: cacheRows } = await sb.from('macro_snapshot').select('id, data').in('id', ['krx_weekly', 'ipo_cache', 'street_cache']);
  const cache = Object.fromEntries((cacheRows || []).map(r => [r.id, r.data]));
  const ctx = {};

  // --only=fed,regime,sectors,sens,calendar,news (점검용. --dry 와 함께만 쓸 것 — 빠진 칸을 저장하지 않으므로 운영엔 무해하지만 의미 없음)
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
  const want = k => !only || only.has(k);
  const fed = want('fed') ? await step('연준', buildFed) : null;
  const regime = want('regime') ? await step('국면', buildRegime) : null;
  if (want('sectors') || want('sens')) await step('바구니 종목', loadBaskets);
  const sectors = want('sectors') || want('sens') ? await step('업종 흐름', () => buildSectors(ctx)) : null;
  const sens = want('sens') ? await step('민감도', () => buildSensitivity(ctx, cache.krx_weekly)) : null;
  const calendar = want('calendar') ? await step('일정', () => buildCalendar(ctx, sb, cache.ipo_cache)) : null;
  const news = want('news') ? await step('정책 뉴스', buildNews) : null;
  const streetOut = want('street') ? await step('월가 시각', () => buildStreet(sb, cache.street_cache, ctx)) : null;
  const flows = want('street') ? await step('외국인 순매수', () => buildFlows(sb)) : null;

  if (DRY) {
    const outArg = process.argv.find(a => a.startsWith('--out='));
    if (outArg) require('fs').writeFileSync(outArg.slice(6), JSON.stringify({ success: true, fed, regime, sectors, sensitivity: sens, calendar, news: (news || []).sort((a, b) => b.published_at.localeCompare(a.published_at)), events: [], street: streetOut ? streetOut.rows : [], flows }));
    if (flows) console.log('수급:', flows.asOf, 'KOSPI', flows.kospi.length, '일, 마지막', JSON.stringify(flows.kospi.slice(-3)), '삼성', JSON.stringify(flows.samsung.slice(-2)));
    if (fed?.futures) console.log('선물 1주 전:', JSON.stringify(fed.futures.prev));
    if (fed) console.log('연준:', JSON.stringify({ rate: fed.rate.upper, dot: fed.dotThisYear, sep: fed.sepDate, link: fed.dotLink, ladder: fed.market.ladder, core: fed.drivers.corePce.last, coreProj: fed.drivers.corePce.projThisYear, cpi: fed.drivers.cpi.last, cpiMiss: fed.drivers.cpi.yoyMissing, cpiAnn3: fed.drivers.cpi.ann3, fomc: fed.fomc.next, left: fed.fomc.remainingThisYear }));
    if (regime) console.log('국면:', JSON.stringify(regime.now), 'rCrit', regime.rCrit, '급등구간', regime.spikes.length);
    if (sectors) console.log('업종:', sectors.kr && `KR ${sectors.kr.date} ${sectors.kr.rows.length}개 빠짐[${sectors.kr.missing}]`, sectors.kr && JSON.stringify(sectors.kr.rows.filter(r => r.kind === 'basket')));
    if (sens) console.log('민감도:', sens.weeks + '주', JSON.stringify(sens.rows.slice(0, 3)));
    if (calendar) console.log('일정:', calendar.items.length, JSON.stringify(calendar.items.slice(0, 12)), '오류', calendar.errors, 'IPO', calendar.ipo && JSON.stringify({ n: calendar.ipo.listed.length, p: calendar.ipo.pending.length, first: calendar.ipo.listed.slice(0, 3) }));
    if (news) console.log('뉴스:', news.length);
    if (fed) console.log('선물:', JSON.stringify(fed.futures && { effr: fed.futures.effr, path: fed.futures.path, months: fed.futures.months.map(m => m.ym + ' ' + m.rate) }), fed.futuresErr || '');
    if (streetOut) { console.log('월가:', streetOut.titles, '제목', streetOut.articles, '추출', JSON.stringify(streetOut.ai)); for (const r of streetOut.rows) console.log('  ', r.first_seen, r.inst, r.target, r.dir, r.value || '', r.prev ? '←' + r.prev : '', r.horizon || '', r.method, r.n_sources + '곳', '|', r.source, '|', r.title.slice(0, 160)); }
    for (const e of [{ target_sym: 'MP', bench_sym: '^GSPC', event_date: '2025-07-10' }, { target_sym: '^KS11', bench_sym: '^TWII', event_date: '2025-07-31' }]) console.log('사건 재계산', e.target_sym, JSON.stringify(await computeYahooEvent(e)));
    process.exit(errors.length ? 1 : 0);
  }

  const now = new Date().toISOString();
  const snaps = [['fed', fed], ['regime', regime], ['sectors', sectors], ['sensitivity', sens], ['calendar', calendar], ['krx_weekly', ctx.krxWeekly], ['ipo_cache', ctx.ipoCache], ['street_cache', ctx.streetCache], ['flows', flows]]
    .filter(([, v]) => v).map(([id, data]) => ({ id, data, updated_at: now }));
  if (snaps.length) { const { error } = await sb.from('macro_snapshot').upsert(snaps); if (error) errors.push('snapshot 저장: ' + error.message); }
  if (news && news.length) {
    const { error } = await sb.from('policy_news').upsert(news, { onConflict: 'link', ignoreDuplicates: true }); if (error) errors.push('news 저장: ' + error.message);
    await sb.from('policy_news').delete().lt('published_at', new Date(Date.now() - 60 * 864e5).toISOString());
  }
  if (streetOut && streetOut.rows.length) {
    const { error } = await sb.from('street_views').upsert(streetOut.rows); if (error) errors.push('월가 저장: ' + error.message);
  }
  await step('정책 사건 결과', async () => {
    const { data, error } = await sb.from('policy_events').select('*');
    if (error) throw new Error(error.message);
    for (const e of data || []) {
      let r = null;
      if (e.target_kind === 'yahoo' && e.target_sym) r = await computeYahooEvent(e);
      else if (e.target_kind === 'krx' && e.target_sym && e.d20 == null && KRX_KEY) r = await computeKrxEvent(e);   // 끝난 사건은 다시 받지 않는다
      if (!r) continue;
      const { error: e2 } = await sb.from('policy_events').update({ ...r, computed_at: new Date().toISOString() }).eq('id', e.id);
      if (e2) throw new Error(e2.message);
    }
  });
  console.log(errors.length ? `⚠️ 일부 실패:\n  ${errors.join('\n  ')}` : '완료');
  process.exit(errors.length && !snaps.length ? 1 : 0);
})();

module.exports = { computeKrxEvent, computeYahooEvent, fomcSchedule, fredReleaseDates };   // 점검용
