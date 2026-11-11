/**
 * winner-traits.js — "수익률 좋은 종목의 공통점" 스캔 (2026-11-11, 관측 — 판정 아님)
 *
 * 질문(사용자): 수익률 좋은 종목들의 공통점 중 미리 포착 가능한 패턴이 있지 않나?
 *
 * 함정: 상위 종목의 공통점(P(특징|승자))은 대개 **하위 종목에도 똑같이** 있다.
 *   소형·고변동·급등이력은 "오를 종목"이 아니라 "크게 움직일 종목"의 특징이다.
 *   그래서 이 스캔은 특징 분위마다 세 숫자를 같이 본다.
 *     승자 lift  = P(상위10% | 분위) / 10%
 *     패자 lift  = P(하위10% | 분위) / 10%
 *     방향비     = 승자 lift / 패자 lift   ← >1 이어야 "방향" 정보. ≈1 이면 변동성일 뿐
 *   그리고 분위의 **매칭초과 중앙값**(같은 날 유니버스 중앙값 대비)을 본다.
 *   설계(2022-01~2024-06)와 검증(2024-07~) 두 구간에서 **같은 방향**이어야 패턴이라 부른다.
 *
 * 규약
 *   - 표본일: 5거래일마다(겹침 완화). 신호일 i 종가까지의 정보만 사용.
 *   - 미래수익: i+1 종가 매수 → i+1+H 종가 (기본 H=20). 같은 날 유니버스 중앙값을 뺀 초과.
 *   - 유니버스: 보통주 · 시총 1,000억+ · 20일 평균 거래대금 5억+ (실제로 살 수 있는 종목).
 *   - 일간 |수익| > 31%는 시총비율로 대체(액면분할 이음매, logic-search.js 와 동일).
 *   - 재무: 분기말+45일 / 연말+90일 공시 지연 가정(point-in-time).
 *
 * 실행: node --max-old-space-size=8192 scripts/winner-traits.js [--h=20] [--step=5]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const H = +arg('h', 20);
const STEP = +arg('step', 5);
const SPLIT = '20240701';
const CAPMIN = 1000e8, VALMIN = 5e8;
const TAIL = 0.10;

// ── 데이터 ──────────────────────────────────────────────────────────────
const lines = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l)).sort((a, b) => a.d.localeCompare(b.d));
const days = lines.map(l => l.d);
const N = days.length;
const S = new Map();
for (let i = 0; i < N; i++) {
  for (const [code, o, h, l, c, vol, val, cap] of lines[i].s) {
    if (!/0$/.test(code)) continue;
    let s = S.get(code);
    if (!s) { s = { o: new Float64Array(N), h: new Float64Array(N), c: new Float64Array(N), val: new Float64Array(N), cap: new Float64Array(N) }; S.set(code, s); }
    s.o[i] = o; s.h[i] = h; s.c[i] = c; s.val[i] = val; s.cap[i] = cap;
  }
}
lines.length = 0;
const dayRet = (s, i) => {
  const a = s.c[i - 1], b = s.c[i];
  if (!(a > 0) || !(b > 0)) return null;
  const r = b / a - 1;
  if (Math.abs(r) > 0.31 && s.cap[i - 1] > 0 && s.cap[i] > 0) return s.cap[i] / s.cap[i - 1] - 1;
  return r;
};

const fin = new Map();
for (const r of JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/financials.json'), 'utf-8')).rows) {
  const y = +r.ym.slice(0, 4), m = +r.ym.slice(4, 6);
  const avail = new Date(Date.UTC(y, m, 0) + (m === 12 ? 90 : 45) * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  if (!fin.has(r.code)) fin.set(r.code, []);
  fin.get(r.code).push({ avail, ...r });
}
for (const a of fin.values()) a.sort((x, y) => x.avail.localeCompare(y.avail));
const finAt = (c, d) => { const a = fin.get(c); if (!a) return null; let best = null; for (const x of a) { if (x.avail <= d) best = x; else break; } return best; };
const sectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/sector-map.json'), 'utf-8'));

// ── 특징 (모두 신호일 i 종가까지) ───────────────────────────────────────
const FEATS = {
  '시가총액':          '큰 값 = 대형주',
  '5일 수익':          '',
  '20일 수익':         '',
  '60일 수익':         '',
  '120일 수익':        '',
  '20일 변동성':       '',
  '20일 최대 일간상승': '급등 이력 (MAX 효과)',
  '양수일 비율(60일)':  '고르게 오름 (FIP)',
  '120일 고점 근접':    '현재가/120일 최고가',
  '20일 이격도':       '현재가/20일 이평',
  '거래회전율(20일)':   '거래대금/시총',
  '거래대금 급증':      '5일 평균/60일 평균',
  '갭 상승 빈도(20일)': '시가가 전일종가 +3% 이상인 날 수',
  'PBR':              '',
  'E/P':              '이익수익률',
  'ROE':              '',
  '부채비율':          '',
};
function featuresAt(i) {
  const out = [];
  for (const [code, s] of S) {
    if (!(s.c[i] > 0) || !(s.cap[i] >= CAPMIN) || i < 121 || i + 1 + H >= N) continue;
    let ok = true, v20 = 0;
    for (let k = 0; k < 20; k++) { if (!(s.c[i - k] > 0)) { ok = false; break; } v20 += s.val[i - k]; }
    if (!ok || v20 / 20 < VALMIN) continue;
    // 미래 (i+1 매수 → i+1+H)
    if (!(s.c[i + 1] > 0) || !(s.c[i + 1 + H] > 0)) continue;
    let g = 1; for (let k = i + 2; k <= i + 1 + H; k++) { const r = dayRet(s, k); if (r == null) { g = null; break; } g *= 1 + r; }
    if (g == null) continue;
    const r60 = [], r20 = [];
    let fail = false;
    for (let k = i - 59; k <= i; k++) { const r = dayRet(s, k); if (r == null) { fail = true; break; } r60.push(r); }
    if (fail) continue;
    r20.push(...r60.slice(-20));
    const cum = (a) => a.reduce((p, r) => p * (1 + r), 1) - 1;
    const m20 = r20.reduce((a, b) => a + b, 0) / 20;
    let hi = 0; for (let k = 0; k < 120; k++) if (s.c[i - k] > hi) hi = s.c[i - k];
    let ma = 0; for (let k = 0; k < 20; k++) ma += s.c[i - k]; ma /= 20;
    let v5 = 0, v60 = 0, n60 = 0; for (let k = 0; k < 60; k++) { if (s.val[i - k] > 0) { v60 += s.val[i - k]; n60++; } if (k < 5) v5 += s.val[i - k]; }
    let gaps = 0; for (let k = 0; k < 20; k++) if (s.o[i - k] > 0 && s.c[i - k - 1] > 0 && s.o[i - k] / s.c[i - k - 1] - 1 >= 0.03) gaps++;
    const p120 = s.c[i - 120] > 0 ? s.c[i] / s.c[i - 120] - 1 : null;
    const f = finAt(code, days[i]); const p = s.c[i];
    out.push({
      code, fwd: g - 1, sector: sectors[code] || '미상',
      x: {
        '시가총액': s.cap[i], '5일 수익': cum(r60.slice(-5)), '20일 수익': cum(r20), '60일 수익': cum(r60), '120일 수익': p120,
        '20일 변동성': Math.sqrt(r20.reduce((a, r) => a + (r - m20) ** 2, 0) / 19),
        '20일 최대 일간상승': Math.max(...r20), '양수일 비율(60일)': r60.filter(r => r > 0).length / 60,
        '120일 고점 근접': p / hi, '20일 이격도': p / ma, '거래회전율(20일)': v20 / 20 / s.cap[i],
        '거래대금 급증': n60 ? (v5 / 5) / (v60 / n60) : null, '갭 상승 빈도(20일)': gaps,
        'PBR': f && f.bps > 0 ? p / f.bps : null,
        'E/P': f && f.bps > 0 && f.roe != null ? (f.roe / 100) * f.bps / p : null,
        'ROE': f && f.roe != null ? f.roe : null, '부채비율': f && f.debt != null ? f.debt : null,
      },
    });
  }
  return out;
}

// ── 집계 ────────────────────────────────────────────────────────────────
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const agg = {};   // agg[feat][seg][decile] = {n, w, l, ex[]}
const sagg = {};  // 업종
const segOf = d => (d < SPLIT ? 'IS' : 'OOS');
let nObs = 0, nDates = { IS: 0, OOS: 0 };
const t0 = Date.now();
for (let i = 121; i + 1 + H < N; i += STEP) {
  const rows = featuresAt(i);
  if (rows.length < 200) continue;
  const seg = segOf(days[i]); nDates[seg]++;
  const fm = med(rows.map(r => r.fwd));
  for (const r of rows) r.ex = r.fwd - fm;
  const byEx = [...rows].sort((a, b) => a.ex - b.ex);
  const k = Math.floor(rows.length * TAIL);
  byEx.forEach((r, j) => { r.lose = j < k; r.win = j >= rows.length - k; });
  nObs += rows.length;
  for (const feat of Object.keys(FEATS)) {
    const v = rows.filter(r => r.x[feat] != null && isFinite(r.x[feat]));
    if (v.length < 100) continue;
    v.sort((a, b) => a.x[feat] - b.x[feat]);
    v.forEach((r, j) => {
      const dec = Math.min(9, Math.floor(j / v.length * 10));
      const A = ((agg[feat] = agg[feat] || {})[seg] = agg[feat][seg] || Array.from({ length: 10 }, () => ({ n: 0, w: 0, l: 0, ex: [] })))[dec];
      A.n++; if (r.win) A.w++; if (r.lose) A.l++; A.ex.push(r.ex);
    });
  }
  for (const r of rows) {
    const A = ((sagg[r.sector] = sagg[r.sector] || {})[seg] = sagg[r.sector][seg] || { n: 0, w: 0, l: 0, ex: [] });
    A.n++; if (r.win) A.w++; if (r.lose) A.l++; A.ex.push(r.ex);
  }
}

// ── 출력 ────────────────────────────────────────────────────────────────
const pc = v => (v == null ? '    -' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%')).padStart(7);
const fx = v => (v == null ? '   -' : v.toFixed(2).padStart(5));
console.log(`데이터 ${days[0]}~${days[N - 1]} · 표본일 ${STEP}거래일마다 (설계 ${nDates.IS}일 / 검증 ${nDates.OOS}일) · 관측 ${nObs.toLocaleString()} 종목-일`);
{ const base = seg => { const A = agg['시가총액'][seg]; const all = A.flatMap(x => x.ex); return all.reduce((p, v) => p + v, 0) / all.length; };
  console.log(`기준선 — 유니버스 전체 초과평균: 설계 ${pc(base('IS'))} / 검증 ${pc(base('OOS'))} (중앙값 대비라 0보다 크다. 분위 평균은 이것과 비교할 것)`); }
console.log(`미래 = D+1 종가 매수 → D+${1 + H} 종가, 같은 날 유니버스 중앙값 대비 초과. 승자/패자 = 그날 상위/하위 ${TAIL * 100}%\n`);
console.log('각 특징의 최하위 분위(D1)와 최상위 분위(D10):  승자lift / 패자lift / 방향비 / 초과중앙 / 초과평균');
console.log('판정 표시: ✅ 설계·검증 모두 같은 쪽 분위가 방향비>1.1 & 초과중앙>0 & 초과평균>0  ·  ⚠ 변동성 특징(양 꼬리 lift 모두 ≥1.3)\n');

const summary = [];
for (const feat of Object.keys(FEATS)) {
  if (!agg[feat] || !agg[feat].IS || !agg[feat].OOS) continue;
  const cell = (seg, d) => { const A = agg[feat][seg][d]; const wl = A.w / A.n / TAIL, ll = A.l / A.n / TAIL; return { wl, ll, dr: wl / ll, m: med(A.ex), mu: A.ex.reduce((p, v) => p + v, 0) / A.ex.length, n: A.n }; };
  console.log(`■ ${feat}${FEATS[feat] ? ` (${FEATS[feat]})` : ''}`);
  const verdict = {};
  for (const [d, lab] of [[0, 'D1  (낮음)'], [9, 'D10 (높음)']]) {
    const a = cell('IS', d), b = cell('OOS', d);
    const good = a.dr > 1.1 && b.dr > 1.1 && a.m > 0 && b.m > 0 && a.mu > 0 && b.mu > 0;
    const bad = a.dr < 0.9 && b.dr < 0.9 && a.m < 0 && b.m < 0 && a.mu < 0 && b.mu < 0;
    const volat = a.wl >= 1.3 && a.ll >= 1.3 && b.wl >= 1.3 && b.ll >= 1.3;
    verdict[d] = { good, bad, volat, a, b };
    console.log(`   ${lab}  설계 ${fx(a.wl)} / ${fx(a.ll)} / ${fx(a.dr)} / ${pc(a.m)} 평균${pc(a.mu)}   검증 ${fx(b.wl)} / ${fx(b.ll)} / ${fx(b.dr)} / ${pc(b.m)} 평균${pc(b.mu)}  ${good ? '✅' : bad ? '❌ 피할 쪽' : ''}${volat ? ' ⚠ 변동성' : ''}`);
  }
  // 단조성: 10분위 초과중앙의 Spearman (분위 순위 vs 초과중앙)
  const rho = seg => { const m = agg[feat][seg].map(A => med(A.ex)); const r = m.map((v, j) => [v, j]).sort((x, y) => x[0] - y[0]).map(x => x[1]); let s = 0; r.forEach((dec, rank) => { s += (dec - rank) ** 2; }); return 1 - 6 * s / (10 * 99); };
  const rI = rho('IS'), rO = rho('OOS');
  console.log(`   10분위 단조성(초과중앙 Spearman) 설계 ${fx(rI)} · 검증 ${fx(rO)}${Math.sign(rI) === Math.sign(rO) && Math.abs(rI) >= 0.6 && Math.abs(rO) >= 0.6 ? '  ← 두 구간 같은 방향으로 단조' : ''}\n`);
  summary.push({ feat, verdict, rI, rO });
}

console.log('■ 업종 (설계 → 검증 초과중앙, 표본 ≥ 2,000 종목-일)');
const secRows = Object.entries(sagg).filter(([, v]) => v.IS && v.OOS && v.IS.n >= 2000 && v.OOS.n >= 2000)
  .map(([k, v]) => ({ k, a: med(v.IS.ex), b: med(v.OOS.ex), wa: v.IS.w / v.IS.n / TAIL, la: v.IS.l / v.IS.n / TAIL, wb: v.OOS.w / v.OOS.n / TAIL, lb: v.OOS.l / v.OOS.n / TAIL }))
  .sort((x, y) => (y.a + y.b) - (x.a + x.b));
for (const r of secRows) console.log(`   ${r.k.padEnd(10)} 설계 ${pc(r.a)} (방향비 ${fx(r.wa / r.la)})  검증 ${pc(r.b)} (방향비 ${fx(r.wb / r.lb)})${r.a > 0 && r.b > 0 ? '  ✅' : r.a < 0 && r.b < 0 ? '  ❌' : ''}`);

console.log('\n── 요약: 두 구간 모두에서 같은 방향인 것 ──');
for (const s of summary) for (const d of [0, 9]) {
  const v = s.verdict[d]; const side = d === 0 ? '낮은 쪽' : '높은 쪽';
  if (v.good) console.log(`  ✅ ${s.feat} ${side}: 초과중앙 설계 ${pc(v.a.m)} / 검증 ${pc(v.b.m)} · 평균 ${pc(v.a.mu)} / ${pc(v.b.mu)}, 방향비 ${fx(v.a.dr)} / ${fx(v.b.dr)}`);
  if (v.bad) console.log(`  ❌ ${s.feat} ${side}: 초과중앙 설계 ${pc(v.a.m)} / 검증 ${pc(v.b.m)} · 평균 ${pc(v.a.mu)} / ${pc(v.b.mu)}, 방향비 ${fx(v.a.dr)} / ${fx(v.b.dr)} (피할 쪽)`);
}
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}초)`);
