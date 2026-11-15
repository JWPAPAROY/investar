/**
 * 시장 흐름 탭 수집기 (2026-11-15) — 연준 · 국면 · 산업 흐름 · 정책 뉴스 · 정책 사건 결과
 *
 *   node scripts/collect-macro.js            # 수집 → Supabase(macro_snapshot / policy_news / policy_events)
 *   node scripts/collect-macro.js --dry      # 수집만, 결과 요약 출력(DB 쓰기 없음)
 *
 * 데이터 출처(전부 무료·키 불필요, KRX 만 KRX_AUTH_KEY):
 *   FRED fredgraph.csv — 기준금리(DFEDTARU/L), 점도표 중앙값(FEDTARMD, 장기 FEDTARMDLR), 2·10년물(DGS2/DGS10),
 *                        근원 PCE(PCEPILFE), CPI(CPIAUCSL), 실업률(UNRATE), 점도표의 PCE·실업률 전망(PCECTPIMD/UNRATEMD)
 *   Yahoo chart v8     — KOSPI(^KS11), S&P500(^GSPC), 미국 업종 ETF, 정책 사건 종목
 *   KRX OpenAPI        — KRX 테마 업종지수 (idx/krx_dd_trd, idx/kospi_dd_trd)
 *   Google 뉴스 RSS    — 정책·국가자본주의·연준 기사 제목
 *
 * 원칙: 여기서 만든 숫자만 화면에 나간다. 매매 권고를 만들지 않는다(근거: 2026-11-15 측정 —
 *   정책 발표 후 20일 추세 6/12, 해외 신호 장중 적중 45%, 금리-주가 관계는 국면마다 부호가 바뀜).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const DRY = process.argv.includes('--dry');
const KRX_KEY = process.env.KRX_AUTH_KEY;
const UA = { 'User-Agent': 'Mozilla/5.0 (investar-macro/1.0)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; await sleep(2000 * (i + 1)); }
  }
  throw new Error(`${url.slice(0, 80)}: ${last && last.message}`);
}

// ── 날짜 도우미 (KST 기준 YYYY-MM-DD) ─────────────────────────────────────────
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = (a, b) => (a && b ? (b / a - 1) * 100 : null);
function corr(x, y) {
  const n = x.length; if (n < 8) return null;
  const mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; }
  return b && c ? a / Math.sqrt(b * c) : null;
}

// ── FRED ────────────────────────────────────────────────────────────────────
async function fred(id) {
  const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: UA });
  return t.trim().split('\n').slice(1).map(l => l.split(',')).filter(([, v]) => v && v !== '.').map(([d, v]) => [d, +v]);
}
const yoy = s => { const m = new Map(s); return s.map(([d, v]) => { const p = m.get(`${+d.slice(0, 4) - 1}${d.slice(4)}`); return p ? [d, r2(pct(p, v))] : null; }).filter(Boolean); };

// ── Yahoo (일봉 종가, 거래소 현지 날짜) ──────────────────────────────────────
const _y = new Map();
async function yahoo(sym, fromYear = 2010) {
  if (_y.has(sym)) return _y.get(sym);
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000), p2 = Math.floor(Date.now() / 1000) + 86400;
  const t = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`, { headers: UA });
  const j = JSON.parse(t).chart.result[0];
  const off = j.meta.gmtoffset || 0, c = j.indicators.quote[0].close;
  const out = j.timestamp.map((ts, i) => [new Date((ts + off) * 1000).toISOString().slice(0, 10), c[i]]).filter(([, v]) => v != null);
  _y.set(sym, out); await sleep(400);
  return out;
}
const lastOnOrBefore = (s, d) => { let lo = 0, hi = s.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m][0] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k; };

// ── KRX 지수 (하루치 전체) ───────────────────────────────────────────────────
async function krxIndexDay(d) {
  const basDd = d.replace(/-/g, ''), out = {};
  for (const p of ['idx/kospi_dd_trd', 'idx/krx_dd_trd']) {
    const t = await get(`http://data-dbg.krx.co.kr/svc/apis/${p}?basDd=${basDd}`, { headers: { AUTH_KEY: KRX_KEY } });
    for (const x of JSON.parse(t).OutBlock_1 || []) { const v = +String(x.CLSPRC_IDX).replace(/,/g, ''); if (v > 0) out[x.IDX_NM] = v; }
    await sleep(300);
  }
  return Object.keys(out).length ? out : null;
}
async function krxOnOrBefore(d, maxBack = 10) {
  for (let k = 0; k <= maxBack; k++) { const x = addDays(d, -k); const m = await krxIndexDay(x); if (m && m['코스피']) return [x, m]; }
  return [null, null];
}

// ── ① 연준 ──────────────────────────────────────────────────────────────────
async function buildFed() {
  const ids = ['DFEDTARU', 'DFEDTARL', 'FEDTARMD', 'FEDTARMDLR', 'DGS2', 'DGS10', 'PCEPILFE', 'CPIAUCSL', 'UNRATE', 'PCECTPIMD', 'UNRATEMD'];
  const S = {};
  for (const id of ids) { S[id] = await fred(id); await sleep(300); }
  const last = id => S[id].at(-1) || [null, null];
  const upper = last('DFEDTARU')[1], lower = last('DFEDTARL')[1], mid = (upper + lower) / 2;
  const year = +kstToday().slice(0, 4);
  const dots = S.FEDTARMD.map(([d, v]) => ({ year: +d.slice(0, 4), median: v }));
  const dotThisYear = (dots.find(x => x.year === year) || {}).median ?? null;
  const dotNextYear = (dots.find(x => x.year === year + 1) || {}).median ?? null;
  const sepDate = last('FEDTARMDLR')[0];
  const coreY = yoy(S.PCEPILFE), cpiY = yoy(S.CPIAUCSL);
  const projCore = (S.PCECTPIMD.find(([d]) => +d.slice(0, 4) === year) || [])[1] ?? null;
  const projUnemp = (S.UNRATEMD.find(([d]) => +d.slice(0, 4) === year) || [])[1] ?? null;
  // 기준금리 변경 이력
  const changes = []; let prev = null;
  for (const [d, v] of S.DFEDTARU) { if (prev != null && v !== prev) changes.push({ date: d, upper: v, change: r2(v - prev) }); prev = v; }
  const since = addDays(kstToday(), -730);
  const weekly = s => s.filter(([d]) => d >= since).filter((_, i, a) => i % 5 === 0 || i === a.length - 1).map(([d, v]) => [d, v]);
  return {
    asOf: kstToday(),
    rate: { upper, lower, since: (changes.at(-1) || {}).date || null, changes: changes.slice(-8) },
    dots, dotThisYear, dotNextYear, sepDate,
    longRun: S.FEDTARMDLR.slice(-6).map(([d, v]) => ({ sep: d, value: v })),
    market: {
      y2: last('DGS2')[1], y2Date: last('DGS2')[0], y10: last('DGS10')[1], y10Date: last('DGS10')[0],
      y2MinusMid: r2(last('DGS2')[1] - mid),
      y2Series: weekly(S.DGS2), y10Series: weekly(S.DGS10),
    },
    drivers: {
      corePce: { last: coreY.at(-1), series: coreY.slice(-24), projThisYear: projCore },
      cpi: { last: cpiY.at(-1), series: cpiY.slice(-24) },
      unemp: { last: last('UNRATE'), series: S.UNRATE.slice(-24), projThisYear: projUnemp },
    },
    impliedMoveThisYear: dotThisYear != null ? r2(dotThisYear - mid) : null,
  };
}

// ── ② 국면: 금리 변화와 주가가 같은 방향인가 ─────────────────────────────────
async function buildRegime() {
  const us10 = await fred('DGS10');
  const ks = await yahoo('^KS11'), sp = await yahoo('^GSPC');
  // 금요일 격자
  const F = []; for (let t = Date.UTC(2010, 0, 8); t <= Date.now(); t += 7 * 864e5) F.push(new Date(t).toISOString().slice(0, 10));
  const val = (s, d) => { const k = lastOnOrBefore(s, d); return k >= 0 && Date.parse(d) - Date.parse(s[k][0]) < 7 * 864e5 ? s[k][1] : null; };
  const W = F.map(d => ({ d, r: val(us10, d), k: val(ks, d), s: val(sp, d) }));
  const diffs = W.map((w, i) => (i && w.r != null && W[i - 1].r != null ? {
    d: w.d, dr: w.r - W[i - 1].r,
    k: w.k && W[i - 1].k ? Math.log(w.k / W[i - 1].k) : null,
    s: w.s && W[i - 1].s ? Math.log(w.s / W[i - 1].s) : null,
  } : null));
  const rolling = (key, i, n = 13) => { const xs = [], ys = []; for (let j = i - n + 1; j <= i; j++) { const q = diffs[j]; if (q && q[key] != null) { xs.push(q.dr); ys.push(q[key]); } } return xs.length >= 10 ? r2(corr(xs, ys)) : null; };
  const series = [];
  for (let i = Math.max(13, W.length - 156); i < W.length; i++) series.push([W[i].d, rolling('k', i), rolling('s', i)]);
  const years = [];
  for (let y = 2010; y <= +kstToday().slice(0, 4); y++) {
    const q = diffs.filter(x => x && x.d.startsWith(String(y)));
    const ix = W.map((w, i) => i).filter(i => W[i].d.startsWith(String(y)));
    const a = W[ix[0] - 1] || W[ix[0]], b = W[ix.at(-1)];
    const qk = q.filter(x => x.k != null), qs = q.filter(x => x.s != null);
    years.push({ year: y, dRate: r2(b.r - a.r), kospi: r2(pct(a.k, b.k)), spx: r2(pct(a.s, b.s)),
      corrK: r2(corr(qk.map(x => x.dr), qk.map(x => x.k))), corrS: r2(corr(qs.map(x => x.dr), qs.map(x => x.s))), partial: y === +kstToday().slice(0, 4) });
  }
  // 금리 급등 구간: 13주 동안 미 10년물 +0.75%p 이상 (겹침 제거)
  const spikes = []; let lastI = -99;
  for (let i = 13; i < W.length; i++) {
    if (W[i].r == null || W[i - 13].r == null || W[i].r - W[i - 13].r < 0.75 || i - lastI < 13) continue;
    lastI = i; const j = Math.min(i + 13, W.length - 1);
    spikes.push({ from: W[i - 13].d, to: W[i].d, rateFrom: W[i - 13].r, rateTo: W[i].r,
      kospiDuring: r2(pct(W[i - 13].k, W[i].k)), spxDuring: r2(pct(W[i - 13].s, W[i].s)),
      kospiAfter: j > i ? r2(pct(W[i].k, W[j].k)) : null, spxAfter: j > i ? r2(pct(W[i].s, W[j].s)) : null, afterWeeks: j - i });
  }
  const n = W.length - 1;
  return {
    asOf: W[n].d, window: 13,
    now: { corrK: rolling('k', n), corrS: rolling('s', n), dRate13: r2(W[n].r - W[n - 13].r), kospi13: r2(pct(W[n - 13].k, W[n].k)), spx13: r2(pct(W[n - 13].s, W[n].s)) },
    series, years, spikes,
  };
}

// ── ③ 산업 흐름 ─────────────────────────────────────────────────────────────
const KRX_THEMES = ['KRX 반도체', 'KRX 정보기술', 'KRX 자동차', 'KRX 2차전지 TOP 10', 'KRX 헬스케어', 'KRX 은행', 'KRX 증권', 'KRX 보험', 'KRX 에너지화학', 'KRX 철강', 'KRX 건설', 'KRX 기계장비', 'KRX 운송', 'KRX 방송통신', 'KRX K콘텐츠', 'KRX 유틸리티', 'KRX 경기소비재', 'KRX 필수소비재'];
const US_ETF = [['XLK', '기술'], ['SMH', '반도체'], ['XLC', '커뮤니케이션'], ['XLY', '경기소비재'], ['XLF', '금융'], ['XLI', '산업재'], ['XLE', '에너지'], ['XLB', '소재'], ['XLV', '헬스케어'], ['XLP', '필수소비재'], ['XLU', '유틸리티'], ['XLRE', '부동산']];
async function buildSectors() {
  const out = { asOf: kstToday(), kr: null, us: null };
  if (KRX_KEY) {
    const [d0, m0] = await krxOnOrBefore(kstToday());
    if (d0) {
      const [d1, m1] = await krxOnOrBefore(addDays(d0, -30));
      const [d3, m3] = await krxOnOrBefore(addDays(d0, -91));
      const kb1 = pct(m1?.['코스피'], m0['코스피']), kb3 = pct(m3?.['코스피'], m0['코스피']);
      out.kr = { date: d0, d1m: d1, d3m: d3, kospi1m: r2(kb1), kospi3m: r2(kb3), rows: KRX_THEMES.filter(n => m0[n]).map(n => ({
        name: n.replace(/^KRX /, ''), r1m: r2(pct(m1?.[n], m0[n])), r3m: r2(pct(m3?.[n], m0[n])),
        x1m: r2(pct(m1?.[n], m0[n]) - kb1), x3m: r2(pct(m3?.[n], m0[n]) - kb3) })) };
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

// ── ④ 정책 뉴스 ─────────────────────────────────────────────────────────────
const NEWS_Q = [
  ['kr_policy', 'ko', '밸류업 정책 증시'], ['kr_policy', 'ko', '상법 개정 주주'], ['kr_policy', 'ko', '자본시장 활성화 정부'], ['kr_policy', 'ko', '공매도 정책'],
  ['state_capital', 'ko', '정부 지분 투자 미국 기업'], ['state_capital', 'en', 'US government equity stake company'], ['state_capital', 'ko', '국민성장펀드'],
  ['fed', 'ko', 'FOMC 점도표'], ['fed', 'en', 'Fed dot plot'],
];
const NEWS_MUST = {
  kr_policy: /밸류업|상법|자본시장|공매도|증시|코스피|주주|배당|금융위/,
  state_capital: /지분|stake|국부|펀드|equity|국가자본|정부 투자|government/i,
  fed: /연준|FOMC|Fed|금리|점도표|파월|Powell|rate/i,
};
const unxml = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
async function buildNews() {
  const rows = new Map();
  for (const [tag, lang, q] of NEWS_Q) {
    const loc = lang === 'ko' ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en';
    let xml = '';
    try { xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:14d')}&${loc}`, { headers: UA }); }
    catch (e) { console.log(`  RSS 실패 (${q}): ${e.message}`); continue; }
    for (const it of xml.split('<item>').slice(1, 16)) {
      const title = unxml((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = unxml((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
      const pub = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
      const source = unxml((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
      if (!title || !link || !pub || Date.now() - pub > 14 * 864e5) continue;
      if (!NEWS_MUST[tag].test(title)) continue;   // 검색어와 무관한 기사(예: 코인 시세) 제외
      rows.set(link, { link, title, source, published_at: new Date(pub).toISOString(), tag });
    }
    await sleep(800);
  }
  return [...rows.values()];
}

// ── ⑤ 정책 사건 결과 (yahoo 대상만 자동 계산) ───────────────────────────────
async function computeEvent(e) {
  const t = await yahoo(e.target_sym, 2022), b = e.bench_sym ? await yahoo(e.bench_sym, 2022) : null;
  const D = e.event_date;
  const i0 = lastOnOrBefore(t, addDays(D, -1)), i1 = t.findIndex(([d]) => d > D);
  if (i0 < 0 || i1 < 0) return null;
  const bAt = d => { if (!b) return null; const k = lastOnOrBefore(b, d); return k >= 0 ? b[k][1] : null; };
  const ex = (a, c) => { const v = pct(t[a][1], t[c][1]); return b ? v - pct(bAt(t[a][0]), bAt(t[c][0])) : v; };
  const res = { reaction: r2(ex(i0, i1)) };
  for (const h of [5, 10, 20]) res['d' + h] = i1 + h < t.length ? r2(ex(i1, i1 + h)) : null;
  return res;
}

(async () => {
  const sb = !DRY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY) : null;
  const errors = [];
  const step = async (name, fn) => { try { const v = await fn(); console.log(`✅ ${name}`); return v; } catch (e) { errors.push(`${name}: ${e.message}`); console.log(`❌ ${name}: ${e.message}`); return null; } };

  const fed = await step('연준', buildFed);
  const regime = await step('국면', buildRegime);
  const sectors = await step('산업 흐름', buildSectors);
  const news = await step('정책 뉴스', buildNews);

  if (DRY) {
    const outArg = process.argv.find(a => a.startsWith('--out='));   // 화면 점검용: 수집 결과를 API 응답 모양으로 저장
    if (outArg) require('fs').writeFileSync(outArg.slice(6), JSON.stringify({ success: true, fed, regime, sectors, news: (news || []).sort((a, b) => b.published_at.localeCompare(a.published_at)), events: [] }));
    if (fed) console.log('연준:', JSON.stringify({ rate: fed.rate.upper, dotThisYear: fed.dotThisYear, sep: fed.sepDate, y2: fed.market.y2, core: fed.drivers.corePce.last, imp: fed.impliedMoveThisYear }));
    if (regime) console.log('국면:', JSON.stringify(regime.now), '급등구간', regime.spikes.length);
    if (sectors) console.log('산업:', sectors.kr && `KR ${sectors.kr.date} ${sectors.kr.rows.length}개`, sectors.us && `US ${sectors.us.date} ${sectors.us.rows.length}개`);
    if (news) console.log('뉴스:', news.length, news.slice(0, 3).map(n => n.title).join(' | '));
    for (const e of [{ target_sym: 'MP', bench_sym: '^GSPC', event_date: '2025-07-10' }, { target_sym: '^KS11', event_date: '2025-07-31' }]) console.log('사건 재계산', e.target_sym, JSON.stringify(await computeEvent(e)));
    process.exit(errors.length ? 1 : 0);
  }

  const snaps = [['fed', fed], ['regime', regime], ['sectors', sectors]].filter(([, v]) => v).map(([id, data]) => ({ id, data, updated_at: new Date().toISOString() }));
  if (snaps.length) { const { error } = await sb.from('macro_snapshot').upsert(snaps); if (error) errors.push('snapshot 저장: ' + error.message); }
  if (news && news.length) {
    const { error } = await sb.from('policy_news').upsert(news, { onConflict: 'link', ignoreDuplicates: true }); if (error) errors.push('news 저장: ' + error.message);
    await sb.from('policy_news').delete().lt('published_at', new Date(Date.now() - 60 * 864e5).toISOString());
  }
  await step('정책 사건 결과', async () => {
    const { data, error } = await sb.from('policy_events').select('*').eq('target_kind', 'yahoo');
    if (error) throw new Error(error.message);
    for (const e of data || []) {
      const r = await computeEvent(e); if (!r) continue;
      const { error: e2 } = await sb.from('policy_events').update({ ...r, computed_at: new Date().toISOString() }).eq('id', e.id);
      if (e2) throw new Error(e2.message);
    }
  });
  console.log(errors.length ? `⚠️ 일부 실패:\n  ${errors.join('\n  ')}` : '완료');
  process.exit(errors.length && !snaps.length ? 1 : 0);
})();
