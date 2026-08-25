/**
 * compare-etf.js — "직접 20종목 굴리기 vs ETF 사기" 비교 (2026-08-25)
 *
 * 왜: 오늘 하루 반복해서 부딪힌 질문이 "왜 인덱스를 안 사는가"였다. 저PBR 포트폴리오가
 *   상장 ETF보다 나은 게 없다면 직접 운용할 이유가 없다.
 *
 * 방법: 저PBR 전략의 NAV 경로(portfolio-sim --emit-nav)와 ETF 종가를 **같은 날짜 격자**
 *   (리밸런싱 매수일)에서 정렬해 비교. 각 ETF는 상장 시점이 달라 **공통 구간**으로 잘라
 *   양쪽을 동일 시작점 1.0으로 재정규화한다.
 *
 * ⚠️ 배당: 저PBR 시뮬(KRX 종가)과 PR형 ETF는 둘 다 분배금/배당 제외라 대칭이다.
 *   **TR 상품(RISE 대형고배당10TR)만 배당 재투자가 포함**되어 그쪽이 구조적으로 유리하다.
 *
 * 실행: node scripts/compare-etf.js [--nav=data/nav-pbr.json]
 */
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const NAVF = path.resolve(__dirname, '..', arg('nav', 'data/nav-pbr.json'));

const NAMES = {
  '069500': ['KODEX 200', '코스피200', 'PR'],
  '161510': ['PLUS 고배당주', 'FnGuide 배당주', 'PR'],
  '315960': ['RISE 대형고배당10TR', 'WISE 대형고배당10', 'TR'],
  '496080': ['TIGER 코리아밸류업', '코리아 밸류업', 'PR'],
  '466940': ['TIGER 은행고배당TOP10', '은행 고배당', 'PR'],
  '484880': ['SOL 금융지주플러스고배당', '금융지주 고배당', 'PR'],
};

const nav = JSON.parse(fs.readFileSync(NAVF, 'utf-8'));           // [{d, nav}]
const navAt = new Map(nav.map(x => [x.d, x.nav]));
const grid = nav.map(x => x.d);

// ETF 종가 로드
const px = new Map();  // code -> Map(date -> close)
for (const l of fs.readFileSync(path.resolve(__dirname, '../data/etf-daily.jsonl'), 'utf-8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  for (const [c, close] of r.e) {
    if (!px.has(c)) px.set(c, new Map());
    if (close > 0) px.get(c).set(r.d, close);
  }
}

const mdd = arr => { let peak = 0, m = 0; for (const v of arr) { if (v > peak) peak = v; const dd = (v / peak - 1) * 100; if (dd < m) m = dd; } return m; };
const cagr = (total, years) => (Math.pow(1 + total / 100, 1 / years) - 1) * 100;
const pct = v => (v == null ? '      -' : ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(8));

console.log(`\n🆚 저PBR 직접 운용 vs 상장 ETF — 같은 날짜 격자(리밸런싱 매수일 ${grid.length}점)에서 비교`);
console.log(`저PBR NAV 구간: ${grid[0]} ~ ${grid[grid.length - 1]}\n`);
console.log('  대상                          | 구간              | 기간  | ETF 누적 | ETF CAGR | ETF MDD | 같은구간 저PBR | MDD');
console.log('  ' + '-'.repeat(120));

for (const [code, [nm, idx, type]] of Object.entries(NAMES)) {
  const m = px.get(code);
  if (!m || m.size < 10) { console.log(`  ${nm.padEnd(28)} | 데이터 없음`); continue; }
  // 격자 위에서 ETF와 저PBR 모두 값이 있는 날짜만
  const pts = grid.filter(d => m.has(d) && navAt.has(d));
  if (pts.length < 5) { console.log(`  ${nm.padEnd(28)} | 공통 구간 부족(${pts.length}점)`); continue; }
  const e0 = m.get(pts[0]), n0 = navAt.get(pts[0]);
  const ep = pts.map(d => m.get(d) / e0);
  const np = pts.map(d => navAt.get(d) / n0);
  const years = pts.length * 10 / 252;   // 격자 간격 = 10거래일
  const eTot = (ep[ep.length - 1] - 1) * 100, nTot = (np[np.length - 1] - 1) * 100;
  console.log(`  ${(nm + ' [' + type + ']').padEnd(28)} | ${pts[0]}~${pts[pts.length - 1]} | ${years.toFixed(1)}년 | ${pct(eTot)} | ${pct(cagr(eTot, years))} | ${pct(mdd(ep))} | ${pct(nTot).padStart(12)} | ${pct(mdd(np))}`);
}

console.log('\n  · "같은구간 저PBR"은 각 ETF의 상장·데이터 구간에 맞춰 저PBR NAV를 다시 정규화한 값이다.');
console.log('  · [PR] = 분배금 제외(저PBR 시뮬과 대칭) / [TR] = 배당 재투자 포함(ETF에 유리).');
console.log('  · 저PBR은 20종목 직접 매매·10거래일 리밸런싱·거래비용 차감 기준. ETF는 보수 미차감(ETF에 유리).\n');
