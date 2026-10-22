/**
 * index-vol-credit-test.js — VKOSPI · 신용 스프레드(근사)로 급락 미리 피하기 (2026-10-22)
 *
 * 판정 기준은 INDEX_VOL_CREDIT_VERDICT.md 에 데이터 수집이 끝나기 전에 등록했다. 신호·임계값·구간을 여기서 바꾸지 말 것.
 * 이벤트·회피율·판정·운용은 index-breadth-test.js 와 동일하게 맞췄다.
 * 데이터: data/krx-drv-index.jsonl · data/krx-bond-index.jsonl (collect-krx-drv-bond.js), kospi-index-long.jsonl
 * 실행: node scripts/index-vol-credit-test.js
 */
const fs = require('fs');
const path = require('path');

const COST = 0.0005;
const fp = f => path.resolve(__dirname, '../data', f);
const lines = f => fs.existsSync(fp(f)) ? fs.readFileSync(fp(f), 'utf-8').split('\n').filter(s => s.trim()) : [];

// ── 데이터 ───────────────────────────────────────────────────────────
const px = new Map();
for (const l of lines('kospi-index-long.jsonl')) { const r = JSON.parse(l); if (!r.h && r.k200[0] > 0) px.set(r.d, r.k200[0]); }
for (const l of lines('krx-index.jsonl')) {
  const r = JSON.parse(l); if (px.has(r.d)) continue;
  const k = r.i.find(x => x[0] === '코스피 200'); if (k && k[1] > 0) px.set(r.d, k[1]);
}
const vk = new Map(), spread = new Map();
for (const l of lines('krx-drv-index.jsonl')) {
  const r = JSON.parse(l); const v = r.i.find(x => x[0] === '코스피 200 변동성지수');
  if (v && v[1] > 0) vk.set(r.d, v[1]);
}
for (const l of lines('krx-bond-index.jsonl')) {
  const r = JSON.parse(l);
  const all = r.b.find(x => x[0] === 'KRX 채권지수'), ktb = r.b.find(x => x[0] === 'KTB 지수');
  if (all && ktb && all[4] > 0 && ktb[4] > 0) spread.set(r.d, all[4] - ktb[4]);
}
const D = [...px.keys()].sort(), n = D.length, C = D.map(d => px.get(d));
const ret = D.map((_, i) => i ? C[i] / C[i - 1] - 1 : 0);
const i0 = D.findIndex(d => d >= '20110103');
const ffill = m => { let last = NaN, miss = 0; const o = D.map(d => { if (m.has(d)) last = m.get(d); else miss++; return last; }); return [o, miss]; };
const [VK, mV] = ffill(vk), [SP, mS] = ffill(spread);
console.log(`KOSPI 200 ${n}일 (${D[0]}~${D[n - 1]}) | VKOSPI ${vk.size}일(누락 ${mV}, 직전값 유지) | 스프레드 ${spread.size}일(누락 ${mS})`);

// ── 지표 ─────────────────────────────────────────────────────────────
const pctRank = (a, L) => a.map((x, i) => { if (i < L || !Number.isFinite(x)) return NaN; const w = a.slice(i - L, i).filter(Number.isFinite); return w.length < L * 0.8 ? NaN : w.filter(v => v < x).length / w.length; });
const rv20 = C.map((_, i) => {
  if (i < 20) return NaN; let s = 0, s2 = 0;
  for (let j = i - 19; j <= i; j++) { const r = Math.log(C[j] / C[j - 1]); s += r; s2 += r * r; }
  const m = s / 20; return Math.sqrt(Math.max(0, s2 / 20 - m * m) * 252) * 100;
});
const vkCh5 = VK.map((v, i) => i >= 5 ? v / VK[i - 5] - 1 : NaN);
const vkGap = VK.map((v, i) => v - rv20[i]);
const spCh60 = SP.map((v, i) => i >= 60 ? v - SP[i - 60] : NaN);
const nearHi = C.map((c, i) => { if (i < 60) return false; let h = 0; for (let j = i - 59; j <= i; j++) h = Math.max(h, C[j]); return c >= h * 0.97; });
const pV1 = pctRank(vkCh5, 250), pV2 = pctRank(vkGap, 250), pV3 = pctRank(VK, 250), pC1 = pctRank(spCh60, 250), pC2 = pctRank(SP, 500);
const fin = x => Number.isFinite(x);
const SIG = {
  'V1 공포 급등': i => fin(pV1[i]) ? pV1[i] >= 0.9 : null,
  'V2 내재>실현': i => fin(pV2[i]) ? pV2[i] >= 0.9 : null,
  'V3 안주': i => fin(pV3[i]) ? (pV3[i] <= 0.1 && nearHi[i]) : null,
  'C1 스프레드 확대': i => fin(pC1[i]) ? pC1[i] >= 0.9 : null,
  'C2 스프레드 수준': i => fin(pC2[i]) ? pC2[i] >= 0.9 : null,
};

// ── 운용 · 이벤트 · 판정 (index-breadth-test.js 와 동일) ─────────────────
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
const avg = a => a.reduce((s, x) => s + x, 0) / a.length;

const events = [];
for (let i = Math.max(i0, 60); i < n; i++) {
  let hi = -1, hk = -1; for (let j = i - 60; j < i; j++) if (C[j] > hi) { hi = C[j]; hk = j; }
  if (C[i] / hi - 1 > -0.15) continue;
  let tr = i; for (let j = i; j < n && C[j] < hi; j++) if (C[j] < C[tr]) tr = j;
  const last = events.at(-1);
  if (last && hk <= last.trough) { if (C[tr] < C[last.trough]) last.trough = tr; }
  else events.push({ peak: hk, trough: tr });
}
const pct = (x, k = 1) => (x >= 0 ? '+' : '') + (x * 100).toFixed(k) + '%';
console.log(`급락 이벤트 ${events.length}개 (60일 고점 대비 −15%)`);
events.forEach(e => console.log(`  ${D[e.peak]} → ${D[e.trough]}  ${pct(C[e.trough] / C[e.peak] - 1)}  ${D[e.peak] < '20210101' ? 'IS' : 'OOS'}`));

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
  console.log('    ' + events.map(e => `${D[e.peak].slice(0, 6)} ${pct(avoid(e), 0)}`).join(' · '));
}
const i = n - 1;
console.log(`\n현재(${D[i]}) VKOSPI ${VK[i]?.toFixed(1)} (백분위 ${(pV3[i] * 100).toFixed(0)}) · 5일 변화 ${pct(vkCh5[i])} · 내재−실현 ${vkGap[i]?.toFixed(1)}p · 스프레드 ${(SP[i] * 100).toFixed(0)}bp (500일 백분위 ${(pC2[i] * 100).toFixed(0)}) · 60일 변화 ${(spCh60[i] * 100).toFixed(0)}bp`);
console.log('켜진 신호: ' + (Object.entries(SIG).filter(([, f]) => f(i)).map(([k]) => k).join(', ') || '없음'));
