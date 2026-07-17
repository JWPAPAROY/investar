/**
 * v3.87 정렬 근거 재검증 (v3.94) — 올바른 수급 신호 기준
 *
 * 왜 필요한가
 *   v3.87 정렬(수급등급 → 기관매수일 → 스윗스팟)은 504개 조합 전수탐색에서 승률 71%로
 *   선정됐다. 그러나 그 탐색이 쓴 institution_buy_days/foreign_buy_days는
 *   checkInstitutionalFlow()의 방향 버그(v3.94에서 수정) 때문에 **가장 오래된 날부터 센**
 *   값이었다. 즉 최적화의 입력이 오염돼 있었다.
 *
 * 어떻게 복원하나
 *   DB의 수급 컬럼은 KIS 30일 한계 때문에 과거 복원이 불가하지만, market_flow_daily가
 *   2026-01-27부터 **전 종목 일별 순매수(inst_net_qty/frgn_net_qty)**를 갖고 있다.
 *   여기서 각 (종목, 추천일) 시점의 연속 순매수일을 올바른 방향(그날부터 과거로)으로 재계산한다.
 *
 * 평가
 *   active_policy(D+1 매수 → D+10 매도) 지평. cumulative_return 기반.
 *   D+N은 v3.94에서 거래일 기준으로 정정됨.
 *
 * 실행: node scripts/revalidate-supply-sort.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { bandRank, supplyRank } = require('../backend/top3Ranking');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function fetchAll(table, cols, filter) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const winR = a => a.length ? a.filter(v => v > 0).length / a.length * 100 : null;

async function main() {
  console.log('📊 v3.87 정렬 재검증 — 올바른 수급 신호 기준\n');

  // 1) market_flow_daily → 종목별 날짜순 수급 시계열
  //    ⚠️ 실사용 구간 주의: 총 행수는 97k지만 2026-01~04는 하루 2~4종목뿐(사실상 빈 구간).
  //       전 종목 수집이 실제로 된 건 2026-05-22부터다. 그 이전 날짜로 수급을 복원하면
  //       "그 종목만 데이터가 있는" 편향 표본이 되므로, 커버리지 임계값으로 잘라낸다.
  console.log('market_flow_daily 로드 중...');
  const flow = await fetchAll('market_flow_daily', 'stock_code,trade_date,inst_net_qty,frgn_net_qty');
  const perDate = {};
  for (const f of flow) perDate[f.trade_date] = (perDate[f.trade_date] || 0) + 1;
  const COVERAGE_MIN = 2000; // 전 종목(~2,560) 수집으로 인정할 최소 종목 수
  const usableDates = Object.entries(perDate).filter(([, n]) => n >= COVERAGE_MIN).map(([d]) => d).sort();
  const flowStart = usableDates[0];
  console.log(`  ${flow.length}행 / 날짜 ${Object.keys(perDate).length}일`);
  console.log(`  전 종목 수집 구간: ${flowStart} ~ ${usableDates[usableDates.length - 1]} (${usableDates.length}거래일)`);
  console.log(`  ※ 2026-01~04는 하루 2~4종목뿐 → 제외 (백필이 실제로 닿은 범위는 5월 하순부터)\n`);

  const byStock = new Map();
  for (const f of flow) {
    if (!byStock.has(f.stock_code)) byStock.set(f.stock_code, []);
    byStock.get(f.stock_code).push(f);
  }
  for (const arr of byStock.values()) arr.sort((a, b) => a.trade_date < b.trade_date ? -1 : 1); // 오름차순

  /** (종목, 기준일) 시점의 연속 순매수일 — 그날부터 과거로 (올바른 방향) */
  function supplyAt(code, date) {
    const arr = byStock.get(code);
    if (!arr) return null;
    let idx = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].trade_date <= date) { idx = i; break; }
    }
    if (idx < 0) return null;
    let inst = 0, frgn = 0;
    for (let i = idx; i >= 0; i--) { if ((arr[i].inst_net_qty || 0) > 0) inst++; else break; }
    for (let i = idx; i >= 0; i--) { if ((arr[i].frgn_net_qty || 0) > 0) frgn++; else break; }
    return { inst, frgn };
  }

  // 2) 추천 + 수익률
  const recs = await fetchAll('screening_recommendations',
    'id,recommendation_date,stock_code,stock_name,total_score,is_top3,institution_buy_days,foreign_buy_days',
    q => q.gte('recommendation_date', flowStart).eq('is_top3', true));
  const prices = await fetchAll('recommendation_daily_prices',
    'recommendation_id,days_since_recommendation,cumulative_return');
  const pIdx = new Map();
  for (const p of prices) {
    if (!pIdx.has(p.recommendation_id)) pIdx.set(p.recommendation_id, {});
    pIdx.get(p.recommendation_id)[p.days_since_recommendation] = p.cumulative_return;
  }
  // D+1 매수 → D+10 매도 수익률
  const retOf = (id) => {
    const m = pIdx.get(id);
    if (!m || m[1] == null || m[10] == null) return null;
    return (1 + m[10] / 100) / (1 + m[1] / 100) * 100 - 100;
  };

  // 3) 각 추천일의 TOP3에 올바른 수급 부착
  const byDate = new Map();
  for (const r of recs) {
    if (!byDate.has(r.recommendation_date)) byDate.set(r.recommendation_date, []);
    byDate.get(r.recommendation_date).push(r);
  }

  let missing = 0, diffCount = 0, total = 0;
  const days = [];
  for (const [date, arr] of [...byDate.entries()].sort()) {
    const enriched = [];
    for (const r of arr) {
      const s = supplyAt(r.stock_code, date);
      if (!s) { missing++; continue; }
      total++;
      if (s.inst !== r.institution_buy_days || s.frgn !== r.foreign_buy_days) diffCount++;
      enriched.push({
        ...r,
        trueInst: s.inst, trueFrgn: s.frgn,
        ret: retOf(r.id),
      });
    }
    if (enriched.length >= 2) days.push({ date, stocks: enriched });
  }
  console.log(`추천일 ${days.length}일 / TOP3 ${total}건 (수급 복원 실패 ${missing}건)`);
  console.log(`DB 저장값과 올바른 값이 다른 건: ${diffCount}/${total} = ${Math.round(diffCount / total * 100)}%\n`);

  // 4) 정렬 전략별 TOP1 성과 비교
  const strategies = {
    'v387_DB오염값 (현행 근거)': (a, b) =>
      (supplyRank(b.institution_buy_days, b.foreign_buy_days) - supplyRank(a.institution_buy_days, a.foreign_buy_days))
      || ((b.institution_buy_days || 0) - (a.institution_buy_days || 0))
      || (bandRank(a.total_score || 0) - bandRank(b.total_score || 0)),
    'v387_올바른수급': (a, b) =>
      (supplyRank(b.trueInst, b.trueFrgn) - supplyRank(a.trueInst, a.trueFrgn))
      || (b.trueInst - a.trueInst)
      || (bandRank(a.total_score || 0) - bandRank(b.total_score || 0)),
    '점수만 (내림차순)': (a, b) => (b.total_score || 0) - (a.total_score || 0),
    '스윗스팟만': (a, b) => bandRank(a.total_score || 0) - bandRank(b.total_score || 0),
    '수급만 (올바른)': (a, b) => supplyRank(b.trueInst, b.trueFrgn) - supplyRank(a.trueInst, a.trueFrgn),
  };

  console.log('전략별 TOP1 성과 (D+1 매수 → D+10 매도)');
  console.log('전략'.padEnd(28), 'n'.padStart(4), '평균'.padStart(9), '승률'.padStart(7), '중앙'.padStart(9));
  const t3rets = days.flatMap(d => d.stocks.map(s => s.ret)).filter(v => v != null);
  for (const [name, cmp] of Object.entries(strategies)) {
    const rets = [];
    for (const d of days) {
      const top1 = [...d.stocks].sort(cmp)[0];
      if (top1 && top1.ret != null) rets.push(top1.ret);
    }
    if (!rets.length) { console.log(name.padEnd(28), '표본 없음'); continue; }
    const sorted = [...rets].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    console.log(
      name.padEnd(28),
      String(rets.length).padStart(4),
      (mean(rets) >= 0 ? '+' : '') + mean(rets).toFixed(2) + '%',
      winR(rets).toFixed(0).padStart(6) + '%',
      (med >= 0 ? '+' : '') + med.toFixed(2) + '%',
    );
  }
  console.log('─'.repeat(62));
  const s3 = [...t3rets].sort((a, b) => a - b);
  console.log(
    'TOP3 전체 (벤치마크)'.padEnd(28),
    String(t3rets.length).padStart(4),
    (mean(t3rets) >= 0 ? '+' : '') + mean(t3rets).toFixed(2) + '%',
    winR(t3rets).toFixed(0).padStart(6) + '%',
    (s3[Math.floor(s3.length / 2)] >= 0 ? '+' : '') + s3[Math.floor(s3.length / 2)].toFixed(2) + '%',
  );
  console.log('\n※ TOP1 알파 = 전략 TOP1 평균 − TOP3 전체 평균');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
