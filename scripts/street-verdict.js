/**
 * 월가 시각 채점 (사전 등록: STREET_VERDICT.md). 기준은 이 파일과 backend/streetViews.js 의 PRICE 표가 정본이다.
 *
 *   node scripts/street-verdict.js --power     # 기준 시험 ①: 대상별 변동성 → 표본 30 묶음에서 검출 가능한 최소 효과
 *   node scripts/street-verdict.js --placebo   # 기준 시험 ②③: 무작위 날짜(효과 없음)에서 통과율 · 효과를 심었을 때 검출률
 *   node scripts/street-verdict.js --status    # 쌓인 사건 수와 판정 가능 여부만 (수익률은 계산하지 않는다)
 *   node scripts/street-verdict.js --judge     # 판정 1회. 조건(판정일·표본) 전에는 거부한다
 *
 * ②③은 실제 사건의 결과를 쓰지 않는다(무작위 날짜·가짜 효과) — 결과를 보기 전에 기준을 시험하는 장치.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const street = require('../backend/streetViews');

// ── 사전 등록 상수 (바꾸면 위반) ──────────────────────────────────────────────
const SIGN = { up: 1, bull: 1, down: -1, bear: -1 };          // 채점 대상 방향. hold·view·연준은 병기만
const PRIMARY = { h: 20, entry: 'next', bench: 'adj', src: 'all' };
const GRID = { h: [5, 20, 60], entry: ['next', 'prior'], bench: ['adj', 'rel'], src: ['all', 'rule'] };
// 대상별 20거래일 상대수익 SD(%p, 2015-01~2025-10, --power 로 2026-11-16 측정해 고정). 수익을 이것으로 나눠 SD 단위로 채점한다
//   — 하이닉스(10%p) 한 종목이 평균을 좌우하지 않게. h 일 구간은 SD×√(h/20).
const SCALE = { kospi: 3.69, korea: 3.69, samsung: 5.60, hynix: 10.07, spx: 2.66, ndx: 3.66, asia: 3.09, memory: 5.80 };
const PASS = { minAbs: 0.25, tAbs: 2.2, gridAgree: 0.75 };   // tAbs 2.2 = 플라시보 t 97.5% 분위(2026-11-16)   // minAbs 는 SD 단위(KOSPI 로 약 0.9%p)
const MIN_CLUSTERS = 30;
const EARLIEST = '2027-05-17', FINAL = '2027-11-16';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const _y = new Map();
async function yahoo(sym) {
  if (_y.has(sym)) return _y.get(sym);
  const p1 = Math.floor(Date.UTC(2014, 0, 1) / 1000), p2 = Math.floor(Date.now() / 1000) + 86400;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = (await r.json()).chart.result[0];
  const off = j.meta.gmtoffset || 0, q = j.indicators.quote[0], adj = j.indicators.adjclose?.[0]?.adjclose;
  const c = adj && adj.length === q.close.length ? adj : q.close;
  const out = j.timestamp.map((ts, i) => [new Date((ts + off) * 1000).toISOString().slice(0, 10), c[i]]).filter(([, v]) => v != null);
  _y.set(sym, out); await sleep(300);
  return out;
}
const lastOnOrBefore = (s, d) => { let lo = 0, hi = s.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m][0] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k; };

/** 사건 하나의 h 거래일 수익(%). entry: next = 기사 뒤 첫 마감부터, prior = 기사 직전 마감부터. bench: rel = 기준 계열 차감 */
function eventReturn(P, B, pubIso, market, h, entry, bench) {
  const i0 = street.entryIndex(P, pubIso, market);
  if (i0 < 0) return null;
  const i = entry === 'next' ? i0 : i0 - 1;
  if (i < 0 || i + h >= P.length) return null;
  const rel = (j, k) => {   // P 인덱스 j→k 구간의 기준 대비 초과수익
    const a = lastOnOrBefore(B, P[j][0]), b = lastOnOrBefore(B, P[k][0]);
    if (a < 0 || b < 0 || b === a) return null;
    return (P[k][1] / P[j][1] - 1) * 100 - (B[b][1] / B[a][1] - 1) * 100;
  };
  const r = rel(i, i + h);
  if (r == null || bench === 'rel') return r;
  // adj(주 기준): 진입 직전 250거래일의 평균 초과수익(h 일 환산)을 뺀다 — "원래 꾸준히 이기던 대상"에 낸 강세 의견이
  //   날짜와 상관없이 맞은 것처럼 보이는 문제(2026-11-16 플라시보에서 효과 없는 날짜의 통과율 10%로 확인).
  if (i < 260) return null;
  const drift = rel(i - 250, i);
  return drift == null ? null : r - drift * (h / 250);
}

const isoWeek = d => { const t = new Date(d + 'T00:00:00Z'); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); return `${t.getUTCFullYear()}-W${String(1 + Math.round(((t - y0) / 864e5 - 3 + ((y0.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`; };
function stat(xs) {
  const n = xs.length; if (n < 3) return { n, mean: null, t: null };
  const m = xs.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { n, mean: m, t: sd ? m / (sd / Math.sqrt(n)) : null };
}
/** 사건들 → 묶음(대상 × 진입 주) 평균의 평균과 t. 같은 주 같은 대상의 의견들은 같은 시장을 겪으므로 한 표본 */
async function score(events, cfg) {
  const cl = new Map();
  for (const e of events) {
    if (cfg.src === 'rule' && e.method !== 'rule') continue;
    const Pc = street.PRICE[e.target]; if (!Pc || !SIGN[e.dir]) continue;
    const P = await yahoo(Pc.sym), B = await yahoo(Pc.bench);
    const r = eventReturn(P, B, e.first_pub, Pc.close, cfg.h, cfg.entry, cfg.bench);
    if (r == null) continue;
    const i0 = street.entryIndex(P, e.first_pub, Pc.close);
    const k = `${e.target}|${isoWeek(P[i0][0])}`;
    if (!cl.has(k)) cl.set(k, { d: P[i0][0], xs: [] });
    cl.get(k).xs.push({ z: SIGN[e.dir] * r / (SCALE[e.target] * Math.sqrt(cfg.h / 20)), raw: SIGN[e.dir] * r });
  }
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const rows = [...cl.values()].map(c => ({ d: c.d, v: avg(c.xs.map(x => x.z)), raw: avg(c.xs.map(x => x.raw)) })).sort((a, b) => a.d.localeCompare(b.d));
  const all = stat(rows.map(r => r.v));
  const half = Math.floor(rows.length / 2);
  return { ...all, rawMean: rows.length ? avg(rows.map(r => r.raw)) : null, first: stat(rows.slice(0, half).map(r => r.v)), second: stat(rows.slice(half).map(r => r.v)) };
}

// 무작위 사건 표본: 실제 사건의 대상·방향 구성을 따르되 날짜는 2015~2025 거래일에서 무작위(결과를 쓰지 않는다)
function randomEvents(template, P_by_target, rng) {
  return template.map(e => {
    const P = P_by_target[e.target]; const lo = P.findIndex(([d]) => d >= '2015-01-01'), hi = P.findIndex(([d]) => d >= '2025-10-01');
    const d = P[lo + Math.floor(rng() * (hi - lo))][0];
    return { ...e, first_pub: `${d}T00:00:00Z` };   // 00:00Z → 같은 날 마감이 '기사 뒤 첫 마감'
  });
}
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function loadEvents(needPub = true) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await sb.from('street_views').select('id, first_seen, first_pub, inst, target, dir, method').order('first_seen');
  if (error) throw new Error(error.message);
  return (data || []).filter(e => !needPub || e.first_pub);
}

(async () => {
  const mode = process.argv[2];
  if (mode === '--power') {
    // 대상별 20거래일 상대수익의 표준편차(2015~2025, 겹치지 않는 구간) → 묶음 30개에서 |t|≥2 를 넘기는 최소 평균
    console.log('대상 | 20일 상대수익 SD | 30묶음 최소 검출 평균(|t|=2) | 60묶음');
    for (const [t, Pc] of Object.entries(street.PRICE)) {
      if (t === 'korea') continue;
      const P = await yahoo(Pc.sym), B = await yahoo(Pc.bench); const xs = [];
      for (let i = P.findIndex(([d]) => d >= '2015-01-01'); i + 20 < P.length; i += 20) {
        const a = lastOnOrBefore(B, P[i][0]), b = lastOnOrBefore(B, P[i + 20][0]);
        if (a >= 0 && b > a) xs.push((P[i + 20][1] / P[i][1] - B[b][1] / B[a][1]) * 100);
      }
      const m = xs.reduce((s, x) => s + x, 0) / xs.length, sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
      console.log(`${t.padEnd(8)} | ${sd.toFixed(2)}%p | ${(2 * sd / Math.sqrt(30)).toFixed(2)}%p | ${(2 * sd / Math.sqrt(60)).toFixed(2)}%p`);
    }
    return;
  }
  if (mode === '--placebo') {
    // 템플릿: 실제 사건의 대상·방향만(날짜·결과는 버림). 묶음 30개 규모가 되도록 반복해 늘린다.
    const real = (await loadEvents(false)).filter(e => street.PRICE[e.target] && SIGN[e.dir]);
    const tpl = []; while (tpl.length < 40) tpl.push(...real.map(e => ({ target: e.target, dir: e.dir, method: e.method })));
    const P_by = {}; for (const e of tpl) P_by[e.target] = await yahoo(street.PRICE[e.target].sym);
    const rng = mulberry32(20261116), N = 300;
    const ts = []; let passNull = 0, detect = 0;
    for (let k = 0; k < N; k++) {
      const ev = randomEvents(tpl.slice(0, 40), P_by, rng);
      const s = await score(ev, PRIMARY);
      ts.push(s.t ?? 0);
      if (s.mean != null && Math.abs(s.mean) >= PASS.minAbs && Math.abs(s.t) >= PASS.tAbs && Math.sign(s.first.mean) === Math.sign(s.second.mean)) passNull++;
    }
    ts.sort((a, b) => a - b);
    console.log(`효과 없음(무작위 날짜 ${N}회): 주 기준(크기·t·절반) 통과 ${passNull}회 = ${(passNull / N * 100).toFixed(1)}%  (이상적 ≤ 5%)`);
    console.log(`플라시보 t 분포 2.5%·97.5% = ${ts[Math.floor(N * 0.025)].toFixed(2)} · ${ts[Math.floor(N * 0.975)].toFixed(2)}  (정상이면 ≈ ±2)`);
    // 효과 주입: 무작위 표본의 결과에 의견 방향으로 inj SD 를 더해, 그 크기의 진짜 효과가 있을 때 기준이 잡아내는 비율
    for (const inj of [0.25, 0.4, 0.6]) {
      let hit = 0;
      for (let k = 0; k < 100; k++) {
        const s = await score(randomEvents(tpl.slice(0, 40), P_by, rng), PRIMARY);
        if (s.mean == null || !s.t) continue;
        const se = Math.abs(s.mean / s.t), m = s.mean + inj;
        if (m >= PASS.minAbs && m / se >= PASS.tAbs) hit++;
      }
      console.log(`효과 ${inj} SD 를 심었을 때 검출률 ${hit}%`);
    }
    return;
  }
  const events = await loadEvents();
  const scorable = events.filter(e => street.PRICE[e.target] && SIGN[e.dir]);
  const clusters = new Set(scorable.map(e => `${e.target}|${isoWeek(e.first_seen)}`)).size;
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  console.log(`사건 ${events.length} · 채점 대상 ${scorable.length} · 묶음 ${clusters} (필요 ${MIN_CLUSTERS}) · 오늘 ${today} · 판정 가능 ${EARLIEST} 이후, 최종 ${FINAL}`);
  if (mode !== '--judge') return;
  if (today < EARLIEST) { console.log(`⛔ ${EARLIEST} 전에는 판정하지 않는다`); process.exit(1); }
  if (clusters < MIN_CLUSTERS && today < FINAL) { console.log('⛔ 묶음 부족 — 최종일 전까지 기다린다'); process.exit(1); }
  // 60일 구간이 끝나지 않은 사건은 모든 칸에서 빠진다(칸마다 표본이 달라지지 않게)
  const primary = await score(scorable, PRIMARY);
  const cells = [];
  for (const h of GRID.h) for (const entry of GRID.entry) for (const bench of GRID.bench) for (const src of GRID.src) cells.push({ cfg: { h, entry, bench, src }, s: await score(scorable, { h, entry, bench, src }) });
  const agree = cells.filter(c => c.s.mean != null && Math.sign(c.s.mean) === Math.sign(primary.mean)).length / cells.length;
  const verdict = primary.n < MIN_CLUSTERS ? '표본 부족 — 판정 불가'
    : Math.abs(primary.mean) >= PASS.minAbs && Math.abs(primary.t) >= PASS.tAbs && Math.sign(primary.first.mean) === Math.sign(primary.second.mean) && agree >= PASS.gridAgree
      ? (primary.mean > 0 ? '통과 — 의견 방향을 따름' : '통과 — 의견 반대 방향') : (agree < PASS.gridAgree ? '판정 불가 — 기준에 따라 결론이 뒤집힘' : '기각');
  console.log(JSON.stringify({ primary, agree, verdict, cells: cells.map(c => ({ ...c.cfg, n: c.s.n, mean: c.s.mean && +c.s.mean.toFixed(2), t: c.s.t && +c.s.t.toFixed(2) })) }, null, 1));
})();
