// ============================================================================
// weekly-diagnostic.js — Phase 1: 주간 진단 (관측 only, action 없음)
// 매주 일요일 22:00 KST 실행. 3가지 진단을 weekly_diagnostics 테이블에 INSERT.
// ============================================================================
// 진단 구성:
//   1. Score Health: 점수 구간 × active_policy timing 수익률 Spearman r. >0이면 정상
//   2. Optimal Timing: in-sample 8주에서 (k,n) 매트릭스 스캔
//        모든 주에서 + 평균인 (k,n) 중 평균 알파 최대 → OOS 1주에서 검증
//   3. TOP1 Alpha: 최근 30일 TOP1 vs TOP3 알파 (현재 timing + optimal timing)
// ============================================================================
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { resolveTop3Order, DB_ACCESSORS } = require('../backend/top3Ranking');

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
const winR = a => a.length ? (a.filter(v => v > 0).length / a.length * 100) : null;

// =============================================================================
// AI 진단 해석 생성 (Gemini)
// =============================================================================
async function generateDiagnosticAI(row, prevRows) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return '(AI 해석 생성 불가 — API 키 누락)';

  const sign = (v, suffix = '%') => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}${suffix}`;
  const healthDesc = {
    healthy:  `양호 — 스윗스팟 선호밴드(50-69 등)가 실제로 더 높은 수익을 내는 정상 상태 (ρ=${row.score_health_corr?.toFixed(2) ?? 'N/A'}, 기준: ρ>0.3)`,
    broken:   `약화 — 스윗스팟 선호순서와 실제 수익순서 사이 뚜렷한 상관이 없는 상태 (ρ=${row.score_health_corr?.toFixed(2) ?? 'N/A'}, 기준: -0.3~0.3). 시장 전환기나 표본 부족 시 일시적으로 나타날 수 있음`,
    inverted: `역전 — 스윗스팟 선호밴드가 오히려 더 낮은 수익을 내는 위험 상태 (ρ=${row.score_health_corr?.toFixed(2) ?? 'N/A'}, 기준: ρ<-0.3)`,
    unknown:  `판정 불가 — 표본 부족`,
  };

  // 이번 주 진단 요약
  let dataStr = `[이번 주 진단 (${row.week_start})]\n`;
  if (row.score_bucket_returns) {
    const buckets = row.score_bucket_returns.map(b => `${b.label}:${sign(b.avg)}`).join(' / ');
    dataStr += `- 점수 구간별 수익률: ${buckets}\n`;
  }
  dataStr += `- 점수 모델 건강도: ${healthDesc[row.score_health_label] || row.score_health_label}\n`;
  dataStr += `- 권장 timing: ${row.optimal_buy_d != null ? `D+${row.optimal_buy_d}매수 → D+${row.optimal_sell_d}매도` : '권장 조합 없음'}\n`;
  dataStr += `- 기대 수익(in-sample): ${sign(row.optimal_avg_return)} / 최저주: ${sign(row.optimal_min_return)}\n`;
  dataStr += `- 검증 수익(OOS): ${row.oos_avg_return != null ? sign(row.oos_avg_return) : '데이터 대기 중 (최신 timing의 미래 날짜 미도래)'}\n`;
  dataStr += `- TOP1 알파: ${sign(row.top1_alpha_optimal_timing, '%p')}\n`;
  dataStr += `- meta 알파 (${row.meta_lookback_weeks || 4}주 전 권장 후향 검증): ${sign(row.meta_alpha_vs_baseline, '%p')}\n`;
  dataStr += `- 현재 정책(자동 적용 후): D+${row.active_buy_offset_day ?? '?'}매수 → D+${row.active_sell_offset_day ?? '?'}매도\n`;
  if (row.warnings && row.warnings.length) dataStr += `- 경고: ${row.warnings.join(', ')}\n`;

  // 직전 3~4주 트렌드
  if (prevRows && prevRows.length > 0) {
    dataStr += `\n[직전 ${prevRows.length}주 트렌드 (최신 → 과거)]\n`;
    for (const p of prevRows) {
      dataStr += `  ${p.week_start}: 권장=D+${p.optimal_buy_d ?? '?'}→D+${p.optimal_sell_d ?? '?'} | OOS수익=${sign(p.oos_avg_return)} | 건강=${p.score_health_label} | TOP1α=${sign(p.top1_alpha_optimal_timing, '%p')} | metaα=${sign(p.meta_alpha_vs_baseline, '%p')}\n`;
    }
  }

  const prompt = `당신은 알고리즘 트레이딩 시스템의 운영 진단 전문가입니다.
아래 주간 진단 결과를 분석하여 시스템 운영 상태를 300자 내외로 종합 브리핑해주세요.

${dataStr}

[필수 분석 관점 — 자연스러운 하나의 단락으로 작성]
1. 시스템 건강: 점수 구간별 수익률 패턴이 정상적인지(고득점일수록 높은 수익), 상관계수(r) 기반 단조성 평가
2. 타이밍 유효성: 권장 timing의 기대 수익(in-sample)과 실제 검증 수익(OOS) 간의 괴리 여부 (OOS가 음수이거나 괴리가 크면 과적합 주의)
3. 종합 판단: Phase 3 자동 적용 시스템에 의해 현재 timing이 운영되고 있으므로, meta 알파 수치를 근거로 이 자동화 시스템이 잘 작동 중인지 평가

가벼운 경어체(해요/합니다)를 사용하고, 번호를 매기지 말고 자연스러운 브리핑 형태로 출력하세요. 군더더기 인사말은 생략하세요.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const models = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

  for (const modelName of models) {
    try {
      console.log(`[AI] 진단 해석 생성 시도 (${modelName})...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = (await result.response).text();
      if (!text) throw new Error('Empty AI response');
      console.log(`[AI] 진단 해석 생성 성공 (${modelName})`);
      return text.trim();
    } catch (err) {
      console.warn(`[AI] ${modelName} 실패:`, err.message);
      if (err.status === 429) {
        console.log('[AI] 429 감지, 12초 대기...');
        await new Promise(r => setTimeout(r, 12000));
      }
    }
  }

  // 모든 모델 실패 → 규칙 기반 fallback
  console.log('[AI] 모든 모델 실패 — 규칙 기반 fallback');
  return generateRuleFallback(row);
}

function generateRuleFallback(row) {
  const sign = (v) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  let brief = '';
  // 점수 건강
  if (row.score_health_label === 'healthy') brief += '점수 스윗스팟이 정상 작동 중입니다. ';
  else if (row.score_health_label === 'broken') brief += '점수 스윗스팟 선호와 실제 수익의 상관이 약해 주의가 필요합니다. ';
  else if (row.score_health_label === 'inverted') brief += '스윗스팟 역전 상태로, 선호밴드(50-69 등)가 오히려 손실을 내는 위험 상황입니다. ';
  // 검증 수익 (OOS)
  if (row.oos_avg_return != null) {
    brief += row.oos_avg_return >= 0
      ? `최근 1주 검증 수익이 ${sign(row.oos_avg_return)}로 양호합니다. `
      : `최근 1주 검증 수익이 ${sign(row.oos_avg_return)}로 다소 부진합니다. `;
  }
  // meta 알파
  if (row.meta_alpha_vs_baseline != null) {
    brief += row.meta_alpha_vs_baseline >= 0
      ? `meta 검증에서 baseline 대비 ${sign(row.meta_alpha_vs_baseline)} 양의 알파를 보이며 진단 신뢰도가 확인됩니다.`
      : `meta 검증에서 baseline 미달(${sign(row.meta_alpha_vs_baseline)})로 진단 예측력에 주의가 필요합니다.`;
  }
  return brief.trim();
}

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
  const last30Cutoff = new Date(today); last30Cutoff.setDate(last30Cutoff.getDate() - 30);
  const last30Str = last30Cutoff.toISOString().slice(0, 10);

  // =========================================================================
  // 0. active_policy 조기 읽기 (Score Health에서 사용)
  // =========================================================================
  let activeBuyD = null, activeSellD = null;
  let activePolicySetBy = null, activePolicySinceDate = null;
  try {
    const { data: ap } = await sb.from('active_policy').select('buy_offset_day,sell_offset_day,set_by,since_date').eq('id', 1).limit(1);
    if (ap && ap.length) {
      activeBuyD = ap[0].buy_offset_day;
      activeSellD = ap[0].sell_offset_day;
      activePolicySetBy = ap[0].set_by;
      activePolicySinceDate = ap[0].since_date;
    }
  } catch (e) {
    console.warn('[1.5. POLICY READ] skipped:', e.message);
  }
  // Score Health 측정 기준: active_policy timing, 없으면 D+0→D+3 fallback
  const healthK = activeBuyD ?? 0;
  const healthN = activeSellD ?? 3;

  // =========================================================================
  // 1. SCORE HEALTH — score bucket × 수익률 단조성 (last 30 days, active timing 기준)
  // =========================================================================
  const recent30All = recs.filter(r => r.recommendation_date >= last30Str);
  // v3.92: 스윗스팟-aware 건강도. 점수모델은 단조(높을수록 좋음)가 아니라 비단조 스윗스팟 설계라
  //   밴드 중간값↔수익 단조 Spearman은 부적합. TOP3 bandRank 의도 선호순서
  //   (50-59>60-69>80-89>90+>70-79>45-49)가 실제 수익순서와 맞는지(순위상관)로 측정.
  //   ρ>0 = 스윗스팟 작동(healthy), ρ<0 = 역전(inverted, 선호밴드가 오히려 손실).
  const srBandRank = (s) => {
    if (s >= 50 && s <= 59) return 1;
    if (s >= 60 && s <= 69) return 2;
    if (s >= 80 && s <= 89) return 3;
    if (s >= 90) return 4;
    if (s >= 70 && s <= 79) return 5;
    return 6; // 45-49
  };
  const bands = [
    { lo: 45, hi: 50, label: '45-49' },
    { lo: 50, hi: 60, label: '50-59' },
    { lo: 60, hi: 70, label: '60-69' },
    { lo: 70, hi: 80, label: '70-79' },
    { lo: 80, hi: 90, label: '80-89' },
    { lo: 90, hi: 200, label: '90+' },
  ];
  const ssGoodness = [], ssReturns = [];
  const monoRank = [], monoReturns = []; // v3.96: 단조축(점수 높을수록 좋은가)
  const scoreBucketReturns = [];
  for (const b of bands) {
    const subset = recent30All.filter(r => (r.total_score||0) >= b.lo && (r.total_score||0) < b.hi);
    const rets = subset.map(r => retFrom(pIdx, r.id, healthK, healthN)).filter(v => v != null);
    if (rets.length >= 3) {
      const avg = mean(rets);
      scoreBucketReturns.push({ label: b.label, avg: Math.round(avg * 100) / 100, n: rets.length });
      if (rets.length >= 5) {
        ssGoodness.push(7 - srBandRank(b.lo)); // 스윗스팟 선호도(클수록 선호)
        ssReturns.push(avg);
        monoRank.push(b.lo);   // 밴드 하한 = 점수 순서 그대로
        monoReturns.push(avg);
      }
    } else {
      scoreBucketReturns.push({ label: b.label, avg: null, n: rets.length });
    }
  }
  // v3.96: 건강도 판정을 **단조축**으로 바꾸고, 스윗스팟축은 설계 점검용으로 병기한다.
  //
  // 왜 (2026-08-25):
  //   ① 기존 판정축은 "스윗스팟 선호순서(50-59>60-69>80-89>90+>70-79>45-49)와 수익순서의 일치"였다.
  //      그런데 같은 날 scripts/score-validity.js가 평가가능 3,442건에서 확인한 실제 패턴은
  //      **단조**다(0~29 −6.93%/승률32% → 80~89 −1.50%/승률44%, 스피어만 +0.127).
  //      즉 점수가 데이터대로 단조롭게 작동하면 옛 지표는 오히려 inverted 경보를 울린다 — 부호가 반대인 계기판.
  //   ② 점 3~4개짜리 스피어만에 ±0.3 임계를 걸어 healthy/broken/inverted를 단언했다.
  //      실제 이력(17주)은 healthy(1.0)→broken(0)→inverted(−1.0)→healthy(1.0)로 주마다 널뛰었다.
  //      n=4에서 ρ=0.4는 아무것도 뜻하지 않는다. → 밴드 4개 미만이면 unknown, 5개 미만이면 weak 접미.
  //   ⚠️ 이 주 이전 행의 score_health_corr는 스윗스팟축 값이다. raw_json.scoreHealthBasis로 구분할 것.
  const MIN_BANDS = 4;
  const monoR = monoRank.length >= MIN_BANDS ? spearman(monoRank, monoReturns) : null;
  const sweetR = ssGoodness.length >= 3 ? spearman(ssGoodness, ssReturns) : null;
  const scoreHealthR = monoR;
  let scoreHealthLabel;
  if (scoreHealthR == null) {
    scoreHealthLabel = 'unknown';
    warnings.push(`score_health: 유효 밴드 ${monoRank.length}개(<${MIN_BANDS}) — 판정 보류`);
  } else {
    if (scoreHealthR > 0.3) scoreHealthLabel = 'healthy';
    else if (scoreHealthR < -0.3) scoreHealthLabel = 'inverted';
    else scoreHealthLabel = 'broken';
    if (monoRank.length < 5) {
      scoreHealthLabel += '_weak';
      warnings.push(`score_health: 밴드 ${monoRank.length}개짜리 상관 — 라벨은 참고용(주간 널뛰기 정상)`);
    }
  }
  // 설계 점검: 스윗스팟 선호순서가 실제 수익순서와 어긋나는지(설계 자체의 유효성)
  if (sweetR != null && monoR != null && sweetR < -0.3 && monoR > 0.3) {
    warnings.push(`스윗스팟 설계 경고: 단조 ρ=${monoR.toFixed(2)}인데 스윗스팟 ρ=${sweetR.toFixed(2)} — 밴드 선호순서(top3Ranking.bandRank)가 데이터와 반대`);
  }

  console.log(`[1. SCORE HEALTH] ${scoreHealthLabel} (단조 ρ=${monoR?.toFixed(2) ?? "n/a"}, 스윗스팟 ρ=${sweetR?.toFixed(2) ?? "n/a"}, timing=D+${healthK}→D+${healthN}, bands=${monoRank.length})`);

  // =========================================================================
  // 2. OPTIMAL TIMING — walk-forward (k,n) scan
  //    in-sample: weeks W-9 ~ W-2 (8 weeks)
  //    oos: week W-1 (last completed week)
  // =========================================================================
  // Build week → top3 ranked
  const top3Dates = [...new Set(recs.filter(r => r.is_top3).map(r => r.recommendation_date))].sort();
  const ranked = new Map();
  for (const d of top3Dates) {
    // v3.94: total_score 내림차순으로 순위를 재구성하고 있었으나 이는 실제 🥇와 다르다.
    //   실제 정렬은 v387(수급등급→기관매수일→스윗스팟)이고, 스윗스팟은 50-59를 90+보다
    //   선호하므로 점수 정렬과 순서가 뒤집힌다 — 실측 57%의 날에 TOP1이 불일치했고,
    //   TOP1 알파 진단이 존재한 적 없는 종목을 측정하고 있었다.
    //   resolveTop3Order: top3_rank(저장된 사실)가 있으면 그것을, 없으면 v387로 재구성.
    ranked.set(d, resolveTop3Order(
      recs.filter(r => r.is_top3 && r.recommendation_date === d), DB_ACCESSORS));
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

  // v3.95: 판정 기준을 절대 부호 → 현행 정책 대비 상대 비교로 전환.
  //   기존 posRatio(주별 수익>0 비율)는 하락 레짐에서 어떤 (k,n)도 70%를 넘길 수 없어
  //   quality가 항상 least_bad로 떨어졌다 — 즉 **보유기간 단축이 가장 필요한 국면에
  //   게이트가 구조적으로 잠겼다**(2026-05-05 이후 3개월간 자동변경 0회, 최근 5주
  //   posRatio 25/25/63/43/50%). 6월 3단 완화(b373409)는 "권고를 말하게" 만들었을 뿐
  //   적용 경로는 절대 기준 그대로여서 맹점의 절반만 고쳐진 상태였다.
  //   → 이제 "그 주에 현행 active_policy보다 나았는가"(edge>0)를 센다. 어느 레짐에서든
  //     의미가 유지되고, 하락장에선 "덜 잃는 쪽"이 정당하게 통과한다.
  //   베이스라인 = active_policy (k=activeBuyD, n=activeSellD). 없으면 절대 기준으로 폴백.
  const baselineWk = (activeBuyD != null && activeSellD != null && activeSellD > activeBuyD)
    ? new Map(weekRet(inSampleWeeks, activeBuyD, activeSellD, arr => arr.slice(0, 3)).map(w => [w.week, w.avg]))
    : null;
  if (!baselineWk || baselineWk.size === 0) {
    warnings.push('active_policy 베이스라인 주별 표본 부족 — 절대 기준(posRatio)으로 폴백');
  }
  // activeBuyD/SellD는 Phase 3 자동적용 시 새 값으로 재할당된다(아래). 판정에 쓴 베이스라인은
  // 그 시점 값이어야 하므로 여기서 스냅샷을 떠 둔다.
  const gateBaselineSnap = { buyD: activeBuyD, sellD: activeSellD, weeks: baselineWk ? baselineWk.size : 0 };

  // 모든 유효 (k,n)의 주별 성과 수집 (절대 posRatio + 베이스라인 대비 beatRatio 병기)
  const allCands = [];
  for (const k of ksRange) for (const n of nsRange) {
    if (n <= k) continue;
    const wkAvgs = weekRet(inSampleWeeks, k, n, arr => arr.slice(0, 3));
    if (wkAvgs.length < Math.max(4, Math.floor(inSampleWeeks.length * 0.6))) continue;
    const avgs = wkAvgs.map(w => w.avg);
    const posRatio = avgs.filter(a => a > 0).length / avgs.length;
    const overall = mean(avgs);
    const minWk = Math.min(...avgs);
    const totalN = wkAvgs.reduce((s, w) => s + w.n, 0);
    // 베이스라인과 공통으로 존재하는 주에서만 edge 산출 (주 집합이 후보마다 다를 수 있음)
    let beatRatio = null, overallEdge = null, minEdge = null, edgeWeeks = 0;
    if (baselineWk && baselineWk.size) {
      const edges = [];
      for (const w of wkAvgs) {
        const b = baselineWk.get(w.week);
        if (b != null) edges.push(w.avg - b);
      }
      if (edges.length >= Math.max(3, Math.floor(baselineWk.size * 0.6))) {
        beatRatio = edges.filter(e => e > 0).length / edges.length;
        overallEdge = mean(edges);
        minEdge = Math.min(...edges);
        edgeWeeks = edges.length;
      }
    }
    allCands.push({ k, n, overall, minWk, totalN, posRatio, beatRatio, overallEdge, minEdge, edgeWeeks,
      weeksMatched: wkAvgs.length, weeks: wkAvgs.map(w => w.week) });
  }

  // 점진적 완화(상대 기준): robust(전 주 현행보다 나음) → majority(≥70% 주) → least_bad.
  //   자동 policy 변경은 robust 즉시 / majority는 2주 연속(아래 Phase 3).
  //   현행 정책 자신은 edge가 전부 0이라 beatRatio 0 → 통과 못 함 = "현행이 최선이면 안 바뀜"이 자연히 성립.
  const POS_MAJORITY = 0.7;
  const relative = allCands.some(c => c.beatRatio != null);
  const gateOf = relative ? (c => c.beatRatio) : (c => c.posRatio);
  const scored = relative ? allCands.filter(c => c.beatRatio != null) : allCands;
  let optimalQuality = null;
  let pool = scored.filter(c => gateOf(c) === 1);               // tier1
  if (pool.length) optimalQuality = 'robust';
  else {
    pool = scored.filter(c => gateOf(c) >= POS_MAJORITY);       // tier2
    if (pool.length) optimalQuality = 'majority';
    else if (scored.length) { pool = scored.slice(); optimalQuality = 'least_bad'; } // tier3
  }
  // 최악의 주를 최대화 — 상대 기준에선 "가장 나빴던 주의 현행 대비 우위"를 최대화
  pool.sort(relative ? ((a, b) => b.minEdge - a.minEdge) : ((a, b) => b.minWk - a.minWk));
  const gateBasis = relative ? 'relative' : 'absolute';
  const candidates = pool; // raw_json/OOS/meta 하위호환

  let optimalBuyD = null, optimalSellD = null, optimalAvg = null, optimalMin = null, optimalN = null;
  let qualityBasisTxt = null; // v3.96: quality 경고 문구(적용/보류 확정 후 사용)
  let oosAvgReturn = null, oosSampleN = null;

  if (candidates.length === 0) {
    warnings.push('no (k,n) candidate (in-sample 데이터 부족)');
  } else {
    const best = candidates[0];
    optimalBuyD = best.k;
    optimalSellD = best.n;
    optimalAvg = best.overall;
    optimalMin = best.minWk;
    optimalN = best.totalN;
    // v3.96: 여기서 '자동적용 보류'를 무조건 적어 넣던 것이 **기록의 거짓말**이었다.
    //   이 경고는 quality!=='robust'면 항상 붙었는데, 실제 게이트는 majority+2주연속도
    //   통과시킨다(autoApplyEligible). 2026-08-23 D+1→D+2 자동변경이 바로 그 경우로,
    //   같은 진단 행에 '보류'라고 적힌 채 정책이 바뀌어 로그만 보면 알 수 없었다.
    //   → 문구는 여기서 만들고, **경고 문장은 Phase 3 결정 이후에 적는다**.
    if (optimalQuality !== 'robust') {
      qualityBasisTxt = gateBasis === 'relative'
        ? `현행 대비 우세 주 비율 ${Math.round(best.beatRatio * 100)}% (edge 평균 ${best.overallEdge?.toFixed(2)}%p, 최저주 ${best.minEdge?.toFixed(2)}%p)`
        : `전주 +비율 ${Math.round(best.posRatio * 100)}%`;
    }
    // v3.92: 최신 in-sample 주가 주별 표본<3으로 제외되면 권고가 과거 주에 동결됨을 명시
    //   (2026-07-06 발견: 6/28·7/5 진단 수치가 소수점까지 동일 — 최신 주 탈락으로 유효 주 집합 불변)
    const latestInSampleWk = inSampleWeeks[inSampleWeeks.length - 1];
    if (latestInSampleWk && best.weeks && !best.weeks.includes(latestInSampleWk)) {
      warnings.push(`최신 in-sample 주(${latestInSampleWk}) 표본<3으로 권고 산출에서 제외 — 권고가 최근 레짐 미반영일 수 있음`);
    }

    // OOS validation
    const oosAvgs = weekRet(oosWeeks, best.k, best.n, arr => arr.slice(0, 3));
    if (oosAvgs.length) {
      oosAvgReturn = oosAvgs[0].avg;
      oosSampleN = oosAvgs[0].n;
      console.log(`  OOS check: (D+${best.k}, D+${best.n}) → ${oosAvgReturn.toFixed(2)}% (n=${oosSampleN})`);
    }
  }

  const bestCand = candidates[0];
  console.log(`[2. OPTIMAL TIMING] (D+${optimalBuyD}, D+${optimalSellD}) quality=${optimalQuality} basis=${gateBasis}`
    + (gateBasis === 'relative' && bestCand
        ? ` beat=${Math.round(bestCand.beatRatio * 100)}%(vs D+${activeBuyD}→D+${activeSellD}) edge=${bestCand.overallEdge?.toFixed(2)}%p minEdge=${bestCand.minEdge?.toFixed(2)}%p`
        : '')
    + ` overall=${optimalAvg?.toFixed(2)}% minWk=${optimalMin?.toFixed(2)}% inSample=${inSampleWeeks.length}wk`);

  // =========================================================================
  // 3. TOP1 ALPHA — last 30 days TOP1 vs TOP3 (current vs optimal timing)
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
  // v3.94: (0,3) 하드코딩이었다. 컬럼명(top1_alpha_current_timing)과 텔레그램 라벨은
  //   "현재 정책"이라 말하는데 실제 active_policy는 D+1→D+10(2026-05-05~)이라 다른 값을
  //   현재 정책이라고 보고하고 있었다. Score Health는 이미 active_policy를 따르므로(healthK/N)
  //   같은 기준으로 통일. CLAUDE.md v3.89 "평가는 active_policy 지평으로 — D+3 평가 금지"와도 일치.
  const top1AlphaCurrent = alphaAt(healthK, healthN);
  const top1AlphaOptimal = (optimalBuyD != null) ? alphaAt(optimalBuyD, optimalSellD) : null;

  console.log(`[3. TOP1 ALPHA] current(D+${healthK},D+${healthN})=${top1AlphaCurrent?.toFixed(2)}%p optimal(D+${optimalBuyD},D+${optimalSellD})=${top1AlphaOptimal?.toFixed(2)}%p`);

  // =========================================================================
  // 4. active_policy 비교 + 자동 적용 (Phase 3)
  //    (activeBuyD, activeSellD는 step 0에서 이미 읽음)
  // =========================================================================
  let recommendationDiffers = null, consecutiveSame = 0;
  let policyAutoApplied = false;
  if (activeBuyD != null && activeSellD != null && optimalBuyD != null && optimalSellD != null) {
    recommendationDiffers = (optimalBuyD !== activeBuyD || optimalSellD !== activeSellD);
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

  // Phase 3: 자동 적용 — 권장이 현재 정책과 다르면 active_policy 갱신.
  //   역동성/휩쏘 균형: robust는 즉시, majority는 2주 연속 동일권고일 때만, least_bad는 권고만.
  //   v3.95: tier 판정 기준이 "주별 수익>0"에서 **"주별로 현행 정책보다 나았는가"**로 바뀌었다.
  //   하락장에서도 게이트가 열릴 수 있다 — 단 "덜 잃는 쪽"으로 여는 것이 이 변경의 의도다.
  const autoApplyEligible = optimalQuality === 'robust'
    || (optimalQuality === 'majority' && consecutiveSame >= 2);
  if (recommendationDiffers && optimalBuyD != null && optimalSellD != null && !autoApplyEligible) {
    const why = optimalQuality === 'majority' ? `majority지만 연속 ${consecutiveSame}주(<2)` : `quality=${optimalQuality}`;
    console.log(`[4. AUTO-APPLY] ⏸ 권고(D+${optimalBuyD}→D+${optimalSellD}) ${why} → 자동적용 보류(권고만 표시)`);
  } else if (recommendationDiffers && optimalBuyD != null && optimalSellD != null) {
    // v3.95 fix: --dry가 이 블록을 막지 않아 dry run이 실제 active_policy를 바꿀 수 있었다
    //   (dryRun 가드는 맨 아래 weekly_diagnostics insert에만 있었다).
    if (dryRun) {
      console.log(`[4. AUTO-APPLY] [DRY] 적용 조건 충족 — 실제라면 D+${activeBuyD}→D+${activeSellD} ⇒ D+${optimalBuyD}→D+${optimalSellD} (quality=${optimalQuality}, ${consecutiveSame}주 연속)`);
    } else
    // Idempotency: 이번 주 이미 auto-diagnostic이 적용했으면 스킵
    if (activePolicySetBy === 'auto-diagnostic' && activePolicySinceDate === weekStart) {
      console.log(`[4. AUTO-APPLY] ⏭ 이미 이번 주(${weekStart}) 자동 적용됨, 스킵`);
    } else
    try {
      const { error: updateErr } = await sb.from('active_policy')
        .update({
          buy_offset_day: optimalBuyD,
          sell_offset_day: optimalSellD,
          set_by: 'auto-diagnostic',
          change_reason: `주간진단(${weekStart}) 자동적용: D+${optimalBuyD}→D+${optimalSellD} (quality=${optimalQuality}, in-sample avg ${optimalAvg?.toFixed(2)}%, ${consecutiveSame}주 연속 권고)`,
          since_date: weekStart,
        })
        .eq('id', 1);

      if (!updateErr) {
        policyAutoApplied = true;
        // 변경 이력 저장
        await sb.from('active_policy_history').insert({
          buy_offset_day: optimalBuyD,
          sell_offset_day: optimalSellD,
          set_by: 'auto-diagnostic',
          change_reason: `주간진단(${weekStart}) 자동적용 (quality=${optimalQuality}, ${consecutiveSame}주 연속, in-sample avg ${optimalAvg?.toFixed(2)}%, min ${optimalMin?.toFixed(2)}%)`,
          prev_buy_offset_day: activeBuyD,
          prev_sell_offset_day: activeSellD,
        });
        console.log(`[4. AUTO-APPLY] ✅ 정책 자동 변경: D+${activeBuyD}→D+${activeSellD} ⇒ D+${optimalBuyD}→D+${optimalSellD}`);
        // 적용 후 상태 갱신
        activeBuyD = optimalBuyD;
        activeSellD = optimalSellD;
        recommendationDiffers = false;
      } else {
        console.warn('[4. AUTO-APPLY] ❌ 정책 변경 실패:', updateErr.message);
      }
    } catch (e) {
      console.warn('[4. AUTO-APPLY] ❌ 정책 변경 예외:', e.message);
    }
  }

  console.log(`[4. POLICY] active=(D+${activeBuyD},D+${activeSellD}) optimal=(D+${optimalBuyD},D+${optimalSellD}) differs=${recommendationDiffers} consecutive=${consecutiveSame}주 autoApplied=${policyAutoApplied}`);

  // v3.96: **실제로 일어난 일**을 그대로 적는다. 이 문장이 weekly_diagnostics.warnings에 남고
  //   OPERATING_STATE.md로 그대로 렌더된다.
  if (qualityBasisTxt) {
    if (policyAutoApplied) {
      warnings.push(`optimal timing quality=${optimalQuality} (${qualityBasisTxt}) — ${consecutiveSame}주 연속 동일 권고로 **자동적용됨** (D+${optimalBuyD}→D+${optimalSellD}, in-sample avg ${optimalAvg?.toFixed(2)}%, 최저주 ${optimalMin?.toFixed(2)}%)`);
    } else if (recommendationDiffers) {
      const why = optimalQuality === 'majority' ? `연속 ${consecutiveSame}주(<2)` : `quality=${optimalQuality}`;
      warnings.push(`optimal timing quality=${optimalQuality} (${qualityBasisTxt}) — ${why}로 자동적용 보류, 권고만`);
    } else {
      warnings.push(`optimal timing quality=${optimalQuality} (${qualityBasisTxt}) — 권고가 현행 정책과 동일, 변경 없음`);
    }
  }
  // 하락 레짐에서 상대 게이트는 "덜 잃는 쪽"으로도 열린다. 채택안이 음수면 그 사실을 명시.
  if (policyAutoApplied && optimalAvg != null && optimalAvg < 0) {
    warnings.push(`⚠️ 자동적용된 조합의 in-sample 평균이 음수(${optimalAvg.toFixed(2)}%) — 상대 게이트(v3.95)는 현행 대비 우열만 본다`);
  }

  // =========================================================================
  // 5. META-MONITOR — N주 전 권장의 후향 검증
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
    console.warn('[5. META] failed:', e.message);
  }

  console.log(`[5. META-MONITOR] ${META_LOOKBACK}주 전 권장(D+${metaPastBuyD},D+${metaPastSellD}): backtest=${metaBacktestAvg?.toFixed(2)}% baseline=${metaBaselineAvg?.toFixed(2)}% alpha=${metaAlpha?.toFixed(2)}%p (n=${metaBacktestN})`);

  // =========================================================================
  // INSERT into weekly_diagnostics
  // =========================================================================
  const row = {
    week_start: weekStart,
    // regime: v3.88에서 개념 폐기. DB 컬럼은 NOT NULL이라 sentinel로 채움
    // (코드 어디서도 읽지 않음 / 추후 DDL로 DROP NOT NULL 가능)
    regime: 'deprecated',
    score_health_corr: scoreHealthR,
    score_health_label: scoreHealthLabel,
    score_bucket_returns: scoreBucketReturns,
    optimal_buy_d: optimalBuyD,
    optimal_sell_d: optimalSellD,
    optimal_avg_return: optimalAvg,
    optimal_min_return: optimalMin,
    optimal_sample_n: optimalN,
    oos_avg_return: oosAvgReturn,
    oos_sample_n: oosSampleN,
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
      ssGoodness, ssReturns,
      scoreHealthBasis: 'monotone', // v3.96 이전 행은 'sweetspot'(기록 없음)
      monoRank, monoReturns, monoR, sweetR,
      scoreHealthBands: monoRank.length,
      optimalQuality,
      gateBasis,                                    // v3.95: 'relative'(현행 대비) | 'absolute'(폴백)
      gateBaseline: gateBasis === 'relative' ? gateBaselineSnap : null,
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

  // 먼저 진단 데이터를 저장 (AI 해석 없이)
  const { error } = await sb.from('weekly_diagnostics').upsert(row, { onConflict: 'week_start' });
  if (error) {
    console.error('[weekly-diagnostic] INSERT failed:', error);
    throw error;
  }
  console.log(`[weekly-diagnostic] saved row for week ${weekStart}`);

  // =========================================================================
  // 7. AI 진단 해석 생성 (Gemini) — DB 저장 후 별도 업데이트
  // =========================================================================
  try {
    let prevRows = [];
    try {
      const { data: prevData } = await sb.from('weekly_diagnostics')
        .select('week_start,score_health_label,optimal_buy_d,optimal_sell_d,top1_alpha_optimal_timing,meta_alpha_vs_baseline,oos_avg_return')
        .lt('week_start', weekStart)
        .order('week_start', { ascending: false })
        .limit(4);
      prevRows = prevData || [];
    } catch (_) {}
    const aiText = await generateDiagnosticAI(row, prevRows);
    if (aiText) {
      await sb.from('weekly_diagnostics')
        .update({ ai_interpretation: aiText })
        .eq('week_start', weekStart);
      row.ai_interpretation = aiText;
      console.log(`[7. AI] 해석 생성 + 업데이트 완료 (${aiText.length}자)`);
    }
  } catch (e) {
    console.warn('[7. AI] 해석 생성 실패 (진단 데이터는 이미 저장됨):', e.message);
  }

  // v3.96: 문서 렌더는 scripts/render-operating-state.js(= DB가 단일 출처)로 일원화.
  //   기존에는 여기서 직접 파일을 썼는데 이 블록이 `!process.env.VERCEL` 가드 안에 있었고
  //   실제 cron은 Vercel에서 돌아, 프로덕션에서는 **한 번도 갱신된 적이 없었다**
  //   (DB 17주치 vs 문서 6주치, 2026-06-15에 동결). 프로덕션 갱신은 이제
  //   .github/workflows/render-operating-state.yml 이 담당한다. 로컬 실행 시에는 즉시 반영.
  if (!process.env.VERCEL) {
    try {
      const { render } = require('./render-operating-state');
      await render();
      console.log('[weekly-diagnostic] OPERATING_STATE.md / WEEKLY_DIAGNOSTICS.md 렌더 완료');
    } catch (e) {
      console.warn('[weekly-diagnostic] 문서 렌더 건너뜀:', e.message);
    }
  }

  return row;
}

// (v3.96) 문서 생성기는 scripts/render-operating-state.js 로 이동했다.

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry') opts.dryRun = true;
    // `--asOf 2026-05-11`과 `--asOf=2026-05-11` 둘 다 허용(=형식이 조용히 무시돼
    //  과거 시점 실행이 전부 현재 시점으로 돌아가던 함정).
    if (args[i] === '--asOf') opts.asOf = args[++i];
    else if (args[i].startsWith('--asOf=')) opts.asOf = args[i].slice(7);
  }
  runDiagnostic(opts)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runDiagnostic };
