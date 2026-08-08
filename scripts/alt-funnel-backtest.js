/**
 * alt-funnel-backtest.js — 대안 깔때기 병렬 검증 (기존 시스템 무변경)
 *
 * 배경(2026-08-08): 현행 깔때기(KIS 거래량순위 top30)는 +10% 상승 관측의 0.95%만
 * 그날 풀에 담고 있었고, 방어업종 대형주는 하필 최악인 것만 골라 담았다.
 * "거래량 폭발"이 우량주 영역에서는 매집이 아니라 투매 신호이기 때문.
 *
 * 대안 가설: 표본추출을 **시총 상위 상시 유니버스**로 바꾸고,
 *            업종 상대강도 + 추세로 거르면 하락장에서도 플러스가 나오는가?
 *
 * ── 설계 원칙 (앞선 실패에서 얻은 것) ──────────────────────────
 * (1) **전방참조 금지.** 업종 강도·모멘텀은 전부 신호일 D 이전 데이터로만 계산한다.
 *     이 스크립트에 "전체 기간 성과로 업종을 고른다" 같은 코드는 없다.
 * (2) **실행 가능한 형태로만 평가.** 슬라이스 평균이 아니라 "매일 K종목 매수" 규칙.
 *     pool-slice-scan에서 좋아 보이던 슬라이스가 일별 픽으로 바꾸니 사라진 전례가 있다.
 * (3) **독립블록 = 신호일/H.** 3 미만이면 판정을 거부하고 "중간 관측"으로만 출력한다.
 * (4) 절대수익과 시장 동일가중 대비를 함께 본다. 3분할 구간 안정성 필수.
 * (5) 파라미터를 스캔해 최고를 고르지 않는다 — 기본값 하나로 돌리고,
 *     민감도는 --sweep으로 따로 본다(그 출력은 채택 근거가 아니라 강건성 확인용).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000, MIN_UNIVERSE = 2000;
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const has = k => process.argv.includes(`--${k}`);

const UNIV = arg('univ', 300);   // 시총 상위 N = 상시 유니버스
const LOOK = arg('look', 20);    // 업종강도·모멘텀 산출 기간(거래일)
const NSEC = arg('sec', 3);      // 선택 업종 수
const K = arg('k', 3);           // 일별 픽 종목 수
const MINSEC = 3;                // 업종 강도 산출 최소 종목 수

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
  console.log('📊 대안 깔때기 병렬 검증 — 시총상위 유니버스 + 업종 상대강도\n');
  console.log(`파라미터: 유니버스 시총상위 ${UNIV} / 관측기간 ${LOOK}일 / 업종 ${NSEC}개 / 일별 ${K}종목\n`);

  const flow = await fetchAll('market_flow_daily', 'stock_code,trade_date,close,market_cap,sector_name');
  const byDate = new Map();
  for (const r of flow) { if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []); byDate.get(r.trade_date).push(r); }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();
  for (const r of flow) {
    if (!dayIdx.has(r.trade_date)) continue;
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, r);
  }
  const at = (c, i) => (i >= 0 && i < days.length ? px.get(c)?.get(days[i]) : null);
  console.log(`시장: ${days.length}거래일 × ${px.size}종목 (${days[0]} ~ ${days[days.length - 1]})`);

  // 현행 풀 (비교군)
  const recs = await fetchAll('screening_recommendations', 'recommendation_date,stock_code,is_top3',
    q => q.gte('recommendation_date', days[0]));
  const top3By = new Map();
  for (const r of recs.filter(x => x.is_top3)) {
    if (!top3By.has(r.recommendation_date)) top3By.set(r.recommendation_date, []);
    top3By.get(r.recommendation_date).push(r.stock_code);
  }

  // ── 전략 정의: 모두 "신호일 i 이전 데이터만" 사용 ────────────
  const trailRet = (c, i, n) => {
    const a = at(c, i - n), b = at(c, i);
    return (a?.close && b?.close) ? ((b.close - a.close) / a.close) * 100 : null;
  };

  // 신호일 i에서 상시 유니버스 = 시총 상위 UNIV
  const universeAt = i => byDate.get(days[i]).filter(r => r.market_cap > 0)
    .sort((a, b) => b.market_cap - a.market_cap).slice(0, UNIV);

  // 업종 상대강도: 유니버스 내 업종별 LOOK일 수익 평균 (과거 데이터만)
  const sectorRankAt = i => {
    const u = universeAt(i);
    const bySec = new Map();
    for (const r of u) {
      if (!r.sector_name) continue;
      const t = trailRet(r.stock_code, i, LOOK);
      if (t == null) continue;
      if (!bySec.has(r.sector_name)) bySec.set(r.sector_name, []);
      bySec.get(r.sector_name).push(t);
    }
    return [...bySec.entries()].filter(([, v]) => v.length >= MINSEC)
      .map(([s, v]) => ({ sector: s, strength: avg(v) }))
      .sort((a, b) => b.strength - a.strength);
  };

  const STRATEGIES = {
    'A. 업종강도상위 → 시총상위K': i => {
      const top = new Set(sectorRankAt(i).slice(0, NSEC).map(x => x.sector));
      return universeAt(i).filter(r => top.has(r.sector_name))
        .sort((a, b) => b.market_cap - a.market_cap).slice(0, K).map(r => r.stock_code);
    },
    'B. 업종강도상위 → 종목모멘텀상위K': i => {
      const top = new Set(sectorRankAt(i).slice(0, NSEC).map(x => x.sector));
      return universeAt(i).filter(r => top.has(r.sector_name))
        .map(r => ({ c: r.stock_code, m: trailRet(r.stock_code, i, LOOK) })).filter(x => x.m != null)
        .sort((a, b) => b.m - a.m).slice(0, K).map(x => x.c);
    },
    'C. 업종강도상위 → 종목모멘텀하위K': i => {
      const top = new Set(sectorRankAt(i).slice(0, NSEC).map(x => x.sector));
      return universeAt(i).filter(r => top.has(r.sector_name))
        .map(r => ({ c: r.stock_code, m: trailRet(r.stock_code, i, LOOK) })).filter(x => x.m != null)
        .sort((a, b) => a.m - b.m).slice(0, K).map(x => x.c);
    },
    'D. 업종강도하위 → 시총상위K (역)': i => {
      const bot = new Set(sectorRankAt(i).slice(-NSEC).map(x => x.sector));
      return universeAt(i).filter(r => bot.has(r.sector_name))
        .sort((a, b) => b.market_cap - a.market_cap).slice(0, K).map(r => r.stock_code);
    },
    'E. 유니버스 모멘텀 -20~0% → 시총상위K': i =>
      universeAt(i).map(r => ({ c: r.stock_code, cap: r.market_cap, m: trailRet(r.stock_code, i, LOOK) }))
        .filter(x => x.m != null && x.m >= -20 && x.m <= 0)
        .sort((a, b) => b.cap - a.cap).slice(0, K).map(x => x.c),
    // 저변동성: 고전적 방어 팩터. 신호일 이전 LOOK일 일간수익 표준편차 하위 K.
    'I. 유니버스 저변동성K': i =>
      universeAt(i).map(r => {
        const rets = [];
        for (let k = 1; k < LOOK; k++) {
          const a = at(r.stock_code, i - k - 1), b = at(r.stock_code, i - k);
          if (a?.close && b?.close) rets.push((b.close - a.close) / a.close);
        }
        if (rets.length < LOOK - 3) return null;
        const m = avg(rets);
        return { c: r.stock_code, sd: Math.sqrt(avg(rets.map(x => (x - m) ** 2))) };
      }).filter(Boolean).sort((a, b) => a.sd - b.sd).slice(0, K).map(x => x.c),
    // ⚠️ 아래는 in-sample: 업종을 이 기간 결과를 보고 골랐다. 채택 근거로 쓸 수 없음.
    'J. 고정 방어업종 대형주 균등 ⚠️IS': i =>
      universeAt(i).filter(r => ['음식료·담배', '운송·창고', '금융', '보험', '통신'].includes(r.sector_name))
        .map(r => r.stock_code),
    'K. 시총 하위 유니버스 균등 (사이즈 확인)': i =>
      byDate.get(days[i]).filter(r => r.market_cap > 0)
        .sort((a, b) => a.market_cap - b.market_cap).slice(0, UNIV).map(r => r.stock_code),
    'F. 유니버스 균등분산 (기준선)': i => universeAt(i).map(r => r.stock_code),
    'G. 전 시장 균등분산 (기준선)': i => byDate.get(days[i]).map(r => r.stock_code),
    'H. 현행 TOP3 (비교군)': i => top3By.get(days[i]) ?? [],
  };

  // ── 백테스트 ──────────────────────────────────────────────────
  const run = (SELL, BUY = 1) => {
    const start = LOOK + 1;
    const sigDays = [];
    for (let i = start; i + SELL < days.length; i++) sigDays.push(i);
    const blocks = sigDays.length / SELL;
    const results = {};
    // 시장 동일가중 일별 평균 (초과수익 기준선)
    const dayMean = new Map();
    for (const i of sigDays) {
      const rs = byDate.get(days[i]).map(r => {
        const b = at(r.stock_code, i + BUY), s = at(r.stock_code, i + SELL);
        return (b?.close && s?.close) ? ((s.close - b.close) / b.close) * 100 : null;
      }).filter(v => v != null);
      dayMean.set(i, avg(rs));
    }
    for (const [name, fn] of Object.entries(STRATEGIES)) {
      const rows = [];
      for (const i of sigDays) {
        for (const c of fn(i)) {
          const b = at(c, i + BUY), s = at(c, i + SELL);
          if (!b?.close || !s?.close) continue;
          const ret = ((s.close - b.close) / b.close) * 100;
          rows.push({ i, date: days[i], code: c, ret, excess: ret - dayMean.get(i) });
        }
      }
      results[name] = rows;
    }
    return { results, sigDays, blocks };
  };

  const thirds = rows => {
    const ds = [...new Set(rows.map(r => r.date))].sort();
    if (!ds.length) return [null, null, null];
    const cut = [ds[Math.floor(ds.length / 3)], ds[Math.floor(ds.length * 2 / 3)]];
    return [
      avg(rows.filter(r => r.date < cut[0]).map(r => r.ret)),
      avg(rows.filter(r => r.date >= cut[0] && r.date < cut[1]).map(r => r.ret)),
      avg(rows.filter(r => r.date >= cut[1]).map(r => r.ret)),
    ];
  };

  for (const SELL of [2, 5, 10]) {
    const { results, sigDays, blocks } = run(SELL);
    console.log(`\n${'═'.repeat(96)}`);
    console.log(`D+1 매수 → D+${SELL} 매도   신호일 ${sigDays.length}일   독립블록 ${blocks.toFixed(1)}` +
      (blocks < 3 ? '  ⚠️ 판정 불가 — 중간 관측' : '  ✅ 판정 요건 충족'));
    console.log('전략'.padEnd(34) + '건수'.padStart(6) + '  절대수익  시장초과   승률   중앙 | 3분할 구간별');
    for (const [name, rows] of Object.entries(results)) {
      if (!rows.length) { console.log(name.padEnd(34) + '   (표본 없음)'); continue; }
      const rt = rows.map(r => r.ret);
      console.log(name.padEnd(34) + rows.length.toLocaleString().padStart(6) +
        '   ' + sign(avg(rt)) + '%  ' + sign(avg(rows.map(r => r.excess))) + '%  ' +
        (winR(rt) ?? 0).toFixed(0).padStart(4) + '%  ' + sign(med(rt)) + '% | ' +
        thirds(rows).map(sign).join(' '));
    }
  }

  // 선택된 업종이 실제로 무엇이었는지 (사후 설명이 아니라 사전 선택 기록)
  console.log(`\n${'═'.repeat(96)}`);
  console.log('전략 A/B가 실제로 고른 업종 (신호일 기준, 전방참조 없음) — 빈도 상위');
  const cnt = new Map();
  for (let i = LOOK + 1; i + 10 < days.length; i++)
    for (const s of sectorRankAt(i).slice(0, NSEC).map(x => x.sector)) cnt.set(s, (cnt.get(s) ?? 0) + 1);
  const tot = [...cnt.values()].reduce((a, b) => a + b, 0);
  console.log([...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([s, n]) => `${s} ${(n / tot * 100).toFixed(0)}%`).join(' / '));

  if (has('sweep')) {
    console.log(`\n${'═'.repeat(96)}`);
    console.log('민감도 (강건성 확인용 — 최고값을 고르는 근거로 쓰지 말 것)');
    console.log('univ  look  sec  k | D+10 전략B 절대수익  승률');
    for (const u of [200, 300, 500]) for (const l of [10, 20]) for (const s of [2, 3, 5]) {
      process.argv = process.argv.filter(a => !a.startsWith('--univ=') && !a.startsWith('--look=') && !a.startsWith('--sec='));
      // 간단화: 전역 상수라 재실행 대신 안내만
    }
    console.log('(파라미터를 바꿔 재실행할 것: node scripts/alt-funnel-backtest.js --univ=500 --look=10 --sec=5)');
  }
})().catch(e => { console.error(e); process.exit(1); });
