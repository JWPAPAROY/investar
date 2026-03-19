/**
 * 종목별 유사 매칭 기대수익 엔진 (v3.66)
 *
 * 6차원 버킷 매칭: 점수구간/고래/기관매수일/시총/거래량비율/RSI
 * 점진적 완화: 6→5→4→3→2차원으로 차원을 줄여가며 최소 샘플 확보
 */

const supabase = require('./supabaseClient');

const MIN_SIMILAR_SAMPLES = 20;

// ─── 버킷 함수 ───

function getScoreBucket(score) {
  if (score >= 90) return '90+';
  if (score >= 75) return '75-89';
  if (score >= 60) return '60-74';
  if (score >= 45) return '45-59';
  return '30-44';
}

function getInstBucket(days) {
  if (days >= 3) return '3+';
  if (days >= 1) return '1-2';
  return '0';
}

function getCapBucket(cap) {
  if (cap >= 10000) return '1T+';
  if (cap >= 3000) return '3K-1T';
  return '<3K';
}

function getVolBucket(ratio) {
  if (ratio >= 3.0) return '3+';
  if (ratio >= 1.5) return '1.5-3';
  return '<1.5';
}

function getRsiBucket(rsi) {
  if (rsi >= 70) return '70+';
  if (rsi >= 50) return '50-70';
  if (rsi >= 30) return '30-50';
  return '<30';
}

function getBucketSignature(rec) {
  return {
    score: getScoreBucket(rec.total_score || rec.totalScore || 0),
    whale: !!(rec.whale_detected || rec.whaleDetected),
    inst: getInstBucket(rec.institution_buy_days || rec.institutionDays || 0),
    cap: getCapBucket(rec.market_cap || rec.marketCap || 0),
    vol: getVolBucket(rec.volume_ratio || rec.volumeRatio || 0),
    rsi: getRsiBucket(rec.rsi || 50),
  };
}

// ─── 유사 매칭 핵심 ───

function findSimilarReturns(targetSig, pool, pricesMap, minSamples = MIN_SIMILAR_SAMPLES) {
  const relaxLevels = [
    ['score', 'whale', 'inst', 'cap', 'vol', 'rsi'],
    ['score', 'whale', 'inst', 'cap', 'vol'],
    ['score', 'whale', 'inst', 'cap'],
    ['score', 'whale', 'inst'],
    ['score', 'whale'],
  ];

  for (const dims of relaxLevels) {
    const matchedIds = [];
    for (const rec of pool) {
      const sig = getBucketSignature(rec);
      let match = true;
      for (const d of dims) {
        if (sig[d] !== targetSig[d]) { match = false; break; }
      }
      if (match && pricesMap.has(rec.id)) matchedIds.push(rec.id);
    }

    if (matchedIds.length >= minSamples) {
      const dayGroups = {};
      for (const id of matchedIds) {
        const prices = pricesMap.get(id);
        if (!prices) continue;
        for (const p of prices) {
          if (p.cumulative_return == null) continue;
          const day = p.days_since_recommendation;
          if (!dayGroups[day]) dayGroups[day] = [];
          dayGroups[day].push(p.cumulative_return);
        }
      }

      let bestDay = null, bestMedian = -Infinity;
      for (let day = 1; day <= 15; day++) {
        const returns = dayGroups[day];
        if (!returns || returns.length < minSamples) continue;
        const sorted = [...returns].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        if (med > bestMedian) { bestMedian = med; bestDay = day; }
      }
      if (bestDay === null) continue;

      const returns = dayGroups[bestDay];
      const sorted = [...returns].sort((a, b) => a - b);
      const n = sorted.length;
      return {
        optimal_days: bestDay,
        p25: parseFloat(sorted[Math.floor(n * 0.25)].toFixed(2)),
        median: parseFloat(sorted[Math.floor(n * 0.5)].toFixed(2)),
        p75: parseFloat(sorted[Math.floor(n * 0.75)].toFixed(2)),
        win_rate: parseFloat((sorted.filter(r => r > 0).length / n * 100).toFixed(2)),
        sample_count: n,
        match_dimensions: dims.join(','),
        match_method: dims.length >= 5 ? 'similar_exact' : 'similar_relaxed',
      };
    }
  }
  return null;
}

// ─── 히스토리 풀 로드 (캐시) ───

let _poolCache = null;
let _poolCacheTime = 0;
const POOL_CACHE_TTL = 10 * 60 * 1000; // 10분

async function loadHistoricalPool() {
  const now = Date.now();
  if (_poolCache && (now - _poolCacheTime) < POOL_CACHE_TTL) {
    return _poolCache;
  }

  if (!supabase) return null;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  // 1. 과거 추천 종목 (90일)
  let allRecs = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('screening_recommendations')
      .select('id, total_score, whale_detected, institution_buy_days, market_cap, volume_ratio, rsi')
      .gte('recommendation_date', cutoffStr)
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    allRecs = allRecs.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // 2. 수익률 (days 1~15)
  let allPrices = [];
  from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('recommendation_daily_prices')
      .select('recommendation_id, days_since_recommendation, cumulative_return')
      .gte('days_since_recommendation', 1)
      .lte('days_since_recommendation', 15)
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    allPrices = allPrices.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const pricesMap = new Map();
  allPrices.forEach(p => {
    if (!pricesMap.has(p.recommendation_id)) pricesMap.set(p.recommendation_id, []);
    pricesMap.get(p.recommendation_id).push(p);
  });

  _poolCache = { recs: allRecs, pricesMap };
  _poolCacheTime = now;
  console.log(`📊 유사 매칭 풀 로드: ${allRecs.length}건 recs, ${allPrices.length}건 prices`);
  return _poolCache;
}

/**
 * 종목의 지표를 받아 실시간 유사 매칭 기대수익 산출
 * @param {Object} indicators - { totalScore, whaleDetected, institutionDays, marketCap, volumeRatio, rsi }
 * @returns {Object|null} { days, p25, median, p75, winRate, sampleCount, matchMethod, matchDimensions }
 */
async function computeSimilarExpectedReturn(indicators) {
  const pool = await loadHistoricalPool();
  if (!pool || pool.recs.length === 0) return null;

  const sig = getBucketSignature(indicators);
  const result = findSimilarReturns(sig, pool.recs, pool.pricesMap);
  if (!result) return null;

  return {
    days: result.optimal_days,
    p25: result.p25,
    median: result.median,
    p75: result.p75,
    winRate: result.win_rate,
    sampleCount: result.sample_count,
    matchMethod: result.match_method,
    matchDimensions: result.match_dimensions,
  };
}

module.exports = {
  getBucketSignature,
  findSimilarReturns,
  loadHistoricalPool,
  computeSimilarExpectedReturn,
  MIN_SIMILAR_SAMPLES,
};
