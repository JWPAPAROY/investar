/**
 * 예측 스코어 분포 및 임계점 적절성 분석
 * 실행: node scripts/analyze-score-distribution.js
 */
require('dotenv').config();
const supabase = require('../backend/supabaseClient');

async function analyze() {
  if (!supabase) { console.error('Supabase 미설정'); return; }

  const { data, error } = await supabase
    .from('overnight_predictions')
    .select('prediction_date, score, signal, hit, kospi_close_change, expected_change, previous_kospi')
    .order('prediction_date', { ascending: true });

  if (error) { console.error('쿼리 실패:', error.message); return; }
  if (!data || data.length === 0) { console.log('데이터 없음'); return; }

  console.log(`\n=== 예측 스코어 분포 분석 (${data.length}건) ===\n`);

  // 1. 기본 통계
  const scores = data.map(d => +d.score);
  scores.sort((a, b) => a - b);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const std = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length);
  const median = scores[Math.floor(scores.length / 2)];
  const min = scores[0], max = scores[scores.length - 1];
  const p10 = scores[Math.floor(scores.length * 0.1)];
  const p25 = scores[Math.floor(scores.length * 0.25)];
  const p75 = scores[Math.floor(scores.length * 0.75)];
  const p90 = scores[Math.floor(scores.length * 0.9)];

  console.log('📊 스코어 기본 통계:');
  console.log(`  최솟값: ${min.toFixed(3)}`);
  console.log(`  P10:    ${p10.toFixed(3)}`);
  console.log(`  P25:    ${p25.toFixed(3)}`);
  console.log(`  중앙값: ${median.toFixed(3)}`);
  console.log(`  평균:   ${mean.toFixed(3)}`);
  console.log(`  P75:    ${p75.toFixed(3)}`);
  console.log(`  P90:    ${p90.toFixed(3)}`);
  console.log(`  최댓값: ${max.toFixed(3)}`);
  console.log(`  표준편차: ${std.toFixed(3)}`);

  // 2. 현재 임계점 기준 분류
  const CURRENT_THRESHOLDS = [
    { min: 0.75, label: '강한상승 🟢🟢' },
    { min: 0.15, label: '약한상승 🟢' },
    { min: -0.35, label: '중립 ⚪' },
    { min: -0.75, label: '약한하락 🔴' },
    { min: -Infinity, label: '강한하락 🔴🔴' },
  ];

  console.log('\n📊 현재 임계점 기준 신호 분포:');
  for (const th of CURRENT_THRESHOLDS) {
    const nextTh = CURRENT_THRESHOLDS[CURRENT_THRESHOLDS.indexOf(th) - 1];
    const upper = nextTh ? nextTh.min : Infinity;
    const count = scores.filter(s => s >= th.min && s < upper).length;
    const pct = (count / scores.length * 100).toFixed(1);

    // 해당 구간의 적중률
    const inRange = data.filter(d => +d.score >= th.min && +d.score < upper && d.hit != null);
    const hits = inRange.filter(d => d.hit === true).length;
    const hitRate = inRange.length > 0 ? (hits / inRange.length * 100).toFixed(1) : '-';

    console.log(`  ${th.label.padEnd(14)} (≥${th.min === -Infinity ? '-∞' : th.min.toFixed(2).padStart(6)}): ${count}건 (${pct}%) | 적중률: ${hitRate}% (${hits}/${inRange.length})`);
  }

  // 3. 표준편차 기준 제안 (데이터 분포 반영)
  const suggested = {
    strong_bullish: +(mean + 1.0 * std).toFixed(2),
    mild_bullish: +(mean + 0.3 * std).toFixed(2),
    mild_bearish: +(mean - 0.3 * std).toFixed(2),
    strong_bearish: +(mean - 1.0 * std).toFixed(2),
  };

  console.log('\n📐 표준편차 기반 제안 임계점:');
  console.log(`  강한상승: ≥ ${suggested.strong_bullish} (평균+1σ)`);
  console.log(`  약한상승: ≥ ${suggested.mild_bullish} (평균+0.3σ)`);
  console.log(`  중립:     ${suggested.mild_bearish} ~ ${suggested.mild_bullish}`);
  console.log(`  약한하락: ≥ ${suggested.strong_bearish} (평균-0.3σ 이하)`);
  console.log(`  강한하락: < ${suggested.strong_bearish} (평균-1σ)`);

  // 4. 제안 임계점 적용 시 분포
  const SUGGESTED_THRESHOLDS = [
    { min: suggested.strong_bullish, label: '강한상승 🟢🟢' },
    { min: suggested.mild_bullish, label: '약한상승 🟢' },
    { min: suggested.mild_bearish, label: '중립 ⚪' },
    { min: suggested.strong_bearish, label: '약한하락 🔴' },
    { min: -Infinity, label: '강한하락 🔴🔴' },
  ];

  console.log('\n📊 제안 임계점 적용 시 분포:');
  for (const th of SUGGESTED_THRESHOLDS) {
    const nextTh = SUGGESTED_THRESHOLDS[SUGGESTED_THRESHOLDS.indexOf(th) - 1];
    const upper = nextTh ? nextTh.min : Infinity;
    const count = scores.filter(s => s >= th.min && s < upper).length;
    const pct = (count / scores.length * 100).toFixed(1);

    const inRange = data.filter(d => +d.score >= th.min && +d.score < upper && d.hit != null);
    const hits = inRange.filter(d => d.hit === true).length;
    const hitRate = inRange.length > 0 ? (hits / inRange.length * 100).toFixed(1) : '-';

    console.log(`  ${th.label.padEnd(14)} (≥${th.min === -Infinity ? '-∞' : th.min.toFixed(2).padStart(6)}): ${count}건 (${pct}%) | 적중률: ${hitRate}% (${hits}/${inRange.length})`);
  }

  // 5. 스코어 히스토그램
  console.log('\n📊 스코어 히스토그램 (0.5 단위):');
  const bucketSize = 0.5;
  const bucketMin = Math.floor(min / bucketSize) * bucketSize;
  const bucketMax = Math.ceil(max / bucketSize) * bucketSize;
  for (let b = bucketMin; b < bucketMax; b += bucketSize) {
    const count = scores.filter(s => s >= b && s < b + bucketSize).length;
    const bar = '█'.repeat(count);
    const label = `${b >= 0 ? '+' : ''}${b.toFixed(1).padStart(5)} ~ ${(b + bucketSize) >= 0 ? '+' : ''}${(b + bucketSize).toFixed(1).padStart(5)}`;
    if (count > 0) console.log(`  ${label}: ${bar} (${count})`);
  }

  // 6. 회귀 파라미터 분석 — 밴드 폭 적절성
  console.log('\n📊 실제 KOSPI 변동률 분포:');
  const actualChanges = data.filter(d => d.kospi_close_change != null).map(d => +d.kospi_close_change);
  if (actualChanges.length > 0) {
    actualChanges.sort((a, b) => a - b);
    const acMean = actualChanges.reduce((s, v) => s + v, 0) / actualChanges.length;
    const acStd = Math.sqrt(actualChanges.reduce((s, v) => s + (v - acMean) ** 2, 0) / actualChanges.length);
    const acMin = actualChanges[0], acMax = actualChanges[actualChanges.length - 1];
    const acP10 = actualChanges[Math.floor(actualChanges.length * 0.1)];
    const acP90 = actualChanges[Math.floor(actualChanges.length * 0.9)];

    console.log(`  실제 KOSPI 변동률 (${actualChanges.length}건):`);
    console.log(`  최솟값: ${acMin.toFixed(2)}%`);
    console.log(`  P10:    ${acP10.toFixed(2)}%`);
    console.log(`  평균:   ${acMean.toFixed(2)}%`);
    console.log(`  P90:    ${acP90.toFixed(2)}%`);
    console.log(`  최댓값: ${acMax.toFixed(2)}%`);
    console.log(`  표준편차: ${acStd.toFixed(2)}%`);
    console.log(`  → 현재 밴드 σ가 이 실제 표준편차와 유사해야 적절합니다.`);
  }

  // 7. 현재 동적 회귀 파라미터 확인
  console.log('\n📊 최근 예측의 expected_change (회귀 파라미터):');
  const recent = data.filter(d => d.expected_change).slice(-5);
  for (const d of recent) {
    const ec = typeof d.expected_change === 'string' ? JSON.parse(d.expected_change) : d.expected_change;
    console.log(`  ${d.prediction_date}: slope=${ec.slope}, intercept=${ec.intercept}, σ=${ec.sigma}, range=${ec.min}%~${ec.max}%`);
  }
}

analyze().catch(console.error);
