/**
 * logic-search.js — 시장을 이기는 선별 로직 원점 재탐색 (2026-10-06)
 *
 * 사용자 지시(2026-10-06): 문헌 근거 없어도 좋아 보이면 써도 되고, 백테스트로 판정한다.
 * 단 과최적화를 막으려고 표본을 시간순으로 가른다:
 *   설계(IS)  신호일 2022-01 ~ 2024-06 — 여기서만 고른다
 *   판정(OOS) 신호일 2024-07 ~ 2026-08 — 고른 뒤 한 번만 본다
 *
 * ── 사전 등록: IS 선택 규칙 (실행 전에 고정) ─────────────────────────────
 *   1. 주 지표 = KOSPI 지수 대비 연환산 초과수익(비용 차감 후).
 *   2. 자격: IS 3개 소구간(2022 / 2023 / 2024H1) 중 2개 이상에서 KOSPI 초과 > 0,
 *            그리고 IS MDD가 KOSPI IS MDD보다 깊지 않을 것.
 *   3. 자격 통과 조합 중 주 지표 상위 3개를 고른다(같은 신호의 K·비중 변형은 1개만).
 *   4. 그 3개만 OOS를 연다. OOS에서 KOSPI 초과 ≥ 0이면 채택 후보.
 *   (OOS 전체 표는 출력하되, 선택은 IS 열만으로 이미 끝난 상태여야 한다.)
 *
 * 규약
 *   - 유니버스: 보통주 · 시총 3,000억+ · 20일 평균 거래대금 10억+ 중 시총 상위 300.
 *   - 리밸런싱 H거래일마다. 신호일 i 종가까지의 정보만 사용, 매수는 i+1 종가.
 *   - 수익은 일별 연쇄. 일간 |수익| > 31%(가격제한폭 초과 = 액면분할·병합 이음매)면
 *     시총 비율로 대체한다(011930 2026-05 3,995→26,700 사례).
 *   - 비용: 신규편입 비중 × 왕복 0.35%(수수료 0, 매도세 0.15%, 편도 슬리피지 0.10%).
 *   - 재무: KIS 재무비율(분기). 공시 지연 가정 = 분기말+45일, 연말+90일(strategy-search.js와 동일).
 *   - 상폐 종목: 마지막 거래일 종가로 청산(낙관 쪽 가정 — 표에 명시).
 *
 * 실행: node --max-old-space-size=8192 scripts/logic-search.js [--h=20] [--oos]
 *   --oos 없이 돌리면 IS 열만 출력한다(선택 단계). 선택 후 --oos로 판정 구간을 연다.
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const H = +arg('h', 20);
const SHOW_OOS = process.argv.includes('--oos');
const ONLY = arg('only', '');          // OOS 단계에서 지정한 조합만 출력 (쉼표 구분 id)
const SPLIT = '20240701';
const COST = 0.35 / 100;
const CAPMIN = 3000e8, VALMIN = 10e8, UNIV = 300;
// --exclude=005930,000660 : 후보와 벤치마크 양쪽에서 제외 (메가캡 효과 제거 검정, 2026-10-06)
const EXCL = new Set(arg('exclude', '').split(',').filter(Boolean));

// ── 가격 ────────────────────────────────────────────────────────────────
const lines = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l)).sort((a, b) => a.d.localeCompare(b.d));
const days = lines.map(l => l.d);
const N = days.length;
const S = new Map();   // code -> { c: Float64Array, cap: Float64Array, val: Float64Array }
for (let i = 0; i < N; i++) {
  for (const [code, , , , cl, , val, cap] of lines[i].s) {
    if (!/0$/.test(code)) continue;   // 우선주(5/7/9/K 끝자리) 배제
    let s = S.get(code);
    if (!s) { s = { c: new Float64Array(N), cap: new Float64Array(N), val: new Float64Array(N) }; S.set(code, s); }
    s.c[i] = cl; s.cap[i] = cap; s.val[i] = val;
  }
}
lines.length = 0;
// 벤치마크: KOSPI 보통주 시총가중 일별 연쇄(전일 시총 가중). EXCL 종목 제외.
//   KOSPI 소속은 krx-master(2026-08 상장 기준)로 판정 → 상폐 종목은 빠진다(소폭 근사).
const MASTER = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/krx-master.json'), 'utf-8')).rows;
const isKospi = new Set(MASTER.filter(r => r.market === 'KOSPI').map(r => r.code));
function benchNav(excl) {
  const nav = new Float64Array(N); nav[0] = 1;
  for (let i = 1; i < N; i++) {
    let wsum = 0, rsum = 0;
    for (const [c, s] of S) {
      if (!isKospi.has(c) || excl.has(c) || !(s.cap[i - 1] > 0) || !(s.c[i - 1] > 0) || !(s.c[i] > 0)) continue;
      wsum += s.cap[i - 1]; rsum += s.cap[i - 1] * dayRet(s, i);
    }
    nav[i] = nav[i - 1] * (1 + (wsum ? rsum / wsum : 0));
  }
  return nav;
}
for (const c of EXCL) S.delete(c);
for (const s of S.values()) { let L = -1; for (let i = 0; i < N; i++) if (s.c[i] > 0) L = i; s.last = L; }

// 일간 수익(이음매 보정). 거래 없는 날(c=0)은 0으로 간주.
const dayRet = (s, i) => {
  const a = s.c[i - 1], b = s.c[i];
  if (!(a > 0) || !(b > 0)) return 0;
  const r = b / a - 1;
  if (Math.abs(r) > 0.31 && s.cap[i - 1] > 0 && s.cap[i] > 0) return s.cap[i] / s.cap[i - 1] - 1;
  return r;
};

// KOSPI 지수
const kospi = new Map();
for (const l of fs.readFileSync(path.resolve(__dirname, '../data/krx-index.jsonl'), 'utf-8').split('\n').filter(Boolean)) {
  const r = JSON.parse(l); const k = r.i.find(x => x[0] === '코스피'); if (k) kospi.set(r.d, k[1]);
}

// ── 재무 point-in-time ─────────────────────────────────────────────────
const fin = new Map();
for (const r of JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/financials.json'), 'utf-8')).rows) {
  const y = +r.ym.slice(0, 4), m = +r.ym.slice(4, 6);
  const end = new Date(Date.UTC(y, m, 0));
  const avail = new Date(end.getTime() + (m === 12 ? 90 : 45) * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  if (!fin.has(r.code)) fin.set(r.code, []);
  fin.get(r.code).push({ avail, ...r });
}
for (const a of fin.values()) a.sort((x, y) => x.avail.localeCompare(y.avail));
const finAt = (c, d) => {
  const a = fin.get(c); if (!a) return null;
  let lo = 0, hi = a.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].avail <= d) { best = a[m]; lo = m + 1; } else hi = m - 1; }
  return best;
};
const sectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/sector-map.json'), 'utf-8'));

// ── 신호일 피처 ─────────────────────────────────────────────────────────
const LOOK = 20, HI = 120;
function features(i) {
  const rows = [];
  for (const [code, s] of S) {
    if (!(s.c[i] > 0) || !(s.cap[i] >= CAPMIN)) continue;
    let vsum = 0, ok = true; const rets = [];
    for (let k = LOOK - 1; k >= 0; k--) { if (!(s.c[i - k] > 0)) { ok = false; break; } vsum += s.val[i - k]; rets.push(dayRet(s, i - k)); }
    if (!ok || vsum / LOOK < VALMIN) continue;
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
    let g = 1; for (const r of rets) g *= 1 + r;
    let hi = 0; for (let k = 0; k < HI && i - k >= 0; k++) if (s.c[i - k] > hi) hi = s.c[i - k];
    const f = finAt(code, days[i]);
    const p = s.c[i];
    rows.push({
      code, cap: s.cap[i], vol, ret20: g - 1, turn: vsum / LOOK / s.cap[i], near: p / hi,
      pbr: f && f.bps > 0 ? p / f.bps : null,
      ps: f && f.sps > 0 ? p / f.sps : null,
      roe: f && f.roe != null ? f.roe : null,
      ep: f && f.bps > 0 && f.roe != null ? (f.roe / 100) * f.bps / p : null,
      debt: f && f.debt != null ? f.debt : null,
      grs: f && f.grs != null ? f.grs : null,
      sector: sectors[code] || '기타',
    });
  }
  rows.sort((a, b) => b.cap - a.cap);
  return rows.slice(0, UNIV);
}

// 백분위(높을수록 좋음). dir=+1 큰 값 선호, -1 작은 값 선호. 결측은 null.
function pct(rows, key, dir) {
  const v = rows.map((r, j) => [r[key], j]).filter(x => x[0] != null && isFinite(x[0]));
  v.sort((a, b) => dir * (a[0] - b[0]));
  const out = new Array(rows.length).fill(null);
  v.forEach(([, j], rank) => { out[j] = v.length > 1 ? rank / (v.length - 1) : 0.5; });
  return out;
}
const hash = s => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

// 신호 정의: rows → 점수 배열(높을수록 매수). 결측 피처가 하나라도 있으면 제외(null).
const avgOf = arrs => arrs[0].map((_, j) => arrs.some(a => a[j] == null) ? null : arrs.reduce((s, a) => s + a[j], 0) / arrs.length);
const SIGNALS = {
  lowPBR:      r => pct(r, 'pbr', -1),
  'PBR+저변동':  r => avgOf([pct(r, 'pbr', -1), pct(r, 'vol', -1)]),
  lowPS:       r => pct(r, 'ps', -1),
  highROE:     r => pct(r, 'roe', 1),
  'E/P':       r => pct(r, 'ep', 1),
  'ROE+저PBR':  r => avgOf([pct(r, 'roe', 1), pct(r, 'pbr', -1)]),
  '단기반전':     r => pct(r, 'ret20', -1),
  'E/P+단기반전':  r => avgOf([pct(r, 'ep', 1), pct(r, 'ret20', -1)]),
  '저회전(무관심)': r => pct(r, 'turn', -1),
  'E/P+저회전':   r => avgOf([pct(r, 'ep', 1), pct(r, 'turn', -1)]),
  'E/P+저회전+저변동': r => avgOf([pct(r, 'ep', 1), pct(r, 'turn', -1), pct(r, 'vol', -1)]),
  '고점근접':     r => pct(r, 'near', 1),
  'E/P+고점근접':  r => avgOf([pct(r, 'ep', 1), pct(r, 'near', 1)]),
  'E/P+저부채':   r => avgOf([pct(r, 'ep', 1), pct(r, 'debt', -1)]),
  'E/P+매출성장':  r => avgOf([pct(r, 'ep', 1), pct(r, 'grs', 1)]),
  '저변동':       r => pct(r, 'vol', -1),
  '업종중립 저PBR': r => {
    const out = new Array(r.length).fill(null); const by = {};
    r.forEach((x, j) => (by[x.sector] = by[x.sector] || []).push(j));
    for (const js of Object.values(by)) { const sub = js.map(j => r[j]); const p = pct(sub, 'pbr', -1); js.forEach((j, t) => { out[j] = p[t]; }); }
    return out;
  },
  '[통제] 무작위':  (r, i) => r.map(x => hash(x.code + days[i])),
};

// ── 백테스트 ────────────────────────────────────────────────────────────
const start = LOOK + HI;
const sigDays = []; for (let i = start; i + 1 < N; i += H) sigDays.push(i);
console.log(`데이터 ${days[0]}~${days[N - 1]} (${N}일) · 리밸런싱 ${H}거래일 · 신호일 ${sigDays.length}회 · 분할 ${SPLIT}`);
console.log('피처 계산 중...');
const feats = new Map(sigDays.map(i => [i, features(i)]));

function run(sigName, K, W) {
  const fn = SIGNALS[sigName];
  const periods = [];  // {d0, d1, ret}
  let prevW = new Map();
  for (let t = 0; t < sigDays.length; t++) {
    const i = sigDays[t], b = i + 1;
    const e = t + 1 < sigDays.length ? sigDays[t + 1] + 1 : N - 1;
    if (e <= b) break;
    const rows = feats.get(i);
    const sc = fn(rows, i);
    const picks = rows.map((r, j) => [r, sc[j]]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1]).slice(0, K).map(x => x[0]);
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
const dIdx = new Map(days.map((d, i) => [d, i]));
const BN = EXCL.size ? benchNav(new Set()) : null;   // (EXCL 종목은 이미 S에서 삭제됨 → 이게 곧 'KOSPI ex-EXCL')
const kret = BN ? (d0, d1) => BN[dIdx.get(d1)] / BN[dIdx.get(d0)] - 1 : (d0, d1) => kospi.get(d1) / kospi.get(d0) - 1;
if (BN) console.log(`벤치마크 = KOSPI 보통주 시총가중 (제외: ${[...EXCL].join(',')}) — 직접 계산`);

function summarize(periods, lo, hi) {
  const ps = periods.filter(p => p.d0 >= lo && p.d0 < hi);
  if (!ps.length) return null;
  let nav = 1, k = 1, peak = 1, mdd = 0, kpeak = 1, kmdd = 0, win = 0;
  for (const p of ps) {
    const kr = kret(p.d0, p.d1);
    nav *= 1 + p.ret; k *= 1 + kr;
    peak = Math.max(peak, nav); mdd = Math.min(mdd, nav / peak - 1);
    kpeak = Math.max(kpeak, k); kmdd = Math.min(kmdd, k / kpeak - 1);
    if (p.ret > kr) win++;
  }
  const yrs = (Date.parse(ps[ps.length - 1].d1.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')) - Date.parse(ps[0].d0.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3'))) / 3.156e10;
  const cagr = nav ** (1 / yrs) - 1, kcagr = k ** (1 / yrs) - 1;
  return { n: ps.length, cum: nav - 1, kcum: k - 1, cagr, kcagr, ex: cagr - kcagr, mdd, kmdd, win: win / ps.length };
}

const pc = v => (v == null ? '   -' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%')).padStart(8);
const results = [];
// --ks=3,5,10 : 종목 수 후보 지정 (기본 10,20 — 사전등록 선택은 기본값으로만 한다). --sig=신호명 으로 한정 가능
const KS = arg('ks', '10,20').split(',').map(Number);
const SIG_ONLY = arg('sig', '');
for (const name of Object.keys(SIGNALS)) for (const K of KS) for (const W of ['eq', 'cap']) {
  if (SIG_ONLY && name !== SIG_ONLY) continue;
  const per = run(name, K, W);
  const is = summarize(per, '0', SPLIT);
  const sub = [['20220101', '20230101'], ['20230101', '20240101'], ['20240101', SPLIT]].map(([a, b]) => summarize(per, a, b));
  const oos = summarize(per, SPLIT, '99999999');
  results.push({ id: `${name}|K${K}|${W}`, name, K, W, is, sub, oos });
}

const kIS = results[0].is;
console.log(`\nKOSPI 설계구간: 누적 ${pc(kIS.kcum)} · CAGR ${pc(kIS.kcagr)} · MDD ${pc(kIS.kmdd)}`);
console.log('\n[설계 구간 IS] 정렬 = KOSPI 대비 연초과 (비용 차감)');
console.log('조합'.padEnd(30), '  IS누적  IS연초과   IS MDD  기간승률 | 22초과  23초과  24H1초과 | 자격');
const eligible = r => r.sub.filter(s => s && s.cum - s.kcum > 0).length >= 2 && r.is.mdd >= kIS.kmdd;
const sorted = [...results].sort((a, b) => b.is.ex - a.is.ex);
for (const r of sorted) {
  console.log(r.id.padEnd(30), pc(r.is.cum), pc(r.is.ex), pc(r.is.mdd), pc(r.is.win), '|', r.sub.map(s => pc(s ? s.cum - s.kcum : null)).join(''), '|', eligible(r) ? '✅' : '');
}
const picked = []; const seen = new Set();
for (const r of sorted) { if (!eligible(r) || seen.has(r.name)) continue; picked.push(r); seen.add(r.name); if (picked.length === 3) break; }
console.log('\n▶ 사전등록 규칙으로 고른 3개:', picked.map(r => r.id).join(' / ') || '(자격 통과 없음)');

if (SHOW_OOS) {
  const kO = results[0].oos;
  console.log(`\n[판정 구간 OOS] KOSPI: 누적 ${pc(kO.kcum)} · CAGR ${pc(kO.kcagr)} · MDD ${pc(kO.kmdd)}`);
  const list = ONLY ? results.filter(r => ONLY.split(',').includes(r.id)) : picked;
  console.log('조합'.padEnd(30), ' OOS누적  OOS연초과  OOS MDD  기간승률 | 판정');
  for (const r of list) console.log(r.id.padEnd(30), pc(r.oos.cum), pc(r.oos.ex), pc(r.oos.mdd), pc(r.oos.win), '|', r.oos.ex >= 0 ? '✅ 채택 후보' : '❌ 기각');
}

// 참고: 전 조합 OOS (선택에 쓰지 않는다 — "애초에 이긴 게 있었나"와 IS↔OOS 순위 상관 확인용)
if (process.argv.includes('--oos-all')) {
  const rk = a => { const o = a.map((v, j) => [v, j]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); o.forEach(([, j], t) => { r[j] = t; }); return r; };
  const a = rk(results.map(r => r.is.ex)), b = rk(results.map(r => r.oos.ex)); const n = a.length;
  const rho = 1 - 6 * a.reduce((s, v, j) => s + (v - b[j]) ** 2, 0) / (n * (n * n - 1));
  console.log(`\n[참고] 전 조합 OOS · IS↔OOS 순위상관 ρ=${rho.toFixed(2)} (n=${n})`);
  for (const r of [...results].sort((x, y) => y.oos.ex - x.oos.ex)) console.log(r.id.padEnd(30), pc(r.oos.cum), pc(r.oos.ex), pc(r.oos.mdd), '| IS연초과', pc(r.is.ex));
}

// 진단: 특정 조합의 기간별 편입 상위 비중 종목 (--holdings=<id>)
const HOLD_ID = arg('holdings', '');
if (HOLD_ID) {
  const [name, k, w] = HOLD_ID.split('|'); const K = +k.slice(1);
  const master = Object.fromEntries(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/krx-master.json'), 'utf-8')).rows.map(r => [r.code, r.name]));
  const cnt = {};
  for (const i of sigDays) {
    const rows = feats.get(i), sc = SIGNALS[name](rows, i);
    const picks = rows.map((r, j) => [r, sc[j]]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1]).slice(0, K).map(x => x[0]);
    const tot = picks.reduce((a, r) => a + r.cap, 0);
    for (const r of picks) { const x = w === 'cap' ? r.cap / tot : 1 / picks.length; const nm = master[r.code] || r.code; cnt[nm] = cnt[nm] || { n: 0, w: 0, oos: 0 }; cnt[nm].n++; cnt[nm].w += x; if (days[i] >= SPLIT) cnt[nm].oos += x; }
  }
  const nOOS = sigDays.filter(i => days[i] >= SPLIT).length;
  console.log(`\n[편입 진단] ${HOLD_ID} — OOS 평균 비중 상위`);
  for (const [nm, v] of Object.entries(cnt).sort((a, b) => b[1].oos - a[1].oos).slice(0, 8)) console.log('  ', nm.padEnd(14), `편입 ${v.n}회 · OOS 평균비중 ${(v.oos / nOOS * 100).toFixed(1)}%`);
}
