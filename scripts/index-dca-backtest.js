/**
 * index-dca-backtest.js — 분할매수 규칙 검정: 정액 vs 낙폭 연동 (2026-10-22)
 *
 * 판정 기준은 INDEX_DCA_VERDICT.md 에 돌리기 전에 등록했다. 규칙·임계값·구간을 여기서 바꾸지 말 것.
 * 실행: node scripts/index-dca-backtest.js [--cashrate=0.03]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const CASH_RATE = +arg('cashrate', 0);
const COST = 0.0005, YEARS = 5;
const fp = f => path.resolve(__dirname, '../data', f);
const lines = f => fs.existsSync(fp(f)) ? fs.readFileSync(fp(f), 'utf-8').split('\n').filter(s => s.trim()) : [];

// ── 데이터 (index-signal-test.js 와 같은 병합) ─────────────────────────
const px = new Map();
for (const l of lines('kospi-index-long.jsonl')) { const r = JSON.parse(l); if (!r.h && r.k200[0] > 0) px.set(r.d, r.k200[0]); }
for (const l of lines('krx-index.jsonl')) {
  const r = JSON.parse(l); if (px.has(r.d)) continue;
  const k = r.i.find(x => x[0] === '코스피 200'); if (k && k[1] > 0) px.set(r.d, k[1]);
}
const D = [...px.keys()].sort(), n = D.length, C = D.map(d => px.get(d));
const utc = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
const wk = d => Math.floor((utc(d) / 864e5 + 3) / 7);
const weekEnd = D.map((d, i) => i === n - 1 || wk(D[i + 1]) !== wk(d));
const dd = C.map((c, i) => { if (i < 252) return NaN; let h = 0; for (let j = i - 252; j <= i; j++) h = Math.max(h, C[j]); return c / h - 1; });
console.log(`KOSPI 200 ${n}일 (${D[0]}~${D[n - 1]}) | 현금이자 연 ${(CASH_RATE * 100).toFixed(1)}%`);

const RULES = {
  'A 정액': () => 1,
  'B1 낙폭 연동': x => x > -0.10 ? 0.7 : x > -0.20 ? 1.5 : x > -0.30 ? 2 : 3,
  'B2 낙폭 연동(강)': x => x > -0.10 ? 0.5 : x > -0.20 ? 1.5 : x > -0.30 ? 2.5 : 4,
};

/** [a, b] 구간 운용 → { mult: 평가액/입금액, invested: 투자 비중(종료 시) } */
function run(rule, a, b) {
  let cash = 0, units = 0, paid = 0, pending = 0;
  const dailyCash = Math.pow(1 + CASH_RATE, 1 / 252) - 1;
  for (let i = a; i <= b; i++) {
    cash *= 1 + dailyCash;
    if (pending > 0) { const amt = Math.min(pending, cash); units += amt * (1 - COST) / C[i]; cash -= amt; pending = 0; }
    if (weekEnd[i] && i < b) { cash += 1; paid += 1; pending = rule(dd[i]); }
  }
  const val = units * C[b] + cash;
  return { mult: val / paid, inv: units * C[b] / val };
}

// 창: 매월 첫 거래일 시작, 5년
const starts = [];
for (let i = 1; i < n; i++) if (D[i].slice(0, 6) !== D[i - 1].slice(0, 6) && D[i] >= '20110101') starts.push(i);
const wins = [];
for (const a of starts) {
  const endDate = String(+D[a].slice(0, 4) + YEARS) + D[a].slice(4);
  const b = D.findIndex(d => d >= endDate);
  if (b < 0) break;
  wins.push([a, b]);
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
const res = wins.map(([a, b]) => ({ start: D[a], end: D[b], r: Object.fromEntries(Object.entries(RULES).map(([k, f]) => [k, run(f, a, b)])) }));
const SEG = { 'IS (시작 2011~2015)': w => w.start < '20160101', 'OOS (시작 2016~)': w => w.start >= '20160101' };

console.log(`5년 창 ${res.length}개 (${res[0].start} ~ ${res.at(-1).start} 시작, 겹침 있음)\n`);
const verdict = {};
for (const [seg, f] of Object.entries(SEG)) {
  const ws = res.filter(f);
  console.log(`━━ ${seg} · 창 ${ws.length}개 ━━`);
  console.log(`  A 정액  평가배수 중앙 ${median(ws.map(w => w.r['A 정액'].mult)).toFixed(3)}`);
  for (const k of ['B1 낙폭 연동', 'B2 낙폭 연동(강)']) {
    const diff = ws.map(w => w.r[k].mult - w.r['A 정액'].mult);
    const win = diff.filter(x => x > 0).length / ws.length, med = median(diff);
    const inv = median(ws.map(w => w.r[k].inv));
    const ok = win >= 0.6 && med > 0.02;
    (verdict[k] ??= []).push(ok);
    console.log(`  ${k.padEnd(14)} 평가배수 중앙 ${median(ws.map(w => w.r[k].mult)).toFixed(3)} | A 대비 이긴 창 ${(win * 100).toFixed(0)}% · 차이 중앙 ${pp(med)} · 최악 ${pp(Math.min(...diff))} 최선 ${pp(Math.max(...diff))} · 종료 시 투자비중 중앙 ${(inv * 100).toFixed(0)}% ${ok ? '✓' : ''}`);
  }
}
console.log('\n━━ 판정 (INDEX_DCA_VERDICT.md) ━━');
for (const [k, v] of Object.entries(verdict)) console.log(`  ${k}: ${v.every(Boolean) ? '✅ 채택' : v.some(Boolean) ? '🟡 보류' : '기각'}`);

// 참고: 창 시작 연도별 (타임라인)
console.log('\n━━ 참고: 시작 연도별 평가배수 중앙 (A / B1 / B2) ━━');
const years = [...new Set(res.map(w => w.start.slice(0, 4)))];
for (const y of years) {
  const ws = res.filter(w => w.start.startsWith(y));
  const m = k => median(ws.map(w => w.r[k].mult)).toFixed(3);
  console.log(`  ${y} 시작 → ${+y + YEARS} 종료  ${m('A 정액')} / ${m('B1 낙폭 연동')} / ${m('B2 낙폭 연동(강)')}`);
}
// 참고: 지금 시점 규칙 출력
const i = n - 1;
console.log(`\n현재(${D[i]}) KOSPI 200 ${C[i]} · 252일 고점 대비 ${(dd[i] * 100).toFixed(1)}% → 이번 주 매수배수 B1 ${RULES['B1 낙폭 연동'](dd[i])} / B2 ${RULES['B2 낙폭 연동(강)'](dd[i])}`);
