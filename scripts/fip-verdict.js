/**
 * fip-verdict.js — 조용한 상승(Frog-in-the-pan) 판정 (2026-11-11)
 *
 * 판정 기준은 FIP_VERDICT.md 에 사전 등록돼 있다. 이 스크립트는 그 문서의 정의를 그대로 구현한다.
 * 신호를 추가하거나 임계값을 바꾸면 판정을 리셋해야 한다(문서 변경 이력에 기록).
 *
 * 유니버스·실행·비용 규약은 scripts/logic-search.js 와 동일하다(복사 — 연구 스크립트끼리 의존을 만들지 않는다).
 *
 * 실행: node --max-old-space-size=8192 scripts/fip-verdict.js
 */
const fs = require('fs');
const path = require('path');

const SPLIT = '20240701';
const COST = 0.35 / 100;
const CAPMIN = 3000e8, VALMIN = 10e8, UNIV = 300;
const LOOK = 20;          // 유동성 판정 창 (logic-search 와 동일)
const START = 140;        // logic-search 의 LOOK+HI 와 같은 시작점 → 같은 신호일 격자
const WIN_PCT = 0.30;     // 승자 = 형성수익 상위 30%

// ── 가격 ────────────────────────────────────────────────────────────────
const lines = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l)).sort((a, b) => a.d.localeCompare(b.d));
const days = lines.map(l => l.d);
const N = days.length;
const S = new Map();
for (let i = 0; i < N; i++) {
  for (const [code, , , , cl, , val, cap] of lines[i].s) {
    if (!/0$/.test(code)) continue;   // 우선주 배제
    let s = S.get(code);
    if (!s) { s = { c: new Float64Array(N), cap: new Float64Array(N), val: new Float64Array(N) }; S.set(code, s); }
    s.c[i] = cl; s.cap[i] = cap; s.val[i] = val;
  }
}
lines.length = 0;
for (const s of S.values()) { let L = -1; for (let i = 0; i < N; i++) if (s.c[i] > 0) L = i; s.last = L; }

const dayRet = (s, i) => {
  const a = s.c[i - 1], b = s.c[i];
  if (!(a > 0) || !(b > 0)) return 0;
  const r = b / a - 1;
  if (Math.abs(r) > 0.31 && s.cap[i - 1] > 0 && s.cap[i] > 0) return s.cap[i] / s.cap[i - 1] - 1;
  return r;
};

const kospi = new Map();
for (const l of fs.readFileSync(path.resolve(__dirname, '../data/krx-index.jsonl'), 'utf-8').split('\n').filter(Boolean)) {
  const r = JSON.parse(l); const k = r.i.find(x => x[0] === '코스피'); if (k) kospi.set(r.d, k[1]);
}

// ── 피처 ────────────────────────────────────────────────────────────────
// 형성 창 W 의 누적수익과 정보 불연속도 ID = sign(PRET) × (%음수일 − %양수일).
// 창 안에 거래 없는 날이 있으면 해당 W 피처는 null (그 신호에서만 제외).
function path_(s, i, W) {
  if (i - W < 0) return null;
  let g = 1, pos = 0, neg = 0;
  for (let k = i - W + 1; k <= i; k++) {
    if (!(s.c[k] > 0) || !(s.c[k - 1] > 0)) return null;
    const r = dayRet(s, k); g *= 1 + r;
    if (r > 0) pos++; else if (r < 0) neg++;
  }
  const pret = g - 1;
  return { ret: pret, id: Math.sign(pret) * (neg - pos) / W };
}
const featCache = new Map();
function features(i) {
  if (featCache.has(i)) return featCache.get(i);
  const rows = [];
  for (const [code, s] of S) {
    if (!(s.c[i] > 0) || !(s.cap[i] >= CAPMIN)) continue;
    let vsum = 0, ok = true;
    for (let k = LOOK - 1; k >= 0; k--) { if (!(s.c[i - k] > 0)) { ok = false; break; } vsum += s.val[i - k]; }
    if (!ok || vsum / LOOK < VALMIN) continue;
    rows.push({ code, cap: s.cap[i], p60: path_(s, i, 60), p120: path_(s, i, 120) });
  }
  rows.sort((a, b) => b.cap - a.cap);
  const out = rows.slice(0, UNIV);
  featCache.set(i, out);
  return out;
}

let SEED = '';   // '' = 사전등록 1회 실행과 같은 단일 무작위. --null 진단에서만 바꾼다
const hash = s => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

// 신호: (rows, i, K) → 편입 종목 배열. 사전 등록된 6개만.
function winners(rows, key) {
  const v = rows.filter(r => r[key]);
  v.sort((a, b) => b[key].ret - a[key].ret);
  return v.slice(0, Math.ceil(v.length * WIN_PCT));
}
const SIGNALS = {
  FIP60:  (r, i, K) => winners(r, 'p60').sort((a, b) => a.p60.id - b.p60.id || b.p60.ret - a.p60.ret).slice(0, K),
  FIP120: (r, i, K) => winners(r, 'p120').sort((a, b) => a.p120.id - b.p120.id || b.p120.ret - a.p120.ret).slice(0, K),
  MOM60:  (r, i, K) => r.filter(x => x.p60).sort((a, b) => b.p60.ret - a.p60.ret).slice(0, K),
  DISC60: (r, i, K) => winners(r, 'p60').sort((a, b) => b.p60.id - a.p60.id || b.p60.ret - a.p60.ret).slice(0, K),
  EW300:  (r) => r,
  '[통제] 무작위': (r, i, K) => [...r].sort((a, b) => hash(a.code + days[i] + SEED) - hash(b.code + days[i] + SEED)).slice(0, K),
};

// ── 백테스트 ────────────────────────────────────────────────────────────
function sigDaysFor(H) { const a = []; for (let i = START; i + 1 < N; i += H) a.push(i); return a; }

function run(name, K, W, H) {
  const sd = sigDaysFor(H);
  const periods = [];
  let prevW = new Map();
  for (let t = 0; t < sd.length; t++) {
    const i = sd[t], b = i + 1;
    const e = t + 1 < sd.length ? sd[t + 1] + 1 : N - 1;
    if (e <= b) break;
    const picks = SIGNALS[name](features(i), i, K);
    if (!picks.length) continue;
    const tot = picks.reduce((a, r) => a + r.cap, 0);
    const w = new Map(picks.map(r => [r.code, W === 'cap' ? r.cap / tot : 1 / picks.length]));
    let turnover = 0; for (const [c, x] of w) turnover += Math.max(0, x - (prevW.get(c) || 0));
    let ret = 0;
    for (const [c, x] of w) {
      const s = S.get(c); let g = 1;
      for (let k = b + 1; k <= e; k++) { if (k > s.last) break; g *= 1 + dayRet(s, k); }
      ret += x * (g - 1);
    }
    ret -= turnover * COST;
    periods.push({ d0: days[b], d1: days[e], ret });
    prevW = w;
  }
  return periods;
}

const toDate = d => Date.parse(d.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3'));
function summarize(ps, lo, hi) {
  ps = ps.filter(p => p.d0 >= lo && p.d0 < hi);
  if (!ps.length) return null;
  let nav = 1, peak = 1, mdd = 0, k = 1;
  for (const p of ps) {
    nav *= 1 + p.ret; peak = Math.max(peak, nav); mdd = Math.min(mdd, nav / peak - 1);
    k *= kospi.get(p.d1) / kospi.get(p.d0);
  }
  const yrs = (toDate(ps[ps.length - 1].d1) - toDate(ps[0].d0)) / 3.156e10;
  return { n: ps.length, cum: nav - 1, cagr: nav ** (1 / yrs) - 1, kcagr: k ** (1 / yrs) - 1, mdd };
}
const SEG = { IS: ['0', SPLIT], OOS: [SPLIT, '99999999'], ALL: ['0', '99999999'] };
function evalCfg(K, W, H) {
  const out = {};
  for (const name of Object.keys(SIGNALS)) {
    const per = run(name, K, W, H);
    out[name] = Object.fromEntries(Object.entries(SEG).map(([k, [lo, hi]]) => [k, summarize(per, lo, hi)]));
  }
  return out;
}

const pc = v => (v == null || !isFinite(v) ? '     -' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%')).padStart(8);
function table(title, R) {
  console.log(`\n${title}`);
  console.log('신호'.padEnd(14), '  IS연  OOS연  전체연 | EW초과 IS   OOS   전체 | 전체MDD   (KOSPI 대비는 data/krx-index.jsonl 이 2026-08-14 에서 끊겨 생략)');
  for (const [name, r] of Object.entries(R)) {
    const ex = seg => r[seg].cagr - R.EW300[seg].cagr;
    console.log(name.padEnd(14), pc(r.IS.cagr), pc(r.OOS.cagr), pc(r.ALL.cagr), '|', pc(ex('IS')), pc(ex('OOS')), pc(ex('ALL')), '|', pc(r.ALL.mdd));
  }
}

console.log(`데이터 ${days[0]}~${days[N - 1]} (${N}거래일) · 분할 ${SPLIT} · 사전등록 FIP_VERDICT.md`);

// ── 진단 모드: 무작위 K종목 포트폴리오 N개의 EW300 대비 연초과 분포 (--null=200) ──
//   P0 무효(2026-11-11 1회차) 원인 진단용. 평균이 0 근처면 척도 편향이 아니라 표본 노이즈다.
const NULLN = +((process.argv.find(s => s.startsWith('--null=')) || '').split('=')[1] || 0);
if (NULLN) {
  const ew = run('EW300', 10, 'eq', 20);
  const ewS = Object.fromEntries(Object.entries(SEG).map(([k, [lo, hi]]) => [k, summarize(ew, lo, hi).cagr]));
  const xs = { IS: [], OOS: [], ALL: [] };
  for (let t = 0; t < NULLN; t++) {
    SEED = '#' + t;
    const per = run('[통제] 무작위', 10, 'eq', 20);
    for (const k of Object.keys(SEG)) { const [lo, hi] = SEG[k]; xs[k].push(summarize(per, lo, hi).cagr - ewS[k]); }
  }
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  console.log(`\n[진단] 무작위 K=10 포트폴리오 ${NULLN}개의 EW300 대비 연초과 (주 설정 K10·eq·H20)`);
  for (const k of Object.keys(SEG)) {
    const a = xs[k], m = a.reduce((s, v) => s + v, 0) / a.length;
    console.log(`  ${k.padEnd(4)} 평균 ${pc(m)} · 중앙 ${pc(q(a, 0.5))} · 5% ${pc(q(a, 0.05))} · 95% ${pc(q(a, 0.95))}`);
  }
  process.exit(0);
}

// ── 주 판정 ─────────────────────────────────────────────────────────────
const M = evalCfg(10, 'eq', 20);
table('[주 설정] K=10 · 등가중 · H=20 (비용 차감, 연환산)', M);

const exEW = (n, seg) => M[n][seg].cagr - M.EW300[seg].cagr;
const P0 = Math.abs(exEW('[통제] 무작위', 'ALL')) <= 0.03;
const P1 = exEW('FIP60', 'IS') > 0 && exEW('FIP60', 'OOS') > 0 && exEW('FIP60', 'ALL') >= 0.03;
const dMom = seg => M.FIP60[seg].cagr - M.MOM60[seg].cagr;
const P2 = dMom('IS') > 0 && dMom('OOS') > 0;
console.log('\n── 판정 (1회) ──');
console.log(`P0 척도: 무작위 EW초과(전체) ${pc(exEW('[통제] 무작위', 'ALL'))} → ${P0 ? '✅' : '❌ 판정 무효'}`);
console.log(`P1 선별: FIP60 EW초과 IS ${pc(exEW('FIP60', 'IS'))} / OOS ${pc(exEW('FIP60', 'OOS'))} / 전체 ${pc(exEW('FIP60', 'ALL'))} (기준 >0 / >0 / ≥+3.0%) → ${P1 ? '✅' : '❌'}`);
console.log(`P2 경로: FIP60−MOM60 IS ${pc(dMom('IS'))} / OOS ${pc(dMom('OOS'))} (기준 >0 / >0) → ${P2 ? '✅' : '❌'}`);
console.log('결론:', !P0 ? '판정 무효 (척도 결함)' : P1 && P2 ? '채택 후보 → 별도 관측 목록, 판정일 따로 사전 등록' : P1 ? '기각 — 그냥 모멘텀' : '기각');

// ── 강건성 병기 (판정을 바꾸지 않는다) ──────────────────────────────────
table('[강건성] K=10 · 등가중 · H=10', evalCfg(10, 'eq', 10));
table('[강건성] K=20 · 등가중 · H=20', evalCfg(20, 'eq', 20));
table('[강건성] K=10 · 시총가중 · H=20', evalCfg(10, 'cap', 20));

// ── 진단: 데이터 마지막 날 FIP60 상위 (판정과 무관) ─────────────────────
const master = Object.fromEntries(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/krx-master.json'), 'utf-8')).rows.map(r => [r.code, r.name]));
const last = N - 1, rows = features(last);
const fip = SIGNALS.FIP60(rows, last, 300);
console.log(`\n[진단] ${days[last]} FIP60 상위 10 (승자 ${fip.length}개 중):`);
fip.slice(0, 10).forEach((r, j) => console.log(`  ${j + 1}. ${(master[r.code] || r.code).padEnd(12)} 60일 ${pc(r.p60.ret)} · 양수일 ${Math.round((1 - r.p60.id) / 2 * 60)}/60`));
const hm = fip.findIndex(r => r.code === '128940');
const hr = rows.find(r => r.code === '128940');
console.log(`  한미약품: ${hm >= 0 ? `FIP60 ${hm + 1}위` : '승자 상위 30% 밖'}${hr && hr.p60 ? ` (60일 ${pc(hr.p60.ret)}, ID ${hr.p60.id.toFixed(2)})` : ''}`);
