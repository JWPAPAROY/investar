/**
 * 해외 지수 기반 한국 시장 당일 방향 예측 (v1.0)
 *
 * 전날 미국장 마감 데이터(S&P500, NASDAQ, VIX 등)를 기반으로
 * 가중 스코어를 계산하여 한국 시장 방향을 예측한다.
 *
 * 주요 함수:
 * - fetchAndPredict(): 메인 — 해외 데이터 수집 + 예측
 * - updateActualResult(date): 당일 실제 결과 업데이트 (장 마감 후)
 */

// yahoo-finance2 v2.x는 ESM 전용 — dynamic import 사용
let _yahooFinance = null;
async function getYahooFinance() {
  if (!_yahooFinance) {
    const mod = await import('yahoo-finance2');
    _yahooFinance = mod.default;
  }
  return _yahooFinance;
}

const supabase = require('./supabaseClient');

// ─── 기본 가중치 ───
const DEFAULT_WEIGHTS = {
  '^GSPC':     { name: 'S&P 500',    weight: +0.25 },
  '^IXIC':     { name: 'NASDAQ',     weight: +0.20 },
  '^SOX':      { name: 'SOX 반도체',  weight: +0.12 },
  '^VIX':      { name: 'VIX 공포',    weight: -0.10 },
  '^DJI':      { name: '다우존스',     weight: +0.08 },
  'USDKRW=X':  { name: '달러/원',     weight: -0.08 },
  '^TNX':      { name: '미국10년물',   weight: -0.07 },
  '^N225':     { name: '닛케이',      weight: +0.05 },
  'CL=F':      { name: 'WTI 원유',    weight: +0.03 },
  'DX-Y.NYB':  { name: '달러인덱스',   weight: -0.02 },
};

// ─── 신호 판정 테이블 ───
const SIGNAL_TABLE = [
  { min:  0.5, signal: 'strong_bullish', emoji: '🟢🟢', label: '강한 상승', guidance: '모멘텀 전략 적극 활용, 갭업 예상 구간' },
  { min:  0.2, signal: 'mild_bullish',   emoji: '🟢',   label: '약한 상승', guidance: '모멘텀 전략 유효, 분할 매수 구간' },
  { min: -0.2, signal: 'neutral',        emoji: '⚪',   label: '중립',     guidance: '방향 불명확, 관망 또는 소량 포지션' },
  { min: -0.5, signal: 'mild_bearish',   emoji: '🔴',   label: '약한 하락', guidance: '보수적 접근, 방어 전략 고려' },
  { min: -Infinity, signal: 'strong_bearish', emoji: '🔴🔴', label: '강한 하락', guidance: '방어 전략 중심, 갭다운 대비' },
];

/**
 * 2-1. yahoo-finance2로 해외 지수 데이터 수집
 * @returns {Object} { ticker: { name, change, price } }
 */
async function fetchOvernightData() {
  const tickers = Object.keys(DEFAULT_WEIGHTS);
  const results = {};

  // 병렬 호출 (5초 이내 완료 목표)
  const promises = tickers.map(async (ticker) => {
    try {
      const yf = await getYahooFinance();
      const quote = await yf.quote(ticker);
      return {
        ticker,
        change: quote.regularMarketChangePercent || 0,
        price: quote.regularMarketPrice || 0,
        previousClose: quote.regularMarketPreviousClose || 0,
      };
    } catch (err) {
      console.warn(`⚠️ ${ticker} 데이터 수집 실패: ${err.message}`);
      return { ticker, change: 0, price: 0, previousClose: 0 };
    }
  });

  const settled = await Promise.all(promises);
  for (const item of settled) {
    results[item.ticker] = item;
  }

  return results;
}

/**
 * 2-3. 예측 스코어 계산
 * score = Σ(변동률 × 가중치)
 */
function calculatePrediction(data, weights) {
  let score = 0;
  const factors = [];

  for (const [ticker, config] of Object.entries(weights)) {
    const d = data[ticker];
    if (!d) continue;

    const change = d.change;
    const w = config.weight;
    const contribution = change * w;
    score += contribution;

    factors.push({
      name: config.name,
      ticker,
      change: +change.toFixed(2),
      weight: w,
      contribution: +contribution.toFixed(4),
    });
  }

  // 기여도 절대값 내림차순 정렬
  factors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // 신호 판정
  const sig = SIGNAL_TABLE.find(s => score >= s.min);

  // VIX 스파이크 감지
  const vixData = data['^VIX'];
  let vixAlert = null;
  if (vixData && vixData.change >= 15) {
    vixAlert = `⚠️ VIX 급등 +${vixData.change.toFixed(1)}% → 변동성 확대 경고`;
  }

  // summary: 기여도 상위 2개 팩터 텍스트
  const top2 = factors.slice(0, 2);
  const summary = top2.map(f => {
    const sign = f.change >= 0 ? '+' : '';
    return `${f.name} ${sign}${f.change}%`;
  }).join(', ');

  const summaryText = vixAlert
    ? `${summary} | ${vixAlert}`
    : `${summary} → ${sig.label} 예상`;

  return {
    score: +score.toFixed(3),
    signal: sig.signal,
    emoji: sig.emoji,
    label: sig.label,
    summary: summaryText,
    vixAlert,
    factors,
    guidance: sig.guidance,
  };
}

/**
 * 2-6. Supabase에서 보정된 가중치 로드
 * 60일 미만이면 DEFAULT_WEIGHTS 사용
 * 60일 이상이면 상관계수 기반 가중치 재계산
 */
async function getActiveWeights() {
  if (!supabase) return { weights: DEFAULT_WEIGHTS, source: 'default' };

  try {
    const { data, error } = await supabase
      .from('overnight_predictions')
      .select('factors, kospi_open_change')
      .not('kospi_open_change', 'is', null)
      .order('prediction_date', { ascending: false })
      .limit(60);

    if (error || !data || data.length < 60) {
      return { weights: DEFAULT_WEIGHTS, source: 'default' };
    }

    // 각 팩터별 상관계수 계산
    const tickers = Object.keys(DEFAULT_WEIGHTS);
    const correlations = {};

    for (const ticker of tickers) {
      const pairs = [];
      for (const row of data) {
        if (!row.factors) continue;
        const factor = (row.factors || []).find(f => f.ticker === ticker);
        if (factor && row.kospi_open_change != null) {
          pairs.push({ x: factor.change, y: row.kospi_open_change });
        }
      }

      if (pairs.length < 30) {
        correlations[ticker] = null;
        continue;
      }

      // 피어슨 상관계수
      const n = pairs.length;
      const sumX = pairs.reduce((s, p) => s + p.x, 0);
      const sumY = pairs.reduce((s, p) => s + p.y, 0);
      const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
      const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
      const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);

      const num = n * sumXY - sumX * sumY;
      const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

      correlations[ticker] = den === 0 ? 0 : num / den;
    }

    // 상관계수 기반 가중치 재계산 (부호 보존, 절대값을 상관계수에 비례)
    const calibrated = {};
    let totalAbsCorr = 0;

    for (const ticker of tickers) {
      const corr = correlations[ticker];
      if (corr == null) {
        // 상관계수 계산 불가 → DEFAULT 유지
        calibrated[ticker] = { ...DEFAULT_WEIGHTS[ticker] };
        totalAbsCorr += Math.abs(DEFAULT_WEIGHTS[ticker].weight);
      } else {
        const originalSign = Math.sign(DEFAULT_WEIGHTS[ticker].weight);
        const absCorr = Math.abs(corr);
        calibrated[ticker] = {
          ...DEFAULT_WEIGHTS[ticker],
          weight: originalSign * absCorr,
        };
        totalAbsCorr += absCorr;
      }
    }

    // 합계 1.0으로 정규화
    if (totalAbsCorr > 0) {
      for (const ticker of tickers) {
        calibrated[ticker].weight = +(calibrated[ticker].weight / totalAbsCorr).toFixed(4);
      }
    }

    return { weights: calibrated, source: 'calibrated_60d' };
  } catch (err) {
    console.warn('⚠️ 가중치 보정 실패, 기본값 사용:', err.message);
    return { weights: DEFAULT_WEIGHTS, source: 'default' };
  }
}

/**
 * 2-7. 예측 결과 Supabase 저장 (upsert)
 */
async function savePrediction(prediction, weights, weightsSource) {
  if (!supabase) return;

  const today = getTodayKST();

  try {
    const { error } = await supabase
      .from('overnight_predictions')
      .upsert({
        prediction_date: today,
        score: prediction.score,
        signal: prediction.signal,
        factors: prediction.factors,
        weights: weights,
      }, {
        onConflict: 'prediction_date',
      });

    if (error) {
      console.warn('⚠️ 예측 저장 실패:', error.message);
    } else {
      console.log(`✅ 예측 저장 완료 (${today}): ${prediction.signal} (${prediction.score})`);
    }
  } catch (err) {
    console.warn('⚠️ 예측 저장 예외:', err.message);
  }
}

/**
 * 2-8. 실제 결과 업데이트 (16:10 KST save 모드에서 호출)
 * KOSPI/KOSDAQ 개장가·종가 변동률 기록 + hit 여부 판정
 */
async function updateActualResult(date) {
  if (!supabase) return;

  try {
    // 해당 날짜 예측 레코드 조회
    const { data: pred } = await supabase
      .from('overnight_predictions')
      .select('*')
      .eq('prediction_date', date)
      .single();

    if (!pred) {
      console.log(`📊 ${date} 예측 레코드 없음 — 업데이트 건너뜀`);
      return;
    }

    // KOSPI(^KS11), KOSDAQ(^KQ11) 데이터 가져오기
    let kospiChange = null, kosdaqChange = null;
    let kospiCloseChange = null, kosdaqCloseChange = null;

    const yf = await getYahooFinance();
    try {
      const kospiQuote = await yf.quote('^KS11');
      if (kospiQuote) {
        kospiChange = kospiQuote.regularMarketChangePercent || 0;
        // 시가 대비 변동률 = (시가 - 전일종가) / 전일종가 * 100
        if (kospiQuote.regularMarketOpen && kospiQuote.regularMarketPreviousClose) {
          const openChange = ((kospiQuote.regularMarketOpen - kospiQuote.regularMarketPreviousClose) / kospiQuote.regularMarketPreviousClose) * 100;
          kospiChange = +openChange.toFixed(3);
        }
        kospiCloseChange = +(kospiQuote.regularMarketChangePercent || 0).toFixed(3);
      }
    } catch (e) {
      console.warn('⚠️ KOSPI 데이터 수집 실패:', e.message);
    }

    try {
      const kosdaqQuote = await yf.quote('^KQ11');
      if (kosdaqQuote) {
        kosdaqChange = kosdaqQuote.regularMarketChangePercent || 0;
        if (kosdaqQuote.regularMarketOpen && kosdaqQuote.regularMarketPreviousClose) {
          const openChange = ((kosdaqQuote.regularMarketOpen - kosdaqQuote.regularMarketPreviousClose) / kosdaqQuote.regularMarketPreviousClose) * 100;
          kosdaqChange = +openChange.toFixed(3);
        }
        kosdaqCloseChange = +(kosdaqQuote.regularMarketChangePercent || 0).toFixed(3);
      }
    } catch (e) {
      console.warn('⚠️ KOSDAQ 데이터 수집 실패:', e.message);
    }

    // 실제 방향 판정 (KOSPI 종가 기준)
    let actualDirection = 'flat';
    if (kospiCloseChange > 0.2) actualDirection = 'up';
    else if (kospiCloseChange < -0.2) actualDirection = 'down';

    // hit 판정: 예측 방향과 실제 방향 일치
    let hit = false;
    const predSignal = pred.signal;
    if ((predSignal.includes('bullish') && actualDirection === 'up') ||
        (predSignal.includes('bearish') && actualDirection === 'down') ||
        (predSignal === 'neutral' && actualDirection === 'flat')) {
      hit = true;
    }

    const { error } = await supabase
      .from('overnight_predictions')
      .update({
        kospi_open_change: kospiChange,
        kospi_close_change: kospiCloseChange,
        kosdaq_open_change: kosdaqChange,
        kosdaq_close_change: kosdaqCloseChange,
        actual_direction: actualDirection,
        hit,
      })
      .eq('prediction_date', date);

    if (error) {
      console.warn('⚠️ 실제 결과 업데이트 실패:', error.message);
    } else {
      console.log(`✅ 실제 결과 업데이트 (${date}): ${actualDirection}, hit=${hit}`);
    }
  } catch (err) {
    console.warn('⚠️ 실제 결과 업데이트 예외:', err.message);
  }
}

/**
 * 누적 적중률 조회
 */
async function getAccuracy() {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('overnight_predictions')
      .select('hit')
      .not('hit', 'is', null);

    if (error || !data || data.length === 0) return null;

    const total = data.length;
    const hits = data.filter(d => d.hit === true).length;
    return {
      total,
      hits,
      rate: +(hits / total * 100).toFixed(1),
    };
  } catch (err) {
    return null;
  }
}

/**
 * 2-9. 메인 함수: 데이터 수집 + 예측 + 저장
 * 같은 날짜 캐시: Supabase에 이미 저장되어 있으면 읽기
 */
async function fetchAndPredict() {
  const today = getTodayKST();

  // 캐시 확인: 오늘 이미 예측 저장되어 있으면 읽기
  if (supabase) {
    try {
      const { data: existing } = await supabase
        .from('overnight_predictions')
        .select('*')
        .eq('prediction_date', today)
        .single();

      if (existing && existing.score != null) {
        console.log(`📊 오늘(${today}) 예측 캐시 사용: ${existing.signal} (${existing.score})`);

        // 신호 판정 재계산
        const sig = SIGNAL_TABLE.find(s => existing.score >= s.min);
        const accuracy = await getAccuracy();

        return {
          score: +existing.score,
          signal: existing.signal,
          emoji: sig.emoji,
          label: sig.label,
          summary: buildSummaryFromFactors(existing.factors, sig),
          vixAlert: detectVixAlertFromFactors(existing.factors),
          factors: existing.factors || [],
          guidance: sig.guidance,
          weightsSource: existing.weights ? 'calibrated_60d' : 'default',
          accuracy,
          timestamp: existing.created_at,
        };
      }
    } catch (e) {
      // 캐시 없음 — 새로 계산
    }
  }

  // 새 예측 계산
  const { weights, source } = await getActiveWeights();
  const data = await fetchOvernightData();
  const prediction = calculatePrediction(data, weights);

  // 저장
  await savePrediction(prediction, weights, source);

  // 적중률 조회
  const accuracy = await getAccuracy();

  return {
    ...prediction,
    weightsSource: source,
    accuracy,
    timestamp: new Date().toISOString(),
  };
}

// ─── 유틸리티 ───

function getTodayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function buildSummaryFromFactors(factors, sig) {
  if (!factors || factors.length === 0) return sig.label;
  const top2 = factors.slice(0, 2);
  const text = top2.map(f => {
    const sign = f.change >= 0 ? '+' : '';
    return `${f.name} ${sign}${f.change}%`;
  }).join(', ');
  return `${text} → ${sig.label} 예상`;
}

function detectVixAlertFromFactors(factors) {
  if (!factors) return null;
  const vix = factors.find(f => f.ticker === '^VIX');
  if (vix && vix.change >= 15) {
    return `⚠️ VIX 급등 +${vix.change.toFixed(1)}% → 변동성 확대 경고`;
  }
  return null;
}

module.exports = {
  fetchAndPredict,
  updateActualResult,
  fetchOvernightData,
  calculatePrediction,
  getActiveWeights,
  DEFAULT_WEIGHTS,
};
