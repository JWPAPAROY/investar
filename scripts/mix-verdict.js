/**
 * 지수 : 저PBR 혼합 비율 판정 (사전 등록 MIX_VERDICT.md, 1회 실행).
 *
 * 저PBR 다리는 backend/portfolio.js 의 buildUniverse/selectPicks 를 그대로 쓴다(실운영과 같은 코드).
 * NAV 는 일별로 계산한다 — 보유 중 비중은 가격대로 흘러가고, 20거래일마다 교체·혼합 리밸런싱.
 *
 * 실행: node --max-old-space-size=8192 scripts/mix-verdict.js
 */
const fs = require('fs');
const path = require('path');
const { STRATEGIES, buildUniverse, selectPicks, buildFinancialIndex } = require('../backend/portfolio');

const SO = STRATEGIES.pbr_lowvol;
const HOLD = SO.hold;                                    // 20
const ROUND = (0.015 + 0.10) * 2 + 0.15;                  // 왕복 0.38%
const MIX_COST = 0.10;                                    // 혼합 리밸런싱 이동 금액당 %
const MIXES = [['M100', 1.0], ['M70', 0.7], ['M50', 0.5], ['M30', 0.3], ['M0', 0.0]];
const IS = ['2022-01-01', '2024-06-30'];
const OOS = ['2024-07-01', '2099-12-31'];
const iso = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

// ── 데이터 ───────────────────────────────────────────────────────────
const D = path.resolve(__dirname, '../data');
const common = new Set(JSON.parse(fs.readFileSync(path.join(D, 'krx-master.json'), 'utf-8')).rows
  .filter(r => r.stkType === '보통주').map(r => r.code));
const recs = fs.readFileSync(path.join(D, 'krx-daily.jsonl'), 'utf-8').split('\n').filter(l => l.trim())
  .map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const kospi = new Map();
for (const l of fs.readFileSync(path.join(D, 'krx-index.jsonl'), 'utf-8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  const k = r.i.find(x => x[0] === '코스피');
  if (k && k[1] > 0) kospi.set(r.d, k[1]);
}
const days = recs.map(r => iso(r.d)).filter((d, k) => kospi.has(recs[k].d));
const recsK = recs.filter(r => kospi.has(r.d));
const KO = recsK.map(r => kospi.get(r.d));
const N = days.length;

const series = new Map();
for (let i = 0; i < N; i++) for (const [c, , , , close, , val, cap] of recsK[i].s) {
  if (!common.has(c)) continue;
  let s = series.get(c);
  if (!s) { s = []; s.byDate = new Map(); series.set(c, s); }
  const rec = { date: days[i], close, marketCap: cap, tradingValue: val };
  s.push(rec); s.byDate.set(days[i], rec);
}
const fin = buildFinancialIndex(JSON.parse(fs.readFileSync(path.join(D, 'financials.json'), 'utf-8')).rows);
const px = (c, i) => series.get(c)?.byDate.get(days[i]) || null;

console.log(`데이터 ${days[0]} ~ ${days[N - 1]} · ${N}거래일 · 보통주 ${series.size} · 재무 ${fin.size}종목`);

// ── 저PBR 다리: 일별 NAV ───────────────────────────────────────────────
const PHASE = +((process.argv.find(s => s.startsWith("--phase=")) || "=0").split("=")[1]);
const START = SO.look + 5 + PHASE;   // --phase=k: 교체 날짜를 k거래일 밀어 위상 민감도 확인
const execDays = new Set();       // 교체(=혼합 리밸런싱) 실행일 인덱스
let hold = new Map();             // code -> 금액 (다리 NAV 단위)
let navP = 1;
const pNav = new Array(N).fill(null);
const picksLog = [];
for (let t = START + 1; t < N; t++) {
  // 1) 전일 종가 → 당일 종가 수익
  if (hold.size) {
    let v = 0;
    for (const [c, amt] of hold) {
      const a = px(c, t - 1), b = px(c, t);
      let r = 1;
      if (a && b && a.close > 0 && b.close > 0) {
        r = b.close / a.close;
        if ((r > 1.31 || r < 0.69) && a.marketCap > 0 && b.marketCap > 0) r = b.marketCap / a.marketCap;
      }                                                 // 거래 없음(정지·상폐) → 마지막 가격 유지
      hold.set(c, amt * r); v += amt * r;
    }
    navP = v;
  }
  // 2) 신호일 = t−1 이 교체 주기에 걸리면 t 종가로 교체
  const sig = t - 1;
  if ((sig - START) % HOLD === 0) {
    const top = buildUniverse(series, sig, days, fin, SO);
    const picks = selectPicks(top, SO).filter(p => px(p.code, t));
    if (picks.length) {
      const tgt = new Map(picks.map(p => [p.code, p.weight * navP]));
      const ws = picks.reduce((s, p) => s + p.weight, 0);
      for (const [c, v] of tgt) tgt.set(c, v / ws);
      let moved = 0;
      for (const [c, v] of tgt) moved += Math.abs(v - (hold.get(c) || 0));
      for (const [c, v] of hold) if (!tgt.has(c)) moved += v;
      const turn = hold.size ? moved / 2 / navP : 1;
      const cost = navP * turn * ROUND / 100;
      navP -= cost;
      hold = new Map([...tgt].map(([c, v]) => [c, v * (navP / (navP + cost))]));
      execDays.add(t);
      picksLog.push({ d: days[t], n: picks.length, turn, codes: picks.map(p => [p.code, +p.weight.toFixed(3)]) });
    }
  }
  if (execDays.size) pNav[t] = navP;
}
const T0 = Math.min(...execDays);

// ── 혼합 NAV ──────────────────────────────────────────────────────────
const mixNav = {};
for (const [name, a] of MIXES) {
  const nav = new Array(N).fill(null);
  let vi = a, vp = 1 - a;
  nav[T0] = 1;
  for (let t = T0 + 1; t < N; t++) {
    vi *= KO[t] / KO[t - 1];
    vp *= pNav[t] / pNav[t - 1];
    let tot = vi + vp;
    if (execDays.has(t) && a > 0 && a < 1) {
      const moved = Math.abs(vi - a * tot);
      tot -= moved * MIX_COST / 100;
      vi = a * tot; vp = (1 - a) * tot;
    }
    nav[t] = tot;
  }
  mixNav[name] = nav;
}

// ── 지표 ─────────────────────────────────────────────────────────────
function stats(nav, from, to) {
  const ix = [];
  for (let t = T0; t < N; t++) if (days[t] >= from && days[t] <= to && nav[t] != null) ix.push(t);
  const s = ix[0], e = ix[ix.length - 1];
  const yrs = (new Date(days[e]) - new Date(days[s])) / (365.25 * 864e5);
  const cagr = (Math.pow(nav[e] / nav[s], 1 / yrs) - 1) * 100;
  let peak = -Infinity, mdd = 0;
  for (const t of ix) { peak = Math.max(peak, nav[t]); mdd = Math.min(mdd, (nav[t] / peak - 1) * 100); }
  let neg = 0, cnt = 0;
  for (const t of ix) if (t - 250 >= T0) { cnt++; if (nav[t] < nav[t - 250]) neg++; }
  return { cagr, mdd, calmar: mdd < 0 ? cagr / -mdd : null, neg: cnt ? neg / cnt * 100 : null, from: days[s], to: days[e] };
}
const f = (v, w = 7) => (v == null ? '-'.padStart(w) : ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(w));
const g = (v, w = 6) => (v == null ? '-'.padStart(w) : v.toFixed(2).padStart(w));

console.log(`저PBR 교체 ${picksLog.length}회 · 평균 종목 ${(picksLog.reduce((s, p) => s + p.n, 0) / picksLog.length).toFixed(1)} · 평균 회전 ${(picksLog.slice(1).reduce((s, p) => s + p.turn, 0) / (picksLog.length - 1) * 100).toFixed(0)}% · 시작 ${days[T0]}\n`);

const res = {};
for (const [label, [a, b]] of [['설계 2022-01~2024-06', IS], ['시험 2024-07~', OOS], ['전체', ['0000', '9999']]]) {
  console.log(`[${label}]   CAGR     MDD   Calmar  롤링1년<0`);
  res[label] = {};
  for (const [name] of MIXES) {
    const s = stats(mixNav[name], a, b);
    res[label][name] = s;
    console.log(`  ${name.padEnd(5)} ${f(s.cagr)} ${f(s.mdd)}  ${g(s.calmar)}   ${f(s.neg).trim().replace('+', '').padStart(6)}`);
  }
  console.log(`  (${res[label].M100.from} ~ ${res[label].M100.to})\n`);
}

// 연도별
const years = [...new Set(days.slice(T0).map(d => d.slice(0, 4)))];
console.log('연도별   ' + MIXES.map(([n]) => n.padStart(8)).join(''));
for (const y of years) {
  const row = MIXES.map(([n]) => {
    const nav = mixNav[n];
    const ix = []; for (let t = T0; t < N; t++) if (days[t].startsWith(y)) ix.push(t);
    const s = ix[0] > T0 ? ix[0] - 1 : ix[0];
    return f((nav[ix[ix.length - 1]] / nav[s] - 1) * 100, 8);
  });
  console.log(`  ${y}  ${row.join('')}`);
}

// ── 판정 ─────────────────────────────────────────────────────────────
const isR = res['설계 2022-01~2024-06'], ooR = res['시험 2024-07~'];
const elig = MIXES.map(([n]) => n).filter(n => isR[n].cagr >= isR.M100.cagr - 2);
const pick = elig.sort((x, y) => (isR[y].calmar ?? -1e9) - (isR[x].calmar ?? -1e9))[0];
console.log(`\n── 판정 (1회) ──`);
console.log(`1단계 설계 구간 후보(CAGR ≥ M100 ${f(isR.M100.cagr).trim()} − 2%p): ${elig.join(', ')}`);
console.log(`       Calmar 최대 → ${pick} (Calmar ${g(isR[pick].calmar).trim()})`);
if (pick === 'M100') {
  console.log('결론: 지수 단독 (혼합의 이점 없음)');
} else {
  const v1 = ooR[pick].cagr >= ooR.M100.cagr - 2;
  const v2 = ooR[pick].mdd >= ooR.M100.mdd + 3;
  console.log(`2단계 시험 구간: ${pick} CAGR ${f(ooR[pick].cagr).trim()} vs M100 ${f(ooR.M100.cagr).trim()} (기준 ≥ −2%p) → ${v1 ? '✅' : '❌'}`);
  console.log(`                 ${pick} MDD  ${f(ooR[pick].mdd).trim()} vs M100 ${f(ooR.M100.mdd).trim()} (기준 3%p 이상 얕음) → ${v2 ? '✅' : '❌'}`);
  console.log(`결론: ${v1 && v2 ? `${pick} 채택 후보` : '기각 — 지수 단독 유지'}`);
}

// ── 진단 덤프 (--dump=파일): 다리 NAV·교체 내역 ─────────────────────────
{
  const a = process.argv.find(s => s.startsWith('--dump='));
  if (a) {
    fs.writeFileSync(a.slice(7), JSON.stringify({ days, KO, pNav, picksLog, T0 }));
    console.log(`\n💾 ${a.slice(7)}`);
  }
}
