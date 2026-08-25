/**
 * direction-signal-battery.js — "방향 예측"이 가능한 신호가 있는가
 *
 * 배경(2026-08-19 gainer-consistency-scan): 현행 거래량 신호는 **변동성 예측**이었다.
 *   D-1 거래량top30 → 다음날 +5%↑ 확률 ×1.7 / −5%↓ 확률 ×3.2, 중앙값 −1.91%.
 *   우측꼬리를 사는 대가로 좌측꼬리를 두 배 더 산다 = 방향 정보 없음.
 *
 * 그래서 이 스크립트는 후보 신호들을 **방향성 기준**으로만 줄 세운다.
 *   방향성 = ① 매칭초과 **중앙값**(평균은 꼬리가 끌고 감) ② 초과 승률
 *            ③ 꼬리대칭비 P(초과≥+5%)/P(초과≤−5%)  ← 1보다 크면 오른쪽으로 기운 분포
 *   변동성 신호는 ①②가 0 근처인데 ③의 분자·분모가 동시에 커진다. 그걸 분리하는 게 목적.
 *
 * 규약(기존 스크립트와 통일):
 *   - 평가는 **"매일 상위 K종목 매수"** 실행 규칙으로만. 슬라이스 통계는 허위양성을 만든다.
 *   - 주 지표는 동일일·동일 시총5분위 **매칭 초과수익**(절대수익은 사이즈 베타).
 *   - 전방참조 없음: 모든 신호는 신호일 i 종가까지의 데이터만, 매수는 i+1.
 *   - 전·후반 절반 부호 유지 여부를 같이 출력(다중검정 방어). 독립블록<3이면 판정 거부.
 *   - 유동성 하한: 시총 ≥ CAPMIN, 20일 평균 거래대금(≈close×volume) ≥ VALMIN.
 *
 * --set=fundamental (2026-08-20 추가): 재무지표 축.
 *   배경: 2026-08-08 전 시장 스캔 = "고칠 곳은 지표가 아니라 풀 구성". 방어 대형주가
 *   하락장에도 플러스였는데 거래량 깔때기가 못 봤다. 가치·퀄리티가 그 집합을 복원하나?
 *   데이터: data/financials.json (scripts/collect-financials.js, KIS FHKST66430300 분기).
 *   ⚠️ 전방참조 방지: 결산년월(stac_yymm) 기말 + 공시시차(연간 90일 / 분기 45일)가
 *      지난 뒤에만 그 분기 값을 쓴다. FIN_LAG_* 상수로 조정.
 *   ⚠️ EPS/ROE는 KIS 표기 관례(누적/TTM)가 분기마다 흔들려 절대수준 해석 금지.
 *      이 배터리는 **동일 결산년월 내 횡단면 순위**로만 쓰므로 관례는 상쇄된다.
 *      BPS·부채비율은 잔액 기준이라 관례 문제가 없다 → 저PBR·저부채가 1차 지표.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const fs = require('fs');
const FIN_PATH = require('path').resolve(__dirname, '../data/financials.json');
const FIN_LAG_ANNUAL = 90; // 12월 결산 사업보고서 공시 시한(일)
const FIN_LAG_QUARTER = 45; // 분기·반기 보고서 공시 시한(일)
const PAGE = 1000;
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10);
const K = arg('k', 20);
// 매수 시점: close(기본, 매수일 종가) | open(매수일 시가 — 갭 신호의 낙관 상한)
const BUYAT = (process.argv.find(s => s.startsWith('--buy=')) || '').split('=')[1] || 'close';
// 매수일 오프셋(신호일 = D+0). **active_policy를 따라야 한다** — 2026-08-23 자동 변경으로
// 현행 정책은 D+2 매수 → D+10 매도다. 기본값 1은 과거 분석(D+1 매수)과의 호환용일 뿐이므로,
// 결론을 운영에 연결할 때는 반드시 --buyoffset을 현행 정책에 맞춰 재실행할 것.
const BUY = arg('buyoffset', 1);
if (!(BUY >= 1 && BUY < SELL)) { console.error(`❌ --buyoffset(${BUY})은 1 이상이고 --sell(${SELL})보다 작아야 함`); process.exit(1); }
const LOOK = arg('look', 20);
const CAPMIN = arg('capmin', 3000) * 1e8;      // 기본 3000억
const VALMIN = arg('valmin', 10) * 1e8;        // 기본 일평균 거래대금 10억
const MIN_UNIVERSE = 2000;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sgn = v => (v == null ? '     -' : ((v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) + '%').padStart(8));

async function fetchAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

(async () => {
  console.log(`\n🧭 방향성 신호 배터리 — 매일 상위 ${K}종목 매수(D+${BUY} ${BUYAT === 'open' ? '시가' : '종가'}) → D+${SELL} 매도`);
  console.log(`   유동성 하한: 시총 ${(CAPMIN / 1e8).toLocaleString()}억+ / 일평균 거래대금 ${(VALMIN / 1e8).toLocaleString()}억+\n`);

  const flow = await fetchAll('market_flow_daily',
    'stock_code,trade_date,open,high,low,close,volume,market_cap,sector_name,inst_net_value,frgn_net_value,prsn_net_value');

  const byDate = new Map();
  for (const r of flow) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []);
    byDate.get(r.trade_date).push(r);
  }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();
  for (const r of flow) {
    if (!dayIdx.has(r.trade_date)) continue;
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, r);
  }
  console.log(`데이터: ${days.length}거래일 × ${px.size}종목 (${days[0]} ~ ${days[days.length - 1]})`);

  // ── 재무 point-in-time 색인 (결산년월 + 공시시차 이후에만 사용 가능) ──
  const finByCode = new Map(); // code -> [{avail:'YYYY-MM-DD', ...}] (avail 오름차순)
  if (fs.existsSync(FIN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(FIN_PATH, 'utf-8'));
    const byCode = new Map();
    for (const r of raw.rows) {
      if (!byCode.has(r.code)) byCode.set(r.code, new Map());
      byCode.get(r.code).set(r.ym, r);
    }
    for (const [code, m] of byCode) {
      const yms = [...m.keys()].sort();
      const arr = [];
      for (let k = 0; k < yms.length; k++) {
        const r = m.get(yms[k]);
        const y = +r.ym.slice(0, 4), mo = +r.ym.slice(4, 6);
        const end = new Date(Date.UTC(y, mo, 0));                   // 결산 기말일
        const lag = (mo === 12 ? FIN_LAG_ANNUAL : FIN_LAG_QUARTER);
        const avail = new Date(end.getTime() + lag * 864e5).toISOString().slice(0, 10);

        // ── flow(전년동기대비) 파생 ──────────────────────────────────
        // 같은 분기위치(YYYY-1, 같은 월)와 비교해야 KIS의 누적/TTM 표기 관례가 상쇄된다.
        const py = m.get(String(y - 1) + r.ym.slice(4));
        const pq = k > 0 ? m.get(yms[k - 1]) : null;
        // KIS는 적자/흑전/적전을 증가율 0으로 표기 → 0은 결측으로 취급해야 한다.
        // (SK하이닉스 202403~202412 opInc가 전부 0. 흑자전환 구간이 통째로 0에 묻힘)
        const gz = (v) => (v == null || v === 0 ? null : v);
        arr.push({
          avail, ym: r.ym, roe: r.roe, eps: r.eps, bps: r.bps, debt: r.debt,
          grs: gz(r.grs), opInc: gz(r.opInc), niInc: gz(r.niInc),
          // 이익 개선의 "주가 대비 크기" — 증가율(%)이 아니라 절대 개선폭을 주가로 나눈다.
          // 증가율 랭킹은 전년 기저가 0에 가까운 종목만 뽑는 기저효과 셀렉터가 된다.
          dEps: (py && r.eps != null && py.eps != null) ? (r.eps - py.eps) : null,
          dSps: (py && r.sps != null && py.sps != null) ? (r.sps - py.sps) : null,
          roeChg: (py && r.roe != null && py.roe != null) ? (r.roe - py.roe) : null,
          debtChg: (py && r.debt != null && py.debt != null) ? (r.debt - py.debt) : null,
          turn: (py && py.eps != null && r.eps != null && py.eps <= 0 && r.eps > 0) ? 1 : 0, // 흑자전환
          // 가속: 이번 분기 증가율 − 직전 분기 증가율 (2차 미분)
          opAccel: (pq && gz(r.opInc) != null && gz(pq.opInc) != null) ? (r.opInc - pq.opInc) : null,
        });
      }
      arr.sort((a, b) => a.avail.localeCompare(b.avail));
      finByCode.set(code, arr);
    }
    console.log(`재무: ${finByCode.size}종목 (data/financials.json, 공시시차 연 ${FIN_LAG_ANNUAL}일 / 분기 ${FIN_LAG_QUARTER}일 적용)`);
  }
  const finAt = (c, date) => {
    const arr = finByCode.get(c); if (!arr) return null;
    let lo = 0, hi = arr.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].avail <= date) { best = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  };

  const at = (c, i) => (i >= 0 && i < days.length ? px.get(c)?.get(days[i]) : null);
  // 매수가는 BUYAT로 갈린다. --buy=open은 "i+1 시가를 보고 그 시가에 체결"을 가정하므로
  // 실행 가능성 상한(낙관)이다. 기본값 close는 시가 확인 후 종가 매수 = 실제로 가능한 실행.
  const buyPx = (b) => (BUYAT === 'open' ? (b?.open ?? b?.close) : b?.close);
  const fwd = (c, i) => { const b = at(c, i + BUY), s = at(c, i + SELL); const bp = buyPx(b); return (bp && s?.close) ? ((s.close - bp) / bp) * 100 : null; };

  // ── 지표 사전계산 (신호일 i 기준, i까지의 데이터만 사용) ──────────────
  const feat = new Map(); // `${i}|${code}` -> {...}
  const eligible = new Map(); // i -> [code]
  for (let i = LOOK + 5; i < days.length; i++) {
    const list = [];
    for (const r of byDate.get(days[i])) {
      const c = r.stock_code;
      if (!r.close || !r.market_cap || r.market_cap < CAPMIN) continue;

      const closes = [], vols = [], rets = [];
      let ok = true;
      for (let k = LOOK; k >= 0; k--) {
        const p = at(c, i - k);
        if (!p?.close) { ok = false; break; }
        closes.push(p.close); vols.push(p.volume ?? 0);
      }
      if (!ok) continue;
      for (let k = 1; k < closes.length; k++) rets.push(((closes[k] - closes[k - 1]) / closes[k - 1]) * 100);

      const val20 = avg(closes.slice(-LOOK).map((cl, k) => cl * vols.slice(-LOOK)[k]));
      if (!(val20 >= VALMIN)) continue;

      const vol20 = sd(rets);
      const ma20 = avg(closes.slice(-LOOK));
      const disparity = (r.close / ma20) * 100;
      const mom20 = ((r.close - closes[0]) / closes[0]) * 100;
      const volRatio = vols[vols.length - 1] / (avg(vols.slice(0, -1)) || 1);

      // 거래량의 "부호" 복원용 지표들
      //  - netShare: 5일 (기관+외인) 순매수대금 / 5일 거래대금 = 부호 붙은 거래량 비중
      //  - closePos: 종가의 일중 위치 (고가권=매수우위 근사, 저가권=매도우위 근사)
      let val5 = 0;
      for (let k = 0; k < 5 && i - k >= 0; k++) { const p = at(c, i - k); if (p?.close && p?.volume) val5 += p.close * p.volume; }
      const closePos = (r.high != null && r.low != null && r.high > r.low)
        ? (r.close - r.low) / (r.high - r.low) : null;

      let instStreak = 0, frgnStreak = 0, inst5 = 0, frgn5 = 0;
      for (let k = 0; k < 10 && i - k >= 0; k++) { const p = at(c, i - k); if (!p || (p.inst_net_value ?? 0) <= 0) break; instStreak++; }
      for (let k = 0; k < 10 && i - k >= 0; k++) { const p = at(c, i - k); if (!p || (p.frgn_net_value ?? 0) <= 0) break; frgnStreak++; }
      for (let k = 0; k < 5 && i - k >= 0; k++) { const p = at(c, i - k); if (!p) continue; inst5 += (p.inst_net_value ?? 0); frgn5 += (p.frgn_net_value ?? 0); }

      // 외국인 전용 파생 (단위: 순매수대금 백만원 → 원)
      let frgn20 = 0, frgnPrior15 = 0, frgnDays20 = 0, prsn5 = 0, val20sum = 0;
      for (let k = 0; k < LOOK && i - k >= 0; k++) {
        const p = at(c, i - k); if (!p) continue;
        const fv = p.frgn_net_value ?? 0;
        frgn20 += fv; if (fv > 0) frgnDays20++;
        if (k >= 5) frgnPrior15 += fv;
        if (p.close && p.volume) val20sum += p.close * p.volume;
      }
      for (let k = 0; k < 5 && i - k >= 0; k++) { const p = at(c, i - k); if (p) prsn5 += (p.prsn_net_value ?? 0); }
      // 순매수 대금 단위 백만원 → 원
      const netRatio = ((inst5 + frgn5) * 1e6) / r.market_cap * 100;

      const netShare = val5 > 0 ? ((inst5 + frgn5) * 1e6) / val5 * 100 : null;

      // ── 눌림/갭 피처 (--set=gap) ──────────────────────────────────────
      // dry5: 직전 5일 평균거래량 / 그 앞 15일 평균 = 거래량이 마른 정도(<1이면 마름)
      // ret5: 5일 수익률(%), pbDepth: 20일 종가고점 대비 하락폭(%), gapNext: i+1 시가 갭(%)
      // ⚠️ gapNext만 i+1 정보를 쓴다. 매수가 i+1 종가이므로 전방참조가 아니지만,
      //    --buy=open과 함께 쓰면 "관측 즉시 체결" 가정이 되니 상한으로만 읽을 것.
      const v5 = avg(vols.slice(-5)), vPrior = avg(vols.slice(0, -5));
      const dry5 = (vPrior > 0) ? v5 / vPrior : null;
      const ret5 = closes.length >= 6
        ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
      const hi20 = Math.max(...closes);
      const pbDepth = hi20 > 0 ? ((hi20 - r.close) / hi20) * 100 : null;
      const nx = at(c, i + 1);
      const gapNext = (nx?.open && r.close) ? ((nx.open - r.close) / r.close) * 100 : null;

      feat.set(`${i}|${c}`, {
        vol20, disparity, mom20, volRatio, instStreak, frgnStreak, netRatio,
        dry5, ret5, pbDepth, gapNext,
        netShare, closePos, net5: (inst5 + frgn5) * 1e6,
        cap: r.market_cap, sector: r.sector_name,
        // 외국인 전용
        fCapRatio: (frgn5 * 1e6) / r.market_cap * 100,          // 5일 외인 순매수 / 시총
        fValShare: val5 > 0 ? (frgn5 * 1e6) / val5 * 100 : null, // 5일 외인 순매수 / 거래대금
        f20CapRatio: (frgn20 * 1e6) / r.market_cap * 100,        // 20일 외인 순매수 / 시총
        fDays20: frgnDays20,                                     // 20일 중 외인 순매수일 수
        fTurn: (frgnPrior15 <= 0 && frgn5 > 0) ? (frgn5 * 1e6) / r.market_cap * 100 : null, // 매도→매수 전환
        fInstDiv: (frgn5 > 0 && inst5 < 0) ? (frgn5 * 1e6) / r.market_cap * 100 : null,     // 외인 매수 & 기관 매도
        fOnly: (frgn5 > 0 && prsn5 < 0) ? (frgn5 * 1e6) / r.market_cap * 100 : null,        // 외인 매수 & 개인 매도
        fAccel: ((frgn5 / 5) - (frgn20 / LOOK)) * 1e6 / r.market_cap * 100,                 // 매수 가속도
        // 재무 (신호일 시점에 공시된 최신 분기만; 없으면 null → 해당 신호에서 자동 제외)
        ...(() => {
          const fin = finAt(c, days[i]);
          if (!fin) return { pbr: null, per: null, roe: null, debt: null, grs: null, opInc: null, finYm: null,
                             niInc: null, epsYield: null, spsYield: null, roeChg: null, debtChg: null, turn: null, opAccel: null };
          return {
            pbr: fin.bps > 0 ? r.close / fin.bps : null,   // 주가순자산비율 (BPS는 잔액 → 관례 안전)
            per: fin.eps > 0 ? r.close / fin.eps : null,   // 흑자기업만 (적자는 null)
            roe: fin.roe, debt: fin.debt, grs: fin.grs, opInc: fin.opInc, niInc: fin.niInc, finYm: fin.ym,
            // flow를 주가로 스케일 — 기저효과 면역. 단위: %p of price
            epsYield: fin.dEps != null ? (fin.dEps / r.close) * 100 : null,   // 전년동기대비 EPS 개선 / 주가
            spsYield: fin.dSps != null ? (fin.dSps / r.close) * 100 : null,   // 전년동기대비 SPS 개선 / 주가
            roeChg: fin.roeChg, debtChg: fin.debtChg, turn: fin.turn, opAccel: fin.opAccel,
          };
        })(),
      });
      list.push(c);
    }
    eligible.set(i, list);
  }

  // ── 시총 5분위 매칭 기준(유니버스 전체 기준으로 계산) ─────────────────
  const capQ = new Map(), qMean = new Map();
  for (let i = 0; i < days.length; i++) {
    const rows = byDate.get(days[i]).filter(r => r.market_cap && r.close);
    const sorted = [...rows].sort((a, b) => a.market_cap - b.market_cap);
    sorted.forEach((r, k) => capQ.set(`${i}|${r.stock_code}`, Math.min(4, Math.floor((k / sorted.length) * 5))));
    const buckets = [[], [], [], [], []];
    for (const r of sorted) { const f = fwd(r.stock_code, i); if (f != null) buckets[capQ.get(`${i}|${r.stock_code}`)].push(f); }
    qMean.set(i, buckets.map(b => (b.length >= 20 ? avg(b) : null)));
  }
  const excess = (c, i) => {
    const f = fwd(c, i); if (f == null) return null;
    const q = capQ.get(`${i}|${c}`); if (q == null) return null;
    const m = qMean.get(i)?.[q]; return m == null ? null : f - m;
  };

  // ── 신호 정의 (score 높을수록 매수) ──────────────────────────────────
  const cap300 = new Map(); // i -> Set(시총 상위 300)
  for (let i = 0; i < days.length; i++) {
    cap300.set(i, new Set(byDate.get(days[i]).filter(r => r.market_cap)
      .sort((a, b) => b.market_cap - a.market_cap).slice(0, 300).map(r => r.stock_code)));
  }

  // 저변동성 상위30% 집합 (유동성 통과 종목 기준)
  const loVolSet = new Map();
  for (const [i, list] of eligible) {
    const scored = list.map(c => [c, feat.get(`${i}|${c}`)?.vol20]).filter(x => x[1] != null);
    scored.sort((a, b) => a[1] - b[1]);
    loVolSet.set(i, new Set(scored.slice(0, Math.ceil(scored.length * 0.3)).map(x => x[0])));
  }

  const SIGNALS = [
    ['기준선: 유니버스 전체', null],
    ['저변동성 (20일 σ 하위)', (f) => -f.vol20],
    ['저변동성 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) ? -f.vol20 : null)],
    ['기관 연속순매수일', (f) => f.instStreak],
    ['외인 연속순매수일', (f) => f.frgnStreak],
    ['5일 순매수대금/시총', (f) => f.netRatio],
    ['★조용한 매집 (순매수↑ & 거래량비≤1)', (f) => (f.volRatio <= 1 && f.netRatio > 0 ? f.netRatio : null)],
    ['거래량 조용 (거래량비 하위)', (f) => -f.volRatio],
    ['거래량 급증 (거래량비 상위) = 현행', (f) => f.volRatio],
    ['이격도 하위 (평균회귀)', (f) => -f.disparity],
    ['20일 모멘텀 상위 (추세추종)', (f) => f.mom20],
    ['20일 모멘텀 하위 (역추세)', (f) => -f.mom20],
    ['대형주 (시총 상위)', (f) => f.cap],

    // ── 사용자 가설 검정: "거래량이 매수/매도 합산이라 방향이 없다" ──
    // 같은 거래량 급증을 부호로 갈랐을 때 성과가 갈리면 가설 지지,
    // 안 갈리면 급증 자체에 복원 가능한 방향 정보가 없다는 뜻.
    ['[부호] 거래량급증 & 순매수(+)', (f) => (f.volRatio >= 2 && f.net5 > 0 ? f.volRatio : null)],
    ['[부호] 거래량급증 & 순매도(−)', (f) => (f.volRatio >= 2 && f.net5 < 0 ? f.volRatio : null)],
    ['[부호] 거래량급증 & 종가 고가권≥0.7', (f) => (f.volRatio >= 2 && f.closePos >= 0.7 ? f.volRatio : null)],
    ['[부호] 거래량급증 & 종가 저가권≤0.3', (f) => (f.volRatio >= 2 && f.closePos <= 0.3 ? f.volRatio : null)],
    ['[부호] 순매수/거래대금 비중 상위', (f) => f.netShare],
    ['[부호] 순매수/거래대금 비중 하위', (f) => (f.netShare == null ? null : -f.netShare)],
    ['[부호] 종가 고가권 (일중 매수우위)', (f) => f.closePos],
  ];

  // 외국인 수급 전용 세트 (--set=foreign). 기관/개인 대비, 전환·가속·다이버전스까지.
  const FOREIGN = [
    ['기준선: 유니버스 전체', null],
    ['외인 5일 순매수/시총 상위', (f) => f.fCapRatio],
    ['외인 5일 순매수/거래대금 상위', (f) => f.fValShare],
    ['외인 20일 순매수/시총 상위', (f) => f.f20CapRatio],
    ['외인 20일 중 순매수일수 상위', (f) => f.fDays20],
    ['외인 연속순매수일 상위', (f) => f.frgnStreak],
    ['외인 매수 가속 (5일 - 20일 평균)', (f) => f.fAccel],
    ['외인 매도→매수 전환', (f) => f.fTurn],
    ['외인 매수 & 기관 매도 (다이버전스)', (f) => f.fInstDiv],
    ['외인 매수 & 개인 매도', (f) => f.fOnly],
    ['외인 순매수 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) ? f.fCapRatio : null)],
    ['외인 순매수 ∩ 저변동성 상위30%', (f, c, i) => (loVolSet.get(i)?.has(c) ? f.fCapRatio : null)],
    ['── 반대 방향 대조군 ──', null],
    ['외인 5일 순매도 상위 (역)', (f) => -f.fCapRatio],
    ['외인 5일 순매도/거래대금 (역)', (f) => (f.fValShare == null ? null : -f.fValShare)],
    ['외인 20일 순매도 상위 (역)', (f) => -f.f20CapRatio],
    ['외인 매도 가속 (역)', (f) => -f.fAccel],
  ];

  // 재무지표 세트 (--set=fundamental). **사전 등록** — 다중검정 방어를 위해 늘리지 말 것.
  // 1차 지표는 관례 안전한 PBR·부채비율. ROE/PER은 동일 결산년월 내 횡단면 순위로만 읽는다.
  const FUNDAMENTAL = [
    ['기준선: 유니버스 전체', null],
    ['저PBR (주가/BPS 하위)', (f) => (f.pbr > 0 ? -f.pbr : null)],
    ['저부채 (부채비율 하위)', (f) => (f.debt == null ? null : -f.debt)],
    ['고ROE', (f) => f.roe],
    ['저PER (흑자기업만)', (f) => (f.per > 0 ? -f.per : null)],
    ['★퀄리티 (ROE상위 ∩ 부채≤100%)', (f) => (f.debt != null && f.debt <= 100 ? f.roe : null)],
    ['★가치+퀄리티 (저PBR ∩ ROE>0 ∩ 부채≤100%)', (f) => (f.pbr > 0 && f.roe > 0 && f.debt != null && f.debt <= 100 ? -f.pbr : null)],
    ['영업이익 성장 상위', (f) => f.opInc],
    ['── 기존 축과의 중복 확인 (증분 기여) ──', null],
    ['저변동성 ∩ 시총상위300 (기존 후보)', (f, c, i) => (cap300.get(i).has(c) ? -f.vol20 : null)],
    ['저PBR ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) && f.pbr > 0 ? -f.pbr : null)],
    ['저PBR ∩ 저변동성 상위30%', (f, c, i) => (loVolSet.get(i)?.has(c) && f.pbr > 0 ? -f.pbr : null)],
    ['퀄리티 ∩ 저변동성 상위30%', (f, c, i) => (loVolSet.get(i)?.has(c) && f.debt != null && f.debt <= 100 ? f.roe : null)],
    ['── 반대 방향 대조군 ──', null],
    ['고PBR (역)', (f) => f.pbr],
    ['고부채 (역)', (f) => f.debt],
    ['저ROE (역)', (f) => (f.roe == null ? null : -f.roe)],
  ];

  // flow(전년동기대비 이익 증가) 세트 (--set=flow). **사전 등록** — 늘리지 말 것.
  // 배경: --set=fundamental의 '영업이익 성장 상위'가 최하위였는데, 그 테스트엔 결함 2개가 있다.
  //   ① KIS는 적자/흑전/적전 증가율을 0으로 표기 → 최대 개선(흑자전환)이 통째로 0에 묻힌다.
  //   ② 증가율(%) 랭킹은 전년 기저가 0에 가까운 종목만 뽑는 **기저효과 셀렉터**다
  //      (삼성전자 202603 opInc +756%, 202406 +1,202%).
  // 그래서 여기서는 0을 결측 처리하고, 증가율 대신 **주가로 스케일한 개선폭**을 1차 지표로 둔다.
  const FLOW = [
    ['기준선: 유니버스 전체', null],
    ['── 증가율(%) 랭킹 — 기저효과 노출 ──', null],
    ['영업이익 증가율 상위 (0=결측 처리)', (f) => f.opInc],
    ['매출액 증가율 상위', (f) => f.grs],
    ['순이익 증가율 상위', (f) => f.niInc],
    ['── 주가 스케일 개선폭 — 기저효과 면역 ──', null],
    ['★ΔEPS/주가 상위 (이익수익률 개선)', (f) => f.epsYield],
    ['★ΔSPS/주가 상위 (매출수익률 개선)', (f) => f.spsYield],
    ['ROE 개선폭 상위 (전년동기대비 %p)', (f) => f.roeChg],
    ['부채비율 개선폭 상위 (감소)', (f) => (f.debtChg == null ? null : -f.debtChg)],
    ['흑자전환 (전년동기 적자→흑자)', (f) => (f.turn === 1 ? (f.epsYield ?? 0) : null)],
    ['영업이익 증가율 가속 (2차 미분)', (f) => f.opAccel],
    ['── 조합 / 기존 축과의 중복 확인 ──', null],
    ['★저PBR ∩ ΔEPS>0 (싼데 좋아지는 중)', (f) => (f.pbr > 0 && f.epsYield > 0 ? -f.pbr : null)],
    ['ΔEPS/주가 ∩ 시총상위300', (f, c, i) => (cap300.get(i).has(c) ? f.epsYield : null)],
    // ↑가 좋아 보이면 반드시 ↓와 비교할 것. 차이가 없으면 공(功)은 시총상위300 필터의 것.
    // ⚠️ f.cap으로 정렬하면 '시총 최상위 20개'라는 또 다른 베팅이 된다. 중립 통제를 위해
    //    종목코드+날짜 해시로 cap300 안에서 임의 20개를 뽑는다(결정적·재현 가능).
    ['[통제] 시총상위300 중 임의 20', (f, c, i) => {
      if (!cap300.get(i).has(c)) return null;
      let h = i * 2654435761;
      for (let k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0;
      return (h % 100000) / 100000;
    }],
    ['[통제] 시총 최상위 20 (메가캡)', (f, c, i) => (cap300.get(i).has(c) ? f.cap : null)],
    ['ΔEPS/주가 ∩ 저변동성 상위30%', (f, c, i) => (loVolSet.get(i)?.has(c) ? f.epsYield : null)],
    ['저변동성 ∩ 시총상위300 (기존 후보)', (f, c, i) => (cap300.get(i).has(c) ? -f.vol20 : null)],
    // 증분 기여 단일 검정: 기존 후보에 flow 조건을 얹었을 때 개선되는가 (조합은 이 한 줄만)
    ['저변동성 ∩ 시총상위300 ∩ ΔEPS>0', (f, c, i) => (cap300.get(i).has(c) && f.epsYield > 0 ? -f.vol20 : null)],
    ['── 반대 방향 대조군 ──', null],
    ['ΔEPS/주가 하위 (역)', (f) => (f.epsYield == null ? null : -f.epsYield)],
    ['영업이익 증가율 하위 (역)', (f) => (f.opInc == null ? null : -f.opInc)],
    ['ROE 악화폭 상위 (역)', (f) => (f.roeChg == null ? null : -f.roeChg)],
  ];

  // "저거래량 눌림 + 갭상승" 세트 (--set=gap). **사전 등록** — 늘리지 말 것.
  // 배경(2026-08-24): 한미약품이 8/21 거래량 1.51x·+4.14%로 5개 랭킹 어디에도 안 걸린 채
  //   8/24 상한가. 사후 1건은 근거가 못 되므로 "조용히 마른 뒤 갭상승"을 전 표본에서 검정한다.
  // ⚠️ 이 축은 시가(open)가 필요해 market_flow_daily(≈60거래일)만 쓸 수 있다.
  //    price-history.jsonl은 [날짜,종가,거래량,거래대금]뿐이라 소급 확장 불가 → 표본이
  //    구조적으로 작다. 블록 확보를 위해 --sell=2 권장, D+10은 판정 불가일 것.
  const dryOK = (f, t) => f.dry5 != null && f.dry5 <= t;
  const GAP = [
    ['기준선: 유니버스 전체', null],
    ['[통제] 시총상위300 중 임의 20', (f, c, i) => {
      if (!cap300.get(i).has(c)) return null;
      let h = i * 2654435761;
      for (let k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0;
      return (h % 100000) / 100000;
    }],
    ['── 눌림 단독 (갭 조건 없음 = 순수 사전신호) ──', null],
    ['눌림 엄격 (마름 & 5일↓ & 이격≤100)', (f) => (dryOK(f, 0.8) && f.ret5 <= 0 && f.disparity <= 100 ? -f.dry5 : null)],
    ['조용 완화 (거래량 마름만)', (f) => (dryOK(f, 0.8) ? -f.dry5 : null)],
    ['고점근접 조용 (마름 & 고점-5% 내)', (f) => (dryOK(f, 0.8) && f.pbDepth <= 5 ? -f.dry5 : null)],
    ['── 갭상승 단독 ──', null],
    ['갭상승 ≥2% (i+1 시가)', (f) => (f.gapNext >= 2 ? f.gapNext : null)],
    ['갭상승 ≥5%', (f) => (f.gapNext >= 5 ? f.gapNext : null)],
    ['── ★교집합: 저거래량 눌림 + 갭상승 ──', null],
    ['★눌림 엄격 ∩ 갭≥2%', (f) => (dryOK(f, 0.8) && f.ret5 <= 0 && f.disparity <= 100 && f.gapNext >= 2 ? f.gapNext : null)],
    ['★조용 완화 ∩ 갭≥2%', (f) => (dryOK(f, 0.8) && f.gapNext >= 2 ? f.gapNext : null)],
    ['★조용 완화 ∩ 갭≥5%', (f) => (dryOK(f, 0.8) && f.gapNext >= 5 ? f.gapNext : null)],
    ['★고점근접 조용 ∩ 갭≥2% (한미형)', (f) => (dryOK(f, 0.8) && f.pbDepth <= 5 && f.gapNext >= 2 ? f.gapNext : null)],
    ['── 대조군 ──', null],
    ['고거래량(안 마름) ∩ 갭≥2%', (f) => (f.dry5 != null && f.dry5 >= 1.5 && f.gapNext >= 2 ? f.gapNext : null)],
    ['조용 ∩ 갭하락 ≤−2% (역)', (f) => (dryOK(f, 0.8) && f.gapNext <= -2 ? -f.gapNext : null)],
  ];

  const SET = (process.argv.find(s => s.startsWith('--set=')) || '').split('=')[1] || 'core';
  const ACTIVE = SET === 'foreign' ? FOREIGN : SET === 'fundamental' ? FUNDAMENTAL
    : SET === 'flow' ? FLOW : SET === 'gap' ? GAP : SIGNALS;

  const half = Math.floor((days.length) / 2);
  const rows = [];
  for (const [name, fn] of ACTIVE) {
    if (name.startsWith('──')) { rows.push({ sep: name }); continue; }
    const ex = [], exA = [], exB = [];
    for (let i = LOOK + 5; i + SELL < days.length; i++) {
      const list = eligible.get(i) || [];
      let picks;
      if (fn == null) {
        picks = list; // 기준선: 유니버스 전체 균등
      } else {
        const scored = [];
        for (const c of list) {
          const f = feat.get(`${i}|${c}`); if (!f) continue;
          const s = fn(f, c, i); if (s == null || !isFinite(s)) continue;
          scored.push([c, s]);
        }
        picks = scored.sort((a, b) => b[1] - a[1]).slice(0, K).map(x => x[0]);
      }
      for (const c of picks) {
        const e = excess(c, i); if (e == null) continue;
        ex.push(e); (i < half ? exA : exB).push(e);
      }
    }
    if (ex.length < 30) continue;
    const up = ex.filter(v => v >= 5).length, dn = ex.filter(v => v <= -5).length;
    rows.push({
      name, n: ex.length, mean: avg(ex), median: med(ex), win: winR(ex),
      tail: dn ? up / dn : null,
      a: avg(exA), b: avg(exB),
      stable: exA.length && exB.length && Math.sign(avg(exA)) === Math.sign(avg(exB)) && avg(exA) > 0
    });
  }

  console.log('\n  신호 (매일 상위' + K + '종목)                    |    n  | 초과평균 | ★초과중앙 | 초과승률 | 꼬리비 | 전반→후반      | 안정');
  console.log('  ' + '-'.repeat(118));
  const base = rows[0];
  for (const r of rows) {
    if (r.sep) { console.log(`  ${r.sep}`); continue; }
    console.log(`  ${r.name.padEnd(36)} | ${String(r.n).padStart(5)} | ${sgn(r.mean)} | ${sgn(r.median)} | ${r.win.toFixed(0).padStart(6)}% | ${(r.tail == null ? '  -' : r.tail.toFixed(2)).padStart(5)} | ${sgn(r.a)}→${sgn(r.b)} | ${r.stable ? ' ✅' : ''}`);
  }
  console.log('\n  · 초과중앙 = 동일일·동일 시총5분위 대비 초과수익 중앙값 (방향성의 주 지표)');
  console.log('  · 꼬리비 = P(초과≥+5%)/P(초과≤−5%). 1 미만이면 왼쪽 꼬리가 두꺼움(=현행 거래량 신호의 병)');
  console.log(`  · 기준선(유니버스 전체) 초과중앙 ${sgn(base.median)} — 각 행은 이 값과 비교해서 읽을 것`);

  const signalDays = days.length - LOOK - 5 - SELL;
  console.log(`\n독립블록 ≈ ${(signalDays / SELL).toFixed(1)} (신호일 ${signalDays}일 / 보유 ${SELL}일). 3 미만이면 판정 금지.`);
  console.log('한계: 전 표본 단일 하락 레짐. 거래비용·슬리피지 미반영. 신호 13개 동시검정 → 상위 1~2개는 우연일 수 있음.\n');
})().catch(e => { console.error(e); process.exit(1); });
