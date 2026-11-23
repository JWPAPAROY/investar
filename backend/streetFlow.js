/**
 * 월가 흐름 (2026-11-23) — 미국 시장 기사 '제목'을 주제별로 세어 월가 관심사가 어디로 옮겨 가는지 본다.
 *   월가 시각(streetViews.js)이 '기관의 목표치 변경'만 남기는 것과 달리, 이쪽은 시장 기사 전체를 센다.
 *   두 칸을 섞지 않는다 — 월가 시각은 STREET_VERDICT.md 채점 대상이다.
 *
 * 원칙
 *   - 주제 분류는 제목 단어 사전(규칙)만 쓴다. AI 해설 없음. 화면 문구는 이 모듈이 센 숫자에서만 만든다.
 *   - 질의는 주제 중립적인 것만 쓴다. 'chip stocks' 같은 주제 질의를 넣으면 그 주제 비중이 질의 때문에 부풀려진다
 *     (2026-11-23 시범: chip stocks 질의가 반도체 비중을 끌어올림).
 *   - Google 뉴스 RSS 는 질의·날짜당 최대 100건이라 바쁜 날은 잘린다(시범 최대 93건) → 화면의 주 지표는 건수가 아니라 '비중'.
 *   - 날짜는 미국 동부 날짜(ET)로 센다. KST 로 세면 미국 장중(ET 10~17시 = KST 0~7시)이 이틀로 쪼개진다.
 *   - 본문은 받지 않는다(유료벽·robots). 제목·매체·링크만.
 *   - 화면 맨 위는 '급증 키워드'(spikes — 사전 없이 직전 4주 대비 급증한 단어). 주제 비중은 그 아래 보조.
 *     사전 주제만으로는 새 사건(11/12 젠슨 황 사임)이 '반도체 27%' 속에 묻혔다.
 *
 * 수집 scripts/collect-street-flow.js, 저장 macro_snapshot 'street_flow'(공개)·'street_flow_cache'(내부),
 * 화면 index.html MacroPanel '월가 흐름'.
 */
const { cleanTitle, KR_OUTLET, JUNK_OUTLET } = require('./streetViews');

const QUERIES = ['"Wall Street" stocks', '"stock market today"', '"S&P 500" Nasdaq', '"stock futures"', '"Dow Jones" stocks close'];

// 인도·캐나다·호주 등 다른 시장 매체, 종목 추천·SEO 매체
const NOISE_SRC = /NDTV|Economic Times|Livemint|Upstox|HDFC|Univest|Gotrade|Business Standard|Moneycontrol|Financial Express|Groww|Angel One|Coinpaper|JournalArta|Beinsure|Motley Fool|24\/7 Wall|TipRanks|ChartMill|TIKR|Kiplinger|CNBC ?TV18|Zacks/i;
// 다른 나라 지수, 종목 추천·낚시형 제목, 개별 종목 자동 기사
const NOISE_T = new RegExp([
  String.raw`\b(?:sensex|nifty|tsx|asx|psx|jse|kse|muhurat)\b`, 'should you', 'bullish or bearish', String.raw`analysts (?:predicting|like|see|bullish)`,
  String.raw`price,? news`, String.raw`news,? quote`, 'share price', 'you need', String.raw`buy (?:now|right now|and hold)`, String.raw`\bdividend`, 'millionaire', 'retire',
  String.raw`best .* to buy`, String.raw`stocks? to (?:buy|watch)`, 'price target', 'prediction:', 'outpaced the stock market',
  String.raw`favou?rite stocks`, String.raw`\boverview\b`, String.raw`\([A-Z]{1,4}[FGHJKMNQUVXZ]\d{2}\)`, 'things to know', 'what investors need', 'last quarter', 'where the stock could',
].join('|'), 'i');

// 주제 — [key, 화면 이름, 정규식]. 한 제목이 여러 주제에 걸릴 수 있다(비중 합계 ≠ 100%).
const THEMES = [
  ['ai', 'AI 투자 회의론', /\bAI (?:bubble|spending|capex|fears?|jitters|sell-?off|rout|trade|doubts?|worries|concerns|unwind|stocks? (?:slide|sink|fall|tumble|plunge|sell))|\bcapex\b|data[- ]cent(?:er|re) (?:spending|doubts|glut)|\bBurry\b|overbuil/i],
  ['chip', '반도체·메모리', /\b(?:chip ?(?:stocks|makers?|sell-?off|shares|rout|sector)|semiconductors?|SOX\b|Nvidia|Micron|memory chips?|HBM|SK ?Hynix|Samsung Electronics|Broadcom|AMD\b|TSMC|Marvell|Sandisk|Western Digital)/i],
  ['rate', '금리·물가·연준', /\b(?:Fed\b|Federal Reserve|FOMC|Powell|Warsh|rate (?:hike|cut|path)s?|hike bets|Treasury yields?|10-year|bond yields?|inflation|CPI|PCE|jobs report|payrolls)/i],
  ['earn', '실적', /\b(?:earnings|results|guidance|revenue|profit warning)\b/i],
  ['ipo', '대형 상장·자금 흡수', /\b(?:IPO|debut|listing|Anthropic|SpaceX|CoreWeave|share sale)\b/i],
  ['geo', '무역·지정학', /\b(?:tariffs?|trade war|export (?:curbs|controls|ban)|chip curbs|China (?:chip|ban|curbs|tension)|Taiwan (?:strait|tension)|sanctions|geopolit\w*|war\b|Iran|Russia|Ukraine)/i],
  ['pol', '미국 정치', /\b(?:midterms?|election|Trump|Democrats|Republicans|shutdown|Congress)\b/i],
  ['oil', '유가·원자재', /\b(?:oil|crude|WTI|Brent|OPEC|gold|copper|commodit\w*)\b/i],
  ['credit', '신용·유동성', /\b(?:credit (?:spreads?|markets?|stress|fears)|private credit|junk bonds?|margin (?:calls?|debt)|liquidity|deleverag\w*|unwind)/i],
];
const THEME_META = THEMES.map(([k, label]) => ({ k, label }));

const DOWN = /\b(?:sell-?off|rout|plunge[sd]?|slides?|slid|tumbles?|tumbled|sinks?|sank|crash\w*|worst|drops?|dropped|falls?|fell|slump\w*|losses|losing streak|correction|bear market|fears?|jitters|panic)\b/i;
const UP = /\b(?:rally|rallies|rallied|rebounds?|rebounded|surges?|surged|soars?|jumps?|jumped|gains|climbs?|record high|all-time high|best day|rises|rose)\b/i;

// 대표 제목 고를 때 매체 순위(앞일수록 우선)
const OUTLET_RANK = [/Reuters/i, /Bloomberg/i, /WSJ|Wall Street Journal/i, /Financial Times|\bFT\b/i, /CNBC/i, /AP News|Associated Press/i, /Barron/i, /MarketWatch/i, /Investor's Business Daily/i, /Fortune/i, /Business Insider/i, /Yahoo Finance$/i];
const outletRank = s => { const i = OUTLET_RANK.findIndex(re => re.test(s || '')); return i < 0 ? 99 : i; };

// 미국 동부 날짜 — DST: 3월 둘째 일요일 07:00 UTC ~ 11월 첫째 일요일 06:00 UTC
function nthSunday(y, m, n) { const d = new Date(Date.UTC(y, m, 1)); const first = (7 - d.getUTCDay()) % 7; return Date.UTC(y, m, 1 + first + 7 * (n - 1)); }
function etDate(ms) {
  const y = new Date(ms).getUTCFullYear();
  const dst = ms >= nthSunday(y, 2, 2) + 7 * 3600e3 && ms < nthSunday(y, 10, 1) + 6 * 3600e3;
  return new Date(ms - (dst ? 4 : 5) * 3600e3).toISOString().slice(0, 10);
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

const unxml = s => String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

// RSS xml → [{t, s, l, d(ET)}] (잡음 제거 후)
function parseRss(xml) {
  const out = [];
  for (const it of String(xml).split('<item>').slice(1)) {
    const title = unxml((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const link = unxml((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    const pub = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    const source = unxml((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
    if (!title || !link || !pub) continue;
    if (KR_OUTLET.test(source) || JUNK_OUTLET.test(source) || NOISE_SRC.test(source)) continue;
    const t = cleanTitle(title);
    if (NOISE_T.test(t)) continue;
    out.push({ t, s: source, l: link, d: etDate(pub) });
  }
  return out;
}

function classify(t) {
  return { th: THEMES.filter(([, , re]) => re.test(t)).map(([k]) => k), down: DOWN.test(t), up: UP.test(t) };
}

// 하루치 제목 → 집계
function dayAgg(titles) {
  const th = {}; let down = 0, up = 0;
  for (const x of titles) {
    const c = classify(x.t);
    for (const k of c.th) th[k] = (th[k] || 0) + 1;
    if (c.down) down++; if (c.up) up++;
  }
  return { n: titles.length, down, up, th };
}

const sumDays = rows => {
  const o = { n: 0, down: 0, up: 0, th: {} };
  for (const r of rows) { o.n += r.n; o.down += r.down; o.up += r.up; for (const [k, v] of Object.entries(r.th || {})) o.th[k] = (o.th[k] || 0) + v; }
  return o;
};
const share = (v, n) => (n ? Math.round((v / n) * 1000) / 10 : null);

// ── 급증 키워드 — 사전 없이, 직전 4주보다 최근 7일 제목에 훨씬 자주 나온 단어·두 단어 묶음 ────────────
//   사전 주제는 미리 정한 칸에만 담기므로 새 사건(CEO 사임, 특정 규제)을 못 잡는다. 이쪽이 그 빈자리를 채운다.
//   시범(2026-11-23): 11/9주 jensen huang 11배·hot inflation 7.6배, 11/16주 anthropic debut 15.6배·chip curbs 14배.
//   방향 단어(fall·rally…)와 시장 일반어는 뺀다 — 분위기는 하락어 비중이 따로 보여준다.
const KW_STOP = new Set(('the a an of to in on for and or as at is are was were be been by with from after its it has have had that this these those what why how '
  + 'who which when where while about into over under than then just still now not but if so up down out off new more most less very all any some '
  + 'stock stocks market markets wall street today s&p 500 nasdaq dow jones us u.s. week weeks day days year years month first last next '
  + 'says said will can could would may might should here here\'s you your we our their they he she his her them '
  + 'lower higher ends end ending edge edges mixed slightly sharply points point index indexes shares share investors traders trading trade '
  + 'close closes closing open opens futures session amid ahead before since despite again back big top key report news live update updates '
  + 'p.m. a.m. et vs. vs 1 2 3 4 5 10 2025 2026 2027 spx ixic dji djia ndx nya rut gspc jan feb mar apr jun jul aug sep sept oct nov dec january february march april june july august september october november december monday tuesday wednesday thursday friday saturday sunday').split(/\s+/));
const KW_DIR = /^(?:sell-?off|selloff|rout|plung(?:e[sd]?|ing)|slid(?:es?|ing)?|tumbl(?:es?|ed|ing)|sink(?:s|ing)?|sank|crash\w*|worst|drop(?:s|ped|ping)?|fall(?:s|ing)?|fell|slump\w*|loss(?:es)?|losing|streak|correction|fears?|jitters|panic|rall(?:y|ies|ied|ying)|rebound(?:s|ed|ing)?|surg(?:es?|ed|ing)|soar(?:s|ed|ing)?|jump(?:s|ed|ing)?|gain(?:s|ed|ing)?|climb(?:s|ed|ing)?|record|best|ris(?:es?|ing)|rose|declin(?:es?|ed|ing)|slip(?:s|ped|ping)?|retreat(?:s|ed|ing)?|extend(?:s|ed|ing)?|deepen(?:s|ed|ing)?)$/;
function grams(t) {
  const w = String(t).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9&.' -]/g, ' ').replace(/(^|\s)['.-]+|['.-]+(?=\s|$)/g, ' ')
    .split(/\s+/).map(x => x.replace(/'s$/, '')).filter(Boolean);
  const ok = x => x.length > 2 && !KW_STOP.has(x) && !KW_DIR.test(x) && !/^\d[\d.,%]*$/.test(x);
  const g = new Set(w.filter(ok));
  for (let i = 0; i < w.length - 1; i++) if (ok(w[i]) && ok(w[i + 1])) g.add(w[i] + ' ' + w[i + 1]);
  return g;
}
// 제목 원문에서 그 말이 쓰인 표기들 (대소문자 보존)
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function forms(g, titles) {
  const re = new RegExp(`(?<![A-Za-z0-9])${g.split(' ').map(escRe).join(`(?:'s)?\\s+`)}(?![A-Za-z0-9])`, 'i');
  return titles.map(x => { const m = x.t.replace(/[‘’]/g, "'").match(re); return m ? { f: m[0], titleCase: isTitleCase(x.t), first: m.index === 0 } : null; }).filter(Boolean);
}
// 'Stocks Fall As Nvidia Slides' 처럼 거의 모든 낱말이 대문자로 시작하는 제목은 대소문자로 고유명사를 판정할 수 없다
function isTitleCase(t) { const w = t.split(/\s+/).filter(x => /^[A-Za-z]{4,}/.test(x)); return w.length >= 3 && w.filter(x => /^[A-Z]/.test(x)).length / w.length > 0.6; }
// 낱말 하나짜리는 고유명사·약어만 받는다(Anthropic, Huang, CPI, ANT). 문장형 제목에서 60% 이상 대문자로 시작해야 한다.
function isProper(fs) {
  const sentence = fs.filter(x => !x.titleCase && !x.first);
  if (sentence.length >= 2) return sentence.filter(x => /^[A-Z]/.test(x.f)).length / sentence.length >= 0.6;
  return fs.filter(x => /^[A-Z0-9&]{2,6}$/.test(x.f)).length / Math.max(1, fs.length) >= 0.6;   // 문장형 제목에 안 나오면 약어만
}
// 화면 표기: 문장형 제목에서 가장 많이 쓰인 표기(없으면 전체에서)
function displayForm(fs, g) {
  const pool = fs.filter(x => !x.titleCase).length ? fs.filter(x => !x.titleCase) : fs;
  const c = new Map(); for (const x of pool) { const f = x.f.replace(/'s(?=\s)/, ''); c.set(f, (c.get(f) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || g;
}

/**
 * now / prev : [{t, s, l?, d}] — 최근 7일, 직전 4주 제목
 * 기준: 최근 7일 MIN_N 건 이상, 비중 배수(prev 는 +1 보정) RATIO_MIN 이상,
 *       서로 다른 제목(앞 30자 기준) MIN_DISTINCT 개 이상 — AP 기사 하나가 지역 매체 수십 곳에 같은 제목으로 실리는 것을 걸러낸다
 *       (시범: 'composite goes' 12건이 제목 2종뿐), 낱말 하나짜리는 고유명사·약어만.
 * 두 단어 묶음이 그 낱말 건수의 60% 이상을 덮으면 낱말은 뺀다.
 */
function spikes(now, prev, { MIN_N = 6, RATIO_MIN = 3, LIMIT = 10, MIN_DISTINCT = 4 } = {}) {
  if (!now.length || prev.length < 100) return [];
  const count = arr => { const o = new Map(); for (const x of arr) for (const g of grams(x.t)) o.set(g, (o.get(g) || 0) + 1); return o; };
  const cn = count(now), cp = count(prev);
  let cand = [...cn.entries()].filter(([, v]) => v >= MIN_N).map(([g, v]) => {
    const p = cp.get(g) || 0, ratio = (v / now.length) / ((p + 1) / prev.length);
    return { g, n: v, prevN: p, ratio: Math.round(ratio * 10) / 10 };
  }).filter(x => x.ratio >= RATIO_MIN).sort((a, b) => b.ratio - a.ratio || b.n - a.n);
  const bigrams = cand.filter(x => x.g.includes(' '));
  cand = cand.filter(x => x.g.includes(' ') || !bigrams.some(b => b.g.split(' ').includes(x.g) && b.n >= 0.6 * x.n));
  // 같은 사건을 가리키는 묶음끼리(작은 쪽 제목의 60% 이상이 겹침) 하나만 남긴다
  const titlesOf = g => now.filter(x => grams(x.t).has(g));
  const out = [];
  for (const c of cand) {
    const ts = titlesOf(c.g), set = new Set(ts.map(x => x.t));
    if (new Set(ts.map(x => x.t.toLowerCase().slice(0, 30))).size < MIN_DISTINCT) continue;
    const fs = forms(c.g, ts);
    if (!c.g.includes(' ') && !isProper(fs)) continue;
    c.label = displayForm(fs, c.g);
    if (out.some(o => { const inter = o._set.size && [...set].filter(t => o._set.has(t)).length; return inter >= 0.6 * Math.min(set.size, o._set.size); })) continue;
    const seen = new Set();
    const titles = ts.filter(x => x.l).sort((a, b) => outletRank(a.s) - outletRank(b.s) || b.d.localeCompare(a.d))
      .filter(x => { const k = x.t.toLowerCase().slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 3).map(x => ({ d: x.d, title: x.t, source: x.s, link: x.l }));
    out.push({ ...c, titles, _set: set });
    if (out.length >= LIMIT) break;
  }
  return out.map(({ _set, ...x }) => x);
}

/**
 * 화면용 스냅샷.
 *   days    : [{d, n, down, up, th}] ET 날짜 오름차순(최대 182일)
 *   titles  : { d: [{t,s,l}] } 최근 며칠 원문(대표 제목용)
 *   lastDay : 집계 마지막 ET 날짜(그날은 수집 시각 이후 기사가 아직 없을 수 있다 → partial 표시)
 */
function buildSnapshot(days, titles, lastDay, px) {
  const byDay = new Map(days.map(r => [r.d, r]));
  const span = (from, to) => [...byDay.values()].filter(r => r.d >= from && r.d <= to);
  const r7from = addDays(lastDay, -6), p28from = addDays(lastDay, -34), p28to = addDays(lastDay, -7);
  const now = sumDays(span(r7from, lastDay)), prev = sumDays(span(p28from, p28to));
  const prevDays = span(p28from, p28to).length;
  const themes = THEME_META.map(({ k, label }) => {
    const r = now.th[k] || 0, p = prev.th[k] || 0;
    const sNow = share(r, now.n), sPrev = share(p, prev.n);
    return { k, label, n7: r, share7: sNow, sharePrev: sPrev, shareRatio: sNow != null && sPrev ? Math.round((sNow / sPrev) * 10) / 10 : null };
  });
  // 주별(ET 월~일) 비중 — 최근 12주
  const monday = d => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const weeks = new Map();
  for (const r of days) { const w = monday(r.d); if (!weeks.has(w)) weeks.set(w, []); weeks.get(w).push(r); }
  const weekly = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([w, rows]) => {
    const s = sumDays(rows);
    return { w, days: rows.length, n: s.n, downShare: share(s.down, s.down + s.up), th: Object.fromEntries(THEME_META.map(({ k }) => [k, share(s.th[k] || 0, s.n)])) };
  });
  // 대표 제목 — 최근 7일 주제별 최대 4건(매체 순위 → 최신), 같은 제목 앞 40자 중복 제거
  const recentTitles = Object.entries(titles || {}).filter(([d]) => d >= r7from && d <= lastDay)
    .flatMap(([d, arr]) => arr.map(x => ({ ...x, d })));
  const top = {};
  for (const { k } of THEME_META) {
    const seen = new Set();
    top[k] = recentTitles.filter(x => classify(x.t).th.includes(k))
      .sort((a, b) => outletRank(a.s) - outletRank(b.s) || b.d.localeCompare(a.d))
      .filter(x => { const key = x.t.toLowerCase().slice(0, 40); if (seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, 4).map(x => ({ d: x.d, title: x.t, source: x.s, link: x.l }));
  }
  const allTitles = Object.entries(titles || {}).flatMap(([d, arr]) => arr.map(x => ({ ...x, d })));
  const kw = spikes(allTitles.filter(x => x.d >= r7from && x.d <= lastDay), allTitles.filter(x => x.d >= p28from && x.d <= p28to));
  return {
    asOf: lastDay, keywords: kw, recent: { from: r7from, to: lastDay, n: now.n, downShare: share(now.down, now.down + now.up) },
    prev: { from: p28from, to: p28to, days: prevDays, n: prev.n, downShare: share(prev.down, prev.down + prev.up) },
    themes, weekly, daily: days.slice(-63).map(r => ({ d: r.d, n: r.n, down: r.down, up: r.up })), top, px: px || null,
    queries: QUERIES,
  };
}

module.exports = { QUERIES, THEMES, THEME_META, parseRss, classify, dayAgg, buildSnapshot, spikes, grams, etDate, addDays, NOISE_SRC, NOISE_T };
