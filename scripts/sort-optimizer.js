/**
 * sort-optimizer.js — TOP1 승률 최대화 정렬 조합 전수 탐색
 *
 * 1. eligible pool(gate 통과) 대상으로 정렬 키 1~3차 조합 전수 탐색
 * 2. 오라클 분석: 날짜별 실제 최고수익 종목의 특징 분석
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;

const avg  = a => a.length ? a.reduce((s,v) => s+v, 0) / a.length : null;
const winR = a => a.length ? (a.filter(v => v > 0).length / a.length * 100) : null;
const med  = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const sign = v => v == null ? '-' : (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

async function fetchAll(table, select) {
  let all = [], from = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── 공통 gate ─────────────────────────────────────────────────────
const gate = s => (s.whale || s.inst >= 3 || s.fgn >= 3) && s.score >= 45
  && s.recommendation_grade !== '과열'
  && Math.abs(s.change_rate || 0) < 25
  && !(s.score >= 80 && s.score <= 89 && s.disparity >= 120);

// ── 이격도 단계적 컷 ──────────────────────────────────────────────
function applyDisparityGate(pool) {
  for (const tier of [130, 140, 150]) {
    const f = pool.filter(s => (s.disparity || 100) < tier);
    if (f.length >= 3) return f;
    if (f.length > 0 && tier === 150) return f;
  }
  return [];
}

// ── 정렬 키 정의 ──────────────────────────────────────────────────
const bandRank = score => {
  if (score >= 50 && score <= 59) return 1;
  if (score >= 60 && score <= 69) return 2;
  if (score >= 80 && score <= 89) return 3;
  if (score >= 90) return 4;
  if (score >= 70 && score <= 79) return 5;
  return 6;
};

const supplyRank = (inst, fgn) => {
  if (fgn >= 2 && inst < 2) return 5;
  if (inst >= 2 && fgn >= 2) return 4;
  if (inst >= 2) return 3;
  if (fgn >= 1) return 2;
  return 1;
};

// 정렬 키 목록: [이름, 비교함수 (음수=a우선, 양수=b우선)]
const SORT_KEYS = [
  { name: 'band',    cmp: (a, b) => bandRank(a.score) - bandRank(b.score) },         // 낮을수록 우선
  { name: 'sg',      cmp: (a, b) => supplyRank(b.inst, b.fgn) - supplyRank(a.inst, a.fgn) }, // 높을수록 우선
  { name: 'score',   cmp: (a, b) => b.score - a.score },                              // 높을수록 우선
  { name: 'inst',    cmp: (a, b) => b.inst - a.inst },                                // 높을수록 우선
  { name: 'fgn',     cmp: (a, b) => b.fgn - a.fgn },                                 // 높을수록 우선
  { name: 'whale',   cmp: (a, b) => (b.whale ? 1 : 0) - (a.whale ? 1 : 0) },         // 고래 우선
  { name: '-disp',   cmp: (a, b) => a.disparity - b.disparity },                      // 이격도 낮을수록 우선
  { name: '-mktcap', cmp: (a, b) => a.marketCapBillion - b.marketCapBillion },        // 소형 우선
  { name: '+mktcap', cmp: (a, b) => b.marketCapBillion - a.marketCapBillion },        // 대형 우선
];

// ── 메인 ──────────────────────────────────────────────────────────
(async () => {
  console.log('데이터 로딩 중...');

  const recs = await fetchAll(
    'screening_recommendations',
    'id,recommendation_date,stock_name,stock_code,total_score,recommendation_grade,' +
    'whale_detected,institution_buy_days,foreign_buy_days,change_rate,disparity,market_cap'
  );
  const prices = await fetchAll(
    'recommendation_daily_prices',
    'recommendation_id,days_since_recommendation,cumulative_return'
  );
  console.log(`  추천 ${recs.length}개  가격 ${prices.length}개\n`);

  const pIdx = new Map();
  for (const p of prices) {
    if (!pIdx.has(p.recommendation_id)) pIdx.set(p.recommendation_id, {});
    pIdx.get(p.recommendation_id)[p.days_since_recommendation] = p.cumulative_return;
  }

  const ret = (id, k, n) => {
    const p = pIdx.get(id) || {};
    const buy = k === 0 ? 0 : p[k];
    const sell = p[n];
    if (buy == null || sell == null) return null;
    return ((1 + sell / 100) / (1 + buy / 100) - 1) * 100;
  };

  const enriched = recs.map(r => ({
    ...r,
    score: r.total_score || 0,
    inst: r.institution_buy_days || 0,
    fgn:  r.foreign_buy_days || 0,
    whale: !!r.whale_detected,
    disparity: r.disparity || 100,
    marketCapBillion: r.market_cap ? r.market_cap / 1e8 : 999999,
    r110: ret(r.id, 1, 10),
    r14:  ret(r.id, 1, 4),
  }));

  // 날짜별 eligible pool
  const byDate = new Map();
  for (const s of enriched) {
    if (!byDate.has(s.recommendation_date)) byDate.set(s.recommendation_date, []);
    byDate.get(s.recommendation_date).push(s);
  }
  const dates = [...byDate.keys()].sort();

  // eligible pool 준비
  const eligibleByDate = new Map();
  let validDates = 0;
  for (const d of dates) {
    const pool = byDate.get(d).filter(gate);
    const eligible = applyDisparityGate(pool);
    if (eligible.length > 0) {
      eligibleByDate.set(d, eligible);
      validDates++;
    }
  }

  // ── §1. 오라클 분석 ────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§1. 오라클 분석 — eligible pool 중 실제 최고수익 종목 특징');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const oracleStocks = [];
  const oracleMissed = []; // 오라클과 현재 전략 비교
  let oracleWin = 0, oracleLoss = 0;

  // 현재 v376NT 정렬
  const currentSort = (a, b) => {
    const bd = bandRank(a.score) - bandRank(b.score);
    if (bd !== 0) return bd;
    const sd = supplyRank(b.inst, b.fgn) - supplyRank(a.inst, a.fgn);
    if (sd !== 0) return sd;
    return b.score - a.score;
  };

  for (const d of eligibleByDate.keys()) {
    const pool = eligibleByDate.get(d);
    const withRet = pool.filter(s => s.r110 != null);
    if (!withRet.length) continue;

    const oracle = [...withRet].sort((a, b) => b.r110 - a.r110)[0];
    oracleStocks.push(oracle);
    if (oracle.r110 > 0) oracleWin++; else oracleLoss++;

    // 현재 전략이 고른 top1
    const current = [...pool].sort(currentSort)[0];
    if (current && oracle.stock_code !== current.stock_code) {
      oracleMissed.push({ d, oracle, current });
    }
  }

  const n = oracleStocks.length;
  const oracleWinR = (oracleWin / n * 100).toFixed(0);
  const oracleAvg = avg(oracleStocks.map(s => s.r110));

  console.log(`오라클 상한 (n=${n}): 평균 ${sign(oracleAvg)}%  승률 ${oracleWinR}%`);
  console.log(`(eligible pool 중 항상 최고수익 종목을 고를 경우의 이론적 상한)\n`);

  // 오라클 종목 특징 분포
  const bandCnt = {1:0,2:0,3:0,4:0,5:0,6:0};
  const sgCnt   = {1:0,2:0,3:0,4:0,5:0};
  let whaleCnt = 0, instAvg = 0, fgnAvg = 0, scoreAvg = 0, dispAvg = 0;

  for (const s of oracleStocks) {
    bandCnt[bandRank(s.score)] = (bandCnt[bandRank(s.score)] || 0) + 1;
    const sg = supplyRank(s.inst, s.fgn);
    sgCnt[sg] = (sgCnt[sg] || 0) + 1;
    if (s.whale) whaleCnt++;
    instAvg += s.inst; fgnAvg += s.fgn; scoreAvg += s.score; dispAvg += s.disparity;
  }

  console.log('오라클 종목 구간 분포:');
  const bandLabels = {1:'50-59',2:'60-69',3:'80-89',4:'90+',5:'70-79',6:'45-49'};
  for (const [k, v] of Object.entries(bandCnt)) {
    if (v) console.log(`  구간${k}(${bandLabels[k]}): ${v}회 (${(v/n*100).toFixed(0)}%)`);
  }
  console.log('오라클 종목 수급 분포:');
  const sgLabels = {1:'고래만',2:'약수급',3:'기관≥2d',4:'외인≥2d',5:'쌍방'};
  for (const [k, v] of Object.entries(sgCnt)) {
    if (v) console.log(`  sg${k}(${sgLabels[k]}): ${v}회 (${(v/n*100).toFixed(0)}%)`);
  }
  console.log(`고래 비율: ${whaleCnt}/${n} (${(whaleCnt/n*100).toFixed(0)}%)`);
  console.log(`평균 점수: ${(scoreAvg/n).toFixed(1)}p  평균 기관: ${(instAvg/n).toFixed(1)}d  평균 외인: ${(fgnAvg/n).toFixed(1)}d  평균 이격: ${(dispAvg/n).toFixed(1)}`);

  // ── §2. 정렬 조합 전수 탐색 ────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§2. 정렬 조합 전수 탐색 — 승률 기준 TOP 20 (D+1→D+10)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const results = [];
  const K = SORT_KEYS;

  // 1차~3차 조합 (중복 없이)
  for (let i = 0; i < K.length; i++) {
    for (let j = 0; j < K.length; j++) {
      if (j === i) continue;
      for (let k = 0; k < K.length; k++) {
        if (k === i || k === j) continue;

        const name = `${K[i].name}→${K[j].name}→${K[k].name}`;
        const sortFn = (a, b) => {
          const d1 = K[i].cmp(a, b); if (d1 !== 0) return d1;
          const d2 = K[j].cmp(a, b); if (d2 !== 0) return d2;
          return K[k].cmp(a, b);
        };

        const returns = [];
        for (const [, pool] of eligibleByDate) {
          const top1 = [...pool].sort(sortFn)[0];
          if (top1 && top1.r110 != null) returns.push(top1.r110);
        }
        if (returns.length < 30) continue;

        results.push({
          name,
          n: returns.length,
          winR: winR(returns),
          avg: avg(returns),
          med: med(returns),
        });
      }
    }
  }

  // 승률 내림차순, 동점 시 평균 내림차순
  results.sort((a, b) => b.winR - a.winR || b.avg - a.avg);

  // 현재 전략 찾기
  const currentName = 'band→sg→score';

  console.log(`${'순위'.padStart(4)} ${'조합'.padEnd(28)} ${'승률'.padStart(6)} ${'평균'.padStart(8)} ${'중앙값'.padStart(8)} ${'n'.padStart(4)}`);
  console.log('-'.repeat(65));

  results.slice(0, 20).forEach((r, idx) => {
    const marker = r.name === currentName ? ' ◀현재' : '';
    console.log(
      `${String(idx+1).padStart(4)} ${r.name.padEnd(28)} ${r.winR.toFixed(0).padStart(5)}% ${sign(r.avg).padStart(8)}% ${sign(r.med).padStart(8)}% ${String(r.n).padStart(4)}${marker}`
    );
  });

  // 현재 전략 순위
  const currentRank = results.findIndex(r => r.name === currentName) + 1;
  const currentResult = results.find(r => r.name === currentName);
  console.log(`\n현재 전략(${currentName}) 순위: ${currentRank}위 / ${results.length}개 조합`);
  if (currentResult) {
    console.log(`  승률 ${currentResult.winR.toFixed(0)}%  평균 ${sign(currentResult.avg)}%  중앙값 ${sign(currentResult.med)}%`);
  }

  // ── §3. 2차 정렬만 탐색 (단순성 우선) ─────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§3. 2키 조합 탐색 — 승률 기준 TOP 10 (D+1→D+10)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const results2 = [];
  for (let i = 0; i < K.length; i++) {
    for (let j = 0; j < K.length; j++) {
      if (j === i) continue;
      const name = `${K[i].name}→${K[j].name}`;
      const sortFn = (a, b) => {
        const d1 = K[i].cmp(a, b); if (d1 !== 0) return d1;
        return K[j].cmp(a, b);
      };
      const returns = [];
      for (const [, pool] of eligibleByDate) {
        const top1 = [...pool].sort(sortFn)[0];
        if (top1 && top1.r110 != null) returns.push(top1.r110);
      }
      if (returns.length < 30) continue;
      results2.push({ name, n: returns.length, winR: winR(returns), avg: avg(returns), med: med(returns) });
    }
  }
  results2.sort((a, b) => b.winR - a.winR || b.avg - a.avg);

  console.log(`${'순위'.padStart(4)} ${'조합'.padEnd(20)} ${'승률'.padStart(6)} ${'평균'.padStart(8)} ${'중앙값'.padStart(8)} ${'n'.padStart(4)}`);
  console.log('-'.repeat(55));
  results2.slice(0, 10).forEach((r, idx) => {
    console.log(
      `${String(idx+1).padStart(4)} ${r.name.padEnd(20)} ${r.winR.toFixed(0).padStart(5)}% ${sign(r.avg).padStart(8)}% ${sign(r.med).padStart(8)}% ${String(r.n).padStart(4)}`
    );
  });

  // ── §4. 승률 상위와 평균 상위 비교 ───────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§4. 평균수익 기준 TOP 10 (3키 조합, 승률 vs 평균 tradeoff)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const byAvg = [...results].sort((a, b) => b.avg - a.avg);
  console.log(`${'순위'.padStart(4)} ${'조합'.padEnd(28)} ${'평균'.padStart(8)} ${'승률'.padStart(6)} ${'중앙값'.padStart(8)} ${'n'.padStart(4)}`);
  console.log('-'.repeat(65));
  byAvg.slice(0, 10).forEach((r, idx) => {
    const marker = r.name === currentName ? ' ◀현재' : '';
    console.log(
      `${String(idx+1).padStart(4)} ${r.name.padEnd(28)} ${sign(r.avg).padStart(8)}% ${r.winR.toFixed(0).padStart(5)}% ${sign(r.med).padStart(8)}% ${String(r.n).padStart(4)}${marker}`
    );
  });

  console.log(`\n총 ${results.length}개 3키 조합 + ${results2.length}개 2키 조합 탐색 완료.`);
})();
