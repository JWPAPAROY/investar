/**
 * 월가 시각 (2026-11-16) — 해외 기사 '제목'에서 기관·대상·방향·수치를 뽑는다.
 *   1) 규칙: 기관 사전 + 대상 사전 + 동사(상향/하향/유지/제시) + 숫자 패턴
 *   2) 규칙이 기관·대상은 찾았는데 방향을 못 정한 제목만 Gemini 로 구조화 → 사전·원문 대조 검증을 통과한 것만 쓴다
 *      (AI 는 해설을 쓰지 않는다. 수치는 제목 원문에 그대로 있어야 통과)
 * 본문은 받지 않는다: 주요 매체(Bloomberg·WSJ·FT·MarketWatch)는 유료벽 또는 robots 로 막혀 있다.
 * 수집 scripts/collect-macro.js(street 단계), 저장 street_views, 화면 index.html MacroPanel '월가 시각'.
 */

// 기관 — 이름에 정치인(Dan Goldman) 같은 동명이 걸려도 대상 사전을 같이 요구하므로 걸러진다
const INST = [
  ['Goldman Sachs', /\bGoldman\b/i], ['Morgan Stanley', /Morgan Stanley/i], ['JPMorgan', /J\.?\s?P\.?\s?Morgan|JPMorgan/i],
  ['Citi', /\bCiti(?:group)?\b/i], ['UBS', /\bUBS\b/], ['Nomura', /\bNomura\b/i], ['HSBC', /\bHSBC\b/], ['Macquarie', /Macquarie/i],
  ['CLSA', /\bCLSA\b/], ['BofA', /Bank of America|\bBofA\b/i], ['Jefferies', /Jefferies/i], ['Bernstein', /\bBernstein\b/i],
  ['Barclays', /Barclays/i], ['Deutsche Bank', /Deutsche Bank/i], ['Wells Fargo', /Wells Fargo/i], ['BNP Paribas', /\bBNP\b/i],
  ['Mizuho', /Mizuho/i], ['Daiwa', /\bDaiwa\b/i], ['Evercore', /Evercore/i], ['Wedbush', /Wedbush/i],
  ['Standard Chartered', /Standard Chartered/i], ['Capital Economics', /Capital Economics/i], ['SocGen', /Soci[eé]t[eé] G[eé]n[eé]rale|SocGen/i],
];
const INST_NAMES = INST.map(x => x[0]);

// 대상 — key 는 저장값, label 은 화면 이름
const TARGETS = [
  ['kospi', 'KOSPI', /\bKospi\b/i],
  ['korea', '한국 증시', /\b(?:South )?Korea(?:n)?(?:'s)? (?:stocks|equities|shares|stock market|market)\b/i],
  ['asia', '아시아·신흥국', /\bAsia(?:n)? (?:ex-Japan )?(?:stocks|equities)|\bemerging[- ]market (?:stocks|equities)|\bemerging markets\b/i],
  ['spx', 'S&P 500', /S&P ?500/i],
  ['ndx', '나스닥', /\bNasdaq\b/i],
  ['samsung', '삼성전자', /\bSamsung(?: Electronics)?\b/i],
  ['hynix', 'SK하이닉스', /\bSK ?hynix\b|\bSKHY\b/i],
  ['memory', '메모리·반도체', /\bmemory(?: chip)?s?\b|\bchip ?stocks\b|\bsemiconductors?\b/i],
  ['fed', '연준 금리', /\bFed\b|Federal Reserve|\bFOMC\b/],
  ['krw', '원화', /\bKorean won\b|\bUSD\/?KRW\b/i],
];
const TARGET_KEYS = TARGETS.map(x => x[0]);
const TARGET_LABEL = Object.fromEntries(TARGETS.map(x => [x[0], x[1]]));

// 방향 — up/down/hold/view(수치 제시)/bull/bear. 연준은 hike/cut/hold.
const DIRS = ['up', 'down', 'hold', 'view', 'bull', 'bear', 'hike', 'cut'];
const V_DOWN = /\b(?:cut|cuts|cutting|slash(?:es|ed)?|lower(?:s|ed)?|trim(?:s|med)?|reduc(?:es|ed)|halv(?:es|ed)|downgrad(?:es|ed|e)|chops?)\b/i;
const V_UP = /\b(?:rais(?:es|ed|e)|lift(?:s|ed)?|boost(?:s|ed)?|ups|upgrad(?:es|ed|e)|doubl(?:es|ed)|increas(?:es|ed))\b/i;
const V_HOLD = /\b(?:keeps?|maintains?|holds?|reiterat\w+|sticks? (?:to|with)|stands? by|reaffirm\w*)\b/i;
const V_VIEW = /\b(?:sets?|initiat\w+|sees?|forecasts?|expects?|predicts?|projects?|targets?)\b/i;
const S_BULL = /\b(?:overweight|bullish|upside|cheap(?:er)?|undervalued|favou?rs?|buy|rally|bottom(?:ed)?)\b/i;
const S_BEAR = /\b(?:underweight|bearish|downside|expensive|overvalued|sell)\b/i;   // correction·bubble 은 "조정이 끝나 간다" 같은 반대 뜻에도 쓰여서 뺐다
const F_HIKE = /\b(?:hike|hikes|raise rates|rate (?:increase|hike)s?|tighten\w*)\b/i;
const F_CUT = /\b(?:rate cuts?|cut rates|cuts? rates|eas(?:e|ing))\b/i;
const F_HOLD = /\b(?:hold|holds|pause|skip|on hold|unchanged)\b/i;

// 첫 번째로 나오는 동사를 쓴다 ("slashes target ... but still sees upside" → 하향)
function firstMatch(seg, pairs) {
  let best = null;
  for (const [dir, re] of pairs) { const m = seg.match(re); if (m && (best == null || m.index < best.i)) best = { dir, i: m.index }; }
  return best?.dir || null;
}

const YEARISH = v => /^(?:19|20)\d\d$/.test(v.replace(/,/g, ''));
function numbers(seg) {
  const value = (() => {
    const to = seg.match(/\bto\s+([₩$]?\d[\d,.]*(?:\s?(?:trillion|million|won))?(?:\s?[–-]\s?[\d,]+)?)/i);
    if (to && !YEARISH(to[1]) && !/%/.test(seg.slice(to.index, to.index + to[0].length + 1))) return to[1].trim();
    const at = seg.match(/\b(?:at|of)\s+([₩$]?\d[\d,.]*(?:\s?(?:trillion|million))?(?:\s?[–-]\s?[\d,]+)?)(?!\s?%)/i);
    if (at && !YEARISH(at[1])) return at[1].trim();
    for (const m of seg.matchAll(/[₩$]?\d{1,3}(?:,\d{3})+(?:\s?[–-]\s?\d{1,3}(?:,\d{3})+)?|[₩$]\d[\d.]*(?:\s?(?:trillion|million))?|\b\d{4,5}\b/g)) {
      if (!YEARISH(m[0])) return m[0].trim();
    }
    return null;
  })();
  const prev = (seg.match(/\bfrom\s+([₩$]?\d[\d,.]*)/i) || [])[1] || null;
  const pct = (seg.match(/(\d+(?:\.\d+)?)\s?%/) || [])[1] || null;
  const horizon = (seg.match(/\b(\d+)-month\b/i) || [])[0] || (seg.match(/\byear-end\b|\bend of (?:next )?year\b/i) || [])[0]
    || (seg.match(/\b(?:for|in|by)\s+((?:19|20)\d\d)\b/i) || [])[1] || null;
  const tidy = v => (v ? v.replace(/[.,]+$/, '') : v);
  return { value: tidy(value), prev: prev && tidy(prev) !== tidy(value) ? tidy(prev) : null, pct: pct ? +pct : null, horizon };
}

const cleanTitle = t => String(t).replace(/\s+-\s+[^-]+$/, '').trim();

// "Goldman Sachs stock faces ..." 처럼 은행 자체의 주가 기사는 은행의 '시각'이 아니다
function bankAsStock(seg) {
  for (const [, re] of INST) {
    const m = seg.match(re);
    if (m && m.index === 0) return /^(?:\s+(?:Sachs|Group|Inc\.?|& Co\.?))*\s*(?:\([A-Z.]+\)\s*)?(?:'s\s+)?(?:stock|shares)\b/i.test(seg.slice(m[0].length));
  }
  return false;
}

/**
 * 제목 하나 → { recs: [...], needsAi: bool }
 * 기관이 나온 자리부터 다음 기관 전까지를 한 구간으로 보고, 구간 안의 대상·동사·숫자를 묶는다.
 */
function extractRule(rawTitle) {
  const title = cleanTitle(rawTitle);
  const hits = [];
  for (const [name, re] of INST) { const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); for (const m of title.matchAll(g)) hits.push({ name, i: m.index }); }
  if (!hits.length) return { recs: [], needsAi: false };
  hits.sort((a, b) => a.i - b.i);
  const recs = []; let needsAi = false;
  for (let k = 0; k < hits.length; k++) {
    if (k > 0 && hits[k].name === hits[k - 1].name) continue;
    const end = k + 1 < hits.length ? hits[k + 1].i : title.length;
    let after = title.slice(hits[k].i, end);
    if (bankAsStock(after)) continue;
    // 절 경계에서 끊는다("Morgan Stanley's Bullish TeraWulf Target, and ... SK Hynix" 의 뒤 절은 다른 이야기). 맨 쉼표는 나열이라 안 끊는다.
    const cut = after.slice(4).search(/;|\s[—–|]\s|,\s+and\s|\.\.\./);
    if (cut >= 0) after = after.slice(0, cut + 4);
    let tg = TARGETS.filter(([, , re]) => re.test(after)).map(x => x[0]);
    // 대상이 기관보다 앞에 나오는 제목("Kospi Falls ... as Goldman Cuts Target")은 접속어로 이어질 때만 앞부분을 본다.
    //   "SKHY in Focus: Morgan Stanley Sees ... Chinese Stocks" 처럼 종목 나열 머리는 기관과 상관없다.
    if (!tg.length && k === 0) {
      const pre = title.slice(0, hits[k].i);
      if (/\b(?:as|after|while|with|amid|on)\s+(?:the\s+)?$/i.test(pre)) tg = TARGETS.filter(([, , re]) => re.test(pre)).map(x => x[0]);
    }
    // memory 는 삼성·하이닉스와 같이 나오면 개별 종목으로, korea 는 KOSPI 와 같이 나오면 KOSPI 로 본다
    if (tg.includes('samsung') || tg.includes('hynix')) tg = tg.filter(t => t !== 'memory');
    if (tg.includes('kospi')) tg = tg.filter(t => t !== 'korea');
    const targets = tg;
    if (!targets.length) continue;
    for (const target of targets) {
      let dir;
      if (target === 'fed') dir = firstMatch(after, [['hike', F_HIKE], ['cut', F_CUT], ['hold', F_HOLD]]);
      const nums = numbers(after);
      // 순서: 목표 변경 동사 > 수치 제시(sets/sees + 숫자) > 강세·약세 표현
      if (target !== 'fed') dir = firstMatch(after, [['down', V_DOWN], ['up', V_UP], ['hold', V_HOLD]])
        || (nums.value && V_VIEW.test(after) ? 'view' : null)
        || firstMatch(after, [['bull', S_BULL], ['bear', S_BEAR]]);
      if (!dir) { needsAi = true; continue; }
      // 대상이 여럿이면 숫자가 누구 것인지 규칙으로 못 가린다 → 숫자는 비우고, 숫자가 있으면 AI 에 다시 묻는다
      const multi = targets.length > 1;
      if (multi && nums.value) needsAi = true;
      // 연준 제목의 숫자는 목표가가 아니다(인상 횟수·bp 등) → 수치는 비우고 시점만 남긴다
      const noNum = multi || target === 'fed';
      recs.push({ inst: hits[k].name, target, dir, ...(noNum ? { value: null, prev: null, pct: null, horizon: nums.horizon } : nums), method: 'rule' });
    }
  }
  return { recs, needsAi: needsAi && !recs.some(r => r.value) };
}

// ── AI 보조 (Gemini) ─────────────────────────────────────────────────────────
const squash = s => String(s).replace(/[\s,]/g, '').toLowerCase();
/** AI 결과 한 줄을 사전·원문으로 검증. 통과 못 하면 null */
function validateAi(o, title) {
  if (!o || typeof o !== 'object') return null;
  const inst = INST.find(([n]) => n === o.inst); if (!inst || !inst[1].test(title)) return null;
  const im = title.match(inst[1]); if (bankAsStock(title.slice(im.index))) return null;
  const tg = TARGETS.find(([k]) => k === o.target); if (!tg || !tg[2].test(title)) return null;
  if (!DIRS.includes(o.dir)) return null;
  if ((o.target === 'fed') !== ['hike', 'cut', 'hold'].includes(o.dir) && o.dir !== 'view') return null;
  const okNum = v => v == null || v === '' || squash(title).includes(squash(v));
  if (!okNum(o.value) || !okNum(o.prev)) return null;
  let value = o.value ? String(o.value).trim() : null;
  if (value && YEARISH(value)) value = null;                                   // "for 2027" 의 연도는 수치가 아니다
  // 화면에는 제목 원문의 표기 그대로(₩670,000 · ₩4.7 Million · 19%) 보여준다
  if (value) {
    const digits = value.replace(/[^\d.]/g, '');
    if (digits) {
      const re = new RegExp('[₩$]?' + digits.split('').map(c => (c === '.' ? '\\.' : c)).join(',?') + '(?:\\s?(?:%|million|trillion|won))?', 'i');
      const m = title.match(re); if (m) value = m[0];
    }
  }
  // 퍼센트는 수익률 전망일 때만 수치로 받는다("77% of KOSPI short positions" 같은 통계는 전망이 아니다)
  if (value && /%$/.test(value)) {
    const at = title.indexOf(value), near = at < 0 ? '' : title.slice(Math.max(0, at - 20), at + value.length + 25);
    if (!/\b(?:return|upside|downside|gain|rise|rising|fall|drop|climb|decline)s?\b/i.test(near)) value = null;
  }
  // 방향 검증: 목표 변경·유지·연준 방향은 제목에 그 동사가 있어야 한다. 없으면 수치가 있을 때만 '제시'로 낮춘다.
  //   (예: "lowers gold forecast on hawkish Fed" 를 연준 인하로, "Kospi can hit 10,000" 을 상향으로 읽은 것)
  const VERB = { up: V_UP, down: V_DOWN, hold: o.target === 'fed' ? F_HOLD : V_HOLD, hike: F_HIKE, cut: F_CUT };
  let dir = o.dir;
  if (VERB[dir] && !VERB[dir].test(title)) dir = value ? 'view' : null;
  if (dir === 'view' && !value) dir = null;                                    // 수치 없는 '제시'는 아무것도 말하지 않는다
  if (!dir || (o.target === 'fed' && dir === 'view')) return null;
  return { inst: o.inst, target: o.target, dir, value, prev: o.prev || null, pct: null, horizon: null, method: 'ai' };
}

// 무료 한도는 모델별 하루 버킷 → 모델을 바꿔 가며 시도. gemini-2.0-flash 는 2026-11 기준 404(퇴역)라 뺐다.
async function aiExtract(titles, apiKey, models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
  if (!titles.length || !apiKey) return { results: {}, model: null, error: apiKey ? null : 'GEMINI_API_KEY 없음' };
  const prompt = `You extract sell-side views from English financial news headlines. Do not interpret or add anything not in the headline.
For each headline return objects {"i": index, "inst": one of ${JSON.stringify(INST_NAMES)}, "target": one of ${JSON.stringify(TARGET_KEYS)}, "dir": one of ${JSON.stringify(DIRS)}, "value": exact number text from the headline or null, "prev": exact previous number text or null}.
dir: up/down = raised/cut a target or rating, hold = kept, view = stated a forecast number, bull/bear = positive/negative stance without a target change, hike/cut/hold for the Fed only.
One headline may yield several objects (one per institution-target pair). Skip pairs not stated in the headline. Return {"items": [...]}.
Headlines:
${titles.map((t, i) => `${i}. ${cleanTitle(t)}`).join('\n')}`;
  const errs = [];
  for (const model of models) {
    if (errs.length) await new Promise(r => setTimeout(r, 8000));   // 429·503 은 잠깐 쉬고 다음 모델
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) { errs.push(`${model} ${r.status}`); continue; }
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      const items = JSON.parse(text).items || [];
      const results = {};
      for (const o of items) {
        const t = titles[o.i]; if (t == null) continue;
        const v = validateAi(o, cleanTitle(t));
        (results[t] = results[t] || []);
        if (v) results[t].push(v);
      }
      for (const t of titles) if (!results[t]) results[t] = [];
      return { results, model, error: null };
    } catch (e) { errs.push(`${model} ${e.message.slice(0, 60)}`); }
  }
  return { results: {}, model: null, error: errs.join(' / ') };
}

// ── 묶기 ─────────────────────────────────────────────────────────────────────
// 한국 매체의 영문판은 뺀다(사용자 요청: 해외 원문). 이름에 한글이 있거나 아래 목록.
// 자동 생성·SEO 매체(제목을 기계적으로 바꿔 붙인다)
const JUNK_OUTLET = /ad-hoc-news|Simply Wall|MarketBeat|Quantisnow|Stock Titan|Pluang|富途|Moomoo|TMGM/i;
const KR_OUTLET = /[가-힣]|Chosun|Korea Herald|Korea Times|JoongAng|Seoul Economic|Business ?korea|bloomingbit|Yonhap|KED Global|Pulse|Hankyoreh|Maeil|Korea Economic|Aju|Kmib|Dong-?A|Hankook|Money ?Today|Edaily|Newsis|BusinessPost|Asiae|TheElec|ZDNet Korea|Korea ?JoongAng/i;
// 대표 기사 고르는 순서(앞일수록 우선)
const OUTLET_RANK = [/Bloomberg/i, /Reuters/i, /CNBC/i, /Financial Times|\bFT\b/i, /Wall Street Journal|WSJ/i, /Barron/i, /MarketWatch/i, /Investing\.com/i, /Yahoo/i, /Business Insider/i, /Nikkei/i, /TheStreet/i, /Benzinga/i];
const rank = src => { const i = OUTLET_RANK.findIndex(re => re.test(src || '')); return i < 0 ? 99 : i; };

/**
 * 기사 단위 추출 결과 → 사건 단위로 묶는다. 같은 기관·대상·방향이 10일 안이면 한 사건.
 * existing = DB 의 최근 행(같은 기준으로 이어 붙인다). 반환 = upsert 할 행.
 */
function cluster(articles, existing = []) {
  const rows = existing.map(r => ({ ...r, sources: [...(r.sources || [])] }));
  // 목표 변경(up/down)·연준 방향은 같은 방향끼리만, 유지·제시·강세·약세는 서로 같은 보고서의 다른 표현으로 본다(강세↔약세는 제외)
  const STANCE = ['hold', 'view', 'bull', 'bear'];
  const same = (x, y) => x === y || (STANCE.includes(x) && STANCE.includes(y) && !(x === 'bull' && y === 'bear') && !(x === 'bear' && y === 'bull'));
  const byKey = (a) => rows.find(r => r.inst === a.inst && r.target === a.target && same(r.dir, a.dir)
    && Math.abs(Date.parse(r.first_seen) - Date.parse(a.date)) <= 10 * 864e5);
  const prio = d => ['up', 'down', 'hike', 'cut', 'hold', 'view', 'bull', 'bear'].indexOf(d);
  const touched = new Set();
  for (const a of articles.sort((x, y) => x.published_at.localeCompare(y.published_at))) {
    let r = byKey(a);
    if (!r) {
      r = { id: `${a.inst}|${a.target}|${a.dir}|${a.date}`, first_seen: a.date, inst: a.inst, target: a.target, dir: a.dir,
        value: null, prev: null, pct: null, horizon: null, method: a.method, title: a.title, link: a.link, source: a.source, sources: [] };
      rows.push(r);
    }
    if (r.sources.some(s => s.link === a.link || s.title === a.title)) continue;
    r.sources.push({ title: a.title, link: a.link, source: a.source, published_at: a.published_at, method: a.method });
    touched.add(r.id);
    for (const k of ['value', 'prev', 'pct', 'horizon']) if (r[k] == null && a[k] != null) r[k] = a[k];
    if (prio(a.dir) < prio(r.dir)) r.dir = a.dir;   // 유지 > 제시 > 강세·약세 순으로 더 구체적인 표현을 대표로
    if (a.method === 'rule') r.method = 'rule';   // 규칙으로도 잡힌 사건은 규칙 표시
  }
  // 대표 기사: 수치가 제목에 들어 있는 기사 우선, 그다음 매체 순위
  for (const r of rows) {
    if (!touched.has(r.id)) continue;
    const score = s => rank(s.source) + (r.value && !squash(s.title).includes(squash(r.value)) ? 100 : 0);
    const best = [...r.sources].sort((x, y) => score(x) - score(y))[0];
    if (best) { r.title = best.title; r.link = best.link; r.source = best.source; }
  }
  return rows.filter(r => touched.has(r.id)).map(r => ({ ...r, n_sources: r.sources.length, sources: r.sources.slice(-15), updated_at: new Date().toISOString() }));
}

module.exports = { extractRule, aiExtract, validateAi, cluster, cleanTitle, KR_OUTLET, JUNK_OUTLET, TARGET_LABEL, INST_NAMES, TARGET_KEYS };
