/**
 * KOSPI200·KOSDAQ150 정기변경 강제 매매 판정 (사전 등록 INDEX_REBAL_VERDICT.md, 1회 실행).
 * 입력: data/index-rebal-events.json, data/index-rebal-codes.json (index-rebal-names.js 산출)
 * 실행: node --max-old-space-size=8192 scripts/index-rebal-verdict.js
 */
const fs = require('fs'), path = require('path');
const D = path.resolve(__dirname, '../data');
const EV = JSON.parse(fs.readFileSync(path.join(D, 'index-rebal-events.json'), 'utf-8')).events;
const CODES = JSON.parse(fs.readFileSync(path.join(D, 'index-rebal-codes.json'), 'utf-8'));
const COST = 0.38;
const need = new Set(CODES.map(x => x.code));

const idx = new Map();
for (const l of fs.readFileSync(path.join(D, 'krx-index.jsonl'), 'utf-8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l), k = r.i.find(x => x[0] === '코스피'), q = r.i.find(x => x[0] === '코스닥');
  if (k && q && k[1] > 0 && q[1] > 0) idx.set(r.d, { K: k[1], Q: q[1] });
}
const recs = fs.readFileSync(path.join(D, 'krx-daily.jsonl'), 'utf-8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(r => idx.has(r.d)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d), N = days.length;
const px = new Map();   // code -> array per day {o,c,cap}
for (let i = 0; i < N; i++) for (const s of recs[i].s) {
  if (!need.has(s[0])) continue;
  let a = px.get(s[0]); if (!a) { a = new Array(N).fill(null); px.set(s[0], a); }
  a[i] = { o: s[1], c: s[4], cap: s[7] };
}
const ymd = s => s.replace(/-/g, '');
const iAfter = d => days.findIndex(x => x > ymd(d));       // 첫 거래일 > d
const iBefore = d => { let k = -1; for (let i = 0; i < N; i++) if (days[i] < ymd(d)) k = i; return k; };

// 종가 i → 종가 j 누적수익(%). 결측일은 보합(마지막 종가 청산).
function stockRet(code, i, j, fromOpen = false) {
  const a = px.get(code); if (!a || i < 0 || j >= N || j <= i - (fromOpen ? 1 : 0)) return null;
  let v = 1, last = a[i];
  if (!last) return null;
  if (fromOpen) { if (!(last.o > 0)) return null; v = last.c / last.o; }
  for (let t = i + 1; t <= j; t++) {
    const b = a[t];
    if (b && b.c > 0 && last.c > 0) {
      let r = b.c / last.c;
      if ((r > 1.31 || r < 0.69) && b.cap > 0 && last.cap > 0) r = b.cap / last.cap;
      v *= r; last = b;
    }
  }
  return (v - 1) * 100;
}
function idxRet(m, i, j, fromOpen = false) {
  const a = idx.get(days[i]), b = idx.get(days[j]);
  if (fromOpen) { const r = recsIdxOpen(m, i); return (b[m] / r - 1) * 100; }
  return (b[m] / a[m] - 1) * 100;
}
const idxOpen = new Map();
for (const l of fs.readFileSync(path.join(D, 'krx-index.jsonl'), 'utf-8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l), k = r.i.find(x => x[0] === '코스피'), q = r.i.find(x => x[0] === '코스닥');
  if (k && q) idxOpen.set(r.d, { K: k[2], Q: q[2] });
}
const recsIdxOpen = (m, i) => idxOpen.get(days[i])[m];

// ── 이벤트 구간 ─────────────────────────────────────────────────────
const W = EV.map(e => {
  const A1 = iAfter(e.ann), R = iBefore(e.eff), A = A1 - 1;
  return { id: e.id, A, A1, R, R10: R + 10 };
});
console.log('회차  A1        R         R+10      (A1→R 거래일)');
for (const w of W) console.log(`${w.id} ${days[w.A1]} ${days[w.R]} ${days[w.R10] || '—'} (${w.R - w.A1})`);
console.log('');

function measure(listKey, seg) {
  const out = [];   // {ev, grp, code, name, ex}
  for (const x of CODES.filter(c => c.list.endsWith(listKey))) {
    const w = W.find(v => v.id === x.ev), grp = x.list.slice(0, 4), m = grp === 'k200' ? 'K' : 'Q';
    let i, j, open = false;
    if (seg === 'A1R') [i, j] = [w.A1, w.R];
    else if (seg === 'A1R_open') [i, j, open] = [w.A1, w.R, true];
    else if (seg === 'RR10') [i, j] = [w.R, w.R10];
    else if (seg === 'pre20') [i, j] = [w.A - 20, w.A];
    if (j >= N || i < 0) continue;
    const s = stockRet(x.code, i, j, open);
    if (s == null) continue;
    out.push({ ev: x.ev, grp, code: x.code, name: x.name, ex: s - idxRet(m, i, j, open), cap: px.get(x.code)[i]?.cap });
  }
  return out;
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function clusters(rows, cost) {
  const g = new Map();
  for (const r of rows) { const k = r.ev + '|' + r.grp; if (!g.has(k)) g.set(k, []); g.get(k).push(r.ex - cost); }
  return [...g].map(([k, v]) => ({ ev: k.split('|')[0], grp: k.split('|')[1], n: v.length, m: mean(v) }));
}
const f = v => (v >= 0 ? '+' : '') + v.toFixed(2);
function report(label, rows, cost, judge) {
  const C = clusters(rows, cost), ms = C.map(c => c.m);
  const M = mean(ms), t = M / (sd(ms) / Math.sqrt(ms.length));
  const k2 = C.filter(c => c.grp === 'k200').map(c => c.m), k1 = C.filter(c => c.grp === 'k150').map(c => c.m);
  const late = C.filter(c => c.ev >= '2024-06').map(c => c.m);
  console.log(`── ${label} — 종목 ${rows.length} · 군집 ${C.length} · 비용 ${cost}`);
  console.log(`   군집평균 ${f(M)}%p  t=${t.toFixed(2)}  KOSPI200 ${f(mean(k2))} · KOSDAQ150 ${f(mean(k1))} · 뒤5회 ${f(mean(late))} · 종목평균 ${f(mean(rows.map(r => r.ex - cost)))}`);
  console.log('   회차별 (K200 / K150): ' + [...new Set(C.map(c => c.ev))].map(ev => {
    const a = C.find(c => c.ev === ev && c.grp === 'k200'), b = C.find(c => c.ev === ev && c.grp === 'k150');
    return `${ev} ${a ? f(a.m) : '—'}/${b ? f(b.m) : '—'}`; }).join(' · '));
  if (judge) {
    const c1 = M >= 1.0, c2 = t >= 2.0, c3 = mean(k2) > 0 && mean(k1) > 0, c4 = mean(late) > 0;
    console.log(`   C1 ${c1 ? '✅' : '❌'} C2 ${c2 ? '✅' : '❌'} C3 ${c3 ? '✅' : '❌'} C4 ${c4 ? '✅' : '❌'} → ${c1 && c2 && c3 && c4 ? '관측 후보' : '기각'}`);
  }
  console.log('');
  return { M, t };
}

console.log('════ 판정 ════\n');
report('H1 편입 수급: A1 종가 → R 종가', measure('_in', 'A1R'), COST, true);
report('H2 편출 반등: R 종가 → R+10 종가', measure('_out', 'RR10'), COST, true);

console.log('════ 병기 (판정 무관) ════\n');
report('편입 R → R+10 (사후 반락)', measure('_in', 'RR10'), 0);
report('편출 A1 → R (발표 뒤 매도 압력)', measure('_out', 'A1R'), 0);
report('편입 발표 전 20일 → A (선반영)', measure('_in', 'pre20'), 0);
report('편출 발표 전 20일 → A', measure('_out', 'pre20'), 0);
report('H1 변형: A1 시가 매수 → R 종가', measure('_in', 'A1R_open'), COST);
// 시총 구간
const h1 = measure('_in', 'A1R');
const caps = h1.map(r => r.cap).sort((a, b) => a - b), med = caps[caps.length >> 1];
console.log(`H1 시총 중앙(${(med / 1e8).toFixed(0)}억) 이하 ${f(mean(h1.filter(r => r.cap <= med).map(r => r.ex - COST)))} · 초과 ${f(mean(h1.filter(r => r.cap > med).map(r => r.ex - COST)))}`);
