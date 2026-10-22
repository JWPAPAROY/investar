/**
 * index-breadth-test.js — 시장 폭·쏠림 신호로 급락 미리 피하기 (2026-10-22)
 *
 * 판정 기준은 INDEX_BREADTH_VERDICT.md 에 데이터 수집이 끝나기 전에 등록했다. 신호·임계값·구간을 여기서 바꾸지 말 것.
 * 데이터: data/krx-daily-2010.jsonl (collect-krx-daily.js --out=krx-daily-2010.jsonl, 행 9번째 원소 = 시장 K/Q)
 *         data/kospi-index-long.jsonl (+krx-index.jsonl 보충)
 * 실행: node --max-old-space-size=8192 scripts/index-breadth-test.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const COST = 0.0005, SEAM = 0.305, MIN_N = 300;
const fp = f => path.resolve(__dirname, '../data', f);
const lines = f => fs.existsSync(fp(f)) ? fs.readFileSync(fp(f), 'utf-8').split('\n').filter(s => s.trim()) : [];

// ── 지수 ─────────────────────────────────────────────────────────────
const px = new Map();
for (const l of lines('kospi-index-long.jsonl')) { const r = JSON.parse(l); if (!r.h && r.k200[0] > 0) px.set(r.d, r.k200[0]); }
for (const l of lines('krx-index.jsonl')) {
  const r = JSON.parse(l); if (px.has(r.d)) continue;
  const k = r.i.find(x => x[0] === '코스피 200'); if (k && k[1] > 0) px.set(r.d, k[1]);
}

/** 단조 덱: 최근 W개 값의 최대(또는 최소)를 O(1) 상각으로 */
class MonoDeque {
  constructor(W, isMax) { this.W = W; this.isMax = isMax; this.q = []; this.h = 0; }
  push(t, v) {
    const q = this.q, better = this.isMax ? (a, b) => a >= b : (a, b) => a <= b;
    while (q.length > this.h && better(v, q[q.length - 1][1])) q.pop();
    q.push([t, v]);
    while (q[this.h][0] <= t - this.W) this.h++;
    if (this.h > 1024) { this.q = q.slice(this.h); this.h = 0; }
  }
  top() { return this.q[this.h][1]; }
}

(async () => {
  // ── 종목 파일을 날짜순으로 (수집 순서가 날짜순이 아닐 수 있음) ─────────
  const byDate = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(fp('krx-daily-2010.jsonl')) });
  for await (const l of rl) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    // 유가 보통주만, 필요한 필드만 남겨 메모리 절약: [code, close, mktcap]
    byDate.set(r.d, r.s.filter(x => x[8] === 'K' && x[0].endsWith('0')).map(x => [x[0], x[4], x[7]]));
  }
  const SD = [...byDate.keys()].sort();
  console.log(`종목 데이터 ${SD.length}일 (${SD[0]}~${SD.at(-1)})`);

  // ── 일별 폭 지표 ────────────────────────────────────────────────────
  const prev = new Map();          // code → 전일 종가
  const hist = new Map();          // code → { t0, hi: MonoDeque, lo: MonoDeque }
  const B = new Map();             // d → { adv, nhnl, top2, capR, eqR }
  let t = 0, seams = 0;
  for (const d of SD) {
    t++;
    const rows = byDate.get(d);
    let up = 0, dn = 0, nh = 0, nl = 0, cnt = 0, capPrev = 0, capRet = 0, eqSum = 0, eqN = 0, total = 0, c1 = 0, c2 = 0;
    for (const [code, close, cap] of rows) {
      total += cap;
      if (cap > c1) { c2 = c1; c1 = cap; } else if (cap > c2) c2 = cap;
      const p = prev.get(code);
      prev.set(code, close);
      let h = hist.get(code);
      if (p > 0) {
        const r = close / p - 1;
        if (Math.abs(r) > SEAM) { seams++; h = null; }
        else {
          cnt++; if (r > 0) up++; else if (r < 0) dn++;
          eqSum += r; eqN++;
          const capP = cap / (1 + r); capPrev += capP; capRet += capP * r;
        }
      }
      if (!h) { h = { t0: t, hi: new MonoDeque(250, true), lo: new MonoDeque(250, false) }; hist.set(code, h); }
      // 신고가/신저가: 직전 250일(당일 제외) 대비, 250일 이력 채운 종목만
      if (t - h.t0 >= 250) { if (close > h.hi.top()) nh++; if (close < h.lo.top()) nl++; }
      h.hi.push(t, close); h.lo.push(t, close);
    }
    if (rows.length < MIN_N || cnt < MIN_N) continue;
    B.set(d, { adv: up / cnt, nhnl: (nh - nl) / cnt, top2: (c1 + c2) / total, capR: capRet / capPrev, eqR: eqSum / eqN });
  }
  console.log(`폭 지표 ${B.size}일 · 이음매 제외 ${seams}건`);

  // ── 지수 날짜에 맞춤 ────────────────────────────────────────────────
  const D = [...px.keys()].filter(d => B.has(d)).sort(), n = D.length;
  const C = D.map(d => px.get(d)), X = D.map(d => B.get(d));
  const ret = D.map((_, i) => i ? C[i] / C[i - 1] - 1 : 0);
  const i0 = D.findIndex(d => d >= '20110103');
  console.log(`분석 ${n}일 (${D[0]}~${D[n - 1]}) · 평가 시작 ${D[i0]}\n`);

  const roll = (arr, N, f) => arr.map((_, i) => i >= N - 1 ? f(arr.slice(i - N + 1, i + 1)) : NaN);
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const pctRank = (a, L = 250) => a.map((x, i) => { if (i < L || !Number.isFinite(x)) return NaN; const w = a.slice(i - L, i).filter(Number.isFinite); return w.filter(v => v < x).length / w.length; });
  const adv20 = roll(X.map(x => x.adv), 20, avg), nhnl20 = roll(X.map(x => x.nhnl), 20, avg);
  const top2 = X.map(x => x.top2), top2d60 = top2.map((v, i) => i >= 60 ? v - top2[i - 60] : NaN);
  const cum = r => { const o = [1]; for (let i = 1; i < n; i++) o.push(o[i - 1] * (1 + r[i])); return o; };
  const capIdx = cum(X.map(x => x.capR)), eqIdx = cum(X.map(x => x.eqR));
  const gap60 = D.map((_, i) => i >= 60 ? (capIdx[i] / capIdx[i - 60]) - (eqIdx[i] / eqIdx[i - 60]) : NaN);
  const nearHi = C.map((c, i) => { if (i < 60) return false; let h = 0; for (let j = i - 59; j <= i; j++) h = Math.max(h, C[j]); return c >= h * 0.97; });
  const pAdv = pctRank(adv20), pTop = pctRank(top2d60), pGap = pctRank(gap60);

  const SIG = {
    'S1 상승종목 고갈': i => Number.isFinite(pAdv[i]) ? (nearHi[i] && pAdv[i] <= 0.2) : null,
    'S2 신고가 고갈': i => Number.isFinite(nhnl20[i]) && i >= 250 ? (nearHi[i] && nhnl20[i] < 0) : null,
    'S3 시총 쏠림 가속': i => Number.isFinite(pTop[i]) ? pTop[i] >= 0.9 : null,
    'S4 대형주 독주': i => Number.isFinite(pGap[i]) ? pGap[i] >= 0.9 : null,
  };

  // ── 운용: 켜지면 현금, 신호일 종가 판단 → 다음 거래일 종가 체결 ──────────
  function simulate(on) {
    const r = new Array(n).fill(0), w = new Array(n).fill(1); let h = 1, pend = null;
    for (let i = i0 + 1; i < n; i++) {
      r[i] = h * ret[i];
      if (pend !== null) { r[i] = (1 + r[i]) * (1 - COST * Math.abs(pend - h)) - 1; h = pend; pend = null; }
      w[i] = h;
      const s = on(i); if (s !== null) { const want = s ? 0 : 1; if (want !== h) pend = want; }
    }
    return { r, w };
  }
  const yrs = (a, b) => (Date.UTC(+D[b].slice(0, 4), +D[b].slice(4, 6) - 1, +D[b].slice(6)) - Date.UTC(+D[a].slice(0, 4), +D[a].slice(4, 6) - 1, +D[a].slice(6))) / (365.25 * 864e5);
  function perf(r, a, b) { let v = 1, pk = 1, mdd = 0; for (let i = a + 1; i <= b; i++) { v *= 1 + r[i]; pk = Math.max(pk, v); mdd = Math.min(mdd, v / pk - 1); } return { cagr: Math.pow(v, 1 / yrs(a, b)) - 1, mdd }; }
  const segRet = (r, a, b) => { let v = 1; for (let i = a + 1; i <= b; i++) v *= 1 + r[i]; return v - 1; };

  // ── 급락 이벤트 ─────────────────────────────────────────────────────
  const events = [];
  for (let i = Math.max(i0, 60); i < n; i++) {
    let hi = -1, hk = -1; for (let j = i - 60; j < i; j++) if (C[j] > hi) { hi = C[j]; hk = j; }
    if (C[i] / hi - 1 > -0.15) continue;
    let tr = i; for (let j = i; j < n && C[j] < hi; j++) if (C[j] < C[tr]) tr = j;   // 고점 회복 전까지 최저
    const last = events.at(-1);
    if (last && hk <= last.trough) { if (C[tr] < C[last.trough]) last.trough = tr; }
    else events.push({ peak: hk, trough: tr });
  }
  const pct = (x, k = 1) => (x >= 0 ? '+' : '') + (x * 100).toFixed(k) + '%';
  console.log(`급락 이벤트 ${events.length}개 (60일 고점 대비 −15%)`);
  events.forEach(e => console.log(`  ${D[e.peak]} → ${D[e.trough]}  ${pct(C[e.trough] / C[e.peak] - 1)}  ${D[e.peak] < '20210101' ? 'IS' : 'OOS'}`));

  // ── 결과 ────────────────────────────────────────────────────────────
  const hold = perf(ret, i0, n - 1);
  console.log(`\n보유  CAGR ${pct(hold.cagr)} MDD ${pct(hold.mdd)}`);
  console.log('\n신호'.padEnd(18) + '현금비중  CAGR   MDD   | 회피율 IS  OOS | 2026-06 회피 | 판정');
  // 2026-06 급락 = 6월 고점 이벤트 중 가장 깊은 것 (6/22 고점 → 10/20). 6/02 단기 조정이 먼저 잡히지 않게
  const ev26 = events.filter(e => D[e.peak] >= '20260601' && D[e.peak] <= '20260630').sort((a, b) => C[a.trough] / C[a.peak] - C[b.trough] / C[b.peak])[0];
  for (const [k, on] of Object.entries(SIG)) {
    const { r, w } = simulate(on);
    const s = perf(r, i0, n - 1);
    let cashDays = 0; for (let i = i0 + 1; i < n; i++) cashDays += 1 - w[i];
    const avoid = e => 1 - segRet(r, e.peak, e.trough) / segRet(ret, e.peak, e.trough);
    const seg = f => { const es = events.filter(f); return es.length ? avg(es.map(avoid)) : NaN; };
    const aIS = seg(e => D[e.peak] < '20210101'), aOOS = seg(e => D[e.peak] >= '20210101');
    const ok = aIS >= 0.4 && aOOS >= 0.4, cheap = s.cagr >= hold.cagr - 0.02;
    const v = ok && cheap ? '✅ 통과' : ok ? '🟡 부분' : '기각';
    console.log(`${k.padEnd(14)} ${(cashDays / (n - 1 - i0) * 100).toFixed(0).padStart(5)}%  ${pct(s.cagr).padStart(6)} ${pct(s.mdd, 0).padStart(5)} | ${pct(aIS, 0).padStart(6)} ${pct(aOOS, 0).padStart(5)} | ${ev26 ? pct(avoid(ev26), 0).padStart(8) : '   -'}     | ${v}`);
    // 이벤트별
    console.log('    ' + events.map(e => `${D[e.peak].slice(0, 6)} ${pct(avoid(e), 0)}`).join(' · '));
  }

  // 현재
  const i = n - 1;
  console.log(`\n현재(${D[i]}) 상승종목 20일 ${(adv20[i] * 100).toFixed(0)}% (백분위 ${(pAdv[i] * 100).toFixed(0)}) · 신고가−신저가 ${(nhnl20[i] * 100).toFixed(1)}% · 상위2 비중 ${(top2[i] * 100).toFixed(1)}% (60일 변화 백분위 ${(pTop[i] * 100).toFixed(0)}) · 대형−동일 60일 ${pct(gap60[i])} (백분위 ${(pGap[i] * 100).toFixed(0)}) · 60일 고점 3% 이내 ${nearHi[i]}`);
  console.log('켜진 신호: ' + (Object.entries(SIG).filter(([, f]) => f(i)).map(([k]) => k).join(', ') || '없음'));
})();
