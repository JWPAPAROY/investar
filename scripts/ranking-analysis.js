/**
 * ranking-analysis.js — 역대 전략 재현 비교 (동일 데이터·동일 기간)
 *
 * 재현 전략 (CHANGELOG 기반):
 *   v376  : tier1(시총≤1조우선) + 스윗스팟 구간(50-59→60-69→80-89→90+→70-79→45-49) + 수급1차 → 점수
 *   v383  : tier1 + 스윗스팟 구간 + 점수1차 (수급 tiebreak)
 *   B1    : 스윗스팟 구간 + 점수1차, tier1 없음 (v3.84 백테스트 B1)
 *   v384  : 순수 점수 → 수급 tiebreak, tier1·구간 없음 (채택된 B2)
 *   v385  : isV2Priority(50-69+고래단독) → 점수 → 수급 tiebreak (현재)
 *   Prop  : 외인매수일 1차 → 점수 (분석 제안)
 *
 * 공통 gate: (고래 OR 기관≥3 OR 외인≥3) AND 점수≥45
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;

// ── 유틸 ──────────────────────────────────────────────────────────
const avg  = a => a.length ? a.reduce((s,v) => s+v, 0) / a.length : null;
const med  = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const winR = a => a.length ? (a.filter(v => v > 0).length / a.length * 100) : null;
const pct5 = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length*0.05)]; };
const sign = v => v == null ? '-' : (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

function supplyGrade(inst, fgn) {
  if (inst >= 2 && fgn >= 2) return 5;
  if (fgn >= 2) return 4;
  if (inst >= 2) return 3;
  if (fgn >= 1 || inst >= 1) return 2;
  return 1;
}

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
const gate = s => (s.whale || s.inst >= 3 || s.fgn >= 3) && s.score >= 45;

// ── 수급 순위 (tiebreak용) ─────────────────────────────────────────
const supplyRank = s => {
  if (s.fgn >= 2 && s.inst < 2) return 5;
  if (s.inst >= 2 && s.fgn >= 2) return 4;
  if (s.inst >= 2) return 3;
  if (s.fgn >= 1) return 2;
  return 1;
};

// ── 스윗스팟 구간 (v3.76~v3.83) ──────────────────────────────────
// 50-59=1위, 60-69=2위, 80-89=3위, 90+=4위, 70-79=5위, 45-49=6위
const bandRank = score => {
  if (score >= 50 && score <= 59) return 1;
  if (score >= 60 && score <= 69) return 2;
  if (score >= 80 && score <= 89) return 3;
  if (score >= 90) return 4;
  if (score >= 70 && score <= 79) return 5;
  return 6; // 45-49
};

// ── tier1 (v3.63~v3.83): 시총 ≤ 1조(10000억) 우선 ────────────────
// tier1 후보가 3개 미만이면 전체로 확대
function applyTier1(pool) {
  const small = pool.filter(s => s.marketCapBillion <= 10000);
  return small.length >= 3 ? small : pool;
}

// ── 전략 정의 ──────────────────────────────────────────────────────
const strategies = {

  // v3.76~82: tier1 + 스윗스팟 구간 + 수급1차 → 점수
  v376: pool => {
    const eligible = applyTier1(pool.filter(gate));
    return [...eligible].sort((a, b) => {
      const bd = bandRank(a.score) - bandRank(b.score); // 낮을수록 좋은 구간
      if (bd !== 0) return bd;
      const sd = supplyRank(b) - supplyRank(a);
      if (sd !== 0) return sd;
      return b.score - a.score;
    });
  },

  // v3.83: tier1 + 스윗스팟 구간 + 점수1차 (수급 tiebreak)
  v383: pool => {
    const eligible = applyTier1(pool.filter(gate));
    return [...eligible].sort((a, b) => {
      const bd = bandRank(a.score) - bandRank(b.score);
      if (bd !== 0) return bd;
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return supplyRank(b) - supplyRank(a);
    });
  },

  // B1 (v3.84 백테스트): 스윗스팟 구간 + 점수1차, tier1 없음
  B1: pool => {
    const eligible = pool.filter(gate);
    return [...eligible].sort((a, b) => {
      const bd = bandRank(a.score) - bandRank(b.score);
      if (bd !== 0) return bd;
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return supplyRank(b) - supplyRank(a);
    });
  },

  // v376NT (현재 production): 스윗스팟 구간 + 수급1차 → 점수, tier1 없음 (v376에서 tier1만 제거)
  v376NT: pool => {
    const eligible = pool.filter(gate);
    return [...eligible].sort((a, b) => {
      const bd = bandRank(a.score) - bandRank(b.score);
      if (bd !== 0) return bd;
      const sd = supplyRank(b) - supplyRank(a);
      if (sd !== 0) return sd;
      return b.score - a.score;
    });
  },

  // v3.84 (B2, 채택): 순수 점수 → 수급 tiebreak
  v384: pool => {
    const eligible = pool.filter(gate);
    return [...eligible].sort((a, b) => {
      const sd = b.score - a.score;
      if (sd !== 0) return sd;
      return supplyRank(b) - supplyRank(a);
    });
  },

  // v3.85 (현재): isV2Priority(50-69+고래단독) → 점수 → 수급 tiebreak
  v385: pool => {
    const eligible = pool.filter(gate);
    const isV2 = s => (s.score >= 50 && s.score <= 69 && s.whale && s.inst < 2 && s.fgn < 2) ? 1 : 0;
    return [...eligible].sort((a, b) => {
      const vd = isV2(b) - isV2(a);
      if (vd !== 0) return vd;
      const sd = b.score - a.score;
      if (sd !== 0) return sd;
      return supplyRank(b) - supplyRank(a);
    });
  },

  // 제안: 외인매수일 1차 → 점수 (데이터상 sg=4 성과가 좋았기 때문)
  Prop: pool => {
    const eligible = pool.filter(gate);
    return [...eligible].sort((a, b) => {
      const fd = b.fgn - a.fgn;
      if (fd !== 0) return fd;
      return b.score - a.score;
    });
  },
};

const stratDesc = {
  v376:   'v3.76~82  tier1+구간+수급1차→점수',
  v383:   'v3.83     tier1+구간+점수1차',
  B1:     'B1(백테)  구간+점수1차, tier1없음',
  v376NT: 'v376NT★  구간+수급1차→점수, tier1없음(현재prod)',
  v384:   'v3.84★   순수점수→수급tiebreak',
  v385:   'v3.85현재 스윗스팟(50-69고래단독)→점수',
  Prop:   '제안      외인매수일1차→점수',
};

// ── 메인 ──────────────────────────────────────────────────────────
(async () => {
  console.log('데이터 로딩 중...');

  const recs = await fetchAll(
    'screening_recommendations',
    'id,recommendation_date,stock_code,stock_name,total_score,' +
    'is_top3,market_regime,whale_detected,institution_buy_days,foreign_buy_days,' +
    'change_rate,disparity,market_cap'
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

  const enriched = recs.map(r => {
    const inst = r.institution_buy_days || 0;
    const fgn  = r.foreign_buy_days || 0;
    return {
      ...r,
      score: r.total_score || 0,
      inst, fgn,
      sg: supplyGrade(inst, fgn),
      whale: !!r.whale_detected,
      marketCapBillion: r.market_cap ? r.market_cap / 100000000 : 999999,
      r14:  ret(r.id, 1, 4),   // D+1매수→D+4매도 (3일 보유)
      r110: ret(r.id, 1, 10),  // D+1매수→D+10매도 (9일 보유)
      // 보유기간 스캔용
      r12:  ret(r.id, 1, 2),
      r13:  ret(r.id, 1, 3),
      r15:  ret(r.id, 1, 5),
      r16:  ret(r.id, 1, 6),
      r17:  ret(r.id, 1, 7),
      r18:  ret(r.id, 1, 8),
      r19:  ret(r.id, 1, 9),
      r111: ret(r.id, 1, 11),
      r112: ret(r.id, 1, 12),
      r115: ret(r.id, 1, 15),
    };
  });

  // 날짜별 그룹
  const byDate = new Map();
  for (const s of enriched) {
    if (!byDate.has(s.recommendation_date)) byDate.set(s.recommendation_date, []);
    byDate.get(s.recommendation_date).push(s);
  }
  const dates = [...byDate.keys()].sort();

  // ── 전략별 시뮬레이션 ──────────────────────────────────────────
  const sNames = Object.keys(strategies);
  const simTop1 = {};
  for (const sn of sNames) simTop1[sn] = [];

  for (const d of dates) {
    const pool = byDate.get(d);
    for (const sn of sNames) {
      const ranked = strategies[sn](pool);
      if (!ranked.length) continue;
      const top1 = ranked[0];
      simTop1[sn].push({ date: d, stock: top1 });
    }
  }

  // ── 결과 출력 ──────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§1. 전략별 TOP1 종합 성과 비교 (역대 + 제안, D+1매수→D+10매도)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${'전략'.padEnd(6)}| ${'설명'.padEnd(36)}| ${'평균'.padStart(8)}| ${'중앙값'.padStart(8)}| ${'승률'.padStart(6)}| ${'5%ile'.padStart(8)}| ${'n'.padStart(4)}`);
  console.log('-'.repeat(85));

  for (const sn of sNames) {
    const rs210 = simTop1[sn].filter(x => x.stock.r110 != null).map(x => x.stock.r110);
    const a = avg(rs210), m = med(rs210), w = winR(rs210), p5 = pct5(rs210);
    const marker = sn === 'v385' ? ' ←현재' : sn === 'v384' ? ' ←v3.84채택' : '';
    console.log(
      `${sn.padEnd(6)}| ${stratDesc[sn].padEnd(36)}| ${sign(a).padStart(8)}%| ${sign(m).padStart(8)}%| ${(w?.toFixed(0)??'-').padStart(5)}%| ${sign(p5).padStart(8)}%| ${String(rs210.length).padStart(4)}${marker}`
    );
  }

  // D+0→D+3 도 비교
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§2. 전략별 TOP1 성과 (D+1매수→D+4매도, 3일 보유)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${'전략'.padEnd(6)}| ${'설명'.padEnd(36)}| ${'평균'.padStart(8)}| ${'중앙값'.padStart(8)}| ${'승률'.padStart(6)}| ${'n'.padStart(4)}`);
  console.log('-'.repeat(70));
  for (const sn of sNames) {
    const rs = simTop1[sn].filter(x => x.stock.r14 != null).map(x => x.stock.r14);
    console.log(
      `${sn.padEnd(6)}| ${stratDesc[sn].padEnd(36)}| ${sign(avg(rs)).padStart(8)}%| ${sign(med(rs)).padStart(8)}%| ${(winR(rs)?.toFixed(0)??'-').padStart(5)}%| ${String(rs.length).padStart(4)}`
    );
  }

  // ── 전략별 수급등급 분포 비교 ──────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§3. 전략별 TOP1 수급등급(sg) 분포 — sg=4(외인≥2d)가 얼마나 선택되나?');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const sgLabels = { 5:'쌍방', 4:'외인≥2d', 3:'기관≥2d', 2:'약수급', 1:'고래만' };
  const header = '전략'.padEnd(6) + '|' + [5,4,3,2,1].map(g => ` sg${g}(${sgLabels[g]})`.padStart(14)).join('|');
  console.log(header);
  console.log('-'.repeat(80));
  for (const sn of sNames) {
    const all = simTop1[sn];
    const total = all.length;
    const row = sn.padEnd(6) + '|' + [5,4,3,2,1].map(g => {
      const cnt = all.filter(x => x.stock.sg === g).length;
      return ` ${cnt}회(${(cnt/total*100).toFixed(0)}%)`.padStart(14);
    }).join('|');
    console.log(row);
  }

  // ── 날짜별 상세 비교 (v384 vs v385 vs Prop) ────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§4. v384 vs v385 vs Prop — 서로 다른 날짜의 TOP1 직접 비교 (D+1→D+10)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let wins = { v384:0, v385:0, Prop:0, tie:0 };
  let judged = 0;
  for (const d of dates) {
    const a = simTop1.v384.find(x=>x.date===d)?.stock;
    const b = simTop1.v385.find(x=>x.date===d)?.stock;
    const c = simTop1.Prop.find(x=>x.date===d)?.stock;
    if (!a || !b || !c) continue;
    if (a.r110 == null && b.r110 == null && c.r110 == null) continue;

    // 셋 중 달라진 날만 출력
    const allSame = a.stock_code === b.stock_code && b.stock_code === c.stock_code;
    if (allSame) continue;

    judged++;
    const rets = { v384: a.r110, v385: b.r110, Prop: c.r110 };
    const valid = Object.entries(rets).filter(([,v]) => v != null);
    if (valid.length >= 2) {
      const best = valid.reduce((mx, cur) => cur[1] > mx[1] ? cur : mx);
      if (best) wins[best[0]] = (wins[best[0]] || 0) + 1;
    }

    const fmt = (s, r) => `${(s?.stock_name||'-').slice(0,7).padEnd(7)}(${String(s?.score||0).padStart(2)}p sg${s?.sg}) ${sign(r).padStart(7)}%`;
    console.log(`${d} | v384:${fmt(a,a.r110)} | v385:${fmt(b,b.r110)} | Prop:${fmt(c,c.r110)}`);
  }

  console.log(`\n  판정 ${judged}일 중 (수익 데이터 있는 날 기준 최고수익 전략):`);
  console.log(`  v384(순수점수) 최고: ${wins.v384}회 | v385(현재) 최고: ${wins.v385}회 | Prop(외인우선) 최고: ${wins.Prop}회`);

  // ── §5. v376 최적 보유기간 스캔 (D+1 매수 기준) ──────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§5. v376 TOP1 — D+1 매수 기준 최적 보유기간 스캔');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${'매도일'.padEnd(8)}| ${'평균'.padStart(8)}| ${'중앙값'.padStart(8)}| ${'승률'.padStart(6)}| ${'5%ile'.padStart(8)}| ${'n'.padStart(4)}`);
  console.log('-'.repeat(55));

  const scanFields = [
    ['D+2',  'r12'],  ['D+3',  'r13'],  ['D+4',  'r14'],
    ['D+5',  'r15'],  ['D+6',  'r16'],  ['D+7',  'r17'],
    ['D+8',  'r18'],  ['D+9',  'r19'],  ['D+10', 'r110'],
    ['D+11', 'r111'], ['D+12', 'r112'], ['D+15', 'r115'],
  ];

  for (const [label, field] of scanFields) {
    const rs = simTop1.v376.filter(x => x.stock[field] != null).map(x => x.stock[field]);
    const a = avg(rs), m = med(rs), w = winR(rs), p5 = pct5(rs);
    const marker = label === 'D+10' ? ' ◀ 현재 active_policy' : '';
    console.log(
      `${label.padEnd(8)}| ${sign(a).padStart(8)}%| ${sign(m).padStart(8)}%| ${(w?.toFixed(0)??'-').padStart(5)}%| ${sign(p5).padStart(8)}%| ${String(rs.length).padStart(4)}${marker}`
    );
  }

  // ── §6. B1 vs v383 직접 비교 ─────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('§6. B1(구간+점수1차) vs v383(tier1+구간+점수1차) — TOP1 직접 비교 (D+1→D+10)');
  console.log('     ※ 현재 production = v376NT(구간+수급1차, tier1없음) — §1 참고');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let winsB = { B1:0, v383:0, tie:0 };
  let diffDays = 0, sameDays = 0;
  // 시총 구간 라벨
  const capLabel = cap => {
    if (!cap) return '?';
    const b = cap / 1e8;
    if (b <= 1000)  return '~1000억';
    if (b <= 3000)  return '~3000억';
    if (b <= 10000) return '~1조';
    if (b <= 30000) return '~3조';
    if (b <= 100000)return '~10조';
    return '10조+';
  };

  const fmtB = (s, r) =>
    `${(s?.stock_name||'-').slice(0,7).padEnd(7)}(${String(s?.score||0).padStart(2)}p ${capLabel(s?.market_cap||0)}) ${sign(r).padStart(7)}%`;

  for (const d of dates) {
    const b = simTop1.B1.find(x=>x.date===d)?.stock;
    const v = simTop1.v383.find(x=>x.date===d)?.stock;
    if (!b || !v) continue;

    const sameStock = b.stock_code === v.stock_code;
    if (sameStock) { sameDays++; continue; }

    diffDays++;
    if (b.r110 == null && v.r110 == null) continue;
    const bR = b.r110, vR = v.r110;
    const winner = bR != null && vR != null ? (bR > vR ? 'B1' : bR < vR ? 'v383' : 'tie') : null;
    if (winner) winsB[winner]++;

    console.log(`${d} | B1:${fmtB(b,bR)} | v383:${fmtB(v,vR)}${winner ? ' ←'+winner : ''}`);
  }

  const b1All  = simTop1.B1.filter(x=>x.stock.r110!=null).map(x=>x.stock.r110);
  const v83All = simTop1.v383.filter(x=>x.stock.r110!=null).map(x=>x.stock.r110);
  console.log(`\n  전체 ${dates.length}일 중: 동일종목 ${sameDays}일 / 다른종목 ${diffDays}일`);
  console.log(`  다른날 승자: B1 ${winsB.B1}회 | v383 ${winsB.v383}회 | 동점 ${winsB.tie}회`);
  console.log(`\n  B1   종합: 평균 ${sign(avg(b1All))}%  중앙값 ${sign(med(b1All))}%  승률 ${winR(b1All)?.toFixed(0)}%  n=${b1All.length}`);
  console.log(`  v383 종합: 평균 ${sign(avg(v83All))}%  중앙값 ${sign(med(v83All))}%  승률 ${winR(v83All)?.toFixed(0)}%  n=${v83All.length}`);

  // tier1이 실제로 발동한 날 분석
  console.log('\n  [tier1 발동 분석] v383에서 tier1(≤1조)이 풀을 좁힌 날:');
  let tier1Active = 0, tier1Helped = 0, tier1Hurt = 0;
  for (const d of dates) {
    const b = simTop1.B1.find(x=>x.date===d)?.stock;
    const v = simTop1.v383.find(x=>x.date===d)?.stock;
    if (!b || !v || b.stock_code === v.stock_code) continue;
    // 다른 종목이면 tier1이 발동해서 선택이 달라진 것
    tier1Active++;
    if (v.r110 != null && b.r110 != null) {
      if (v.r110 > b.r110) tier1Helped++;
      else if (v.r110 < b.r110) tier1Hurt++;
    }
  }
  console.log(`    tier1이 선택 바꾼 날: ${tier1Active}일`);
  console.log(`    tier1이 도움된 날: ${tier1Helped}일 (v383이 더 좋은 수익)`);
  console.log(`    tier1이 해가 된 날: ${tier1Hurt}일 (B1이 더 좋은 수익)`);

  console.log('\n분석 완료.\n');
})();
