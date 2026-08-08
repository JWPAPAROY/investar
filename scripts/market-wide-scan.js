/**
 * market-wide-scan.js — "하락장에도 오르는 종목"이 실제로 무엇이었나 (전 시장 기준)
 *
 * pool-slice-scan.js가 "추천 풀 안"을 봤다면, 이건 풀을 벗어나 **전 상장종목**을 본다.
 * 질문 3개:
 *   Q1. 이 하락 레짐에서 절대수익 플러스가 나온 종목군이 실제로 존재하는가?
 *   Q2. 존재한다면 어떤 특성인가 (시총/수급/모멘텀/변동성/업종)?
 *   Q3. 현행 스크리닝 풀은 그 종목군에 닿을 수 있었는가? (닿지 못했다면 철학의 문제)
 *
 * 지표: 여기선 **절대수익 + 시장평균(동일가중) 대비**를 본다.
 *   pool-slice-scan은 시총 매칭으로 사이즈 효과를 제거했지만, 여기선 사이즈 자체가
 *   가설("우량주")의 일부이므로 제거하면 안 된다.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const BUY = arg('buy', 1), SELL = arg('sell', 10);
const MIN_UNIVERSE = 2000;
const 억 = 1e8, 조 = 1e12;

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sign = v => (v == null ? '   -  ' : (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)).padStart(6));

async function fetchAll(table, cols, apply) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

(async () => {
  console.log(`📊 전 시장 스캔 — D+${BUY} 매수 → D+${SELL} 매도\n`);

  const flow = await fetchAll('market_flow_daily',
    'stock_code,trade_date,close,volume,market_cap,sector_name,inst_net_value,frgn_net_value');

  const byDate = new Map();
  for (const r of flow) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []);
    byDate.get(r.trade_date).push(r);
  }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();
  for (const r of flow) {
    if (!dayIdx.has(r.trade_date)) continue;
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, r);
  }
  console.log(`시장: ${days.length}거래일 × ${px.size}종목 (${days[0]} ~ ${days[days.length - 1]})`);

  const at = (code, i) => (i >= 0 && i < days.length ? px.get(code)?.get(days[i]) : null);
  const fwd = (code, i) => {
    const b = at(code, i + BUY), s = at(code, i + SELL);
    return (b?.close && s?.close) ? ((s.close - b.close) / b.close) * 100 : null;
  };
  const pastRet = (code, i, n) => {
    const a = at(code, i - n), b = at(code, i);
    return (a?.close && b?.close) ? ((b.close - a.close) / a.close) * 100 : null;
  };
  const buyDays = (code, i, n, f) => {
    let c = 0, seen = 0;
    for (let k = 0; k < n && i - k >= 0; k++) {
      const r = at(code, i - k); if (!r) continue;
      seen++; if ((r[f] ?? 0) > 0) c++;
    }
    return seen >= n - 1 ? c : null;
  };

  // ── 전 시장 관측치 구성 ────────────────────────────────────────
  const obs = [];
  for (let i = 20; i + SELL < days.length; i++) {
    const dayMean = avg(byDate.get(days[i]).map(r => fwd(r.stock_code, i)).filter(v => v != null));
    for (const r of byDate.get(days[i])) {
      const ret = fwd(r.stock_code, i);
      if (ret == null || !r.market_cap) continue;
      obs.push({
        date: days[i], code: r.stock_code, cap: r.market_cap, sector: r.sector_name,
        ret, excess: ret - dayMean,
        instD5: buyDays(r.stock_code, i, 5, 'inst_net_value'),
        frgnD5: buyDays(r.stock_code, i, 5, 'frgn_net_value'),
        instD20: buyDays(r.stock_code, i, 20, 'inst_net_value'),
        mom20: pastRet(r.stock_code, i, 20),
        mom5: pastRet(r.stock_code, i, 5),
      });
    }
  }
  const uDates = [...new Set(obs.map(o => o.date))].sort();
  const mid = uDates[Math.floor(uDates.length / 2)];
  console.log(`관측치: ${obs.length.toLocaleString()}건 / ${uDates.length}일 (${uDates[0]} ~ ${uDates[uDates.length - 1]})`);
  console.log(`시장 전체 평균수익 ${sign(avg(obs.map(o => o.ret)))}% / 승률 ${(winR(obs.map(o => o.ret)) ?? 0).toFixed(0)}%`);
  console.log(`전·후반 분할: ${mid}\n`);

  const hdr = () => console.log('슬라이스'.padEnd(34) + 'n'.padStart(7) + '  절대수익  시장초과   승률 | 전반   후반');
  const line = (label, rows) => {
    if (rows.length < 20) return;
    const rt = rows.map(r => r.ret), ex = rows.map(r => r.excess);
    const h1 = rows.filter(r => r.date < mid).map(r => r.ret);
    const h2 = rows.filter(r => r.date >= mid).map(r => r.ret);
    console.log(label.padEnd(34) + rows.length.toLocaleString().padStart(7) +
      '   ' + sign(avg(rt)) + '%  ' + sign(avg(ex)) + '%  ' +
      (winR(rt) ?? 0).toFixed(0).padStart(4) + '% | ' + sign(avg(h1)) + ' ' + sign(avg(h2)));
  };

  console.log('══ 시가총액 ══'); hdr();
  const capBands = [
    ['10조+', o => o.cap >= 10 * 조], ['5~10조', o => o.cap >= 5 * 조 && o.cap < 10 * 조],
    ['1~5조', o => o.cap >= 1 * 조 && o.cap < 5 * 조], ['3000억~1조', o => o.cap >= 3000 * 억 && o.cap < 1 * 조],
    ['1000~3000억', o => o.cap >= 1000 * 억 && o.cap < 3000 * 억], ['1000억 미만', o => o.cap < 1000 * 억],
  ];
  for (const [n, f] of capBands) line(n, obs.filter(f));

  console.log('\n══ 수급 (올바른 방향, 5일) ══'); hdr();
  for (const k of [0, 1, 2, 3, 4, 5]) line(`외인 순매수 ${k}일`, obs.filter(o => o.frgnD5 === k));
  for (const k of [0, 1, 2, 3, 4, 5]) line(`기관 순매수 ${k}일`, obs.filter(o => o.instD5 === k));
  line('외인≥4일 & 기관≥4일 (쌍방)', obs.filter(o => o.frgnD5 >= 4 && o.instD5 >= 4));

  console.log('\n══ 20일 모멘텀 ══'); hdr();
  const momBands = [['-999~-20%', -999, -20], ['-20~-10%', -20, -10], ['-10~0%', -10, 0],
    ['0~+10%', 0, 10], ['+10~+25%', 10, 25], ['+25%~', 25, 9999]];
  for (const [n, lo, hi] of momBands) line(`20일 ${n}`, obs.filter(o => o.mom20 != null && o.mom20 >= lo && o.mom20 < hi));

  console.log('\n══ 가설: "하락장에 오르는 우량주" 조합 ══'); hdr();
  const 우량 = o => o.cap >= 1 * 조;
  line('시총1조+', obs.filter(우량));
  line('시총1조+ & 20일모멘텀>0', obs.filter(o => 우량(o) && o.mom20 > 0));
  line('시총1조+ & 외인≥3일', obs.filter(o => 우량(o) && o.frgnD5 >= 3));
  line('시총1조+ & 외인≥3 & 모멘텀>0', obs.filter(o => 우량(o) && o.frgnD5 >= 3 && o.mom20 > 0));
  line('시총1조+ & 외인≥4 & 기관≥3', obs.filter(o => 우량(o) && o.frgnD5 >= 4 && o.instD5 >= 3));
  line('시총5조+ & 외인≥3 & 모멘텀>0', obs.filter(o => o.cap >= 5 * 조 && o.frgnD5 >= 3 && o.mom20 > 0));
  line('시총1조+ & 기관20일≥12', obs.filter(o => 우량(o) && o.instD20 >= 12));
  line('↑ 대조: 시총1000억- & 모멘텀>0', obs.filter(o => o.cap < 1000 * 억 && o.mom20 > 0));

  console.log('\n══ 업종 (시총1조+ 한정, n≥100) ══'); hdr();
  const big = obs.filter(우량);
  const secs = [...new Set(big.map(o => o.sector))].filter(Boolean)
    .map(s => ({ s, rows: big.filter(o => o.sector === s) })).filter(x => x.rows.length >= 100)
    .sort((a, b) => avg(b.rows.map(r => r.ret)) - avg(a.rows.map(r => r.ret)));
  for (const { s, rows } of secs.slice(0, 8)) line(s, rows);
  console.log('  ...');
  for (const { s, rows } of secs.slice(-4)) line(s, rows);

  // ── Q3. 현행 풀이 승자에게 닿았는가 ────────────────────────────
  const recs = await fetchAll('screening_recommendations', 'recommendation_date,stock_code,is_top3',
    q => q.gte('recommendation_date', days[0]));
  const inPool = new Set(recs.map(r => `${r.recommendation_date}|${r.stock_code}`));
  const poolCodes = new Set(recs.map(r => r.stock_code));
  const top3Codes = new Set(recs.filter(r => r.is_top3).map(r => r.stock_code));

  console.log('\n══ Q3. 현행 풀이 "오른 종목"에 닿았는가 ══');
  const winners = obs.filter(o => o.ret > 0);
  const bigWin = obs.filter(o => o.ret >= 10);
  const cover = set => rows => {
    const codes = new Set(rows.map(r => r.code));
    return `${[...codes].filter(c => set.has(c)).length}/${codes.size} (${(([...codes].filter(c => set.has(c)).length / codes.size) * 100).toFixed(1)}%)`;
  };
  console.log(`전 시장 종목 수: ${px.size} / 풀에 한 번이라도 등장: ${poolCodes.size} (${((poolCodes.size / px.size) * 100).toFixed(1)}%) / TOP3 경험: ${top3Codes.size}`);
  console.log(`  플러스 수익 관측 종목 중 풀 경험: ${cover(poolCodes)(winners)}`);
  console.log(`  +10% 이상 관측 종목 중 풀 경험: ${cover(poolCodes)(bigWin)}`);
  console.log(`  +10% 이상 관측 종목 중 TOP3 경험: ${cover(top3Codes)(bigWin)}`);
  const sameDay = bigWin.filter(o => inPool.has(`${o.date}|${o.code}`));
  console.log(`  +10% 이상 관측 ${bigWin.length.toLocaleString()}건 중 **그날 풀에 있던** 건: ${sameDay.length} (${((sameDay.length / bigWin.length) * 100).toFixed(2)}%)`);

  // 최고 성과 조합이 풀에 얼마나 잡혔는지
  const elite = obs.filter(o => 우량(o) && o.frgnD5 >= 3 && o.mom20 > 0);
  const eliteInPool = elite.filter(o => inPool.has(`${o.date}|${o.code}`));
  console.log(`  '시총1조+ & 외인≥3 & 모멘텀>0' ${elite.length.toLocaleString()}건 중 그날 풀에 있던 건: ${eliteInPool.length} (${((eliteInPool.length / elite.length) * 100).toFixed(2)}%)`);
})().catch(e => { console.error(e); process.exit(1); });
