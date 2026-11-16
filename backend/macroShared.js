/**
 * 시장 흐름 탭 공용 도우미 (2026-11-16) — 수집기(scripts/collect-macro.js)와 읽기(api/_macroView.js)가 같이 쓴다.
 *   - 뉴스 걸러내기·중복 묶기 (수집 때와 보여줄 때 같은 기준)
 *   - 주간 회귀(민감도): beta·상관·t·n
 */

// ── 뉴스 ─────────────────────────────────────────────────────────────────────
// 주제어(무엇에 관한 기사인가) + 한국 정책은 주체어(누가 하는가)까지 있어야 통과.
// 2026-11-16: '공매도' 질의가 "반도체 공매도 베팅 46% 급증" 같은 시황 기사를 '한국 정책'으로 끌고 와서 주체어 조건을 추가했다.
const NEWS_TOPIC = {
  kr_policy: /밸류업|상법|자본시장|공매도|증시|코스피|코스닥|주주|배당|금융위|세제|금투세|대주주/,
  state_capital: /지분|stake|국부|펀드|equity|국가자본|정부 투자|government/i,
  fed: /연준|FOMC|Fed|금리|점도표|파월|Powell|워시|Warsh|rate/i,
};
const KR_POLICY_ACTOR = /정부|금융위|금감원|국회|대통령|대통령실|여당|야당|민주당|국민의힘|정책|법안|개정|입법|제도|당국|위원회|기재부|재정경제부|거래소|세제|시행|발표|추진|간담회|공약/;

function newsPasses(tag, title) {
  const t = NEWS_TOPIC[tag];
  if (!t || !t.test(title)) return false;
  if (tag === 'kr_policy' && !KR_POLICY_ACTOR.test(title)) return false;
  return true;
}

// 제목 정규화 → 글자 2-gram 집합. " - 언론사" 꼬리, [속보] 같은 머리표, 기호를 뗀다.
function titleGrams(title) {
  const s = String(title).replace(/\s-\s[^-]+$/, '').replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
// 겹침 계수 = 공통 2-gram / 짧은 쪽 2-gram 수. 짧은 속보 제목이 긴 종합 기사에 묻히는 경우까지 잡는다.
const overlap = (a, b) => { if (!a.size || !b.size) return 0; let k = 0; for (const x of a) if (b.has(x)) k++; return k / Math.min(a.size, b.size); };

/** 같은 태그·36시간 안·제목 겹침 ≥ 0.45 면 한 묶음(2026-11-16 실제 제목 96건으로 조정). 입력은 최신순, 출력 각 행에 similar(묶인 다른 기사 수). */
function dedupeNews(rows, threshold = 0.45) {
  const kept = [];
  for (const r of rows) {
    const g = titleGrams(r.title), t = Date.parse(r.published_at);
    const hit = kept.find(k => k.tag === r.tag && Math.abs(k._t - t) <= 1.5 * 864e5 && overlap(k._g, g) >= threshold);
    if (hit) { hit.similar++; continue; }
    kept.push({ ...r, similar: 0, _g: g, _t: t });
  }
  return kept.map(({ _g, _t, ...r }) => r);
}

// ── 주간 회귀 ────────────────────────────────────────────────────────────────
// t 분포 양측 5% 임계값 근사 (Cornish-Fisher 2차, df ≥ 5 에서 오차 < 0.01)
function tCrit(df) {
  const z = 1.959964;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}
/** 표본 n 에서 상관이 5% 유의가 되는 최소 |r| */
function rCrit(n) { if (n < 4) return 1; const t = tCrit(n - 2); return t / Math.sqrt(n - 2 + t * t); }

/** y = a + b·x 최소제곱. 반환 { beta, r, t, n, sig } (sig = |t| ≥ 임계값) */
function ols(xs, ys) {
  const P = []; for (let i = 0; i < xs.length; i++) if (isFinite(xs[i]) && isFinite(ys[i]) && xs[i] != null && ys[i] != null) P.push([xs[i], ys[i]]);
  const n = P.length; if (n < 8) return { beta: null, r: null, t: null, n, sig: false };
  const mx = P.reduce((s, p) => s + p[0], 0) / n, my = P.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of P) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return { beta: null, r: null, t: null, n, sig: false };
  const beta = sxy / sxx, r = sxy / Math.sqrt(sxx * syy);
  const t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));
  return { beta, r, t, n, sig: Math.abs(t) >= tCrit(n - 2) };
}

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * 민감도: 주간 수익(%) 계열을 요인 변화 계열에 회귀.
 * factors = [{ d, us10, sox, fx }] (수준값, KR 날짜 기준 정렬), closes = Map(날짜 → 종가)
 * 단위: 미 10년물 +0.10%p 당 %, SOX +1% 당 %, 원/달러 +1% 당 %.
 * 주간 |수익| > 40% 는 액면분할·권리락 같은 이음매로 보고 뺀다.
 */
function sensitivity(factors, closes) {
  const ret = [], dus = [], dsox = [], dfx = [];
  for (let i = 1; i < factors.length; i++) {
    const a = factors[i - 1], b = factors[i];
    const pa = closes.get(a.d), pb = closes.get(b.d);
    if (!pa || !pb) continue;
    const r = (pb / pa - 1) * 100;
    if (Math.abs(r) > 40) continue;
    ret.push(r);
    dus.push(a.us10 != null && b.us10 != null ? (b.us10 - a.us10) * 10 : null);   // 0.10%p 단위
    dsox.push(a.sox && b.sox ? (b.sox / a.sox - 1) * 100 : null);
    dfx.push(a.fx && b.fx ? (b.fx / a.fx - 1) * 100 : null);
  }
  const pack = o => ({ beta: round(o.beta), r: round(o.r), t: round(o.t, 1), n: o.n, sig: o.sig });
  return { us10: pack(ols(dus, ret)), sox: pack(ols(dsox, ret)), fx: pack(ols(dfx, ret)), weeks: ret.length };
}

module.exports = { newsPasses, dedupeNews, rCrit, ols, sensitivity, round };
