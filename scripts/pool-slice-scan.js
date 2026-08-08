/**
 * pool-slice-scan.js — "풀을 다각도로 썰면 승률 좋은 로직이 나오는가" 실측
 *
 * 질문: 현행 TOP3 선별이 나쁜 건 확인됐다(2026-08-06). 그런데 추천 풀 자체는
 *       괜찮고 "다르게 자르기만 하면" 승률 높은 부분집합이 나오는가?
 *
 * 방법:
 *   - 수익 정의 = active_policy 그대로 D+1 종가 매수 → D+10 종가 매도 (거래일 기준)
 *   - 가격/시총/섹터/수급은 전부 market_flow_daily (유일하게 올바른 출처)
 *   - 주 지표 = 매칭 초과수익: 같은 날 · 같은 시총 5분위 전체 시장 평균 대비
 *     (절대수익은 사이즈 베타에 잡아먹힘 — v3.90~92 플로어 saga의 교훈)
 *   - 금지: screening_recommendations의 institution_buy_days/foreign_buy_days
 *     (v3.94 이전 방향 버그) → 수급은 market_flow_daily에서 그날부터 과거로 재계산
 *
 * 다중검정 주의: 수십 개 슬라이스를 스캔하면 우연히 좋아 보이는 게 반드시 나온다.
 *   → 각 슬라이스를 전·후반 절반으로 쪼개 부호가 유지되는지 함께 출력한다.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const BUY_OFFSET = arg('buy', 1);    // active_buy_offset_day
const SELL_OFFSET = arg('sell', 10); // active_sell_offset_day
const MIN_UNIVERSE = 2000; // 전 종목 수집이 실제로 된 날만

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
  console.log('📊 추천 풀 다각도 슬라이스 스캔 (D+%d 매수 → D+%d 매도)\n'
    .replace('%d', BUY_OFFSET).replace('%d', SELL_OFFSET));

  // ── 1. 시장 데이터 ────────────────────────────────────────────
  const flow = await fetchAll('market_flow_daily',
    'stock_code,trade_date,close,market_cap,sector_name,inst_net_value,frgn_net_value',
    q => q.order('trade_date', { ascending: true }));

  const byDate = new Map();
  for (const r of flow) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []);
    byDate.get(r.trade_date).push(r);
  }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  console.log(`시장 데이터: ${days.length}거래일 (${days[0]} ~ ${days[days.length - 1]})`);

  // 종목별 date -> row
  const px = new Map();
  for (const r of flow) {
    if (!dayIdx.has(r.trade_date)) continue;
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, r);
  }

  const fwdRet = (code, dIdx) => {
    const b = days[dIdx + BUY_OFFSET], s = days[dIdx + SELL_OFFSET];
    if (!b || !s) return null;
    const m = px.get(code); if (!m) return null;
    const pb = m.get(b), ps = m.get(s);
    if (!pb || !ps || !pb.close || !ps.close) return null;
    return ((ps.close - pb.close) / pb.close) * 100;
  };

  // ── 2. 날짜 × 시총5분위 벤치마크 ──────────────────────────────
  const bench = new Map(); // `${date}|${q}` -> 평균수익
  const capQuintile = new Map(); // `${date}|${code}` -> q
  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    const rows = byDate.get(date).filter(r => r.market_cap > 0).sort((a, b) => a.market_cap - b.market_cap);
    const per = Math.ceil(rows.length / 5);
    const buckets = [[], [], [], [], []];
    rows.forEach((r, j) => {
      const q = Math.min(4, Math.floor(j / per));
      capQuintile.set(`${date}|${r.stock_code}`, q);
      const ret = fwdRet(r.stock_code, i);
      if (ret != null) buckets[q].push(ret);
    });
    buckets.forEach((b, q) => { if (b.length >= 30) bench.set(`${date}|${q}`, avg(b)); });
  }

  // 수급: 그날부터 과거 N거래일 순매수일수 (올바른 방향)
  const supplyDays = (code, dIdx, n, field) => {
    const m = px.get(code); if (!m) return null;
    let c = 0, seen = 0;
    for (let k = 0; k < n && dIdx - k >= 0; k++) {
      const r = m.get(days[dIdx - k]); if (!r) continue;
      seen++; if ((r[field] ?? 0) > 0) c++;
    }
    return seen >= n - 1 ? c : null;
  };

  // ── 3. 추천 풀 ────────────────────────────────────────────────
  const recs = await fetchAll('screening_recommendations',
    'recommendation_date,stock_code,stock_name,total_score,total_score_v2,market_cap,whale_detected,' +
    'accumulation_detected,mfi,volume_ratio,rsi,disparity,vwap_divergence,consecutive_rise_days,' +
    'escape_velocity,obv_trend,asymmetric_ratio,vpd_score,momentum_score,trend_score,defense_score,' +
    'recommendation_grade,sector_name,market,market_regime,is_top3,top3_rank,volume_acceleration_score',
    q => q.gte('recommendation_date', days[0]));

  const pool = [];
  for (const r of recs) {
    const i = dayIdx.get(r.recommendation_date);
    if (i == null || i + SELL_OFFSET >= days.length) continue;
    const ret = fwdRet(r.stock_code, i);
    if (ret == null) continue;
    const q = capQuintile.get(`${r.recommendation_date}|${r.stock_code}`);
    const bm = bench.get(`${r.recommendation_date}|${q}`);
    if (bm == null) continue;
    pool.push({
      ...r, dIdx: i, ret, excess: ret - bm, capQ: q,
      instD5: supplyDays(r.stock_code, i, 5, 'inst_net_value'),
      frgnD5: supplyDays(r.stock_code, i, 5, 'frgn_net_value'),
      flowSector: px.get(r.stock_code)?.get(r.recommendation_date)?.sector_name ?? r.sector_name,
    });
  }
  const uDates = [...new Set(pool.map(p => p.recommendation_date))].sort();
  const midDate = uDates[Math.floor(uDates.length / 2)];
  console.log(`추천 풀: ${pool.length}건 / ${uDates.length}일 (${uDates[0]} ~ ${uDates[uDates.length - 1]})`);
  console.log(`전·후반 분할 기준일: ${midDate}\n`);

  // ── 4. 슬라이스 리포트 ────────────────────────────────────────
  const hdr = () => console.log(
    '슬라이스'.padEnd(30) + 'n'.padStart(5) + '  절대수익  매칭초과   승률  초과승률 | 전반   후반');
  const line = (label, rows) => {
    if (!rows.length) return;
    const ex = rows.map(r => r.excess), rt = rows.map(r => r.ret);
    const h1 = rows.filter(r => r.recommendation_date < midDate).map(r => r.excess);
    const h2 = rows.filter(r => r.recommendation_date >= midDate).map(r => r.excess);
    console.log(
      label.padEnd(30) + String(rows.length).padStart(5) +
      '   ' + sign(avg(rt)) + '%  ' + sign(avg(ex)) + '%  ' +
      (winR(rt) ?? 0).toFixed(0).padStart(4) + '%   ' + (winR(ex) ?? 0).toFixed(0).padStart(4) + '% | ' +
      sign(avg(h1)) + ' ' + sign(avg(h2)));
  };

  console.log('══ 기준선 ══');
  hdr();
  line('풀 전체 (균등분산)', pool);
  line('현행 TOP3', pool.filter(p => p.is_top3));
  line('현행 TOP1', pool.filter(p => p.top3_rank === 1));
  line('풀에서 TOP3 제외', pool.filter(p => !p.is_top3));

  const numSlice = (name, key, edges) => {
    console.log(`\n══ ${name} ══`);
    hdr();
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      line(`${key} ${lo}~${hi}`, pool.filter(p => p[key] != null && p[key] >= lo && p[key] < hi));
    }
  };

  numSlice('점수 밴드', 'total_score', [0, 45, 50, 55, 60, 70, 80, 90, 999]);
  numSlice('RSI', 'rsi', [0, 30, 45, 55, 65, 75, 999]);
  numSlice('MFI', 'mfi', [0, 30, 50, 70, 85, 999]);
  numSlice('이격도', 'disparity', [0, 95, 100, 105, 110, 999]);
  numSlice('거래량비', 'volume_ratio', [0, 1, 1.5, 2, 3, 9999]);
  numSlice('연속상승일', 'consecutive_rise_days', [0, 1, 2, 3, 5, 99]);
  numSlice('모멘텀점수', 'momentum_score', [-999, 0, 10, 20, 30, 999]);
  numSlice('추세점수', 'trend_score', [-999, 0, 10, 20, 30, 999]);
  numSlice('기관 순매수일(5d, 올바른)', 'instD5', [0, 1, 2, 3, 4, 6]);
  numSlice('외인 순매수일(5d, 올바른)', 'frgnD5', [0, 1, 2, 3, 4, 6]);

  console.log('\n══ 시총 분위(전체시장 기준) ══');
  hdr();
  for (let q = 0; q < 5; q++) line(`Q${q + 1} ${q === 0 ? '(최소)' : q === 4 ? '(최대)' : ''}`, pool.filter(p => p.capQ === q));

  console.log('\n══ 불리언/범주 ══');
  hdr();
  line('고래감지 O', pool.filter(p => p.whale_detected));
  line('고래감지 X', pool.filter(p => !p.whale_detected));
  line('매집감지 O', pool.filter(p => p.accumulation_detected));
  line('매집감지 X', pool.filter(p => !p.accumulation_detected));
  for (const g of [...new Set(pool.map(p => p.recommendation_grade))].filter(Boolean))
    line(`등급 ${g}`, pool.filter(p => p.recommendation_grade === g));
  for (const m of [...new Set(pool.map(p => p.market))].filter(Boolean))
    line(`시장 ${m}`, pool.filter(p => p.market === m));

  console.log('\n══ 업종 (n≥25만) ══');
  hdr();
  const sectors = [...new Set(pool.map(p => p.flowSector))].filter(Boolean);
  const secRows = sectors.map(s => ({ s, rows: pool.filter(p => p.flowSector === s) }))
    .filter(x => x.rows.length >= 25).sort((a, b) => avg(b.rows.map(r => r.excess)) - avg(a.rows.map(r => r.excess)));
  for (const { s, rows } of secRows) line(s, rows);

  console.log('\n══ 가설 슬라이스(조합) ══');
  hdr();
  line('점수≥70', pool.filter(p => p.total_score >= 70));
  line('점수≥70 & 고래O', pool.filter(p => p.total_score >= 70 && p.whale_detected));
  line('점수≥70 & RSI<70', pool.filter(p => p.total_score >= 70 && p.rsi < 70));
  line('점수≥70 & 거래량비<2', pool.filter(p => p.total_score >= 70 && p.volume_ratio < 2));
  line('점수<45 (하위 배제 대상)', pool.filter(p => p.total_score < 45));

  // ── 4-b. 일별 픽 전략 비교 (동수 비교) ────────────────────────
  console.log('\n══ 일별 픽 전략 (하루 K종목, 동수 비교) ══');
  hdr();
  const byRecDate = new Map();
  for (const p of pool) {
    if (!byRecDate.has(p.recommendation_date)) byRecDate.set(p.recommendation_date, []);
    byRecDate.get(p.recommendation_date).push(p);
  }
  const pick = (label, k, cmp, filter) => {
    const out = [];
    for (const [, rows] of byRecDate) {
      const c = (filter ? rows.filter(filter) : rows).sort(cmp).slice(0, k);
      out.push(...c);
    }
    line(label, out);
  };
  const byScore = (a, b) => b.total_score - a.total_score;
  pick('점수최고 1종목', 1, byScore);
  pick('점수최고 3종목', 3, byScore);
  pick('점수최고 3종목 & 거래량비<2', 3, byScore, p => p.volume_ratio < 2);
  pick('점수최저 3종목', 3, (a, b) => a.total_score - b.total_score);
  pick('RSI최저 3종목', 3, (a, b) => (a.rsi ?? 999) - (b.rsi ?? 999));
  pick('이격도최저 3종목', 3, (a, b) => (a.disparity ?? 999) - (b.disparity ?? 999));
  line('현행 TOP3 (재게시)', pool.filter(p => p.is_top3));

  // ── 5. 최고/최저 슬라이스의 안정성 요약 ───────────────────────
  console.log('\n══ 다중검정 점검 ══');
  console.log(`스캔한 슬라이스 수가 많을수록 "전반+후반 부호가 같고 |초과|가 큰" 것만 의미가 있습니다.`);
  console.log(`풀 전체 매칭초과 = ${sign(avg(pool.map(p => p.excess)))}% (이 값이 0 근처면 "풀 자체엔 알파가 없다")`);
})().catch(e => { console.error(e); process.exit(1); });
