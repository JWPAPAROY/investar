/**
 * portfolio.js — 저PBR·저변동 포트폴리오 구성 (v3.97, 2026-08-26)
 *
 * 왜 만들었나:
 *   현행 추천 풀은 KIS 순위 API 5종(거래량 증가율·거래량·거래대금·회전율·등락률)으로
 *   만들어진다. 다섯 축이 전부 "이미 움직인/이미 거래가 몰린" 주목도라, 풀 자체가
 *   주목 정점 이후 표본이 된다 — 2026-08-08 측정에서 **풀 전체 매칭초과 −7.39%(D+10)**.
 *   문제는 랭킹이 아니라 풀이라는 결론이 나왔고(2026-08-08), 이 파일이 그 대안이다.
 *
 *   구조적 모순의 증거: 풀의 65%가 시총 3천억 미만인데 최종 TOP3의 80%는 시총상위300이다.
 *   마이크로캡을 잔뜩 모은 뒤 마지막 시총 플로어로 내다 버리는 구조 —
 *   **시총 기준은 마지막 필터가 아니라 유니버스여야 한다**는 것이 1번 설계 원칙이다.
 *
 * 무엇을 고르나 (2026-08-25 IS/OOS 탐색에서 살아남은 조합):
 *   유니버스  보통주 · 시총 ≥ 3,000억 · 20일 평균 거래대금 ≥ 10억 · 그중 시총 상위 300
 *   팩터      저PBR 백분위 + 저변동(20일 일간수익 표준편차) 백분위
 *   K         10종목 (기본)
 *   리밸런싱  60거래일
 *   비중      시총가중
 *
 * 왜 20일인가 (2026-08-26 재측정 — 처음엔 60일로 잡았다가 바꿨다):
 *   같은 팩터·K에서 주기만 바꿔 전 조합을 보면 60일의 우위가 표본 착시였다.
 *     주기   검증CAGR  검증MDD  검증승률  검증기간수
 *     10일    +38.1%   −11.3%    64%       50
 *     20일    +65.5%   −10.2%    67%       24
 *     60일    +45.9%    −5.7%    71%        7
 *   결정적인 건 **같은 기간 시장(시총가중)과의 비교**다:
 *     20일 전략 +65.5% vs 시장 +58.1% → **+7.4%p 우위** (MDD 10.2% vs 17.9%)
 *     60일 전략 +45.9% vs 시장 +57.0% → **−11.1%p 열위** (MDD 5.7% vs 10.4%)
 *   즉 60일은 검증 구간에서 **시장을 못 이긴다**. 60일을 골랐던 근거(IS 승률 78%·MDD −6.5%)는
 *   **9기간짜리 숫자**였다(9회 중 7회). 20일은 검증만 24기간으로 표본이 3.4배다.
 *   바꾼 이유는 "수익이 더 높아서"가 아니라 **"표본이 3배이고 벤치마크를 이기기 때문"**이다.
 *   치르는 값: MDD가 −5.7% → −10.2%로 커진다.
 *   재현: node --max-old-space-size=8192 scripts/strategy-search.js --factor='PBR+저변동'
 *
 *   ⚠️ 그래도 검증 24기간이다. **확정된 전략이 아니라 관측 대상이다.**
 *
 * 검증되지 않아 **일부러 빼둔 것**:
 *   수급(3회 기각) · 업종 로테이션(고르는 덴 무효) · 순방향 재무(고ROE∩저부채 −1.02%)
 *   · 거래량/모멘텀 계열(개별 검정 미통과) · 손절(기대값 못 바꿈).
 *   여기에 뭔가 더하고 싶으면 먼저 단독 검정을 통과시킬 것 — 넣으면 노이즈만 는다.
 *
 * 이 파일은 **데이터 출처에 무관한 순수 로직**이다.
 *   실운용(DB: market_flow_daily + stock_financials) → scripts/build-portfolio.js
 *   백테스트(로컬: krx-daily.jsonl)                 → scripts/strategy-search.js
 *   같은 정의를 두 벌 쓰지 않기 위해 여기서만 정의한다(사본 드리프트 사고 3회 겪음).
 */

const DEFAULTS = {
  capMin: 3000e8,   // 시총 하한 3,000억
  valMin: 10e8,     // 20일 평균 거래대금 하한 10억 (유동성 = 실행 가능성)
  look: 20,         // 변동성 관측 창(거래일)
  univ: 300,        // 시총 상위 N
  k: 10,            // 보유 종목 수
  hold: 20,         // 리밸런싱 주기(거래일) — 아래 '왜 20일인가' 참고
  weight: 'cap',    // 'cap' | 'eq'
  factor: 'PBR+저변동',
};

/**
 * 병행 관측 전략 (2026-10-06 추가).
 *   pbr_lowvol  — 기존(v3.97). 판정 PORTFOLIO_VERDICT.md, 벤치 KOSPI.
 *   ep_lowturn  — 이익수익률(E/P) + 저회전(20일 평균 거래대금/시총). 판정 PORTFOLIO_VERDICT_EP.md.
 *     출처: scripts/logic-search.js --exclude=005930,000660 (사전등록 IS 선택 → OOS 통과).
 *     설계 2022-01~2024-06 KOSPI ex-2 대비 연 +26.2%p → 판정 2024-07~2026-08 연 +3.1%p,
 *     MDD −10.8%(벤치 −18.1%). **삼성전자·SK하이닉스는 유니버스와 벤치마크 양쪽에서 제외**한다 —
 *     두 종목은 따로 보유(또는 지수 ETF)한다는 전제의 "나머지 시장" 전략이다.
 *     ⚠️ 제외 조건은 OOS를 본 뒤 정한 것이라 엄격한 판정보다 한 단계 약하다 → 실시간 관측 대상.
 */
const MEGA = ['005930', '000660'];
const STRATEGIES = {
  pbr_lowvol: { ...DEFAULTS },
  ep_lowturn: { ...DEFAULTS, factor: 'E/P+저회전', weight: 'eq', exclude: MEGA, bench: 'kospi_ex_mega' },
};

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/**
 * 후보 유니버스 구성 + 팩터 백분위 부여.
 *
 * @param {Map<string, Array>} series  code -> [{date, close, marketCap, tradingValue}] (날짜 오름차순, 전 구간)
 * @param {number} idx                 신호일의 인덱스(공용 거래일 배열 기준)
 * @param {string[]} days              공용 거래일 배열(오름차순)
 * @param {Function|object} fin        (code, date) => bps | null, 또는 buildFinancialIndex() 결과(roe 포함)
 * @param {object} opts
 * @returns {Array} 시총상위 N, 각 행에 p_pbr/p_vol20/p_cap(1 = 저PBR/저변동/대형)
 */
function buildUniverse(series, idx, days, fin, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const bpsAt = typeof fin === 'function' ? fin : fin.bpsAt;
  const roeAt = typeof fin === 'function' ? () => null : (fin.roeAt || (() => null));
  const excl = new Set(o.exclude || []);
  const date = days[idx];
  const rows = [];

  for (const [code, arr] of series) {
    if (excl.has(code)) continue;
    const byDate = arr.byDate || null;
    const at = (k) => (byDate ? byDate.get(days[k]) : null);
    const cur = at(idx);
    if (!cur || !(cur.close > 0) || !(cur.marketCap >= o.capMin)) continue;

    // 최근 look+1 거래일이 **빠짐없이** 있어야 한다 (거래정지·신규상장 배제)
    const closes = [];
    let ok = true;
    for (let k = o.look; k >= 0; k--) {
      const p = at(idx - k);
      if (!p || !(p.close > 0)) { ok = false; break; }
      closes.push(p.close);
    }
    if (!ok) continue;

    // 유동성: **신호일 직전까지**의 20일 평균 거래대금.
    //   당일 거래대금은 KRX가 다음 날 공표하므로 항상 비어 있다(2026-08-25 확인).
    //   신호일을 빼는 것이 point-in-time 관점에서도 맞다.
    const vals = [];
    for (let k = o.look; k >= 1; k--) {
      const p = at(idx - k);
      if (p && p.tradingValue > 0) vals.push(p.tradingValue);
    }
    const val20 = vals.length >= Math.ceil(o.look * 0.5) ? avg(vals) : null;
    if (val20 == null || !(val20 >= o.valMin)) continue;

    const rets = [];
    for (let k = 1; k < closes.length; k++) rets.push(((closes[k] - closes[k - 1]) / closes[k - 1]) * 100);
    const bps = bpsAt(code, date);
    const roe = roeAt(code, date);

    rows.push({
      code, close: cur.close, cap: cur.marketCap, val20,
      vol20: sd(rets),
      pbr: bps > 0 ? cur.close / bps : null,
      bps: bps > 0 ? bps : null,
      // E/P = ROE × BPS / 주가 (logic-search.js와 같은 정의 — EPS 필드의 분기/누적 모호성을 피한다)
      ep: bps > 0 && roe != null && isFinite(roe) ? (roe / 100) * bps / cur.close : null,
      // 회전율 = 20일 평균 거래대금 / 시총 (낮을수록 '무관심')
      turn: cur.marketCap > 0 ? val20 / cur.marketCap : null,
    });
  }

  rows.sort((a, b) => b.cap - a.cap);
  const top = rows.slice(0, o.univ);

  // 백분위: 1 = 가장 좋음(저PBR / 저변동 / 대형)
  const rank = (key, asc, allowNonPos = false) => {
    const a = top.filter(r => r[key] != null && isFinite(r[key]) && (allowNonPos || r[key] > 0));
    a.sort((x, y) => (asc ? x[key] - y[key] : y[key] - x[key]));
    a.forEach((r, k) => { r['p_' + key] = a.length > 1 ? 1 - k / (a.length - 1) : 1; });
  };
  rank('pbr', true); rank('vol20', true); rank('cap', false);
  rank('ep', false, true);   // 적자(음수 E/P)도 순위에 넣는다 — 맨 아래로 간다(백테스트와 동일)
  rank('turn', true);
  return top;
}

/** 팩터 점수 (strategy-search.js FACTORS와 동일 정의) */
const FACTORS = {
  'PBR': r => r.p_pbr,
  'PBR+저변동': r => (r.p_pbr != null && r.p_vol20 != null) ? r.p_pbr + r.p_vol20 : null,
  'PBR+대형': r => (r.p_pbr != null && r.p_cap != null) ? r.p_pbr + r.p_cap : null,
  '저변동': r => r.p_vol20,
  'E/P+저회전': r => (r.p_ep != null && r.p_turn != null) ? r.p_ep + r.p_turn : null,
};

/**
 * 상위 K종목 선택 + 비중 배분.
 * @returns {Array} [{code, close, cap, pbr, vol20, score, weight}]
 */
function selectPicks(top, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fn = FACTORS[o.factor];
  if (!fn) throw new Error(`알 수 없는 팩터: ${o.factor}`);

  const scored = top
    .map(r => ({ ...r, score: fn(r) }))
    .filter(r => r.score != null && isFinite(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, o.k);

  const denom = o.weight === 'cap'
    ? scored.reduce((s, r) => s + r.cap, 0)
    : scored.length;

  return scored.map(r => ({
    ...r,
    weight: denom > 0 ? (o.weight === 'cap' ? r.cap / denom : 1 / denom) : 0,
  }));
}

/**
 * 재무 point-in-time 색인.
 *
 * 분기 실적은 결산월이 지나야 공시된다. 결산월에 바로 알 수 있다고 가정하면
 * **미래 정보를 쓰는 것**(lookahead)이고 백테스트가 부풀려진다.
 * 규칙: 분기말 + 45일, 연말(12월 결산)은 + 90일 후부터 사용 가능.
 * (scripts/strategy-search.js가 쓰던 규칙을 여기로 올렸다 — 실운용과 백테스트가
 *  다른 지연을 쓰면 성과가 비교 불가능해진다)
 *
 * @param {Array} rows [{stock_code|code, stac_yymm|ym, bps, eps, roe}]
 * @returns {{bpsAt:Function, epsAt:Function, roeAt:Function, size:number}}
 */
function buildFinancialIndex(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const code = r.stock_code || r.code;
    const ym = String(r.stac_yymm || r.ym || '');
    if (!code || ym.length !== 6) continue;
    const y = +ym.slice(0, 4), m = +ym.slice(4, 6);
    const end = new Date(Date.UTC(y, m, 0));                       // 그 달의 말일
    const lagDays = (m === 12 ? 90 : 45);
    const avail = new Date(end.getTime() + lagDays * 864e5).toISOString().slice(0, 10);
    if (!by.has(code)) by.set(code, []);
    by.get(code).push({ avail, bps: r.bps, eps: r.eps, roe: r.roe == null ? null : +r.roe });
  }
  for (const a of by.values()) a.sort((x, y2) => x.avail.localeCompare(y2.avail));

  const at = (code, dateIso) => {
    const a = by.get(code);
    if (!a) return null;
    let lo = 0, hi = a.length - 1, best = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m].avail <= dateIso) { best = a[m]; lo = m + 1; } else hi = m - 1;
    }
    return best;
  };
  return {
    size: by.size,
    bpsAt: (c, d) => { const f = at(c, d); return f && f.bps > 0 ? f.bps : null; },
    epsAt: (c, d) => { const f = at(c, d); return f && f.eps > 0 ? f.eps : null; },
    roeAt: (c, d) => { const f = at(c, d); return f && f.roe != null && isFinite(f.roe) ? f.roe : null; },
  };
}

/**
 * 벤치마크: KOSPI 보통주 시총가중 매수후보유 수익(%) — 지정 종목 제외.
 *   d0 시총 가중 × (d1 종가 / d0 종가). 구간이 리밸런싱 1회(약 20거래일)라 편입 변동은 무시한다.
 *   일간 가격제한(±30%)을 넘는 비율이 나오면 액면분할·병합 이음매로 보고 시총 비율로 대체한다.
 * @param {Array} rows0 [{stock_code, close, cap}] d0
 * @param {Array} rows1 [{stock_code, close, cap}] d1
 * @param {Set} kospiCodes  KOSPI 소속 코드
 */
function capWeightedReturn(rows0, rows1, kospiCodes, exclude = []) {
  const ex = new Set(exclude);
  const m1 = new Map(rows1.map(r => [r.stock_code, r]));
  let w = 0, x = 0;
  for (const a of rows0) {
    if (!kospiCodes.has(a.stock_code) || ex.has(a.stock_code) || !/0$/.test(a.stock_code)) continue;
    const b = m1.get(a.stock_code);
    if (!b || !(a.close > 0) || !(b.close > 0) || !(a.cap > 0)) continue;
    let r = b.close / a.close;
    if ((r > 3 || r < 1 / 3) && b.cap > 0) r = b.cap / a.cap;
    w += a.cap; x += a.cap * r;
  }
  return w > 0 ? (x / w - 1) * 100 : null;
}

module.exports = { DEFAULTS, STRATEGIES, MEGA, FACTORS, capWeightedReturn, buildUniverse, selectPicks, buildFinancialIndex, avg, sd };
