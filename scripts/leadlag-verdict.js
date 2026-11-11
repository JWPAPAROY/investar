/**
 * 미국 업종(SOX 상대강도) → 한국 업종 시차 반영 판정 (사전 등록 LEADLAG_VERDICT.md, 1회 실행).
 *
 * 한국 반도체 = 삼성전자+SK하이닉스 시총가중, 나머지 = KOSPI ex-2 (지수에서 역산).
 * 결정일 d 종가에 결정, 미국은 d 보다 앞선 미국 거래일 종가까지만 쓴다.
 *
 * 실행: node --max-old-space-size=8192 scripts/leadlag-verdict.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const D = path.resolve(__dirname, '../data');
const SEMI = ['005930', '000660'];
const ROUND = 0.38;
const LS = [20, 40, 60];
const HOLD = 5, PHASES = 5;
const IS = ['20100101', '20181231'], OOS = ['20190101', '20991231'];

async function loadKR() {
  // 지수 종가
  const idx = new Map(), capTot = new Map();
  for (const l of fs.readFileSync(path.join(D, 'kospi-index-long.jsonl'), 'utf-8').split('\n')) {
    if (!l.trim()) continue; const r = JSON.parse(l);
    if (r.k && r.d < '20220101' && r.k[0] > 0) idx.set(r.d, r.k[0]);
  }
  for (const l of fs.readFileSync(path.join(D, 'krx-index.jsonl'), 'utf-8').split('\n')) {
    if (!l.trim()) continue; const r = JSON.parse(l);
    const k = r.i.find(x => x[0] === '코스피');
    if (k && k[1] > 0) { idx.set(r.d, k[1]); capTot.set(r.d, k[7]); }
  }
  // 두 종목 + (2021 이전) KOSPI 시총 합
  const semi = new Map();   // d -> {code: [close, cap]}
  const scan = async (file, tagged) => {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(D, file)), crlfDelay: Infinity });
    for await (const l of rl) {
      if (!l.trim()) continue;
      const r = JSON.parse(l);
      if (tagged && r.d >= '20220101') continue;
      const m = {}; let tot = 0;
      for (const s of r.s) {
        if (SEMI.includes(s[0])) m[s[0]] = [s[4], s[7]];
        if (tagged && s[8] === 'K' && s[7] > 0) tot += s[7];
      }
      semi.set(r.d, m);
      if (tagged) capTot.set(r.d, tot);
    }
  };
  await scan('krx-daily-2010.jsonl', true);
  await scan('krx-daily.jsonl', false);

  const days = [...idx.keys()].filter(d => semi.has(d) && capTot.get(d) > 0).sort();
  const rows = [];
  for (let t = 1; t < days.length; t++) {
    const a = days[t - 1], b = days[t];
    const sa = semi.get(a), sb = semi.get(b);
    let num = 0, den = 0, cap2 = 0;
    for (const c of SEMI) {
      if (!sa[c]) continue;
      cap2 += sa[c][1];
      if (!sb[c] || !(sa[c][0] > 0) || !(sb[c][0] > 0)) { den += sa[c][1]; continue; }   // 정지일 = 0%
      let r = sb[c][0] / sa[c][0];
      if ((r > 1.3 || r < 0.7) && sb[c][1] > 0) r = sb[c][1] / sa[c][1];             // 분할 이음매
      num += sa[c][1] * (r - 1); den += sa[c][1];
    }
    const R2 = den > 0 ? num / den : 0;
    const w2 = cap2 / capTot.get(a);
    const RK = idx.get(b) / idx.get(a) - 1;
    const RX = (RK - w2 * R2) / (1 - w2);
    rows.push({ d: b, R2, RX, RK, w2 });
  }
  return rows;
}

function loadUS() {
  const u = JSON.parse(fs.readFileSync(path.join(D, 'us-daily.json'), 'utf-8'));
  const sox = new Map(u['^SOX'].filter(x => x[1] > 0)), spx = new Map(u['^GSPC'].filter(x => x[1] > 0));
  const dates = [...sox.keys()].filter(d => spx.has(d)).sort();
  return { dates, sox: dates.map(d => sox.get(d)), spx: dates.map(d => spx.get(d)) };
}

(async () => {
  const kr = await loadKR();
  const us = loadUS();
  const N = kr.length;
  console.log(`한국 ${kr[0].d} ~ ${kr[N - 1].d} (${N}일) · 미국 ${us.dates[0]} ~ ${us.dates[us.dates.length - 1]} · 현재 반도체 비중 w₂ ${(kr[N - 1].w2 * 100).toFixed(1)}%`);

  // 누적 로그 (한국)
  const c2 = [0], cx = [0];
  for (const r of kr) { c2.push(c2[c2.length - 1] + Math.log(1 + r.R2)); cx.push(cx[cx.length - 1] + Math.log(1 + r.RX)); }
  // c2[t+1] = kr[t] 종가까지 누적
  // 결정일 t (kr[t].d 종가) 기준 미국 인덱스: 미국 날짜 < kr[t].d 인 마지막
  const usIdx = new Array(N); { let j = -1; for (let t = 0; t < N; t++) { while (j + 1 < us.dates.length && us.dates[j + 1] < kr[t].d) j++; usIdx[t] = j; } }
  const sUS = (t, L) => { const j = usIdx[t]; if (j - L < 0) return null; return Math.log(us.sox[j] / us.sox[j - L]) - Math.log(us.spx[j] / us.spx[j - L]); };
  const sKR = (t, L) => (t + 1 - L < 0 ? null : (c2[t + 1] - c2[t + 1 - L]) - (cx[t + 1] - cx[t + 1 - L]));
  const fwd = (t, H) => (t + 1 + H > N ? null : (c2[t + 1 + H] - c2[t + 1]) - (cx[t + 1 + H] - cx[t + 1]));

  // 전략 NAV (일별): 결정일 t 신호로 t+1..t+H 보유
  function strat(sig, L, phase, H = HOLD) {
    const nav = new Array(N).fill(null);
    let v = 1, pos = null, start = null;
    for (let t = 0; t < N; t++) {
      if (pos != null) { v *= 1 + (pos === 'S' ? kr[t].R2 : kr[t].RX); nav[t] = v; }
      if (start == null) { if (sig(t, L) != null && t >= 60) start = t + phase; else continue; }
      if (t >= start && (t - start) % H === 0) {
        const s = sig(t, L); if (s == null) continue;
        const np = s > 0 ? 'S' : 'X';
        if (np !== pos) v *= 1 - ROUND / 100;
        pos = np; if (nav[t] == null) nav[t] = v;
      }
    }
    return nav;
  }
  const kospiNav = (() => { const a = []; let v = 1; for (const r of kr) { v *= 1 + r.RK; a.push(v); } return a; })();
  const cagr = (nav, [a, b]) => {
    const ix = []; for (let t = 0; t < N; t++) if (kr[t].d >= a && kr[t].d <= b && nav[t] != null) ix.push(t);
    const s = ix[0], e = ix[ix.length - 1];
    const yrs = (Date.parse(iso(kr[e].d)) - Date.parse(iso(kr[s].d))) / (365.25 * 864e5);
    return (Math.pow(nav[e] / nav[s], 1 / yrs) - 1) * 100;
  };
  const iso = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const med = a => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };
  const f = v => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(7);

  // ── 1) 설계 구간 L 선택 ──
  console.log('\n[설계 2010-2018] CAGR 위상 5개 중앙 (최소~최대)');
  const kIS = cagr(kospiNav, IS), kOO = cagr(kospiNav, OOS);
  console.log(`  KOSPI 보유      ${f(kIS)}`);
  const isMed = {};
  for (const L of LS) {
    const u = [...Array(PHASES).keys()].map(p => cagr(strat(sUS, L, p), IS));
    const k = [...Array(PHASES).keys()].map(p => cagr(strat(sKR, L, p), IS));
    isMed[L] = med(u);
    console.log(`  L=${L}  US ${f(med(u))} (${f(Math.min(...u)).trim()}~${f(Math.max(...u)).trim()})   KR ${f(med(k))}`);
  }
  const Lsel = LS.slice().sort((a, b) => isMed[b] - isMed[a])[0];
  console.log(`  → 선택 L=${Lsel}`);

  // ── 2) 시험 구간 ──
  console.log(`\n[시험 2019-2026] L=${Lsel}  KOSPI 보유 ${f(kOO).trim()}`);
  let p1 = 0, p2 = 0;
  for (let p = 0; p < PHASES; p++) {
    const u = cagr(strat(sUS, Lsel, p), OOS), k = cagr(strat(sKR, Lsel, p), OOS);
    if (u - kOO >= 2) p1++; if (u - k > 0) p2++;
    console.log(`  위상 ${p}: US ${f(u)} (KOSPI 대비 ${f(u - kOO).trim()}p)  KR ${f(k)}  US−KR ${f(u - k).trim()}p`);
  }
  // P3 회귀 (Newey-West)
  function nwReg(L, from, to, H = HOLD) {
    const Y = [], X = [];
    for (let t = 0; t < N; t++) {
      if (kr[t].d < from || kr[t].d > to) continue;
      const a = sUS(t, L), b = sKR(t, L), y = fwd(t, H);
      if (a == null || b == null || y == null) continue;
      Y.push(y); X.push([1, a, b]);
    }
    const n = Y.length, k = 3;
    const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], XtY = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) { XtY[p] += X[i][p] * Y[i]; for (let q = 0; q < k; q++) XtX[p][q] += X[i][p] * X[i][q]; }
    const inv = inv3(XtX);
    const beta = [0, 1, 2].map(p => inv[p].reduce((s, v, q) => s + v * XtY[q], 0));
    const e = Y.map((y, i) => y - X[i].reduce((s, v, p) => s + v * beta[p], 0));
    const lag = H;
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let l = 0; l <= lag; l++) {
      const w = l === 0 ? 1 : 1 - l / (lag + 1);
      for (let i = l; i < n; i++) for (let p = 0; p < k; p++) for (let q = 0; q < k; q++) {
        const g = X[i][p] * e[i] * X[i - l][q] * e[i - l];
        S[p][q] += w * (l === 0 ? g : g + X[i - l][p] * e[i - l] * X[i][q] * e[i]) / (l === 0 ? 1 : 1);
      }
    }
    // l>0 항을 두 번 더했으므로 대칭 보정 완료. V = inv S inv
    const V = mul(mul(inv, S), inv);
    return { n, beta, t: beta.map((b, p) => b / Math.sqrt(V[p][p])) };
  }
  function inv3(m) {
    const [a, b, c] = m[0], [d, e, f2] = m[1], [g, h, i] = m[2];
    const A = e * i - f2 * h, B = -(d * i - f2 * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [[A, -(b * i - c * h), b * f2 - c * e], [B, a * i - c * g, -(a * f2 - c * d)], [C, -(a * h - b * g), a * e - b * d]].map(r => r.map(v => v / det));
  }
  function mul(A, B) { return A.map((r, p) => B[0].map((_, q) => r.reduce((s, v, k) => s + v * B[k][q], 0))); }

  const reg = nwReg(Lsel, ...OOS);
  console.log(`  P3 회귀 (n=${reg.n}): S_US 계수 t = ${reg.t[1].toFixed(2)} · S_KR 계수 t = ${reg.t[2].toFixed(2)}`);

  const P1 = p1 >= 4, P2 = p2 >= 4, P3 = reg.t[1] >= 2;
  console.log(`\n── 판정 (1회) ──`);
  console.log(`P1 수익 (KOSPI +2%p 이상): ${p1}/5 → ${P1 ? '✅' : '❌'}`);
  console.log(`P2 미국 정보의 몫 (US > KR): ${p2}/5 → ${P2 ? '✅' : '❌'}`);
  console.log(`P3 예측력 (t ≥ 2): ${reg.t[1].toFixed(2)} → ${P3 ? '✅' : '❌'}`);
  console.log(`결론: ${P1 && P2 && P3 ? '관측 후보' : '기각'}`);

  // ── 강건성 병기 ──
  const corr = (a, b) => { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let x = 0, y = 0, z = 0; for (let i = 0; i < n; i++) { x += (a[i] - ma) * (b[i] - mb); y += (a[i] - ma) ** 2; z += (b[i] - mb) ** 2; } return x / Math.sqrt(y * z); };
  console.log('\n[병기] 같은 주 vs 다음 주 상관 (주 단위 비중첩, 미국 SOX−S&P 5일 vs 한국 반도체−나머지 5일)');
  for (const [name, [a, b]] of [['설계', IS], ['시험', OOS]]) {
    const same = [[], []], next = [[], []];
    for (let t = 6; t + 6 < N; t += 5) {
      if (kr[t].d < a || kr[t].d > b) continue;
      // 같은 주: 미국은 d+1 직전까지(= 한국 d 와 같은 날짜까지), 한국은 d-4..d
      const usSame = sUS(t + 1, 5), krSame = sKR(t, 5), usNow = sUS(t, 5), krNext = fwd(t, 5);
      if (usSame != null && krSame != null) { same[0].push(usSame); same[1].push(krSame); }
      if (usNow != null && krNext != null) { next[0].push(usNow); next[1].push(krNext); }
    }
    console.log(`  ${name}: 같은 주 r = ${corr(...same).toFixed(2)} · 다음 주 r = ${corr(...next).toFixed(2)} (n=${next[0].length})`);
  }
  console.log('\n[병기] S_US 계수 t (보유·L 전 조합, 시험 구간 / 설계 구간)');
  for (const H of [5, 20]) console.log(`  H=${H}: ` + LS.map(L => `L=${L} ${nwReg(L, ...OOS, H).t[1].toFixed(2)} / ${nwReg(L, ...IS, H).t[1].toFixed(2)}`).join(' · '));
  console.log(`\n[병기] 보유 20일 시험 구간 US 전략 CAGR (위상 0~4): ` + [0, 1, 2, 3, 4].map(p => f(cagr(strat(sUS, Lsel, p * 4, 20), OOS)).trim()).join(' ') + `  vs KOSPI ${f(kOO).trim()}`);
  const t = N - 1;
  console.log(`\n[참고] 현재(${kr[t].d}) 신호: ` + LS.map(L => `L=${L} 미국 ${f(sUS(t, L) * 100).trim()}p · 한국 ${f(sKR(t, L) * 100).trim()}p`).join(' | '));
})();
