/**
 * quiet-verdict.js — "조용한 종목" 복합 패턴 판정 (2026-11-11)
 *
 * 기준은 QUIET_VERDICT.md 에 사전 등록(커밋 4d90cb6)돼 있다. 정의를 바꾸면 판정 리셋.
 * 시험 구간 = 2010-01 ~ 2021-12 (data/krx-daily-2010.jsonl — 종목 선별 분석에 처음 쓰는 표본).
 *
 * 실행: node --max-old-space-size=12288 scripts/quiet-verdict.js [--null=200]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const NULLN = +arg('null', 200);
const TEST_END = '20220101';
const COST = 0.35 / 100;
const CAPMIN = 1000e8, VALMIN = 5e8, LOOK = 20;

(async () => {
  // ── 가격 (스트리밍 — 605MB 라 한 번에 못 읽는다) ──────────────────────
  const recs = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.resolve(__dirname, '../data/krx-daily-2010.jsonl')), crlfDelay: Infinity });
  for await (const l of rl) if (l.trim()) recs.push(JSON.parse(l));
  recs.sort((a, b) => a.d.localeCompare(b.d));
  const days = recs.map(r => r.d), N = days.length;
  const S = new Map();
  for (let i = 0; i < N; i++) {
    for (const [code, o, , , c, , val, cap] of recs[i].s) {
      if (!/0$/.test(code)) continue;
      let s = S.get(code);
      if (!s) { s = { o: new Float32Array(N), c: new Float64Array(N), val: new Float64Array(N), cap: new Float64Array(N) }; S.set(code, s); }
      s.o[i] = o; s.c[i] = c; s.val[i] = val; s.cap[i] = cap;
    }
    recs[i] = null;
  }
  for (const s of S.values()) { let L = -1; for (let i = 0; i < N; i++) if (s.c[i] > 0) L = i; s.last = L; }
  const dayRet = (s, i) => {
    const a = s.c[i - 1], b = s.c[i];
    if (!(a > 0) || !(b > 0)) return 0;
    const r = b / a - 1;
    if (Math.abs(r) > 0.31 && s.cap[i - 1] > 0 && s.cap[i] > 0) return s.cap[i] / s.cap[i - 1] - 1;
    return r;
  };
  const kospi = new Map();
  for (const l of fs.readFileSync(path.resolve(__dirname, '../data/kospi-index-long.jsonl'), 'utf-8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l); if (r.k) kospi.set(r.d, r.k[0]);
  }
  console.log(`데이터 ${days[0]}~${days[N - 1]} (${N}거래일, ${S.size}종목) · 시험 구간 < ${TEST_END} · 사전등록 QUIET_VERDICT.md`);

  // ── 피처 ──────────────────────────────────────────────────────────────
  const featCache = new Map();
  function features(i) {
    if (featCache.has(i)) return featCache.get(i);
    const rows = [];
    for (const [code, s] of S) {
      if (!(s.c[i] > 0) || !(s.cap[i] >= CAPMIN) || i < LOOK + 1) continue;
      let v = 0, ok = true; const rs = []; let gaps = 0;
      for (let k = 0; k < LOOK; k++) {
        const j = i - k;
        if (!(s.c[j] > 0) || !(s.c[j - 1] > 0)) { ok = false; break; }
        v += s.val[j]; rs.push(dayRet(s, j));
        if (s.o[j] > 0 && s.o[j] / s.c[j - 1] - 1 >= 0.03) gaps++;
      }
      if (!ok || v / LOOK < VALMIN) continue;
      const m = rs.reduce((a, b) => a + b, 0) / LOOK;
      rows.push({ code, cap: s.cap[i], vol: Math.sqrt(rs.reduce((a, r) => a + (r - m) ** 2, 0) / (LOOK - 1)), turn: v / LOOK / s.cap[i], max: Math.max(...rs), gaps });
    }
    // 백분위 (동순위 평균). dir=-1 → 작을수록 높은 점수
    const pct = (key, dir) => {
      const idx = rows.map((r, j) => j).sort((a, b) => dir * (rows[a][key] - rows[b][key]));
      const out = new Float64Array(rows.length);
      for (let t = 0; t < idx.length;) {
        let u = t; while (u + 1 < idx.length && rows[idx[u + 1]][key] === rows[idx[t]][key]) u++;
        const p = rows.length > 1 ? ((t + u) / 2) / (rows.length - 1) : 0.5;
        for (let w = t; w <= u; w++) out[idx[w]] = p;
        t = u + 1;
      }
      return out;
    };
    const P = { vol: pct('vol', -1), turn: pct('turn', -1), max: pct('max', -1), gaps: pct('gaps', -1), cap: pct('cap', 1) };
    rows.forEach((r, j) => { r.p = { vol: P.vol[j], turn: P.turn[j], max: P.max[j], gaps: P.gaps[j], cap: P.cap[j] }; r.q = (P.vol[j] + P.turn[j] + P.max[j] + P.gaps[j] + P.cap[j]) / 5; });
    featCache.set(i, rows);
    return rows;
  }

  let SEED = '';
  const hash = s => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const top = (rows, key, K) => [...rows].sort((a, b) => key(b) - key(a)).slice(0, K);
  const SIG = {
    Q:      (r, i, K) => top(r, x => x.q, K),
    무작위:   (r, i, K) => top(r, x => hash(x.code + days[i] + SEED), K),
    '저변동 단독': (r, i, K) => top(r, x => x.p.vol, K),
    '저회전 단독': (r, i, K) => top(r, x => x.p.turn, K),
    '저MAX 단독': (r, i, K) => top(r, x => x.p.max, K),
    '갭없음 단독': (r, i, K) => top(r, x => x.p.gaps + x.p.cap * 1e-6, K),
    '대형 단독':  (r, i, K) => top(r, x => x.p.cap, K),
  };
  // 시총 상위 300 유니버스 변형
  const cap300 = fn => (r, i, K) => fn([...r].sort((a, b) => b.cap - a.cap).slice(0, 300), i, K);

  function run(fn, K, H) {
    const sd = []; for (let i = LOOK + 1; i + 1 < N; i += H) sd.push(i);
    const per = []; let prevW = new Map();
    for (let t = 0; t < sd.length; t++) {
      const i = sd[t], b = i + 1, e = t + 1 < sd.length ? sd[t + 1] + 1 : N - 1;
      if (e <= b) break;
      const picks = fn(features(i), i, K);
      if (!picks.length) continue;
      const w = new Map(picks.map(r => [r.code, 1 / picks.length]));
      let to = 0; for (const [c, x] of w) to += Math.max(0, x - (prevW.get(c) || 0));
      let ret = 0;
      for (const [c, x] of w) { const s = S.get(c); let g = 1; for (let k = b + 1; k <= e; k++) { if (k > s.last) break; g *= 1 + dayRet(s, k); } ret += x * (g - 1); }
      per.push({ d0: days[b], d1: days[e], ret: ret - to * COST });
      prevW = w;
    }
    return per;
  }
  const toT = d => Date.parse(d.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3'));
  function stats(per, lo, hi) {
    const ps = per.filter(p => p.d0 >= lo && p.d0 < hi);
    if (!ps.length) return null;
    let nav = 1, pk = 1, mdd = 0, k = 1;
    for (const p of ps) { nav *= 1 + p.ret; pk = Math.max(pk, nav); mdd = Math.min(mdd, nav / pk - 1); const a = kospi.get(p.d0), b = kospi.get(p.d1); if (a && b) k *= b / a; }
    const yrs = (toT(ps[ps.length - 1].d1) - toT(ps[0].d0)) / 3.156e10;
    return { cagr: nav ** (1 / yrs) - 1, kcagr: k ** (1 / yrs) - 1, mdd, cum: nav - 1 };
  }
  const years = per => { const y = {}; for (const p of per) { const Y = p.d0.slice(0, 4); y[Y] = (y[Y] || 1) * (1 + p.ret); } for (const Y in y) y[Y] -= 1; return y; };
  const pc = v => (v == null || !isFinite(v) ? '     -' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%')).padStart(8);
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

  // ── 주 판정: K20 · H20 ────────────────────────────────────────────────
  const t0 = Date.now();
  const qPer = run(SIG.Q, 20, 20);
  const nulls = [];
  for (let t = 0; t < NULLN; t++) { SEED = '#' + t; nulls.push(run(SIG.무작위, 20, 20)); }
  SEED = '';
  const qT = stats(qPer, '0', TEST_END), qD = stats(qPer, TEST_END, '9');
  const nT = nulls.map(p => stats(p, '0', TEST_END).cagr), nD = nulls.map(p => stats(p, TEST_END, '9').cagr);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

  console.log(`\n[주 설정] Q 상위 20 · 등가중 · 20거래일 리밸런싱 · 비용 차감 (무작위 ${NULLN}개, ${((Date.now() - t0) / 1000).toFixed(0)}초)`);
  console.log('구간'.padEnd(18), '  Q20 연수익  무작위 평균   무작위 5%   무작위 95% |  Q−무작위   KOSPI 연   Q MDD');
  for (const [lab, s, n] of [['시험 2010-2021', qT, nT], ['발견 2022-2026', qD, nD]]) {
    console.log(lab.padEnd(18), pc(s.cagr), '   ', pc(mean(n)), '  ', pc(q(n, 0.05)), '  ', pc(q(n, 0.95)), '|', pc(s.cagr - mean(n)), '  ', pc(s.kcagr), '  ', pc(s.mdd));
  }

  // 연도별
  const qy = years(qPer), ny = nulls.map(years);
  console.log('\n연도별 (Q20 vs 무작위 평균)');
  let win = 0, tot = 0;
  for (const Y of Object.keys(qy).sort()) {
    const nm = mean(ny.map(y => y[Y]).filter(v => v != null));
    const a = kospi.get(Object.keys(Object.fromEntries(qPer.filter(p => p.d0.startsWith(Y)).map(p => [p.d0, 1])))[0]);
    const ps = qPer.filter(p => p.d0.startsWith(Y)); const k = ps.reduce((g, p) => { const x = kospi.get(p.d0), z = kospi.get(p.d1); return x && z ? g * z / x : g; }, 1) - 1;
    const beat = qy[Y] > nm;
    if (Y < TEST_END.slice(0, 4)) { tot++; if (beat) win++; }
    console.log(`  ${Y}${Y < TEST_END.slice(0, 4) ? '' : '*'}  Q20 ${pc(qy[Y])}  무작위 ${pc(nm)}  차이 ${pc(qy[Y] - nm)}  KOSPI ${pc(k)}  ${beat ? '✅' : '❌'}`);
  }
  console.log('  (* = 발견 표본, 판정에 쓰지 않음)');

  // 판정
  const P1 = qT.cagr - mean(nT) >= 0.03 && qT.cagr > q(nT, 0.95);
  const P2 = win >= 8;
  const P3 = qT.cagr - qT.kcagr > 0;
  console.log('\n── 판정 (1회, 시험 구간 2010-2021) ──');
  console.log(`P1 크기:   Q−무작위 ${pc(qT.cagr - mean(nT))} (기준 ≥+3.0%), 무작위 95% ${pc(q(nT, 0.95))} 초과 ${qT.cagr > q(nT, 0.95) ? 'O' : 'X'} → ${P1 ? '✅' : '❌'}`);
  console.log(`P2 일관성: ${win}/${tot}개 연도 무작위 평균 상회 (기준 ≥8) → ${P2 ? '✅' : '❌'}`);
  console.log(`P3 실용(병기): KOSPI 대비 ${pc(qT.cagr - qT.kcagr)}/년 → ${P3 ? '✅' : '❌'}`);
  console.log('결론:', P1 && P2 ? '채택 후보 — 관측 개시, 실매매는 별도 사전 등록' : '기각');

  // ── 강건성 (판정을 바꾸지 않는다) ─────────────────────────────────────
  console.log('\n[강건성] 시험 구간 연수익 (무작위 평균은 같은 K·H로 50개)');
  const rnd = (K, H, wrap = f => f) => { const a = []; for (let t = 0; t < 50; t++) { SEED = 'r' + t; a.push(stats(run(wrap(SIG.무작위), K, H), '0', TEST_END).cagr); } SEED = ''; return mean(a); };
  const cfgs = [['Q · K10 · H20', SIG.Q, 10, 20], ['Q · K40 · H20', SIG.Q, 40, 20], ['Q · K20 · H10', SIG.Q, 20, 10], ['Q · 시총300 · K20 · H20', cap300(SIG.Q), 20, 20, cap300]];
  for (const [lab, fn, K, H, wrap] of cfgs) { const s = stats(run(fn, K, H), '0', TEST_END); const r = rnd(K, H, wrap); console.log(`  ${lab.padEnd(22)} ${pc(s.cagr)}  무작위 ${pc(r)}  차이 ${pc(s.cagr - r)}  MDD ${pc(s.mdd)}`); }
  for (const name of ['저변동 단독', '저회전 단독', '저MAX 단독', '갭없음 단독', '대형 단독']) { const s = stats(run(SIG[name], 20, 20), '0', TEST_END); console.log(`  ${name.padEnd(22)} ${pc(s.cagr)}  무작위 ${pc(mean(nT))}  차이 ${pc(s.cagr - mean(nT))}  MDD ${pc(s.mdd)}`); }

  // 10분위 단조성 (시험 구간, 5거래일마다, D+1→D+21 매칭초과 중앙값)
  const dec = Array.from({ length: 10 }, () => []);
  const med = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  for (let i = LOOK + 1; i + 22 < N && days[i] < TEST_END; i += 5) {
    const rows = features(i).filter(r => { const s = S.get(r.code); return s.c[i + 1] > 0 && s.c[i + 21] > 0; });
    if (rows.length < 100) continue;
    const f = rows.map(r => { const s = S.get(r.code); let g = 1; for (let k = i + 2; k <= i + 21; k++) g *= 1 + dayRet(s, k); return g - 1; });
    const m = med(f);
    const ord = rows.map((r, j) => j).sort((a, b) => rows[a].q - rows[b].q);
    ord.forEach((j, t) => dec[Math.min(9, Math.floor(t / ord.length * 10))].push(f[j] - m));
  }
  console.log('\n[강건성] 시험 구간 Q 10분위 (D1=가장 시끄러움 … D10=가장 조용함) — D+1→D+21 매칭초과 중앙 / 평균');
  console.log('  ' + dec.map((a, j) => `D${j + 1} ${pc(med(a))}/${pc(mean(a))}`).join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
