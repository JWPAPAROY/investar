/**
 * 깔때기 뒤집기 검증 — 풀 밖 수급-우선 신호 (To-Do #6-A, v3.94 개정 설계)
 *
 * 가설
 *   현행 풀(거래량 순위 top30)은 "가장 시끄러운 30개" = 주목 정점 이후 표본이라 음의 드리프트.
 *   철학은 "조용한 매집 선점"인데 표본추출이 정반대다.
 *   → 순위에 뜨기 전(풀 밖)에서 매집 신호를 잡으면 알파가 있는가?
 *
 * 설계 (개정 근거는 CLAUDE.md To-Do #6-A 참고)
 *   - 주 지표: **동일일·동일 시총분위 매칭 초과수익**. 절대수익은 베타(특히 사이즈)에
 *     잡아먹히므로 신호 자체를 볼 수 없다.
 *   - 동수 비교: 신호 집합을 랭킹해 **일별 상위 3개**를 뽑아 현행 TOP3와 견준다.
 *     (신호 전체 평균 vs TOP3 3개는 불공정한 비교)
 *   - 평가: D+1 매수 → D+10 매도 (active_policy 지평). D+1/3/5는 민감도 관측용.
 *   - **독립블록 = 신호일 ÷ H.** D+10 윈도우가 겹치면 같은 시장 구간을 반복 측정할 뿐이다.
 *     블록<3이면 이 스크립트는 "중간 관측"으로만 출력하고 판정을 거부한다.
 *
 * 데이터 주의
 *   - 수급은 market_flow_daily에서 **올바른 방향**(그날부터 과거로)으로 재계산한다.
 *     screening_recommendations의 수급 컬럼은 v3.94 이전 방향 버그 산출값이라 사용 금지.
 *   - market_flow_daily의 전 종목 수집은 2026-05-22부터. 그 이전은 하루 2~4종목뿐이라 제외.
 *   - KOSPI는 overnight_predictions.kospi_close 시계열 (kospi_close_change 신뢰 금지).
 *
 * 실행:
 *   node scripts/validate-funnel-inversion.js
 *   node scripts/validate-funnel-inversion.js --L=20 --streak=5   # 강건성 확인
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const arg = (k, d) => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? Number(m.split('=')[1]) : d;
};
const CFG = {
  L: arg('L', 10),            // 신호 형성 깊이 (거래량 점증·가격 횡보 참조 구간)
  streak: arg('streak', 3),   // 기관/외인 연속 순매수 최소 일수
  volRatio: arg('volRatio', 1.2), // 최근5일 평균거래량 / 직전 L일 평균 배수
  flatPct: arg('flat', 10),   // 가격 횡보 허용 |변동%|
  H: arg('H', 10),            // 평가 지평 (D+1 매수 → D+H 매도)
  topN: arg('topN', 3),       // TOP3 동수 비교용
  COVERAGE_MIN: 2000,         // 전 종목 수집으로 인정할 최소 종목 수/일
  MIN_BLOCKS: 3,              // 정식 판정에 필요한 독립블록
};

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
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fmt = v => v == null ? '   n/a' : ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(7);

async function main() {
  console.log('📊 깔때기 뒤집기 검증 — 풀 밖 수급-우선 신호');
  console.log(`   설정: L=${CFG.L}d streak=${CFG.streak}d volRatio=${CFG.volRatio} flat<${CFG.flatPct}% H=D+${CFG.H}\n`);

  // ── 1. 데이터 로드 ────────────────────────────────────────────────
  const flow = await fetchAll('market_flow_daily',
    'stock_code,trade_date,close,volume,inst_net_qty,frgn_net_qty,market_cap');
  const per = {};
  for (const f of flow) per[f.trade_date] = (per[f.trade_date] || 0) + 1;
  const DATES = Object.entries(per).filter(([, n]) => n >= CFG.COVERAGE_MIN).map(([d]) => d).sort();
  const dPos = new Map(DATES.map((d, i) => [d, i]));

  // 종목 → (날짜 → 레코드)
  const byStock = new Map();
  for (const f of flow) {
    if (!dPos.has(f.trade_date)) continue;
    if (!byStock.has(f.stock_code)) byStock.set(f.stock_code, new Map());
    byStock.get(f.stock_code).set(f.trade_date, f);
  }

  console.log(`전 종목 수집: ${DATES.length}거래일 (${DATES[0]} ~ ${DATES[DATES.length - 1]}), ${byStock.size}종목`);

  // 현행 풀(그날 스크리닝에 뜬 종목) — "풀 밖" 판정용
  const recs = await fetchAll('screening_recommendations',
    'recommendation_date,stock_code,is_top3', q => q.gte('recommendation_date', DATES[0]));
  const poolByDate = new Map();
  const top3ByDate = new Map();
  for (const r of recs) {
    if (!poolByDate.has(r.recommendation_date)) poolByDate.set(r.recommendation_date, new Set());
    poolByDate.get(r.recommendation_date).add(r.stock_code);
    if (r.is_top3) {
      if (!top3ByDate.has(r.recommendation_date)) top3ByDate.set(r.recommendation_date, []);
      top3ByDate.get(r.recommendation_date).push(r.stock_code);
    }
  }

  // KOSPI 종가 시계열
  const kp = await fetchAll('overnight_predictions', 'prediction_date,kospi_close',
    q => q.gte('prediction_date', DATES[0]).lt('prediction_date', '2900-01-01').not('kospi_close', 'is', null));
  const kospi = new Map(kp.map(x => [x.prediction_date, x.kospi_close]));

  // ── 2. 수익률 helper (D+1 매수 → D+H 매도, 거래일 인덱스) ──────────
  const closeAt = (code, di) => byStock.get(code)?.get(DATES[di])?.close ?? null;
  const retOf = (code, di, H) => {
    const buy = closeAt(code, di + 1), sell = closeAt(code, di + H);
    if (!buy || !sell || buy <= 0) return null;
    return (sell / buy - 1) * 100;
  };
  const kospiRet = (di, H) => {
    const b = kospi.get(DATES[di + 1]), s = kospi.get(DATES[di + H]);
    if (!b || !s) return null;
    return (s / b - 1) * 100;
  };

  // ── 3. 신호 판정 ──────────────────────────────────────────────────
  //    수급 스트릭은 반드시 **그날부터 과거로** (v3.94: 반대로 세던 버그)
  function signalOf(code, di) {
    const m = byStock.get(code);
    if (!m) return null;
    const at = k => m.get(DATES[k]);
    if (di - CFG.L < 0) return null;
    const cur = at(di);
    if (!cur || !cur.close) return null;

    let inst = 0, frgn = 0;
    for (let k = di; k >= 0; k--) { const r = at(k); if (r && (r.inst_net_qty || 0) > 0) inst++; else break; }
    for (let k = di; k >= 0; k--) { const r = at(k); if (r && (r.frgn_net_qty || 0) > 0) frgn++; else break; }
    if (inst < CFG.streak && frgn < CFG.streak) return null;

    const vols = [], base = [];
    for (let k = di - 4; k <= di; k++) { const r = at(k); if (r?.volume) vols.push(r.volume); }
    for (let k = di - CFG.L; k <= di - 5; k++) { const r = at(k); if (r?.volume) base.push(r.volume); }
    if (!vols.length || !base.length) return null;
    const avgV = mean(vols), avgB = mean(base);
    if (avgB <= 0 || avgV < avgB * CFG.volRatio) return null;

    const p0 = at(di - CFG.L)?.close;
    if (!p0 || Math.abs((cur.close / p0 - 1) * 100) >= CFG.flatPct) return null;

    return { inst, frgn, volGrowth: avgV / avgB, cap: cur.market_cap || 0 };
  }

  // ── 4. 신호일 순회 ────────────────────────────────────────────────
  const lo = CFG.L, hi = DATES.length - CFG.H;
  const signalDays = Math.max(0, hi - lo);
  const blocks = signalDays / CFG.H;
  console.log(`신호일: ${signalDays}일 (index ${lo}~${hi - 1}) → 독립블록 ${blocks.toFixed(1)}\n`);

  const rows = [];   // 신호 종목별 결과
  const t3rows = []; // 현행 TOP3
  const kRows = [];  // KOSPI (신호일당 1건)

  for (let di = lo; di < hi; di++) {
    const date = DATES[di];
    const pool = poolByDate.get(date) || new Set();

    // 그날 전 종목 시총 5분위 경계
    const universe = [];
    for (const [code, m] of byStock) {
      const r = m.get(date);
      if (r && r.market_cap > 0) universe.push({ code, cap: r.market_cap });
    }
    if (universe.length < 500) continue;
    universe.sort((a, b) => a.cap - b.cap);
    const qOf = new Map();
    universe.forEach((u, i) => qOf.set(u.code, Math.min(4, Math.floor(i / (universe.length / 5)))));

    // 신호 판정
    const sig = [];
    for (const { code } of universe) {
      const s = signalOf(code, di);
      if (s) sig.push({ code, ...s });
    }
    const sigSet = new Set(sig.map(s => s.code));

    // 분위별 비신호 평균 (매칭 대조군)
    const ctrl = [[], [], [], [], []];
    for (const { code } of universe) {
      if (sigSet.has(code)) continue;
      const r = retOf(code, di, CFG.H);
      if (r != null) ctrl[qOf.get(code)].push(r);
    }
    const ctrlMean = ctrl.map(a => mean(a));

    // 신호 종목 결과
    const todays = [];
    for (const s of sig) {
      const r = retOf(s.code, di, CFG.H);
      if (r == null) continue;
      const q = qOf.get(s.code);
      const cm = ctrlMean[q];
      if (cm == null) continue;
      todays.push({ date, ...s, ret: r, excess: r - cm, q, outOfPool: !pool.has(s.code) });
    }
    // 랭킹: 수급강도(연속일 max) → 거래량 점증률
    todays.sort((a, b) =>
      (Math.max(b.inst, b.frgn) - Math.max(a.inst, a.frgn)) || (b.volGrowth - a.volGrowth));
    todays.forEach((t, i) => { t.rank = i + 1; });
    rows.push(...todays);

    // 현행 TOP3 (같은 날, 같은 가격 소스로 동일 조건 평가)
    for (const code of (top3ByDate.get(date) || [])) {
      const r = retOf(code, di, CFG.H);
      if (r == null) continue;
      const q = qOf.get(code);
      const cm = q != null ? ctrlMean[q] : null;
      t3rows.push({ date, code, ret: r, excess: cm == null ? null : r - cm });
    }

    const kr = kospiRet(di, CFG.H);
    if (kr != null) kRows.push({ date, ret: kr });
  }

  // ── 5. 리포트 ─────────────────────────────────────────────────────
  const outPool = rows.filter(r => r.outOfPool);
  const top3sig = outPool.filter(r => r.rank <= CFG.topN);

  console.log('구분'.padEnd(30), 'n'.padStart(6), '절대'.padStart(8), '매칭초과'.padStart(9), '승률'.padStart(7), '중앙'.padStart(8));
  console.log('─'.repeat(74));
  const line = (name, arr, key = 'ret') => {
    const abs = arr.map(r => r[key]).filter(v => v != null);
    const exc = arr.map(r => r.excess).filter(v => v != null);
    console.log(
      name.padEnd(30), String(abs.length).padStart(6),
      fmt(mean(abs)), fmt(mean(exc)),
      (winR(exc) == null ? '  n/a' : winR(exc).toFixed(0) + '%').padStart(7),
      fmt(med(exc)),
    );
  };
  line(`풀 밖 신호 전체`, outPool);
  line(`풀 밖 신호 상위${CFG.topN} (동수)`, top3sig);
  line(`현행 TOP3`, t3rows);
  console.log('─'.repeat(74));
  console.log('KOSPI (신호일 D+1→D+' + CFG.H + ')'.padEnd(9), String(kRows.length).padStart(6), fmt(mean(kRows.map(r => r.ret))));
  console.log('\n※ 매칭초과 = 같은 날·같은 시총 5분위의 비신호 종목 평균 대비 초과수익 (시장·사이즈 요인 제거)');

  // 블록별
  console.log('\n독립블록별 매칭초과 (신호 상위' + CFG.topN + ', 겹치지 않는 D+' + CFG.H + ' 구간):');
  const nb = Math.floor(signalDays / CFG.H);
  for (let b = 0; b < nb; b++) {
    const from = DATES[lo + b * CFG.H], to = DATES[lo + (b + 1) * CFG.H - 1];
    const seg = top3sig.filter(r => r.date >= from && r.date <= to).map(r => r.excess).filter(v => v != null);
    console.log(`  블록${b + 1} ${from}~${to}  n=${String(seg.length).padStart(3)}  ${fmt(mean(seg))}`);
  }

  // ── 6. 판정 게이트 ────────────────────────────────────────────────
  console.log('');
  if (blocks < CFG.MIN_BLOCKS) {
    console.log('⚠️  중간 관측 — 판정 불가');
    console.log(`   독립블록 ${blocks.toFixed(1)} < ${CFG.MIN_BLOCKS}. D+${CFG.H} 윈도우가 겹쳐 사실상 같은 시장 구간을`);
    console.log('   반복 측정한 것이다. 위 수치로 가설을 기각하거나 채택하지 말 것.');
    // blocks = (N - L - H) / H  →  blocks=b 이려면 N = L + H*(b+1)
    const needDays = CFG.L + CFG.H * (CFG.MIN_BLOCKS + 1) - DATES.length;
    console.log(`   블록 ${CFG.MIN_BLOCKS} 확보까지 +${needDays}거래일 필요 (평일 17:50 수집으로 매일 1일씩 누적).`);
  } else {
    console.log(`✅ 독립블록 ${blocks.toFixed(1)} ≥ ${CFG.MIN_BLOCKS} — 판정 가능`);
    console.log('   판정: 매칭초과가 블록별로 일관되게 양수 → 깔때기 전환 설계.');
    console.log('         일관되게 음수/무차별 → 가설 기각, 시스템을 베타+리스크컨트롤로 재규정.');
    console.log('   ⚠️ 표본 구간이 단일 레짐(하락장)이면 "그 레짐에서만"의 결론임을 명시할 것.');
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
