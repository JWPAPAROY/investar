/**
 * 신규 상장 보호예수 해제 판정 (사전 등록 LOCKUP_VERDICT.md, 1회 실행).
 * 실행: node --max-old-space-size=8192 scripts/lockup-verdict.js
 */
const fs = require('fs'), path = require('path');
const D = path.resolve(__dirname, '../data');
const IPO = JSON.parse(fs.readFileSync(path.join(D, 'lockup-ipos.json'), 'utf-8'));
const COST = 0.38, need = new Set(IPO.map(x => x.code));
const idx = new Map();
for (const l of fs.readFileSync(path.join(D, 'krx-index.jsonl'), 'utf-8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l), k = r.i.find(x => x[0] === '코스피'), q = r.i.find(x => x[0] === '코스닥');
  if (k && q && k[1] > 0 && q[1] > 0) idx.set(r.d, { K: k[1], Q: q[1] });
}
const recs = fs.readFileSync(path.join(D, 'krx-daily.jsonl'), 'utf-8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(r => idx.has(r.d)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d), N = days.length;
const px = new Map();
for (let i = 0; i < N; i++) for (const s of recs[i].s) {
  if (!need.has(s[0])) continue;
  let a = px.get(s[0]); if (!a) { a = new Array(N).fill(null); px.set(s[0], a); }
  a[i] = { c: s[4], cap: s[7] };
}
const ymd = s => s.replace(/-/g, '');
const firstIdxOnOrAfter = d => days.findIndex(x => x >= ymd(d));
function addMonths(iso, m) {
  const [y, mo, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo - 1 + m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo - 1 + m, Math.min(d, last))).toISOString().slice(0, 10);
}
function ret(code, i, j) {
  const a = px.get(code); if (!a || i < 0 || j >= N || j <= i) return null;
  let k = i; while (k >= 0 && !a[k]) k--; if (k < 0) return null;
  let last = a[k], v = 1;
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
const iret = (m, i, j) => (idx.get(days[j])[m] / idx.get(days[i])[m] - 1) * 100;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const f = v => (v >= 0 ? '+' : '') + v.toFixed(2);

function rows(M, a, b, extra = () => true) {
  const out = [];
  for (const x of IPO) {
    const L = firstIdxOnOrAfter(x.list), U = firstIdxOnOrAfter(addMonths(x.list, M));
    if (U < 0 || U + 25 >= N || U + a < L) continue;   // 구간 시작이 상장일 이후여야 한다 (2026-11-11 수정: 처음엔 U-20>L 를 모든 구간에 걸어 M1 표본이 잘렸다)
    const i = U + a, j = U + b;
    if (!px.get(x.code)?.[L]) continue;
    const s = ret(x.code, i, j); if (s == null) continue;
    const m = x.cls === 'Y' ? 'K' : 'Q';
    const run = ret(x.code, L, U - 1);
    const r = { code: x.code, name: x.name, cls: x.cls, U: days[U], month: days[U].slice(0, 6), ex: s - iret(m, i, j), run };
    if (extra(r)) out.push(r);
  }
  return out;
}
function summarize(R, cost) {
  const g = new Map(); for (const r of R) { if (!g.has(r.month)) g.set(r.month, []); g.get(r.month).push(r.ex - cost); }
  const C = [...g].map(([m, v]) => ({ m, v: mean(v) }));
  const ms = C.map(c => c.v), M = mean(ms), t = M / (sd(ms) / Math.sqrt(ms.length));
  const early = mean(C.filter(c => c.m < '202407').map(c => c.v)), late = mean(C.filter(c => c.m >= '202407').map(c => c.v));
  return { n: R.length, k: C.length, M, t, early, late, stock: mean(R.map(r => r.ex - cost)) };
}
const line = (lab, s) => console.log(`${lab.padEnd(28)} n=${String(s.n).padStart(3)} 월=${String(s.k).padStart(2)}  평균 ${f(s.M).padStart(6)}%p  t=${s.t.toFixed(2).padStart(5)}  앞 ${f(s.early)} · 뒤 ${f(s.late)}  (종목평균 ${f(s.stock)})`);

console.log(`데이터 ${days[0]} ~ ${days[N - 1]} · IPO ${IPO.length}\n\n════ 판정 ════`);
for (const M of [1, 3, 6, 12]) {
  const h1 = summarize(rows(M, -1, 5), 0), h2 = summarize(rows(M, 5, 25), COST);
  line(`H1-${M} 해제 압력 U-1→U+5`, h1);
  console.log(`   → ${h1.M <= -1 && h1.t <= -2.7 && h1.early < 0 && h1.late < 0 ? '✅ 보유 규칙 후보' : '❌ 기각'}`);
  line(`H2-${M} 되돌림 U+5→U+25`, h2);
  console.log(`   → ${h2.M >= 1 && h2.t >= 2.7 && h2.early > 0 && h2.late > 0 ? '✅ 관측 후보' : '❌ 기각'}`);
}
console.log('\n════ 병기 (판정 무관) ════');
for (const M of [1, 3, 6, 12]) {
  line(`M${M} 선반영 U-20→U-1`, summarize(rows(M, -20, -1), 0));
  line(`M${M} 해제일 U-1→U`, summarize(rows(M, -1, 0), 0));
  line(`M${M} 다음날 U→U+1`, summarize(rows(M, 0, 1), 0));
  const all = rows(M, -1, 5), med = [...all.map(r => r.run)].sort((a, b) => a - b)[all.length >> 1];
  line(`M${M} H1 · 상장 후 상승 상위`, summarize(all.filter(r => r.run > med), 0));
  line(`M${M} H1 · 상장 후 상승 하위`, summarize(all.filter(r => r.run <= med), 0));
  line(`M${M} H1 · KOSDAQ만`, summarize(all.filter(r => r.cls === 'K'), 0));
}
