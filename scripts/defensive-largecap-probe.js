/**
 * defensive-largecap-probe.js — "하락장에도 오르는 우량주" 가설 정밀 검증
 *
 * market-wide-scan에서 시총1조+ 방어업종(음식료·담배 승률66%, 운송·창고 61%)이
 * 유일하게 플러스로 나왔다. 이게 실체인지 소표본 착시인지 가른다.
 *
 * 검증 항목:
 *   1) 종목 수 — 2~3종목이 만든 착시인가? (관측치 n이 아니라 distinct 종목 수)
 *   2) 중앙값 — 평균이 소수 아웃라이어에 끌려간 건 아닌가?
 *   3) 지평 민감도 — D+2/3/5/10 전부에서 유지되는가?
 *   4) 실행 가능성 — "매일 K종목 뽑기" 규칙으로 재현되는가?
 *   5) 기간 안정성 — 3분할 구간 전부에서 부호가 같은가?
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000, 조 = 1e12, MIN_UNIVERSE = 2000;
const DEFENSIVE = ['음식료·담배', '운송·창고', '금융', '보험', '통신'];

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sign = v => (v == null ? '   -  ' : (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)).padStart(6));

async function fetchAll(table, cols, apply) {
  const out = [];
  for (let f = 0; ; f += PAGE) {
    let q = sb.from(table).select(cols).range(f, f + PAGE - 1);
    if (apply) q = apply(q);
    const { data, error } = await q; if (error) throw error;
    out.push(...data); if (data.length < PAGE) break;
  }
  return out;
}

(async () => {
  const flow = await fetchAll('market_flow_daily', 'stock_code,trade_date,close,market_cap,sector_name,frgn_net_value,inst_net_value');
  const byDate = new Map();
  for (const r of flow) { if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []); byDate.get(r.trade_date).push(r); }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();
  for (const r of flow) { if (!dayIdx.has(r.trade_date)) continue; if (!px.has(r.stock_code)) px.set(r.stock_code, new Map()); px.get(r.stock_code).set(r.trade_date, r); }
  const at = (c, i) => (i >= 0 && i < days.length ? px.get(c)?.get(days[i]) : null);
  const nameOf = new Map(flow.map(r => [r.stock_code, r.sector_name]));

  const build = (BUY, SELL) => {
    const out = [];
    for (let i = 20; i + SELL < days.length; i++) {
      const rets = new Map();
      for (const r of byDate.get(days[i])) {
        const b = at(r.stock_code, i + BUY), s = at(r.stock_code, i + SELL);
        if (b?.close && s?.close) rets.set(r.stock_code, ((s.close - b.close) / b.close) * 100);
      }
      const dayMean = avg([...rets.values()]);
      for (const r of byDate.get(days[i])) {
        const ret = rets.get(r.stock_code);
        if (ret == null || !r.market_cap) continue;
        out.push({ date: days[i], code: r.stock_code, cap: r.market_cap, sector: r.sector_name, ret, excess: ret - dayMean });
      }
    }
    return out;
  };

  const report = (label, rows) => {
    if (!rows.length) return console.log(label.padEnd(30) + '   (표본 없음)');
    const rt = rows.map(r => r.ret);
    const codes = new Set(rows.map(r => r.code));
    const ds = [...new Set(rows.map(r => r.date))].sort();
    const third = [0, Math.floor(ds.length / 3), Math.floor(ds.length * 2 / 3)].map((s, k, a) => {
      const e = k === 2 ? ds.length : a[k + 1];
      return avg(rows.filter(r => r.date >= ds[s] && r.date < (ds[e] ?? '9999')).map(r => r.ret));
    });
    console.log(label.padEnd(30) + String(rows.length).padStart(6) + String(codes.size).padStart(6) +
      '   ' + sign(avg(rt)) + '%  ' + sign(med(rt)) + '%  ' + (winR(rt) ?? 0).toFixed(0).padStart(4) + '%  ' +
      sign(avg(rows.map(r => r.excess))) + '% | ' + third.map(sign).join(' '));
  };
  const hdr = () => console.log('슬라이스'.padEnd(30) + '관측'.padStart(6) + '종목'.padStart(6) + '    평균    중앙   승률   시장초과 | 3분할 구간별 평균');

  for (const SELL of [2, 3, 5, 10]) {
    const obs = build(1, SELL);
    const big = obs.filter(o => o.cap >= 1 * 조);
    console.log(`\n════════ D+1 매수 → D+${SELL} 매도 ════════`);
    hdr();
    report('전 시장', obs);
    report('시총1조+ 전체', big);
    for (const s of DEFENSIVE) report(`  시총1조+ ${s}`, big.filter(o => o.sector === s));
    report('시총1조+ 방어업종 통합', big.filter(o => DEFENSIVE.includes(o.sector)));
    report('시총1조+ 전기·전자(대조)', big.filter(o => o.sector === '전기·전자'));

    // 실행 가능성: 매일 방어업종 대형주 중 시총 상위 3종목
    const byDay = new Map();
    for (const o of big.filter(x => DEFENSIVE.includes(x.sector))) {
      if (!byDay.has(o.date)) byDay.set(o.date, []); byDay.get(o.date).push(o);
    }
    const pick = [];
    for (const [, rows] of byDay) pick.push(...rows.sort((a, b) => b.cap - a.cap).slice(0, 3));
    report('  ↳ 매일 시총상위 3종목', pick);
  }

  // 종목별 기여도 — 소수 종목이 만든 착시인지
  console.log('\n════════ 방어업종 대형주 종목별 (D+1→D+10, n≥10) ════════');
  const obs10 = build(1, 10).filter(o => o.cap >= 1 * 조 && DEFENSIVE.includes(o.sector));
  const byCode = new Map();
  for (const o of obs10) { if (!byCode.has(o.code)) byCode.set(o.code, []); byCode.get(o.code).push(o); }
  const rows = [...byCode.entries()].filter(([, v]) => v.length >= 10)
    .map(([c, v]) => ({ c, n: v.length, m: avg(v.map(x => x.ret)), w: winR(v.map(x => x.ret)), sec: nameOf.get(c) }))
    .sort((a, b) => b.m - a.m);
  console.log('종목코드   업종            관측   평균     승률');
  for (const r of rows) console.log(`${r.c}  ${(r.sec || '').padEnd(14)}${String(r.n).padStart(4)}  ${sign(r.m)}%  ${r.w.toFixed(0).padStart(4)}%`);
  console.log(`\n플러스 종목 ${rows.filter(r => r.m > 0).length} / 전체 ${rows.length}`);
})().catch(e => { console.error(e); process.exit(1); });
