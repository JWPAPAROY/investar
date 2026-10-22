/**
 * index-signal-test.js — KOSPI 200 가격 외 신호 검정: 해외(A) · 수급(B) · 구조적 이벤트(C) (2026-10-21)
 *
 * 판정 기준은 INDEX_SIGNAL_VERDICT.md 에 돌리기 전에 등록했다. 신호·임계값·구간을 여기서 바꾸지 말 것.
 * 데이터: kospi-index-long.jsonl(+krx-index 보충) · us-daily.json · kospi-investor-daily.jsonl
 *
 * 실행: node scripts/index-signal-test.js [--only=A|B|C|D|E|F] [--freq=W]
 *   --freq=W: 신호를 매주 마지막 거래일 종가에만 판단 → 다음 거래일 종가 체결 (주간 관측 변형, 2026-10-22).
 *             기본(D)은 매 거래일 판단. 판정 기준·임계값은 동일.
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const ONLY = arg('only', 'ABCDEF');
const FREQ = arg('freq', 'D');
const COST = 0.0005, BAND = 0.1;
const fp = f => path.resolve(__dirname, '../data', f);
const lines = f => fs.existsSync(fp(f)) ? fs.readFileSync(fp(f), 'utf-8').split('\n').filter(s => s.trim()) : [];

// ── 데이터 ───────────────────────────────────────────────────────────
const px = new Map();   // d → [close, open]
for (const l of lines('kospi-index-long.jsonl')) { const r = JSON.parse(l); if (!r.h && r.k200[0] > 0) px.set(r.d, [r.k200[0], r.k200[1]]); }
for (const l of lines('krx-index.jsonl')) {
  const r = JSON.parse(l); if (px.has(r.d)) continue;
  const k = r.i.find(x => x[0] === '코스피 200'); if (k && k[1] > 0) px.set(r.d, [k[1], k[2]]);
}
const D = [...px.keys()].sort(), n = D.length;
const C = D.map(d => px.get(d)[0]), O = D.map(d => px.get(d)[1]);
const i0 = D.findIndex(d => d >= '20110103');
const isEnd = D.findIndex(d => d >= '20190101') - 1;
const SEG = { '전 구간': [i0, n - 1], 'IS 2011-18': [i0, isEnd], 'OOS 2019-': [isEnd, n - 1] };
// 주의 마지막 거래일 (월요일 시작 주; 다음 거래일이 다른 주면 그 주의 끝)
const wk = d => Math.floor((Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 864e5 + 3) / 7);
const weekEnd = D.map((d, i) => i === n - 1 || wk(D[i + 1]) !== wk(d));
const ret = D.map((_, i) => i ? C[i] / C[i - 1] - 1 : 0);
const gap = D.map((_, i) => i ? O[i] / C[i - 1] - 1 : 0);
const intra = D.map((_, i) => C[i] / O[i] - 1);

const flow = new Map();
for (const l of lines('kospi-investor-daily.jsonl')) {
  const r = JSON.parse(l);
  flow.set(r.d, { frgn: +r.frgn_ntby_tr_pbmn, orgn: +r.orgn_ntby_tr_pbmn, prsn: +r.prsn_ntby_tr_pbmn });
}
const us = fs.existsSync(fp('us-daily.json')) ? JSON.parse(fs.readFileSync(fp('us-daily.json'), 'utf-8')) : {};
const missingFlow = D.slice(i0).filter(d => !flow.has(d)).length;
console.log(`KOSPI 200 ${n}일 (${D[0]}~${D[n - 1]}) | 수급 누락 ${missingFlow}일 | 해외 ${Object.keys(us).join(', ')}`);

// ── 통계 도구 ────────────────────────────────────────────────────────
const fmt = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const pct = (x, k = 1) => (x >= 0 ? '+' : '') + (x * 100).toFixed(k) + '%';
const pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const vari = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
function welch(a, b) { const t = (mean(a) - mean(b)) / Math.sqrt(vari(a) / a.length + vari(b) / b.length); return { d: mean(a) - mean(b), t, na: a.length }; }
function corr(x, y) {
  const mx = mean(x), my = mean(y); let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  const r = sxy / Math.sqrt(sx * sy); return { r, t: r * Math.sqrt((x.length - 2) / (1 - r * r)), n: x.length };
}
/** 일간 수익 배열 r 의 (a, b] 성적 */
function perf(r, a, b) {
  let v = 1, peak = 1, mdd = 0;
  for (let i = a + 1; i <= b; i++) { v *= 1 + r[i]; peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const yrs = (Date.parse(fmt(D[b])) - Date.parse(fmt(D[a]))) / (365.25 * 864e5);
  const cagr = Math.pow(v, 1 / yrs) - 1;
  return { tot: v - 1, cagr, mdd, calmar: cagr / Math.max(1e-9, -mdd) };
}
/** 전략형 판정 (INDEX_SIGNAL_VERDICT.md) */
function judge(name, r, bench = ret) {
  const out = {};
  for (const [k, [a, b]] of Object.entries(SEG)) out[k] = { s: perf(r, a, b), m: perf(bench, a, b) };
  const all = out['전 구간'], ex = all.s.cagr - all.m.cagr;
  const exIS = out['IS 2011-18'].s.cagr - out['IS 2011-18'].m.cagr, exOOS = out['OOS 2019-'].s.cagr - out['OOS 2019-'].m.cagr;
  let v;
  if (ex > 0 && all.s.calmar > all.m.calmar && exIS > 0 && exOOS > 0) v = '✅ 통과';
  else if (ex > -0.02 && all.s.mdd - all.m.mdd >= 0.10) v = '🟡 낙폭 축소 후보';
  else v = '기각';
  console.log(`  ${name.padEnd(22)} 전 구간 ${pct(all.s.cagr).padStart(7)}/년 MDD ${pct(all.s.mdd).padStart(7)} Calmar ${all.s.calmar.toFixed(2).padStart(5)} | 연초과 전체 ${pp(ex).padStart(7)} IS ${pp(exIS).padStart(7)} OOS ${pp(exOOS).padStart(7)} → ${v}`);
  return v;
}
/** 신호(i → 목표비중|null)를 '신호일 종가 판단 → 다음 거래일 종가 체결'로 운용한 일간 수익 */
function lagged(sig, init = 1) {
  const r = new Array(n).fill(0); let h = init, pending = null;
  for (let i = i0 + 1; i < n; i++) {
    r[i] = h * ret[i];
    if (pending !== null) { r[i] = (1 + r[i]) * (1 - COST * Math.abs(pending - h)) - 1; h = pending; pending = null; }
    const w = FREQ === 'W' && !weekEnd[i] ? null : sig(i); if (w !== null && Math.abs(w - h) >= BAND) pending = w;
  }
  return r;
}
const segIdx = (a, b) => { const o = []; for (let i = a + 1; i <= b; i++) o.push(i); return o; };

// ── A. 해외 ──────────────────────────────────────────────────────────
function usSeries(t) {
  const s = us[t] || [], dates = s.map(x => x[0]);
  const lastBefore = d => { let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] < d) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
  // 한국 전일 마감 이후 새로 나온 미국 세션만: (d 이전 마지막) / (d−1 이전 마지막)
  return D.map((d, i) => { if (!i) return NaN; const a = lastBefore(d), b = lastBefore(D[i - 1]); return a > b && b >= 0 ? s[a][1] / s[b][1] - 1 : (a === b ? 0 : NaN); });
}
if (ONLY.includes('A')) {
  console.log('\n━━ A0. 해외 수익률 → 갭 / 장중 상관 (진단) ━━');
  const U = {};
  for (const t of Object.keys(us)) {
    U[t] = usSeries(t);
    const row = [t.padEnd(6)];
    for (const [k, [a, b]] of Object.entries(SEG)) {
      if (k === '전 구간') continue;
      const idx = segIdx(a, b).filter(i => Number.isFinite(U[t][i]));
      const g = corr(idx.map(i => U[t][i]), idx.map(i => gap[i])), it = corr(idx.map(i => U[t][i]), idx.map(i => intra[i]));
      row.push(`${k}: 갭 r=${g.r.toFixed(2)} | 장중 r=${it.r.toFixed(2)} (t=${it.t.toFixed(1)})`);
    }
    console.log('  ' + row.join('   '));
  }
  console.log('\n━━ A1. 갭 회피 — 신호 나쁜 날 장전 시간외(전일 종가) 매도 → 시가 재매수 ━━');
  const A1 = [['EWY<0', 'EWY', 0], ['EWY<-1%', 'EWY', -0.01], ['ES=F<0', 'ES=F', 0], ['ES=F<-1%', 'ES=F', -0.01]];
  for (const [name, t, th] of A1) {
    let days = 0;
    const r = ret.map((x, i) => { if (i <= i0 || !(U[t][i] < th)) return x; days++; return (1 - COST) ** 2 * (C[i] / O[i]) - 1; });
    judge(`${name} (${days}일 회피)`, r);
  }
  console.log('\n━━ A2. 장중 — 신호 좋은 날만 시가 매수 → 종가 매도 ━━');
  const allIntra = ret.map((_, i) => i <= i0 ? 0 : (1 - COST) ** 2 * (C[i] / O[i]) - 1);
  console.log('  [기준] 매일 시가→종가');
  judge('매일 시가→종가', allIntra);
  for (const [name, t] of [['EWY>0', 'EWY'], ['ES=F>0', 'ES=F']]) {
    const r = ret.map((_, i) => i > i0 && U[t][i] > 0 ? (1 - COST) ** 2 * (C[i] / O[i]) - 1 : 0);
    judge(name, r);
    const vsIntra = {}; for (const [k, [a, b]] of Object.entries(SEG)) vsIntra[k] = perf(r, a, b).cagr - perf(allIntra, a, b).cagr;
    console.log(`  ${''.padEnd(22)} vs 매일 시가→종가: 전체 ${pp(vsIntra['전 구간'])} IS ${pp(vsIntra['IS 2011-18'])} OOS ${pp(vsIntra['OOS 2019-'])}`);
  }
}

// ── B. 수급 ──────────────────────────────────────────────────────────
if (ONLY.includes('B')) {
  const F = k => D.map(d => flow.has(d) ? flow.get(d)[k] : 0);
  const cum = (a, N) => { const o = new Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += a[i]; if (i >= N) s -= a[i - N]; if (i >= N - 1) o[i] = s; } return o; };
  const ser = { 외국인: F('frgn'), 기관: F('orgn'), 개인: F('prsn') };
  console.log('\n━━ B0. 5일 누적 순매수 z(250일) → 다음 5·20거래일 수익 상관 (진단) ━━');
  for (const [who, a] of Object.entries(ser)) {
    const c5 = cum(a, 5), z = new Array(n).fill(NaN);
    for (let i = 255; i < n; i++) { const w = c5.slice(i - 250, i); const m = mean(w), s = Math.sqrt(vari(w)); z[i] = (c5[i] - m) / s; }
    const row = [who.padEnd(4)];
    for (const H of [5, 20]) for (const [k, [a0, b0]] of Object.entries(SEG)) {
      if (k === '전 구간') continue;
      const idx = segIdx(a0, b0 - H).filter(i => Number.isFinite(z[i]));
      // 미래 수익: 다음 거래일 종가 체결 기준 (i+1 → i+1+H)
      const c = corr(idx.map(i => z[i]), idx.map(i => C[Math.min(n - 1, i + 1 + H)] / C[i + 1] - 1));
      row.push(`H${H} ${k.slice(0, 3)} r=${c.r.toFixed(2)}`);
    }
    console.log('  ' + row.join('  '));
  }
  console.log('\n━━ B1~B3. 수급 추세 (신호일 다음 거래일 종가 체결) ━━');
  for (const [who, rule] of [['외국인', 'buy'], ['기관', 'buy'], ['개인', 'contra']]) for (const N of [5, 20, 60]) {
    const c = cum(ser[who], N);
    const sig = i => Number.isFinite(c[i]) ? (rule === 'buy' ? (c[i] > 0 ? 1 : 0) : (c[i] > 0 ? 0 : 1)) : null;
    judge(`${who} ${N}일 ${rule === 'buy' ? '>0 보유' : '>0 현금'}`, lagged(sig, 1));
  }
}

// ── C. 구조적 이벤트 ─────────────────────────────────────────────────
if (ONLY.includes('C')) {
  const dow = D.map(d => new Date(fmt(d) + 'T00:00:00Z').getUTCDay());
  const ym = D.map(d => d.slice(0, 6));
  const ev = {};
  const mark = (k, i) => { (ev[k] ||= new Set()).add(i); };
  // 옵션 만기: 둘째 목요일, 휴장이면 직전 거래일
  for (const m of [...new Set(ym)]) {
    const y = +m.slice(0, 4), mo = +m.slice(4, 6);
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const day2thu = 1 + ((4 - first + 7) % 7) + 7;
    const target = `${m}${String(day2thu).padStart(2, '0')}`;
    let k = -1; for (let i = 0; i < n; i++) if (D[i] <= target && ym[i] === m) k = i;
    if (k < 0) continue;
    mark('C1 옵션 만기일', k);
    if ([3, 6, 9, 12].includes(mo)) mark('C2 동시만기일', k);
    if (k + 1 < n) mark('C3 만기 다음 날', k + 1);
  }
  for (let i = 0; i < n; i++) {
    if (i + 1 < n && ym[i + 1] !== ym[i]) mark('C4 월말월초', i);
    if (i >= 1 && ym[i - 1] !== ym[i]) for (let j = i; j < Math.min(n, i + 3); j++) mark('C4 월말월초', j);
    if (i + 1 < n) {   // 사이에 빈 평일 수
      let gapWd = 0; const a = new Date(fmt(D[i]) + 'T00:00:00Z'), b = new Date(fmt(D[i + 1]) + 'T00:00:00Z');
      for (const t = new Date(a.getTime() + 864e5); t < b; t.setUTCDate(t.getUTCDate() + 1)) if (t.getUTCDay() % 6 !== 0) gapWd++;
      if (gapWd >= 1) { mark('C5 연휴 전일', i); mark('C6 연휴 다음 날', i + 1); }
    }
    mark(`C7 ${'일월화수목금토'[dow[i]]}요일`, i);
  }
  for (const y of [...new Set(D.map(d => d.slice(0, 4)))]) {
    const dec = D.map((d, i) => [d, i]).filter(([d]) => d.startsWith(`${y}12`)).map(([, i]) => i);
    const jan = D.map((d, i) => [d, i]).filter(([d]) => d.startsWith(`${y}01`)).map(([, i]) => i);
    dec.slice(-5).forEach(i => mark('C8 12월 마지막 5일', i));
    jan.slice(0, 5).forEach(i => mark('C8 1월 첫 5일', i));
  }
  console.log('\n━━ C. 이벤트일 평균 일간수익 − 비이벤트일 (Welch t) ━━');
  console.log('  ' + '이벤트'.padEnd(18) + '  IS 2011-18 (차이 / t / n)       OOS 2019- (차이 / t / n)       판정');
  const sig = [];
  for (const [k, set] of Object.entries(ev).sort()) {
    const res = {};
    for (const [s, [a, b]] of Object.entries(SEG)) {
      if (s === '전 구간') continue;
      const idx = segIdx(a, b), inE = idx.filter(i => set.has(i)).map(i => ret[i]), outE = idx.filter(i => !set.has(i)).map(i => ret[i]);
      res[s] = welch(inE, outE);
    }
    const A = res['IS 2011-18'], B = res['OOS 2019-'];
    const ok = Math.sign(A.d) === Math.sign(B.d) && Math.abs(A.t) >= 2 && Math.abs(B.t) >= 2;
    if (ok) sig.push([k, set, A.d]);
    const f = r => `${pct(r.d, 3).padStart(8)} / ${r.t.toFixed(2).padStart(5)} / ${String(r.na).padStart(4)}`;
    console.log(`  ${k.padEnd(18)}  ${f(A)}       ${f(B)}       ${ok ? '✅ 유의' : Math.sign(A.d) === Math.sign(B.d) ? '부호 일치' : '부호 반전'}`);
  }
  if (sig.length) {
    console.log('\n━━ C 전략형 (유의 이벤트만) ━━');
    for (const [k, set, d] of sig) {
      // 나쁜 이벤트: 전일 종가 매도 → 당일 종가 재매수 (그날만 빠짐). 좋은 이벤트: 그날만 보유.
      const r = ret.map((x, i) => i <= i0 ? x : d < 0 ? (set.has(i) ? (1 - COST) ** 2 - 1 : x) : (set.has(i) ? (1 - COST) ** 2 * (1 + x) - 1 : 0));
      judge(`${k} ${d < 0 ? '빠지기' : '만 보유'}`, r);
    }
  } else console.log('\n  유의 이벤트 없음 → C 전략형 생략 (사전 등록대로)');
}

// ── D. 밸류에이션 (build-kospi-valuation.js 산출물) ──────────────────
if (ONLY.includes('D')) {
  const vf = fp('kospi-valuation-monthly.json');
  if (!fs.existsSync(vf)) { console.log('\n❌ D: data/kospi-valuation-monthly.json 없음 — build-kospi-valuation.js 먼저'); process.exit(0); }
  const V = JSON.parse(fs.readFileSync(vf, 'utf-8'));
  const lowCov = V.filter(v => v.covB < 0.9 || v.covE < 0.9).length;
  console.log(`\n━━ D. 밸류에이션 ━━ 월 ${V.length}개 (${V[0].d}~${V.at(-1).d}) · 커버리지 90% 미만 ${lowCov}개월`);
  const W = 36;
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const RULES = {
    D1: (k) => V[k].pbr <= median(V.slice(k - W + 1, k + 1).map(v => v.pbr)) ? 1 : 0.5,
    D2: (k) => V[k].ey >= median(V.slice(k - W + 1, k + 1).map(v => v.ey)) ? 1 : 0.5,
    D3: (k) => { const w = V.slice(k - W + 1, k + 1).map(v => v.pbr); const below = w.filter(x => x < V[k].pbr).length; return below / (W - 1) >= 0.8 ? 0 : 1; },
  };
  const byDate = new Map(V.map((v, k) => [v.d, k]));
  const start = D.indexOf(V[W - 1].d);
  console.log(`  신호 구간 ${D[start]} ~ ${D[n - 1]} (${((Date.parse(fmt(D[n - 1])) - Date.parse(fmt(D[start]))) / (365.25 * 864e5)).toFixed(1)}년)`);
  const bh = perf(ret, start, n - 1);
  console.log(`  보유                    CAGR ${pct(bh.cagr).padStart(7)} MDD ${pct(bh.mdd).padStart(7)} Calmar ${bh.calmar.toFixed(2)}`);
  for (const [key, rule] of Object.entries(RULES)) {
    // 주간 모드: 월말 값은 그 주말에야 판단에 쓴다 (가장 최근 월말 값을 매주 판단)
    let lastK;
    const sig = i => { const k0 = byDate.get(D[i]); if (k0 !== undefined) lastK = k0; const k = FREQ === 'W' ? lastK : k0; return k !== undefined && k >= W - 1 ? rule(k) : null; };
    const r = lagged(sig, 1);
    let avgW = 0, h = 1; for (let i = start + 1; i <= n - 1; i++) { const k = byDate.get(D[i - 1]); if (k !== undefined && k >= W - 1) h = rule(k); avgW += h; }
    const s = perf(r, start, n - 1), ex = s.cagr - bh.cagr;
    const v = ex > 0 && s.calmar > bh.calmar ? '✅ 통과' : (ex > -0.02 && s.mdd - bh.mdd >= 0.10 ? '🟡 낙폭 축소 후보' : '기각');
    console.log(`  ${key.padEnd(22)}  CAGR ${pct(s.cagr).padStart(7)} MDD ${pct(s.mdd).padStart(7)} Calmar ${s.calmar.toFixed(2)} | 연초과 ${pp(ex).padStart(7)} 평균비중 ${(avgW / (n - 1 - start) * 100).toFixed(0)}% → ${v}`);
  }
  // 진단: PBR 36개월 백분위 vs 다음 12개월 수익 (겹침 — 방향만)
  const xs = [], ys = [];
  for (let k = W - 1; k < V.length; k++) {
    const i = D.indexOf(V[k].d), j = D.findIndex(d => d > String(+V[k].d.slice(0, 4) + 1) + V[k].d.slice(4));
    if (i < 0 || j < 0) continue;
    const w = V.slice(k - W + 1, k + 1).map(v => v.pbr);
    xs.push(w.filter(x => x < V[k].pbr).length / (W - 1)); ys.push(C[j] / C[i] - 1);
  }
  const c = corr(xs, ys);
  console.log(`  진단: PBR 백분위 → 다음 12개월 수익 r = ${c.r.toFixed(2)} (n=${c.n}, 겹침 표본이라 t 무효)`);
}

// ── E. 외국인 수급 × 밸류에이션 / 낙폭 (사용자 가설, INDEX_SIGNAL_VERDICT.md E절) ──
if (ONLY.includes('E')) {
  const frg = D.map(d => flow.has(d) ? flow.get(d).frgn : 0);
  const cumN = N => { const o = new Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += frg[i]; if (i >= N) s -= frg[i - N]; if (i >= N - 1) o[i] = s; } return o; };
  const f20 = cumN(20), f60 = cumN(60);
  const z20 = new Array(n).fill(NaN);
  for (let i = 270; i < n; i++) { const w = f20.slice(i - 250, i); const m = mean(w), s = Math.sqrt(vari(w)); z20[i] = (f20[i] - m) / s; }
  console.log('\n━━ E0. 외국인 20일 누적 z — 동행 vs 선행 (진단) ━━');
  for (const [k, [a, b]] of Object.entries(SEG)) {
    const idx = segIdx(a, b - 21).filter(i => i >= 20 && Number.isFinite(z20[i]));
    const same = corr(idx.map(i => z20[i]), idx.map(i => C[i] / C[i - 20] - 1));
    const next = corr(idx.map(i => z20[i]), idx.map(i => C[i + 21] / C[i + 1] - 1));
    console.log(`  ${k.padEnd(11)} 같은 20일 수익 r = ${same.r.toFixed(2).padStart(5)}   다음 20일 수익 r = ${next.r.toFixed(2).padStart(5)}`);
  }
  // 2025~26 외국인 누적 (조원; 거래대금 단위 백만원)
  const sumBetween = (a, b) => { let s = 0; for (let i = 0; i < n; i++) if (D[i] > a && D[i] <= b) s += frg[i]; return s / 1e6; };
  const lv = d => C[D.findIndex(x => x >= d)];
  console.log(`  외국인 순매수: 2025-01~2026-06-22 ${sumBetween('20241231', '20260622').toFixed(1)}조원 (KOSPI 200 ${pct(lv('20260622') / lv('20250102') - 1)}) | 2026-06-23~10-20 ${sumBetween('20260622', '20261020').toFixed(1)}조원 (${pct(C[n - 1] / lv('20260622') - 1)})`);
  console.log(`  현재 외국인 20일 누적 ${(f20[n - 1] / 1e6).toFixed(1)}조원 · 60일 ${(f60[n - 1] / 1e6).toFixed(1)}조원`);

  // 월말 PBR 36개월 백분위 → 다음 달 매일 사용
  const vf = fp('kospi-valuation-monthly.json');
  const V = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf-8')) : [];
  const pctOf = new Map();
  for (let k = 35; k < V.length; k++) { const w = V.slice(k - 35, k + 1).map(v => v.pbr); pctOf.set(V[k].d, w.filter(x => x < V[k].pbr).length / 35); }
  const pbrPct = new Array(n).fill(NaN); let cur = NaN;
  for (let i = 0; i < n; i++) { if (pctOf.has(D[i])) cur = pctOf.get(D[i]); pbrPct[i] = cur; }
  const hi250 = D.map((_, i) => { if (i < 250) return NaN; let h = -1; for (let j = i - 250; j <= i; j++) h = Math.max(h, C[j]); return h; });

  console.log('\n━━ E1~E4 ━━');
  const valStart = D.indexOf(V[35]?.d);
  for (const [key, f] of [['E1 비싸고 외인20 매도→현금', f20], ['E2 비싸고 외인60 매도→현금', f60]]) {
    const r = lagged(i => !Number.isFinite(pbrPct[i]) ? 1 : (pbrPct[i] >= 0.8 && f[i] < 0 ? 0 : 1), 1);
    const s = perf(r, valStart, n - 1), m = perf(ret, valStart, n - 1), ex = s.cagr - m.cagr;
    const v = ex > 0 && s.calmar > m.calmar ? '✅ 통과' : (ex > -0.02 && s.mdd - m.mdd >= 0.10 ? '🟡 낙폭 축소 후보' : '기각');
    console.log(`  ${key.padEnd(26)} [${D[valStart]}~] CAGR ${pct(s.cagr)} MDD ${pct(s.mdd)} Calmar ${s.calmar.toFixed(2)} | 보유 ${pct(m.cagr)} / ${pct(m.mdd)} / ${m.calmar.toFixed(2)} | 연초과 ${pp(ex)} → ${v}`);
  }
  for (const [key, f] of [['E3 −15%·외인20 매도→현금', f20], ['E4 −15%·외인60 매도→현금', f60]]) {
    let h = 1;
    const sig = i => { if (!Number.isFinite(hi250[i]) || !Number.isFinite(f[i])) return null;
      if (h === 1 && C[i] / hi250[i] - 1 <= -0.15 && f[i] < 0) h = 0; else if (h === 0 && f[i] > 0) h = 1; return h; };
    judge(key, lagged(sig, 1));
  }
  // 이벤트: −15% 이후 외국인 20일 누적이 음→양 전환한 날
  const ev = [];
  for (let i = Math.max(i0, 251); i < n - 1; i++) if (f20[i - 1] < 0 && f20[i] > 0 && C[i] / hi250[i] - 1 <= -0.15) ev.push(i);
  for (const H of [20, 60]) {
    const evR = ev.filter(i => i + 1 + H < n).map(i => C[i + 1 + H] / C[i + 1] - 1);
    const all = []; for (let i = i0; i + 1 + H < n; i++) all.push(C[i + 1 + H] / C[i + 1] - 1);
    const w = welch(evR, all);
    console.log(`  이벤트 '−15% 후 외인 복귀' ${ev.length}회 → 다음 ${H}일 평균 ${pct(mean(evR))} vs 평소 ${pct(mean(all))} (t=${w.t.toFixed(2)}, 겹침 있음) · 이벤트 날짜: ${H === 20 ? ev.map(i => D[i]).join(' ') : ''}`);
  }
}

// ── F. 신용융자잔고 · 고객예탁금 (INDEX_SIGNAL_VERDICT.md F절) ──────────
if (ONLY.includes('F')) {
  const fund = new Map();
  for (const l of lines('market-funds-daily.jsonl')) { const r = JSON.parse(l); fund.set(r.d, { cap: +r.hts_avls / 100, crdt: +r.crdt_loan_rmnd, dep: +r.cust_dpmn_amt }); }   // cap 억원 환산
  const miss = D.slice(i0).filter(d => !fund.has(d) || !(fund.get(d).cap > 0) || !(fund.get(d).crdt > 0)).length;
  // 누락일은 직전 값 유지
  const crdt = [], dep = [], cap = []; let last = null;
  for (const d of D) { const f = fund.get(d); if (f && f.cap > 0 && f.crdt > 0 && f.dep > 0) last = f; crdt.push(last?.crdt ?? NaN); dep.push(last?.dep ?? NaN); cap.push(last?.cap ?? NaN); }
  const ratio = (a) => a.map((x, i) => x / cap[i]);
  const growth = (a, N) => a.map((x, i) => i >= N ? x / a[i - N] - 1 : NaN);
  const pctl = (a, L = 500) => a.map((x, i) => { if (i < L || !Number.isFinite(x)) return NaN; const w = a.slice(i - L, i).filter(Number.isFinite); return w.filter(v => v < x).length / w.length; });
  const IND = {
    'F1 신용/시총': pctl(ratio(crdt)), 'F2 신용 60일 증가율': pctl(growth(crdt, 60)),
    'F3 예탁금/시총': pctl(ratio(dep)), 'F4 예탁금 60일 증가율': pctl(growth(dep, 60)),
  };
  console.log(`\n━━ F. 신용·예탁금 ━━ (누락·0값 ${miss}일은 직전 값 유지)`);
  const lvl = (a, i) => a[i];
  console.log(`  현재(${D[n - 1]}) 신용융자 ${(crdt[n - 1] / 1e4).toFixed(1)}조원 · 예탁금 ${(dep[n - 1] / 1e4).toFixed(1)}조원 · 신용/시총 ${(crdt[n - 1] / cap[n - 1] * 100).toFixed(2)}%`);
  console.log('  진단: 극단 이후 KOSPI 200 수익 (상위5% / 하위5% / 평소)');
  for (const [k, p] of Object.entries(IND)) {
    for (const H of [20, 60, 120]) {
      const row = [];
      for (const [name, a, b] of [['IS', i0, isEnd], ['OOS', isEnd, n - 1]]) {
        const all = [], hi = [], lo = [];
        for (let i = a; i < Math.min(b, n - 1 - H); i++) { if (!Number.isFinite(p[i])) continue; const r = C[i + 1 + H] / C[i + 1] - 1; all.push(r); if (p[i] >= 0.95) hi.push(r); if (p[i] <= 0.05) lo.push(r); }
        const m = x => x.length ? pct(mean(x)) : '  -  ';
        row.push(`${name} ${m(hi).padStart(7)} / ${m(lo).padStart(7)} / ${m(all).padStart(6)}`);
      }
      console.log(`  ${(H === 20 ? k : '').padEnd(16)} ${String(H).padStart(3)}일  ${row.join('    ')}`);
    }
    console.log(`  ${''.padEnd(16)} 현재 백분위 ${(p[n - 1] * 100).toFixed(0)}%`);
  }
  console.log('\n  전략형');
  for (const [k, p, test] of [
    ['F1 신용/시총 ≥90% 현금', IND['F1 신용/시총'], x => x >= 0.9],
    ['F2 신용증가 ≥90% 현금', IND['F2 신용 60일 증가율'], x => x >= 0.9],
    ['F3 예탁금/시총 ≤10% 현금', IND['F3 예탁금/시총'], x => x <= 0.1],
    ['F4 예탁금증가 ≥90% 현금', IND['F4 예탁금 60일 증가율'], x => x >= 0.9],
  ]) judge(k, lagged(i => Number.isFinite(p[i]) ? (test(p[i]) ? 0 : 1) : null, 1));
}
