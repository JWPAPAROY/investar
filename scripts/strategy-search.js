/**
 * strategy-search.js — 최고 승률·수익 조합 탐색 (2026-08-25)
 *
 * ⚠️ 이 스크립트의 목적은 "최고를 찾는 것"이 아니라 **"찾은 것이 진짜인지 가리는 것"**이다.
 *   단일 4.6년 표본에서 수십 조합을 돌려 1등을 고르면 그건 발견이 아니라 과최적화다.
 *   그래서 표본을 시간순으로 둘로 가른다:
 *     **학습(IS)** 2022-01~2024-06 — 여기서만 고른다
 *     **검증(OOS)** 2024-07~2026-08 — 고른 뒤 한 번만 본다. **이것이 답이다.**
 *   IS 1등과 OOS 성적의 괴리가 곧 과최적화의 크기다.
 *
 * 탐색 공간(의도적으로 작게): 오늘까지 개별 검정을 통과한 블록만 조합한다.
 *   팩터 5종 × K 3종 × 리밸런싱 3종 × 비중 2종 = 90조합.
 *   (검정 통과 못 한 거래량·갭·모멘텀 계열은 애초에 넣지 않는다 — 넣으면 노이즈만 늘린다)
 *
 * 비용: 회전율 × 왕복 0.38% 차감. 벤치마크는 비용 미차감(전략에 불리).
 * 실행: node --max-old-space-size=8192 scripts/strategy-search.js
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const BUY = 2, LOOK = 20;
const CAPMIN = 3000e8, VALMIN = 10e8;
const FEE = 0.015, TAX = 0.15, SLIP = 0.10;
const ROUND = (FEE + SLIP) + (FEE + SLIP + TAX);
const SPLIT = arg('split', '20240701');

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pct = v => (v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(8));

// ── 데이터 ─────────────────────────────────────────────────────────────
const master = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/krx-master.json'), 'utf-8')).rows;
const common = new Set(master.filter(r => r.stkType === '보통주').map(r => r.code));
const recs = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d), N = days.length;
const byDay = recs.map(r => { const m = new Map(); for (const s of r.s) if (common.has(s[0])) m.set(s[0], s); return m; });
const row = (c, i) => (i >= 0 && i < N ? byDay[i].get(c) : undefined);
const close = (c, i) => { const r = row(c, i); return r && r[4] > 0 ? r[4] : null; };
const capAt = (c, i) => { const r = row(c, i); return r ? r[7] : null; };

// 재무 point-in-time
const finByCode = new Map();
for (const r of JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/financials.json'), 'utf-8')).rows) {
  const y = +r.ym.slice(0, 4), m = +r.ym.slice(4, 6);
  const end = new Date(Date.UTC(y, m, 0));
  const avail = new Date(end.getTime() + (m === 12 ? 90 : 45) * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  if (!finByCode.has(r.code)) finByCode.set(r.code, []);
  finByCode.get(r.code).push({ avail, bps: r.bps, eps: r.eps });
}
for (const a of finByCode.values()) a.sort((x, y) => x.avail.localeCompare(y.avail));
const finAt = (c, d) => {
  const a = finByCode.get(c); if (!a) return null;
  let lo = 0, hi = a.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].avail <= d) { best = a[m]; lo = m + 1; } else hi = m - 1; }
  return best;
};

// ── 일별 후보 피처 (한 번만 계산) ──────────────────────────────────────
console.log('피처 계산 중...');
const cand = new Map();   // i -> [{c, cap, vol20, pbr, per}]
for (let i = LOOK + 5; i < N; i++) {
  const rows = [];
  for (const r of byDay[i].values()) {
    const [c, , , , cl, , , cap] = r;
    if (!(cl > 0) || !(cap >= CAPMIN)) continue;
    const closes = [];
    let ok = true, vsum = 0;
    for (let k = LOOK; k >= 0; k--) {
      const p = row(c, i - k); if (!p || !(p[4] > 0)) { ok = false; break; }
      closes.push(p[4]); vsum += (p[6] || 0);
    }
    if (!ok || !(vsum / (LOOK + 1) >= VALMIN)) continue;
    const rets = [];
    for (let k = 1; k < closes.length; k++) rets.push(((closes[k] - closes[k - 1]) / closes[k - 1]) * 100);
    const fin = finAt(c, days[i]);
    rows.push({ c, cap, vol20: sd(rets), pbr: fin && fin.bps > 0 ? cl / fin.bps : null, per: fin && fin.eps > 0 ? cl / fin.eps : null });
  }
  rows.sort((a, b) => b.cap - a.cap);
  const top = rows.slice(0, 300);
  const rank = (key, asc) => {
    const a = top.filter(r => r[key] != null && isFinite(r[key]) && r[key] > 0);
    a.sort((x, y) => (asc ? x[key] - y[key] : y[key] - x[key]));
    a.forEach((r, k) => { r['p_' + key] = a.length > 1 ? 1 - k / (a.length - 1) : 1; });
  };
  rank('pbr', true); rank('vol20', true); rank('per', true); rank('cap', false);  // p_* : 1 = 저PBR/저변동/저PER/대형
  cand.set(i, top);
}
console.log(`후보 준비 완료 (${cand.size}일)\n`);

// ── 팩터 조합 ──────────────────────────────────────────────────────────
const FACTORS = {
  'PBR': r => r.p_pbr,
  'PBR+저변동': r => (r.p_pbr != null && r.p_vol20 != null) ? r.p_pbr + r.p_vol20 : null,
  'PBR+대형': r => (r.p_pbr != null && r.p_cap != null) ? r.p_pbr + r.p_cap : null,
  'PBR+PER': r => (r.p_pbr != null && r.p_per != null) ? r.p_pbr + r.p_per : null,
  '저변동': r => r.p_vol20,
};

function simulate(fkey, K, HOLD, weight, from, to) {
  const idxs = [];
  for (let i = LOOK + 5; i + BUY + HOLD + BUY < N; i += HOLD) {
    if (days[i] >= from && days[i] <= to) idxs.push(i);
  }
  if (idxs.length < 4) return null;
  const fn = FACTORS[fkey];
  let nav = 1, prev = new Map();
  const rets = [], navPath = [1];
  for (let k = 0; k < idxs.length - 1; k++) {
    const i = idxs[k], j = idxs[k + 1];
    const scored = cand.get(i).map(r => [r, fn(r)]).filter(x => x[1] != null && isFinite(x[1]));
    scored.sort((a, b) => b[1] - a[1]);
    const picks = scored.slice(0, K).map(x => x[0]);
    const usable = [];
    for (const r of picks) {
      const bp = close(r.c, i + BUY), sp = close(r.c, j + BUY);
      if (bp && sp) usable.push([r.c, ((sp - bp) / bp) * 100, capAt(r.c, i) || 0]);
    }
    if (!usable.length) { navPath.push(nav); continue; }
    const rw = usable.map(x => (weight === 'cap' ? x[2] : 1));
    const ws = rw.reduce((s, v) => s + v, 0) || 1;
    const cur = new Map();
    let gross = 0;
    usable.forEach((x, t) => { const w = rw[t] / ws; cur.set(x[0], w); gross += x[1] * w; });
    let dw = 0;
    for (const [c, w] of cur) dw += Math.abs(w - (prev.get(c) || 0));
    for (const [c, w] of prev) if (!cur.has(c)) dw += w;
    const net = gross - (prev.size ? dw / 2 : 1) * ROUND;
    nav *= 1 + net / 100; rets.push(net); navPath.push(nav); prev = cur;
  }
  let peak = 0, mdd = 0;
  for (const v of navPath) { if (v > peak) peak = v; const d2 = (v / peak - 1) * 100; if (d2 < mdd) mdd = d2; }
  const years = rets.length * HOLD / 252;
  return {
    total: (nav - 1) * 100, cagr: (Math.pow(nav, 1 / years) - 1) * 100, mdd,
    win: rets.filter(v => v > 0).length / rets.length * 100, n: rets.length,
  };
}

// ── 벤치마크 (같은 규칙으로 굴린 시장) ────────────────────────────────
function bench(mode, HOLD, from, to) {
  const idxs = [];
  for (let i = LOOK + 5; i + BUY + HOLD + BUY < N; i += HOLD) if (days[i] >= from && days[i] <= to) idxs.push(i);
  if (idxs.length < 4) return null;
  let nav = 1; const rets = [], navPath = [1];
  for (let k = 0; k < idxs.length - 1; k++) {
    const i = idxs[k], j = idxs[k + 1];
    let num = 0, den = 0; const eq = [];
    const rows = mode === 'cap300' ? cand.get(i) : [...byDay[i].values()].map(r => ({ c: r[0], cap: r[7] }));
    for (const r of rows) {
      const bp = close(r.c, i + BUY), sp = close(r.c, j + BUY);
      if (!bp || !sp) continue;
      const ret = ((sp - bp) / bp) * 100;
      eq.push(ret); num += ret * (r.cap || 0); den += (r.cap || 0);
    }
    if (!eq.length) { navPath.push(nav); continue; }
    const ret = mode === 'capw' ? num / den : avg(eq);
    nav *= 1 + ret / 100; rets.push(ret); navPath.push(nav);
  }
  let peak = 0, mdd = 0;
  for (const v of navPath) { if (v > peak) peak = v; const d2 = (v / peak - 1) * 100; if (d2 < mdd) mdd = d2; }
  const years = rets.length * HOLD / 252;
  return { cagr: (Math.pow(nav, 1 / years) - 1) * 100, mdd, win: rets.filter(v => v > 0).length / rets.length * 100, n: rets.length };
}

// ── 탐색 ───────────────────────────────────────────────────────────────
const combos = [];
for (const f of Object.keys(FACTORS)) for (const K of [10, 20, 40]) for (const H of [10, 20, 60]) for (const w of ['eq', 'cap']) {
  const is = simulate(f, K, H, w, '20220101', SPLIT);
  if (!is) continue;
  combos.push({ f, K, H, w, is });
}
console.log(`탐색: ${combos.length}조합 | 학습 2022-01~${SPLIT} / 검증 ${SPLIT}~2026-08\n`);

const show = (title, sorted) => {
  console.log(`  ${title}`);
  console.log('    팩터          K  주기 비중 | 학습 CAGR  학습 MDD  학습승률 | **검증 CAGR  검증 MDD  검증승률**');
  for (const c of sorted.slice(0, 5)) {
    const oos = simulate(c.f, c.K, c.H, c.w, SPLIT, '99999999');
    console.log(`    ${c.f.padEnd(12)} ${String(c.K).padStart(2)} ${String(c.H).padStart(3)}일 ${c.w.padEnd(4)} | ${pct(c.is.cagr)} ${pct(c.is.mdd)} ${c.is.win.toFixed(0).padStart(5)}% | ${pct(oos && oos.cagr)} ${pct(oos && oos.mdd)} ${oos ? oos.win.toFixed(0).padStart(5) + '%' : '   -'} (기간 IS ${c.is.n} / OOS ${oos ? oos.n : 0})`);
  }
  console.log('');
};
for (const H of [10, 20, 60]) {
  const a = bench('capw', H, '20220101', SPLIT), b = bench('capw', H, SPLIT, '99999999');
  const c2 = bench('cap300', H, '20220101', SPLIT), d2 = bench('cap300', H, SPLIT, '99999999');
  console.log();
}
console.log('');
// 벤치마크 먼저 — 전략 CAGR은 반드시 같은 기간 시장과 나란히 읽어야 한다.
console.log('  ▍벤치마크 (같은 규칙·같은 기간, 비용 미차감)');
for (const H of [10, 20, 60]) {
  const a = bench('capw', H, '20220101', SPLIT), b = bench('capw', H, SPLIT, '99999999');
  const c2 = bench('cap300', H, '20220101', SPLIT), d2 = bench('cap300', H, SPLIT, '99999999');
  console.log(`    ${String(H).padStart(2)}일 | 시총가중 시장  학습 ${pct(a && a.cagr)} (MDD ${pct(a && a.mdd)}) → 검증 ${pct(b && b.cagr)} (MDD ${pct(b && b.mdd)})  |  동일가중 cap300  학습 ${pct(c2 && c2.cagr)} → 검증 ${pct(d2 && d2.cagr)}`);
}
console.log('');

show('▍학습 CAGR 상위 5', [...combos].sort((a, b) => b.is.cagr - a.is.cagr));
show('▍학습 승률 상위 5', [...combos].sort((a, b) => b.is.win - a.is.win));

// 전체 조합의 IS→OOS 상관 = 과최적화 진단
const pairs = combos.map(c => ({ is: c.is.cagr, oos: (simulate(c.f, c.K, c.H, c.w, SPLIT, '99999999') || {}).cagr })).filter(x => x.oos != null);
const mi = avg(pairs.map(p => p.is)), mo = avg(pairs.map(p => p.oos));
let cov = 0, vi = 0, vo = 0;
for (const p of pairs) { cov += (p.is - mi) * (p.oos - mo); vi += (p.is - mi) ** 2; vo += (p.oos - mo) ** 2; }
const corr = (vi > 0 && vo > 0) ? cov / Math.sqrt(vi * vo) : null;
console.log(`  📉 학습 CAGR ↔ 검증 CAGR 상관계수 = ${corr == null ? '-' : corr.toFixed(2)} (n=${pairs.length}조합)`);
console.log(`     학습 평균 CAGR ${mi.toFixed(1)}% → 검증 평균 CAGR ${mo.toFixed(1)}%`);
console.log('     상관이 0 근처면 학습 성적으로 미래를 못 고른다는 뜻 = 탐색 자체가 무의미.\n');
