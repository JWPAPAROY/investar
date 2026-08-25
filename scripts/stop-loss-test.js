/**
 * stop-loss-test.js — "좌측 꼬리를 손절로 자르면 분포가 비대칭이 되는가" (2026-08-25)
 *
 * 배경(tail-hunter.js): **종목 선별로는 우측 꼬리만 고를 수 없다.** 우측 확률을 높이는
 *   조건은 전부 좌측을 더 크게 높였다(소형∩고변동∩거래량급증 = 우측 2.20× / 좌측 6.04×).
 *   남은 경로는 예측이 아니라 **포지션 관리** — 손절로 좌측을 사후에 절단하는 것.
 *
 * 검정: D+1 종가 매수 후, 보유 중 종가 기준 손실이 −STOP%에 닿으면 청산.
 *   ① 즉시 체결(그날 종가) = **낙관적 상한**
 *   ② 다음날 종가 체결 = **현실판**(종가 확인 후 주문하므로 하루 밀린다)
 *   손절이 우측 꼬리는 건드리지 않으므로 P(우측)은 유지되고 P(좌측)만 줄어야 한다.
 *   진짜 질문은 **평균이 양수로 넘어가는가** — 손절은 반등할 종목도 손실로 확정시킨다.
 *
 * 실행: node --max-old-space-size=8192 scripts/stop-loss-test.js [--sell=10] [--up=20] [--dn=20]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10), BUY = 1, LOOK = 20;
const UP = arg('up', 20), DN = arg('dn', 20);
const CAPMIN = arg('capmin', 500) * 1e8, VALMIN = arg('valmin', 3) * 1e8;
const STEP = arg('step', 2);   // 연산량 조절: 신호일 샘플링 간격

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pc = v => (v == null ? '   -' : (v * 100).toFixed(2).padStart(6) + '%');
const f2 = v => (v == null ? '   -' : ((v >= 0 ? '+' : '') + v.toFixed(2)).padStart(7));

const recs = fs.readFileSync(path.resolve(__dirname, '../data/krx-daily.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).sort((a, b) => (a.d < b.d ? -1 : 1));
const days = recs.map(r => r.d), N = days.length;
const byDay = recs.map(r => { const m = new Map(); for (const s of r.s) m.set(s[0], s); return m; });
const row = (c, i) => (i >= 0 && i < N ? byDay[i].get(c) : undefined);
const close = (c, i) => { const r = row(c, i); return r && r[4] > 0 ? r[4] : null; };

/** 손절 규칙 적용 수익률. stop=null이면 만기 보유. lag=1이면 다음날 종가 체결. */
function exitRet(c, i, stop, lag) {
  const b = close(c, i + BUY); if (!b) return null;
  if (stop != null) {
    for (let k = BUY + 1; k <= SELL; k++) {
      const p = close(c, i + k); if (!p) continue;
      const r = ((p - b) / b) * 100;
      if (r <= -stop) {
        if (!lag) return r;
        const q = close(c, i + k + 1);
        return q ? ((q - b) / b) * 100 : r;   // 다음날 가격 없으면 당일 종가로 대체
      }
    }
  }
  const s = close(c, i + SELL);
  return s ? ((s - b) / b) * 100 : null;
}

// ── 피처 + 그룹 ────────────────────────────────────────────────────────
const feat = new Map(), elig = new Map(), poolOf = new Map();
for (let i = LOOK + 5; i + SELL + 1 < N; i += STEP) {
  const list = [], prows = [];
  for (const r of byDay[i].values()) {
    const [c, , , , cl, vol, val, cap] = r;
    if (!(cl > 0) || !(cap >= CAPMIN)) continue;
    const closes = [], vols = [];
    let ok = true, vsum = 0;
    for (let k = LOOK; k >= 0; k--) {
      const p = row(c, i - k); if (!p || !(p[4] > 0)) { ok = false; break; }
      closes.push(p[4]); vols.push(p[5] || 0); vsum += (p[6] || 0);
    }
    if (!ok || !(vsum / (LOOK + 1) >= VALMIN)) continue;
    const avgV = avg(vols.slice(0, -1)) || 1;
    const rets = [];
    for (let k = 1; k < closes.length; k++) rets.push(((closes[k] - closes[k - 1]) / closes[k - 1]) * 100);
    const prev = closes[closes.length - 2];
    feat.set(`${i}|${c}`, { cap, volRatio: vols[vols.length - 1] / avgV, vol20: sd(rets), turn: vol / (cap / cl), chg: prev > 0 ? ((cl - prev) / prev) * 100 : null, val });
    list.push(c);
    prows.push({ c, vol, val, surge: val >= 1e8 ? vols[vols.length - 1] / avgV : null, turn: vol / (cap / cl), chg: prev > 0 ? ((cl - prev) / prev) * 100 : null });
  }
  elig.set(i, list);
  const pick = k => prows.filter(r => r[k] != null && isFinite(r[k])).sort((a, b) => b[k] - a[k]).slice(0, 30).map(r => r.c);
  const u = new Set();
  for (const k of ['vol', 'val', 'surge', 'turn', 'chg']) for (const c of pick(k)) u.add(c);
  poolOf.set(i, u);
}
for (const [i, list] of elig) {
  const rank = (key, asc) => {
    const a = list.map(c => [c, feat.get(`${i}|${c}`)[key]]).filter(x => x[1] != null && isFinite(x[1]));
    a.sort((x, y) => (asc ? x[1] - y[1] : y[1] - x[1]));
    a.forEach(([c], k) => { feat.get(`${i}|${c}`)['p_' + key] = a.length > 1 ? k / (a.length - 1) : 0; });
  };
  rank('vol20', false); rank('cap', true);
}

const GROUPS = [
  ['유니버스 전체', () => true],
  ['현행 풀 (5랭킹 합집합)', (f, c, i) => poolOf.get(i).has(c)],
  ['고변동성 상위 10%', f => f.p_vol20 <= 0.1],
  ['★소형∩고변동∩거래량급증 (최공격)', f => f.p_cap <= 0.3 && f.p_vol20 <= 0.1 && f.volRatio >= 3],
  ['대형주 상위 10% (대조)', f => f.p_cap >= 0.9],
];
const STOPS = [[null, 0, '손절 없음'], [5, 0, '−5% 즉시'], [7, 0, '−7% 즉시'], [10, 0, '−10% 즉시'], [15, 0, '−15% 즉시'], [7, 1, '−7% 익일종가(현실판)']];

console.log(`\n✂️ 손절 검정 — D+${BUY} 매수 → 최장 D+${SELL}, 우측=+${UP}%↑ / 좌측=−${DN}%↓`);
console.log(`데이터: ${N}거래일 (${days[0]} ~ ${days[N - 1]}), 신호일 ${STEP}일 간격 샘플\n`);

for (const [gname, gfn] of GROUPS) {
  console.log(`  ▍${gname}`);
  console.log('    손절 규칙            |       n  | P(우측) | P(좌측) | 비대칭비 | 평균수익 | 중앙수익 | 승률');
  for (const [stop, lag, label] of STOPS) {
    const rs = [];
    for (const [i, list] of elig) {
      for (const c of list) {
        const f = feat.get(`${i}|${c}`); if (!f || !gfn(f, c, i)) continue;
        const v = exitRet(c, i, stop, lag); if (v != null) rs.push(v);
      }
    }
    if (rs.length < 100) continue;
    const up = rs.filter(v => v >= UP).length / rs.length;
    const dn = rs.filter(v => v <= -DN).length / rs.length;
    const win = rs.filter(v => v > 0).length / rs.length * 100;
    console.log(`    ${label.padEnd(20)} | ${String(rs.length).padStart(7)} | ${pc(up)} | ${pc(dn)} | ${(dn > 0 ? (up / dn).toFixed(2) : '  -').padStart(7)} | ${f2(avg(rs))} | ${f2(med(rs))} | ${win.toFixed(0).padStart(3)}%`);
  }
  console.log('');
}
console.log('  · 손절은 우측 꼬리를 건드리지 않으므로 P(우측)은 거의 유지되고 P(좌측)만 줄어야 정상.');
console.log('  · 관건은 **평균수익이 양수로 넘어가는가** — 손절은 반등할 종목도 손실로 확정시킨다.');
console.log('  · "익일종가" 판이 현실에 가깝다(종가 확인 후 주문). 거래비용은 미반영.\n');
