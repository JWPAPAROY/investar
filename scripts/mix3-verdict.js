/**
 * 지수 : 저PBR : E/P 3자 혼합 판정 (사전 등록 MIX3_VERDICT.md, 1회 실행).
 *
 * 두 방어 다리(pbr_lowvol, ep_lowturn)는 backend/portfolio.js 정의 그대로.
 * 위상(교체 시작일) 0~19 전부를 돌려 분포로 판정한다 — MIX_VERDICT.md 의 교훈.
 *
 * 실행: node --max-old-space-size=8192 scripts/mix3-verdict.js
 */
const fs = require('fs');
const path = require('path');
const { STRATEGIES, buildUniverse, selectPicks, buildFinancialIndex } = require('../backend/portfolio');

const ROUND = (0.015 + 0.10) * 2 + 0.15;   // 왕복 0.38%
const MIX_COST = 0.10;
const PHASES = 20;
const MIXES = [
  ['M100', 1.0, 0.0, 0.0],
  ['A70-P', 0.7, 0.30, 0.0], ['A70-H', 0.7, 0.15, 0.15], ['A70-E', 0.7, 0.0, 0.30],
  ['A50-P', 0.5, 0.50, 0.0], ['A50-H', 0.5, 0.25, 0.25], ['A50-E', 0.5, 0.0, 0.50],
];
const IS = ['2022-01-01', '2024-06-30'];
const OOS = ['2024-07-01', '2099-12-31'];
const iso = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

// ── 데이터 ───────────────────────────────────────────────────────────
const D = path.resolve(__dirname, '../data');
const common = new Set(JSON.parse(fs.readFileSync(path.join(D, 'krx-master.json'), 'utf-8')).rows
  .filter(r => r.stkType === '보통주').map(r => r.code));
const kospi = new Map();
for (const l of fs.readFileSync(path.join(D, 'krx-index.jsonl'), 'utf-8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l); const k = r.i.find(x => x[0] === '코스피');
  if (k && k[1] > 0) kospi.set(r.d, k[1]);
}
const recs = fs.readFileSync(path.join(D, 'krx-daily.jsonl'), 'utf-8').split('\n').filter(l => l.trim())
  .map(l => JSON.parse(l)).filter(r => kospi.has(r.d)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => iso(r.d)), KO = recs.map(r => kospi.get(r.d)), N = days.length;
const series = new Map();
for (let i = 0; i < N; i++) for (const [c, , , , close, , val, cap] of recs[i].s) {
  if (!common.has(c)) continue;
  let s = series.get(c); if (!s) { s = []; s.byDate = new Map(); series.set(c, s); }
  const rec = { date: days[i], close, marketCap: cap, tradingValue: val };
  s.push(rec); s.byDate.set(days[i], rec);
}
const fin = buildFinancialIndex(JSON.parse(fs.readFileSync(path.join(D, 'financials.json'), 'utf-8')).rows);
const px = (c, i) => series.get(c)?.byDate.get(days[i]) || null;
console.log(`데이터 ${days[0]} ~ ${days[N - 1]} · ${N}거래일 · 보통주 ${series.size} · 재무 ${fin.size}종목\n`);

// 신호일별 픽 캐시 (위상이 달라도 같은 신호일이면 같은 픽)
const pickCache = { pbr_lowvol: new Map(), ep_lowturn: new Map() };
function picksAt(key, i) {
  const m = pickCache[key];
  if (!m.has(i)) { const so = STRATEGIES[key]; m.set(i, selectPicks(buildUniverse(series, i, days, fin, so), so)); }
  return m.get(i);
}

// ── 다리 하나의 일별 NAV ─────────────────────────────────────────────
function legNav(key, phase) {
  const START = STRATEGIES[key].look + 5 + phase;
  let hold = new Map(), nav = 1;
  const out = new Array(N).fill(null), exec = new Set();
  for (let t = START + 1; t < N; t++) {
    if (hold.size) {
      let v = 0;
      for (const [c, amt] of hold) {
        const a = px(c, t - 1), b = px(c, t);
        let r = 1;
        if (a && b && a.close > 0 && b.close > 0) {
          r = b.close / a.close;
          if ((r > 1.31 || r < 0.69) && a.marketCap > 0 && b.marketCap > 0) r = b.marketCap / a.marketCap;
        }
        hold.set(c, amt * r); v += amt * r;
      }
      nav = v;
    }
    if ((t - 1 - START) % STRATEGIES[key].hold === 0) {
      const picks = picksAt(key, t - 1).filter(p => px(p.code, t));
      if (picks.length) {
        const ws = picks.reduce((s, p) => s + p.weight, 0);
        const tgt = new Map(picks.map(p => [p.code, p.weight / ws * nav]));
        let moved = 0;
        for (const [c, v] of tgt) moved += Math.abs(v - (hold.get(c) || 0));
        for (const [c, v] of hold) if (!tgt.has(c)) moved += v;
        const cost = nav * (hold.size ? moved / 2 / nav : 1) * ROUND / 100;
        const k = (nav - cost) / nav;
        nav -= cost;
        hold = new Map([...tgt].map(([c, v]) => [c, v * k]));
        exec.add(t);
      }
    }
    if (exec.size) out[t] = nav;
  }
  return { nav: out, exec };
}

function stats(nav, T0, from, to) {
  const ix = [];
  for (let t = T0; t < N; t++) if (days[t] >= from && days[t] <= to && nav[t] != null) ix.push(t);
  const s = ix[0], e = ix[ix.length - 1];
  const yrs = (new Date(days[e]) - new Date(days[s])) / (365.25 * 864e5);
  const cagr = (Math.pow(nav[e] / nav[s], 1 / yrs) - 1) * 100;
  let peak = -Infinity, mdd = 0;
  for (const t of ix) { peak = Math.max(peak, nav[t]); mdd = Math.min(mdd, (nav[t] / peak - 1) * 100); }
  return { cagr, mdd, calmar: mdd < 0 ? cagr / -mdd : null };
}

// ── 위상별 실행 ──────────────────────────────────────────────────────
const R = [];   // R[phase][mix] = {IS:{}, OOS:{}}
for (let ph = 0; ph < PHASES; ph++) {
  const P = legNav('pbr_lowvol', ph), E = legNav('ep_lowturn', ph);
  const T0 = Math.max(Math.min(...P.exec), Math.min(...E.exec));
  const row = {};
  for (const [name, a, p, e] of MIXES) {
    const nav = new Array(N).fill(null);
    let vi = a, vp = p, ve = e; nav[T0] = 1;
    for (let t = T0 + 1; t < N; t++) {
      vi *= KO[t] / KO[t - 1];
      if (vp) vp *= P.nav[t] / P.nav[t - 1];
      if (ve) ve *= E.nav[t] / E.nav[t - 1];
      let tot = vi + vp + ve;
      if (P.exec.has(t) && a < 1) {
        const moved = (Math.abs(vi - a * tot) + Math.abs(vp - p * tot) + Math.abs(ve - e * tot)) / 2;
        tot -= moved * MIX_COST / 100;
        vi = a * tot; vp = p * tot; ve = e * tot;
      }
      nav[t] = tot;
    }
    row[name] = { IS: stats(nav, T0, ...IS), OOS: stats(nav, T0, ...OOS) };
  }
  R.push(row);
  process.stdout.write(`위상 ${ph} `);
}
console.log('\n');

// ── 요약 표 ──────────────────────────────────────────────────────────
const med = a => { const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const f = v => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(7);
for (const seg of ['IS', 'OOS']) {
  console.log(`[${seg === 'IS' ? '설계 2022-02~2024-06' : '시험 2024-07~2026-11'}] 위상 20개 — CAGR 중앙 (최소~최대) · MDD 중앙 · Calmar 중앙`);
  for (const [name] of MIXES) {
    const c = R.map(r => r[name][seg].cagr), m = R.map(r => r[name][seg].mdd), k = R.map(r => r[name][seg].calmar);
    console.log(`  ${name.padEnd(6)} ${f(med(c))} (${f(Math.min(...c)).trim()} ~ ${f(Math.max(...c)).trim()})  MDD ${f(med(m))}  Calmar ${med(k).toFixed(2)}`);
  }
  console.log('');
}

// ── Q1 ──────────────────────────────────────────────────────────────
console.log('── Q1: E/P 추가 효과 (위상 20개 중 Calmar 우위 횟수) ──');
const verdictQ1 = [];
for (const a of ['A70', 'A50']) for (const alt of ['H', 'E']) {
  const cnt = seg => R.filter(r => r[`${a}-${alt}`][seg].calmar > r[`${a}-P`][seg].calmar).length;
  const ci = cnt('IS'), co = cnt('OOS');
  const v = ci >= 14 && co >= 14 ? 'E/P를 섞는 게 낫다' : ci <= 6 && co <= 6 ? '저PBR만이 낫다' : '차이를 주장할 수 없다';
  console.log(`  ${a}-${alt} vs ${a}-P : 설계 ${ci}/20 · 시험 ${co}/20 → ${v}`);
  verdictQ1.push([alt, a, v]);
}
for (const alt of ['H', 'E']) {
  const vs = verdictQ1.filter(x => x[0] === alt).map(x => x[2]);
  console.log(`  결론(-${alt}): ${vs[0] === vs[1] ? vs[0] : '차이를 주장할 수 없다 (a=70/50 결론 불일치)'}`);
}

// ── Q2 ──────────────────────────────────────────────────────────────
console.log('\n── Q2: 지수 단독 대비 ──');
const isMed = n => ({ cagr: med(R.map(r => r[n].IS.cagr)), calmar: med(R.map(r => r[n].IS.calmar)) });
const base = isMed('M100');
const elig = MIXES.map(m => m[0]).filter(n => isMed(n).cagr >= base.cagr - 2);
const pick = elig.sort((x, y) => isMed(y).calmar - isMed(x).calmar)[0];
console.log(`  1단계 설계 후보(CAGR 중앙 ≥ M100 ${f(base.cagr).trim()} − 2%p): ${elig.join(', ')} → Calmar 중앙 최대 ${pick} (${isMed(pick).calmar.toFixed(2)})`);
if (pick === 'M100') console.log('  결론: 지수 단독');
else {
  const pass = R.filter(r => r[pick].OOS.cagr >= r.M100.OOS.cagr - 2 && r[pick].OOS.mdd >= r.M100.OOS.mdd + 3).length;
  const v1 = R.filter(r => r[pick].OOS.cagr >= r.M100.OOS.cagr - 2).length;
  const v2 = R.filter(r => r[pick].OOS.mdd >= r.M100.OOS.mdd + 3).length;
  console.log(`  2단계 시험: V1 ${v1}/20 · V2 ${v2}/20 · 동시 ${pass}/20 (기준 ≥15) → ${pass >= 15 ? `${pick} 채택 후보` : '기각 — 지수 단독'}`);
}

// ── 병기 (판정을 바꾸지 않는다): 혼합별 시험 구간 V1·V2 동시 통과 위상 수 ──
console.log('\n[병기] 시험 구간 V1·V2 동시 통과 위상 수 (판정 무관)');
console.log('  ' + MIXES.slice(1).map(([n]) => `${n} ${R.filter(r => r[n].OOS.cagr >= r.M100.OOS.cagr - 2 && r[n].OOS.mdd >= r.M100.OOS.mdd + 3).length}/20`).join(' · '));
