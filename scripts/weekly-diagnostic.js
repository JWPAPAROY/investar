// ============================================================================
// weekly-diagnostic.js — Phase 1: 주간 진단 (관측 only, action 없음)
// 매주 일요일 22:00 KST 실행. 4가지 진단을 weekly_diagnostics 테이블에 INSERT.
// ============================================================================
// 진단 구성:
//   1. Regime: 강신호 종목(volR>=3 + VPD>=2)의 최근 30일 T+3 평균
//        > +1% momentum / -1% < x < +1% sideways / < -1% defense
//   2. Score Health: 점수 구간 × T+3 평균의 Spearman r. >0이면 정상
//   3. Optimal Timing: in-sample 8주에서 (k,n) 매트릭스 스캔
//        모든 주에서 + 평균인 (k,n) 중 평균 알파 최대 → OOS 1주에서 검증
//   4. TOP1 Alpha: 최근 30일 TOP1 vs TOP3 알파 (현재 timing + optimal timing)
// ============================================================================
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000;

async function fetchAll(table, select, filters = {}) {
  let all = [], from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    for (const [k, v] of Object.entries(filters)) {
      if (v.gte !== undefined) q = q.gte(k, v.gte);
      if (v.lte !== undefined) q = q.lte(k, v.lte);
    }
    const { data, error } = await q;
    if (error) throw error;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;

// Spearman rank correlation between two arrays
function spearman(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    sorted.forEach((s, idx) => { ranks[s.i] = idx + 1; });
    return ranks;
  };
  const rx = rank(x), ry = rank(y);
  const n = x.length;
  let d2sum = 0;
  for (let i = 0; i < n; i++) d2sum += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2sum) / (n * (n * n - 1));
}

// Get cumulative_return for rec at days_since (k=0 means D-day close)
function retFrom(pIdx, rid, k, n) {
  const m = pIdx.get(rid);
  if (!m) return null;
  if (k === 0) return m[n] != null ? m[n] : null;
  if (m[k] == null || m[n] == null) return null;
  return (1 + m[n] / 100) / (1 + m[k] / 100) * 100 - 100;
}

function weekStartOf(dateStr) {
  // returns Monday of the ISO week containing dateStr (YYYY-MM-DD)
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7; // Sun=0 → 7
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

// =============================================================================
// MAIN
// =============================================================================
async function runDiagnostic({ asOf = null, dryRun = false } = {}) {
  const today = asOf ? new Date(asOf) : new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const weekStart = weekStartOf(todayStr);

  // Pull last 90 days of recommendations + prices
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  console.log(`[weekly-diagnostic] asOf=${todayStr} weekStart=${weekStart} cutoff=${cutoffStr}`);

  const recs = await fetchAll('screening_recommendations',
    'id,recommendation_date,total_score,is_top3,vpd_raw,disparity,volume_ratio,change_rate,whale_detected,institution_buy_days,foreign_buy_days,recommendation_grade,market_cap,sector_name',
    { recommendation_date: { gte: cutoffStr, lte: todayStr } });

  const recIds = recs.map(r => r.id);
  // recommendation_daily_prices doesn't have recommendation_date — fetch by recommendation_id batch
  const allPrices = await fetchAll('recommendation_daily_prices',
    'recommendation_id,days_since_recommendation,cumulative_return');
  const recIdSet = new Set(recIds);
  const prices = allPrices.filter(p => recIdSet.has(p.recommendation_id));

  const pIdx = new Map();
  for (const p of prices) {
    if (!pIdx.has(p.recommendation_id)) pIdx.set(p.recommendation_id, {});
    pIdx.get(p.recommendation_id)[p.days_since_recommendation] = p.cumulative_return;
  }

  console.log(`[weekly-diagnostic] recs=${recs.length} prices=${prices.length}`);

  const warnings = [];

  // =========================================================================
  // 1. REGIME — last 30 days strong-signal T+3 mean
  // =========================================================================
  const last30Cutoff = new Date(today); last30Cutoff.setDate(last30Cutoff.getDate() - 30);
  const last30Str = last30Cutoff.toISOString().slice(0, 10);
  const recent = recs.filter(r => r.recommendation_date >= last30Str
    && r.vpd_raw != null && r.disparity != null && r.disparity >= 100);
  const strong = recent.filter(r => r.volume_ratio >= 3 && r.vpd_raw >= 2);
  const strongRets = strong.map(r => retFrom(pIdx, r.id, 0, 3)).filter(v => v != null);
  const strongAvg = mean(strongRets);

  let regime;
  if (strongAvg == null) { regime = 'unknown'; warnings.push('strong_signal sample=0'); }
  else if (strongAvg > 1.0) regime = 'momentum';
  else if (strongAvg < -1.0) regime = 'defense';
  else regime = 'sideways';

  if (strongRets.length < 10) warnings.push(`strong_signal n=${strongRets.length} (<10, low confidence)`);

  console.log(`[1. REGIME] ${regime} (strong T+3 avg=${strongAvg?.toFixed(2)}%, n=${strongRets.length})`);

  // =========================================================================
  // 2. SCORE HEALTH — score bucket × T+3 monotonicity (last 30 days)
  // =========================================================================
  const recent30All = recs.filter(r => r.recommendation_date >= last30Str);
  const buckets = [
    { lo: 45, hi: 55, mid: 50 },
    { lo: 55, hi: 65, mid: 60 },
    { lo: 65, hi: 75, mid: 70 },
    { lo: 75, hi: 200, mid: 80 },
  ];
  const bucketMids = [], bucketAvgs = [];
  for (const b of buckets) {
    const subset = recent30All.filter(r => (r.total_score||0) >= b.lo && (r.total_score||0) < b.hi);
    const rets = subset.map(r => retFrom(pIdx, r.id, 0, 3)).filter(v => v != null);
    if (rets.length >= 5) {
      bucketMids.push(b.mid);
      bucketAvgs.push(mean(rets));
    }
  }
  const scoreHealthR = bucketMids.length >= 3 ? spearman(bucketMids, bucketAvgs) : null;
  let scoreHealthLabel;
  if (scoreHealthR == null) { scoreHealthLabel = 'unknown'; warnings.push('score_health insufficient buckets'); }
  else if (scoreHealthR > 0.3) scoreHealthLabel = 'healthy';
  else if (scoreHealthR < -0.3) scoreHealthLabel = 'inverted';
  else scoreHealthLabel = 'broken';

  console.log(`[2. SCORE HEALTH] ${scoreHealthLabel} (r=${scoreHealthR?.toFixed(2)}, buckets=${bucketMids.length})`);

  // =========================================================================
  // 3. OPTIMAL TIMING — walk-forward (k,n) scan
  //    in-sample: weeks W-9 ~ W-2 (8 weeks)
  //    oos: week W-1 (last completed week)
  // =========================================================================
  // Build week → top3 ranked
  const top3Dates = [...new Set(recs.filter(r => r.is_top3).map(r => r.recommendation_date))].sort();
  const ranked = new Map();
  for (const d of top3Dates) {
    ranked.set(d, recs.filter(r => r.is_top3 && r.recommendation_date === d)
      .sort((a, b) => (b.total_score||0) - (a.total_score||0)));
  }
  const dateToWeek = (d) => weekStartOf(d);
  const weekDates = new Map(); // week → [dates]
  for (const d of top3Dates) {
    const w = dateToWeek(d);
    if (!weekDates.has(w)) weekDates.set(w, []);
    weekDates.get(w).push(d);
  }
  const allWeeks = [...weekDates.keys()].sort();
  const inSampleWeeks = allWeeks.filter(w => w < weekStart).slice(-8); // last 8 weeks before current
  const oosWeeks = allWeeks.filter(w => w < weekStart).slice(-1); // last completed week

  const ksRange = [0, 1, 2, 3];
  const nsRange = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  // For each (k,n), compute per-week TOP3 avg return
  function weekRet(weeksList, k, n, picker) {
    const weekAvgs = [];
    for (const w of weeksList) {
      const dts = weekDates.get(w) || [];
      const rets = [];
      for (const d of dts) {
        const arr = ranked.get(d) || [];
        for (const r of picker(arr)) {
          const v = retFrom(pIdx, r.id, k, n);
          if (v != null) rets.push(v);
        }
      }
      if (rets.length >= 3) weekAvgs.push({ week: w, avg: mean(rets), n: rets.length });
    }
    return weekAvgs;
  }

  // Find (k,n) where ALL in-sample weeks have positive avg, then rank by overall mean
  const candidates = [];
  for (const k of ksRange) for (const n of nsRange) {
    if (n <= k) continue;
    const wkAvgs = weekRet(inSampleWeeks, k, n, arr => arr.slice(0, 3));
    if (wkAvgs.length < Math.max(4, Math.floor(inSampleWeeks.length * 0.6))) continue;
    const allPositive = wkAvgs.every(w => w.avg > 0);
    if (!allPositive) continue;
    const overall = mean(wkAvgs.map(w => w.avg));
    const minWk = Math.min(...wkAvgs.map(w => w.avg));
    const totalN = wkAvgs.reduce((s, w) => s + w.n, 0);
    candidates.push({ k, n, overall, minWk, totalN, weeksMatched: wkAvgs.length });
  }
  candidates.sort((a, b) => b.minWk - a.minWk); // robust: maximize the worst week

  let optimalBuyD = null, optimalSellD = null, optimalAvg = null, optimalMin = null, optimalN = null;
  let oosTop1AlphaOptimal = null;

  if (candidates.length === 0) {
    warnings.push('no (k,n) all-positive in in-sample');
  } else {
    const best = candidates[0];
    optimalBuyD = best.k;
    optimalSellD = best.n;
    optimalAvg = best.overall;
    optimalMin = best.minWk;
    optimalN = best.totalN;

    // OOS validation
    const oosAvgs = weekRet(oosWeeks, best.k, best.n, arr => arr.slice(0, 3));
    if (oosAvgs.length) {
      console.log(`  OOS check: (D+${best.k}, D+${best.n}) → ${oosAvgs[0].avg.toFixed(2)}% (n=${oosAvgs[0].n})`);
    }
  }

  console.log(`[3. OPTIMAL TIMING] (D+${optimalBuyD}, D+${optimalSellD}) overall=${optimalAvg?.toFixed(2)}% minWk=${optimalMin?.toFixed(2)}% inSample=${inSampleWeeks.length}wk`);

  // =========================================================================
  // 4. TOP1 ALPHA — last 30 days TOP1 vs TOP3 (current vs optimal timing)
  // =========================================================================
  const recent30Dates = top3Dates.filter(d => d >= last30Str);
  function alphaAt(k, n) {
    const t1Rets = [], t3Rets = [];
    for (const d of recent30Dates) {
      const arr = ranked.get(d) || [];
      if (arr[0]) { const v = retFrom(pIdx, arr[0].id, k, n); if (v != null) t1Rets.push(v); }
      for (const r of arr.slice(0, 3)) {
        const v = retFrom(pIdx, r.id, k, n); if (v != null) t3Rets.push(v);
      }
    }
    if (t1Rets.length < 3 || t3Rets.length < 5) return null;
    return mean(t1Rets) - mean(t3Rets);
  }
  const top1AlphaCurrent = alphaAt(0, 3); // current default: D+0 매수 D+3 평가
  const top1AlphaOptimal = (optimalBuyD != null) ? alphaAt(optimalBuyD, optimalSellD) : null;

  console.log(`[4. TOP1 ALPHA] current(D+0,D+3)=${top1AlphaCurrent?.toFixed(2)}%p optimal(D+${optimalBuyD},D+${optimalSellD})=${top1AlphaOptimal?.toFixed(2)}%p`);

  // =========================================================================
  // 5. active_policy 비교 (Phase 2)
  // =========================================================================
  let activeBuyD = null, activeSellD = null;
  let recommendationDiffers = null, consecutiveSame = 0;
  try {
    const { data: ap } = await sb.from('active_policy').select('buy_offset_day,sell_offset_day').eq('id', 1).limit(1);
    if (ap && ap.length) {
      activeBuyD = ap[0].buy_offset_day;
      activeSellD = ap[0].sell_offset_day;
      if (optimalBuyD != null && optimalSellD != null) {
        recommendationDiffers = (optimalBuyD !== activeBuyD || optimalSellD !== activeSellD);
      }
    }
  } catch (e) {
    console.warn('[5. POLICY COMPARE] active_policy fetch skipped:', e.message);
  }

  // 같은 권고가 몇 주 연속인지 카운트 (직전 진단들 조회)
  if (optimalBuyD != null && optimalSellD != null) {
    try {
      const { data: prevDiags } = await sb.from('weekly_diagnostics')
        .select('week_start,optimal_buy_d,optimal_sell_d')
        .lt('week_start', weekStart)
        .order('week_start', { ascending: false })
        .limit(20);
      consecutiveSame = 1; // 이번 주 자체 포함
      for (const p of prevDiags || []) {
        if (p.optimal_buy_d === optimalBuyD && p.optimal_sell_d === optimalSellD) {
          consecutiveSame++;
        } else break; // 연속이 끊기면 종료
      }
    } catch (_) {}
  }

  console.log(`[5. POLICY COMPARE] active=(D+${activeBuyD},D+${activeSellD}) optimal=(D+${optimalBuyD},D+${optimalSellD}) differs=${recommendationDiffers} consecutive=${consecutiveSame}주`);

  // =========================================================================
  // 6. META-MONITOR — N주 전 권장의 후향 검증
  //    "4주 전 진단이 (k,n)을 권장 → 그 후 4주에 적용했다면 어땠을지" 가상 백테스트
  // =========================================================================
  const META_LOOKBACK = 4;
  let metaPastBuyD = null, metaPastSellD = null;
  let metaBacktestAvg = null, metaBacktestWin = null, metaBacktestN = null;
  let metaBaselineAvg = null, metaAlpha = null;

  try {
    // N주 전 진단의 권장 timing 조회
    const lookbackDate = new Date(today);
    lookbackDate.setDate(lookbackDate.getDate() - META_LOOKBACK * 7);
    const lookbackWeekStart = weekStartOf(lookbackDate.toISOString().slice(0, 10));

    const { data: pastDiag } = await sb.from('weekly_diagnostics')
      .select('week_start,optimal_buy_d,optimal_sell_d')
      .lte('week_start', lookbackWeekStart)
      .order('week_start', { ascending: false })
      .limit(1);
    const past = pastDiag?.[0];

    if (past && past.optimal_buy_d != null && past.optimal_sell_d != null) {
      metaPastBuyD = past.optimal_buy_d;
      metaPastSellD = past.optimal_sell_d;

      // 그 진단 이후 ~ 직전 주까지의 TOP3들을 (metaPastBuyD, metaPastSellD)으로 평가
      const evalStartDate = past.week_start;
      const evalEndDate = weekStart; // 이번 주 직전까지
      const evalDates = top3Dates.filter(d => d >= evalStartDate && d < evalEndDate);

      const recRets = [], baseRets = [];
      for (const d of evalDates) {
        const arr = ranked.get(d) || [];
        for (const r of arr.slice(0, 3)) {
          const recR = retFrom(pIdx, r.id, metaPastBuyD, metaPastSellD);
          const baseR = retFrom(pIdx, r.id, 0, 3); // baseline = 시스템 기본 (D+0매수 D+3매도)
          if (recR != null) recRets.push(recR);
          if (baseR != null) baseRets.push(baseR);
        }
      }
      if (recRets.length >= 5) {
        metaBacktestAvg = mean(recRets);
        metaBacktestWin = winR(recRets);
        metaBacktestN = recRets.length;
        if (baseRets.length >= 5) {
          metaBaselineAvg = mean(baseRets);
          metaAlpha = metaBacktestAvg - metaBaselineAvg;
        }
      } else {
        warnings.push(`meta-monitor: 표본 부족 (n=${recRets.length})`);
      }
    } else {
      warnings.push(`meta-monitor: ${META_LOOKBACK}주 전 진단 없음 (데이터 누적 필요)`);
    }
  } catch (e) {
    console.warn('[6. META] failed:', e.message);
  }

  console.log(`[6. META-MONITOR] ${META_LOOKBACK}주 전 권장(D+${metaPastBuyD},D+${metaPastSellD}): backtest=${metaBacktestAvg?.toFixed(2)}% baseline=${metaBaselineAvg?.toFixed(2)}% alpha=${metaAlpha?.toFixed(2)}%p (n=${metaBacktestN})`);

  // =========================================================================
  // INSERT into weekly_diagnostics
  // =========================================================================
  const row = {
    week_start: weekStart,
    regime,
    strong_signal_t3_avg: strongAvg,
    strong_signal_n: strongRets.length,
    score_health_corr: scoreHealthR,
    score_health_label: scoreHealthLabel,
    optimal_buy_d: optimalBuyD,
    optimal_sell_d: optimalSellD,
    optimal_avg_return: optimalAvg,
    optimal_min_return: optimalMin,
    optimal_sample_n: optimalN,
    top1_alpha_current_timing: top1AlphaCurrent,
    top1_alpha_optimal_timing: top1AlphaOptimal,
    in_sample_weeks: inSampleWeeks.length,
    oos_weeks: oosWeeks.length,
    total_recs_evaluated: recs.length,
    active_buy_offset_day: activeBuyD,
    active_sell_offset_day: activeSellD,
    recommendation_differs: recommendationDiffers,
    consecutive_same_recommendation: consecutiveSame,
    meta_lookback_weeks: META_LOOKBACK,
    meta_past_buy_d: metaPastBuyD,
    meta_past_sell_d: metaPastSellD,
    meta_backtest_avg_return: metaBacktestAvg,
    meta_backtest_win_rate: metaBacktestWin,
    meta_backtest_sample_n: metaBacktestN,
    meta_baseline_avg_return: metaBaselineAvg,
    meta_alpha_vs_baseline: metaAlpha,
    warnings: warnings.length ? warnings : null,
    raw_json: {
      bucketMids, bucketAvgs,
      candidatesTop5: candidates.slice(0, 5),
      inSampleWeeksList: inSampleWeeks,
      oosWeeksList: oosWeeks,
    },
  };

  if (dryRun) {
    console.log('\n[DRY RUN] would insert:');
    console.log(JSON.stringify({ ...row, raw_json: '...' }, null, 2));
    return row;
  }

  const { error } = await sb.from('weekly_diagnostics').upsert(row, { onConflict: 'week_start' });
  if (error) {
    console.error('[weekly-diagnostic] INSERT failed:', error);
    throw error;
  }
  console.log(`[weekly-diagnostic] saved row for week ${weekStart}`);

  // Phase 1-6: write OPERATING_STATE.md + append WEEKLY_DIAGNOSTICS.md
  // Vercel runtime은 read-only file system이므로 process.env.VERCEL=1일 때 skip
  if (!process.env.VERCEL) {
    try {
      writeOperatingState(row);
      appendWeeklyDiagnosticsLog(row);
      console.log('[weekly-diagnostic] OPERATING_STATE.md / WEEKLY_DIAGNOSTICS.md updated');
    } catch (e) {
      console.warn('[weekly-diagnostic] file write skipped:', e.message);
    }
  }

  return row;
}

// =============================================================================
// File generators (local-only, skipped on Vercel)
// =============================================================================
function writeOperatingState(row) {
  const repoRoot = path.resolve(__dirname, '..');
  const file = path.join(repoRoot, 'OPERATING_STATE.md');
  const regimeMap = { momentum:'🔴 모멘텀', sideways:'⚪ 횡보', defense:'🛡 방어', unknown:'❓ 미상' };
  const healthMap = { healthy:'✅ 양호', broken:'⚠️ 깨짐', inverted:'⛔ 역전', unknown:'❓ 미상' };
  const sign = (v, suffix='%') => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}${suffix}`;
  const md = `# Investar 운영 상태 (자동 생성)

> ⚠️ 이 파일은 매주 일요일 22:00 KST \`weekly-diagnostic\` cron에 의해 **덮어쓰기**됩니다.
> 수동 편집하지 마세요. CLAUDE.md(설계 문서)와 분리된 자동 운영 상태 파일입니다.

**최종 갱신**: ${row.week_start} (asOf 기준 주의 시작일)

---

## 현재 운영 파라미터

| 항목 | 값 |
|------|-----|
| **시장 레짐** | ${regimeMap[row.regime] || row.regime} |
| **권장 매수일** | D+${row.optimal_buy_d ?? '?'} 종가 |
| **권장 매도일** | D+${row.optimal_sell_d ?? '?'} 종가 |
| **점수 모델 건강도** | ${healthMap[row.score_health_label] || row.score_health_label} (r=${row.score_health_corr?.toFixed(2) ?? 'N/A'}) |
| **TOP1 알파 (현재 D+0,D+3)** | ${sign(row.top1_alpha_current_timing, '%p')} |
| **TOP1 알파 (권장 timing)** | ${sign(row.top1_alpha_optimal_timing, '%p')} |

## 진단 표본

- **강신호 종목 T+3 평균**: ${sign(row.strong_signal_t3_avg)} (n=${row.strong_signal_n})
- **권장 timing in-sample 평균**: ${sign(row.optimal_avg_return)}
- **권장 timing 최저주**: ${sign(row.optimal_min_return)}
- **in-sample 기간**: ${row.in_sample_weeks}주 / 표본 ${row.optimal_sample_n}건
- **평가 대상 추천 수**: ${row.total_recs_evaluated}

## 진단 신뢰도 (meta-monitor)

${row.meta_past_buy_d != null
  ? `- **${row.meta_lookback_weeks}주 전 권장**: D+${row.meta_past_buy_d} → D+${row.meta_past_sell_d}
- **가상 운영 평균**: ${sign(row.meta_backtest_avg_return)} (n=${row.meta_backtest_sample_n}, 승률 ${row.meta_backtest_win_rate?.toFixed(0) ?? '?'}%)
- **baseline 대비 알파**: ${sign(row.meta_alpha_vs_baseline, '%p')} ${
  row.meta_alpha_vs_baseline >= 1 ? '✅ 진단 효과 확인'
  : row.meta_alpha_vs_baseline >= 0 ? '⚪ baseline 동등'
  : '⚠️ baseline 미달'
}`
  : '- 데이터 누적 중 (4주 후부터 표시)'}

${row.warnings && row.warnings.length ? `## ⚠️ 경고\n\n${row.warnings.map(w => `- ${w}`).join('\n')}\n` : ''}

---

## Phase 1 상태

- **현재**: 관측 only. 룰/가중치 자동 변경 **없음**.
- **다음 단계**: Phase 2 (4주 데이터 누적 후) — \`active_policy\` 테이블 + timing 자동 조정
- **이력**: [WEEKLY_DIAGNOSTICS.md](./WEEKLY_DIAGNOSTICS.md)
`;
  fs.writeFileSync(file, md, 'utf8');
}

function appendWeeklyDiagnosticsLog(row) {
  const repoRoot = path.resolve(__dirname, '..');
  const file = path.join(repoRoot, 'WEEKLY_DIAGNOSTICS.md');
  const sign = (v, suffix='%') => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}${suffix}`;

  // 처음 호출이면 헤더 작성
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Investar 주간 진단 이력 (auto-append)

> 매주 일요일 22:00 KST cron에서 자동 추가. 최신 항목이 맨 위.

`, 'utf8');
  }

  // 기존 내용 읽고 새 항목을 헤더 뒤에 삽입
  const existing = fs.readFileSync(file, 'utf8');
  const headerEnd = existing.indexOf('\n---\n');
  const header = headerEnd >= 0 ? existing.slice(0, headerEnd + 5) : existing;
  const rest = headerEnd >= 0 ? existing.slice(headerEnd + 5) : '';

  // 같은 week_start가 이미 있으면 그 항목 제거 후 새로 삽입 (재실행 대응)
  const dupRe = new RegExp(`\\n## ${row.week_start}[\\s\\S]*?(?=\\n## |$)`, 'g');
  const restCleaned = rest.replace(dupRe, '');

  const entry = `\n## ${row.week_start}

| 항목 | 값 |
|------|-----|
| 레짐 | ${row.regime} |
| 강신호 T+3 평균 | ${sign(row.strong_signal_t3_avg)} (n=${row.strong_signal_n}) |
| 권장 timing | D+${row.optimal_buy_d ?? '?'} → D+${row.optimal_sell_d ?? '?'} |
| in-sample 평균 / 최저주 | ${sign(row.optimal_avg_return)} / ${sign(row.optimal_min_return)} |
| 점수 건강도 | ${row.score_health_label} (r=${row.score_health_corr?.toFixed(2) ?? 'N/A'}) |
| TOP1 알파 (현재 / 권장) | ${sign(row.top1_alpha_current_timing, '%p')} / ${sign(row.top1_alpha_optimal_timing, '%p')} |
${row.warnings?.length ? `| 경고 | ${row.warnings.join('; ')} |\n` : ''}
`;

  // 헤더가 없는 경우 헤더 추가
  let finalHeader = header;
  if (headerEnd < 0) {
    finalHeader = header + '\n---\n';
  }

  fs.writeFileSync(file, finalHeader + entry + restCleaned, 'utf8');
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry') opts.dryRun = true;
    if (args[i] === '--asOf') opts.asOf = args[++i];
  }
  runDiagnostic(opts)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runDiagnostic };
