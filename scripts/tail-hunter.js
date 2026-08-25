/**
 * tail-hunter.js — "극단적 우측 꼬리로 갈 종목만 고를 수 있는가" (2026-08-25)
 *
 * 왜: 보유기간 곡선에서 TOP3는 **평균은 크고 중앙값은 음수**인 복권형 분포로 확인됐다.
 *   그렇다면 목표를 "평균 수익"이 아니라 **"우측 꼬리 소속 확률"**로 바꿔 잡을 수 있는가?
 *
 * 함정: 우측 꼬리를 노리는 조건은 대개 **좌측 꼬리도 함께 산다**(변동성을 사는 것).
 *   그래서 이 스크립트는 반드시 셋을 같이 잰다 —
 *     P(우측) = P(수익 ≥ +UP%)   P(좌측) = P(수익 ≤ −DN%)   **비대칭비 = P(우측)/P(좌측)**
 *   비대칭비가 기준선보다 유의하게 크지 않으면 "우측만 고르기"는 성립하지 않는다.
 *   기대값(평균)도 같이 본다 — 비대칭비가 커도 평균이 음수면 돈은 잃는다.
 *
 * 유니버스: 꼬리는 소형주에 살기 때문에 기존 필터(시총 3,000억+)를 **완화**한다.
 *   기본 시총 500억+ / 20일 평균 거래대금 3억+ (실행 가능성 최소선).
 *
 * 실행: node --max-old-space-size=8192 scripts/tail-hunter.js [--sell=10] [--up=20] [--dn=20]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SELL = arg('sell', 10), BUY = 1, LOOK = 20;
const UP = arg('up', 20), DN = arg('dn', 20);
const CAPMIN = arg('capmin', 500) * 1e8, VALMIN = arg('valmin', 3) * 1e8;

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
const ret = (c, i) => { const b = close(c, i + BUY), s = close(c, i + SELL); return (b && s) ? ((s - b) / b) * 100 : null; };

console.log(`\n🎯 우측 꼬리 사냥 — D+${BUY} 매수 → D+${SELL} 매도, 우측=+${UP}%↑ / 좌측=−${DN}%↓`);
console.log(`데이터: ${N}거래일 (${days[0]} ~ ${days[N - 1]}) | 유니버스: 시총 ${CAPMIN / 1e8}억+ / 거래대금 ${VALMIN / 1e8}억+\n`);

// ── 피처 ───────────────────────────────────────────────────────────────
const feat = new Map(), elig = new Map();
for (let i = LOOK + 5; i + SELL < N; i++) {
  const list = [];
  for (const r of byDay[i].values()) {
    const [c, , , , cl, , , cap] = r;
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
    const ma20 = avg(closes), hi20 = Math.max(...closes), prev = closes[closes.length - 2];
    feat.set(`${i}|${c}`, {
      cap, price: cl, volRatio: vols[vols.length - 1] / avgV, vol20: sd(rets),
      disparity: (cl / ma20) * 100, isHigh20: cl >= hi20 ? 1 : 0,
      ret1: prev > 0 ? ((cl - prev) / prev) * 100 : null,
      mom20: ((cl - closes[0]) / closes[0]) * 100,
      turn: vols[vols.length - 1] / (cap / cl),
    });
    list.push(c);
  }
  elig.set(i, list);
}
// 일별 백분위(변동성·회전율·시총)
for (const [i, list] of elig) {
  const rank = (key, asc) => {
    const a = list.map(c => [c, feat.get(`${i}|${c}`)[key]]).filter(x => x[1] != null && isFinite(x[1]));
    a.sort((x, y) => (asc ? x[1] - y[1] : y[1] - x[1]));
    a.forEach(([c], k) => { feat.get(`${i}|${c}`)['p_' + key] = a.length > 1 ? k / (a.length - 1) : 0; });
  };
  rank('vol20', false); rank('turn', false); rank('cap', true);   // 0 = 가장 고변동/고회전/소형
}

// ── 사전 등록 후보 (늘리지 말 것) ──────────────────────────────────────
const G = [
  ['기준선: 유니버스 전체', () => true],
  ['── 변동성을 사는 조건 ──', null],
  ['소형주 (시총 하위 30%)', f => f.p_cap <= 0.3],
  ['고변동성 상위 10%', f => f.p_vol20 <= 0.1],
  ['회전율 상위 10%', f => f.p_turn <= 0.1],
  ['거래량 급증 ≥3배', f => f.volRatio >= 3],
  ['저가주 (2,000원 이하)', f => f.price <= 2000],
  ['── 추세·돌파 조건 ──', null],
  ['20일 신고가 돌파', f => f.isHigh20 === 1],
  ['이격도 ≥ 120', f => f.disparity >= 120],
  ['전일 +5%↑', f => f.ret1 >= 5],
  ['── 교집합 (꼬리 극대화 시도) ──', null],
  ['★소형 ∩ 고변동 ∩ 거래량급증', f => f.p_cap <= 0.3 && f.p_vol20 <= 0.1 && f.volRatio >= 3],
  ['★소형 ∩ 신고가돌파', f => f.p_cap <= 0.3 && f.isHigh20 === 1],
  ['★고변동 ∩ 신고가돌파 ∩ 전일+5%', f => f.p_vol20 <= 0.1 && f.isHigh20 === 1 && f.ret1 >= 5],
  ['── 대조: 안정 조건 ──', null],
  ['저변동성 하위 10% (변동성 회피)', f => f.p_vol20 >= 0.9],
  ['대형주 (시총 상위 10%)', f => f.p_cap >= 0.9],
];

console.log('  조건                              |       n  | P(우측) | P(좌측) | 비대칭비 | 평균수익 | 중앙수익');
console.log('  ' + '-'.repeat(106));
let baseUp = null, baseDn = null;
for (const [name, fn] of G) {
  if (fn == null) { console.log('  ' + name); continue; }
  const rs = [];
  for (const [i, list] of elig) {
    for (const c of list) {
      const f = feat.get(`${i}|${c}`); if (!f || !fn(f)) continue;
      const v = ret(c, i); if (v != null) rs.push(v);
    }
  }
  if (rs.length < 100) continue;
  const up = rs.filter(v => v >= UP).length / rs.length;
  const dn = rs.filter(v => v <= -DN).length / rs.length;
  if (baseUp == null) { baseUp = up; baseDn = dn; }
  const ratio = dn > 0 ? up / dn : null;
  const lift = `${(up / baseUp).toFixed(2)}× / ${(dn / baseDn).toFixed(2)}×`;
  console.log(`  ${name.padEnd(33)} | ${String(rs.length).padStart(7)} | ${pc(up)} | ${pc(dn)} | ${(ratio == null ? '  -' : ratio.toFixed(2)).padStart(7)} | ${f2(avg(rs))} | ${f2(med(rs))}   ${lift}`);
}
console.log('\n  · 비대칭비 = P(우측)/P(좌측). 기준선보다 **크게** 높아야 "우측만 골랐다"고 할 수 있다.');
console.log('  · 맨 오른쪽 "a× / b×" = 기준선 대비 우측·좌측 확률 배수. b가 a보다 크면 좌측을 더 많이 산 것.');
console.log('  · 비대칭비가 높아도 **평균수익이 음수면 돈은 잃는다** — 둘을 같이 볼 것.\n');
