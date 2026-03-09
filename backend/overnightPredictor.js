/**
 * 해외 지수 기반 한국 시장 당일 방향 예측 (v1.1)
 *
 * 전날 미국장 마감 데이터(S&P500, NASDAQ, VIX 등)를 기반으로
 * 가중 스코어를 계산하여 한국 시장 방향을 예측한다.
 *
 * Yahoo Finance chart API (v8) 직접 호출 — API 키 불필요, Vercel 호환
 *
 * 주요 함수:
 * - fetchAndPredict(): 메인 — 해외 데이터 수집 + 예측
 * - updateActualResult(date): 당일 실제 결과 업데이트 (장 마감 후)
 */

const https = require('https');
const supabase = require('./supabaseClient');
const kisApi = require('./kisApi');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── 기본 가중치 (다중공선성 제거 후 12개) ───
// 제거됨: ^GSPC(ES=F와 중복), ^IXIC(NQ=F와 중복),
//         ^DJI(^GSPC와 r=0.84), DX-Y.NYB(USDKRW=X와 r=0.56),
//         ^KS200(한국장 시간대 지수)
// KOSPI200F: KIS API 경유 야간선물 — 한국시간 06:00까지 거래, 가장 최신 데이터
// EWY: iShares MSCI South Korea ETF — 미국 본장(~06:00 KST) 마감 기준, 보조 지표
const DEFAULT_WEIGHTS = {
  'KOSPI200F': { name: '코스피200선물', weight: +0.20, unit: 'pt', defaultCorr: null, source: 'KRX', sourceUrl: 'https://finance.naver.com/sise/sise_index.naver?code=KPI200' },
  'KOSDAQ150F': { name: '코스닥150선물', weight: 0, unit: 'pt', defaultCorr: null, source: 'KRX', sourceUrl: 'https://finance.naver.com/sise/sise_index.naver?code=KRX150' },
  'EWY': { name: '한국 ETF(EWY)', weight: 0, unit: '$', defaultCorr: null, source: 'NYSE', sourceUrl: 'https://finance.yahoo.com/quote/EWY' },
  '^SOX': { name: 'SOX 반도체', weight: +0.18, unit: 'pt', defaultCorr: +0.582, source: 'NASDAQ', sourceUrl: 'https://finance.yahoo.com/quote/%5ESOX' },
  'NQ=F': { name: '나스닥 선물', weight: +0.11, unit: 'pt', defaultCorr: +0.454, source: 'CME', sourceUrl: 'https://finance.yahoo.com/quote/NQ=F' },
  'CL=F': { name: 'WTI 원유', weight: -0.11, unit: '$/bbl', defaultCorr: -0.423, source: 'NYMEX', sourceUrl: 'https://finance.yahoo.com/quote/CL=F' },
  'ES=F': { name: 'S&P500 선물', weight: +0.10, unit: 'pt', defaultCorr: +0.418, source: 'CME', sourceUrl: 'https://finance.yahoo.com/quote/ES=F' },
  '^VIX': { name: 'VIX 공포', weight: -0.10, unit: '', defaultCorr: -0.416, source: 'CBOE', sourceUrl: 'https://finance.yahoo.com/quote/%5EVIX' },
  'GC=F': { name: '금 선물', weight: +0.08, unit: '$/oz', defaultCorr: +0.308, source: 'COMEX', sourceUrl: 'https://finance.yahoo.com/quote/GC=F' },
  'HG=F': { name: '구리 선물', weight: +0.07, unit: '$/lb', defaultCorr: +0.297, source: 'COMEX', sourceUrl: 'https://finance.yahoo.com/quote/HG=F' },
  'USDKRW=X': { name: '달러/원', weight: -0.04, unit: '원', defaultCorr: -0.150, source: 'FX', sourceUrl: 'https://finance.yahoo.com/quote/USDKRW=X' },
  '^N225': { name: '닛케이', weight: 0, unit: '¥', defaultCorr: +0.103, source: 'JPX', sourceUrl: 'https://finance.yahoo.com/quote/%5EN225' },
  '^TNX': { name: '미국10년물', weight: 0, unit: '%', defaultCorr: +0.036, source: 'CBOE', sourceUrl: 'https://finance.yahoo.com/quote/%5ETNX' },
};
// 가중치 절대값 합 = 0.99 (보정 시 자동 정규화)

// ─── AI 해석 실패 판별 ───
const AI_FAIL_MARKER = '[RULE_BASED]';
function isAiFailure(text) {
  if (!text) return true;
  if (text.startsWith(AI_FAIL_MARKER)) return true;
  // 레거시 DB 값 호환: "AI 해석을 생성할 수 없습니다" 등 구 오류 메시지
  if (text.length < 60 && (/실패|오류|생성할 수 없/.test(text))) return true;
  return false;
}

// ─── 회귀 기반 밴드 기본값 ───
// 34일 OLS 회귀: 실제 KOSPI% = 0.78 × score + 0.77, 잔차σ = 3.44%
const DEFAULT_REGRESSION = { slope: 0.78, intercept: 0.77, sigma: 3.44 };

// ─── 신호 판정 테이블 (39건 스코어 분포 기반, 2026-03-08 재조정) ───
// 스코어 분포: 평균 -0.32, σ=1.70, 범위 -4.39~+2.89
// 기존 ±0.75 → 강한등급에 64% 집중. σ 기반으로 균형 분포 재설정
const SIGNAL_TABLE = [
  { min: 1.4, signal: 'strong_bullish', emoji: '🟢🟢', label: '강한 상승', guidance: '모멘텀 전략 적극 활용, 갭업 예상 구간' },
  { min: 0.2, signal: 'mild_bullish', emoji: '🟢', label: '약한 상승', guidance: '모멘텀 전략 유효, 분할 매수 구간' },
  { min: -0.8, signal: 'neutral', emoji: '⚪', label: '중립', guidance: '방향 불명확, 관망 또는 소량 포지션' },
  { min: -2.0, signal: 'mild_bearish', emoji: '🔴', label: '약한 하락', guidance: '보수적 접근, 방어 전략 고려' },
  { min: -Infinity, signal: 'strong_bearish', emoji: '🔴🔴', label: '강한 하락', guidance: '방어 전략 중심, 갭다운 대비' },
];

/**
 * 회귀 기반 예측 변동폭 계산 (v2.0)
 * center = slope × score + intercept (OLS 회귀선)
 * 밴드: ±잔차σ (회귀선 기준 대칭)
 *
 * 기존 방식(score × beta)은 예측 방향으로 center가 과도하게 치우쳐
 * 밴드가 한쪽에만 넓어지는 문제가 있었음. 회귀 기반은 양의 절편(시장 상승 편향)을
 * 반영하여 양방향 균형 잡힌 밴드를 제공.
 */
function calcExpectedChange(score, regression) {
  const reg = regression || DEFAULT_REGRESSION;
  // 극단 스코어 감쇠: |score|>2 구간에서 sqrt 압축 (선형 외삽 과대 방지)
  let effectiveScore = score;
  if (Math.abs(score) > 2) {
    const sign = score > 0 ? 1 : -1;
    effectiveScore = sign * (2 + Math.sqrt(Math.abs(score) - 2));
  }
  const rawCenter = reg.slope * effectiveScore + reg.intercept;
  // center 클램핑: ±5% (일일 변동 현실 범위)
  const center = +Math.min(Math.max(rawCenter, -5.0), 5.0).toFixed(2);
  const band = reg.sigma;

  // 최종 변동률 클램핑: ±8% (서킷브레이커 수준)
  return {
    min: +Math.max(center - band, -8.0).toFixed(2),
    max: +Math.min(center + band, 8.0).toFixed(2),
    center,
    slope: +reg.slope.toFixed(3),
    intercept: +reg.intercept.toFixed(2),
    sigma: +band.toFixed(2)
  };
}

/**
 * Yahoo Finance chart API (v8) 직접 호출
 * API 키 불필요, Vercel 서버리스 호환
 */
function yahooQuote(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d`;
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) { reject(new Error('No chart result')); return; }

          const meta = result.meta || {};
          const closes = result.indicators?.quote?.[0]?.close || [];
          const opens = result.indicators?.quote?.[0]?.open || [];

          let dataDate = null;
          let dataTimestamp = null; // KST 기준 마감 시각 (ISO string)
          if (result.timestamp && result.timestamp.length > 0) {
            const unixTs = result.timestamp[result.timestamp.length - 1];
            const d = new Date(unixTs * 1000);
            dataDate = d.toISOString().slice(0, 10);
            // KST 변환 (UTC+9)
            const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
            dataTimestamp = kst.toISOString().replace('T', ' ').slice(0, 16); // "YYYY-MM-DD HH:mm"
          }

          // 최신 2일 데이터에서 변동률 계산
          if (closes.length >= 2) {
            const prevClose = closes[closes.length - 2];
            const currClose = closes[closes.length - 1];
            const currOpen = opens[opens.length - 1];
            if (prevClose && currClose) {
              const change = ((currClose - prevClose) / prevClose) * 100;
              resolve({
                price: currClose,
                previousClose: prevClose,
                chartPreviousClose: meta.chartPreviousClose || meta.previousClose || prevClose,
                open: currOpen || currClose,
                change: +change.toFixed(4),
                dataDate,
                dataTimestamp,
              });
              return;
            }
          }

          // fallback: meta 데이터
          const price = meta.regularMarketPrice || 0;
          const prevClose = meta.chartPreviousClose || meta.previousClose || 0;
          const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
          resolve({ price, previousClose: prevClose, open: price, change: +change.toFixed(4), dataDate, dataTimestamp });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * 팩터별 60일 변동성 조회 (z-score 정규화용)
 * @returns {Object} { ticker: { mean, std } }
 */
async function getFactorVolatility() {
  if (!supabase) return {};
  try {
    const { data, error } = await supabase
      .from('overnight_predictions')
      .select('factors')
      .not('factors', 'is', null)
      .order('prediction_date', { ascending: false })
      .limit(60);

    if (error || !data || data.length < 10) return {};

    const stats = {};
    const tickers = Object.keys(DEFAULT_WEIGHTS);
    for (const ticker of tickers) {
      const changes = [];
      for (const row of data) {
        const f = (row.factors || []).find(f => f.ticker === ticker);
        if (f && f.change != null && f.change !== 0) changes.push(f.change);
      }
      if (changes.length >= 10) {
        const mean = changes.reduce((s, v) => s + v, 0) / changes.length;
        const std = Math.sqrt(changes.reduce((s, v) => s + (v - mean) ** 2, 0) / changes.length);
        stats[ticker] = { mean, std: std || 1 }; // std=0 방지
      }
    }
    console.log(`📊 팩터 변동성: ${Object.keys(stats).length}개 팩터 z-score 준비 (${data.length}일)`);
    return stats;
  } catch (err) {
    console.warn('⚠️ 팩터 변동성 조회 실패:', err.message);
    return {};
  }
}

/**
 * 해외 지수 데이터 수집 (병렬 호출)
 * @returns {Object} { ticker: { ticker, change, price, previousClose } }
 */
async function fetchOvernightData() {
  const tickers = Object.keys(DEFAULT_WEIGHTS);
  const results = {};

  // Yahoo Finance 지표 (KIS API 조회 대상 제외)
  const kisTickers = ['KOSPI200F', 'KOSDAQ150F'];
  const yahooTickers = tickers.filter(t => !kisTickers.includes(t));
  const promises = yahooTickers.map(async (ticker) => {
    try {
      const quote = await yahooQuote(ticker);
      return { ticker, ...quote };
    } catch (err) {
      console.warn(`⚠️ ${ticker} 데이터 수집 실패: ${err.message}`);
      return { ticker, change: 0, price: 0, previousClose: 0, failed: true };
    }
  });

  // KIS API 선물 조회 (KOSPI200F, KOSDAQ150F)
  const kisFuturesPromise = (async () => {
    const todayKST = getTodayKST();
    const futuresResults = [];

    // KOSPI200F
    try {
      const futures = await kisApi.getKospi200FuturesPrice();
      if (futures) {
        futuresResults.push({
          ticker: 'KOSPI200F',
          price: futures.price,
          previousClose: futures.previousClose,
          change: futures.change,
          dataDate: todayKST,
          dataTimestamp: `${todayKST} 06:00`,
        });
      } else {
        console.warn('⚠️ KOSPI200F 데이터 null — 기본값 사용');
        futuresResults.push({ ticker: 'KOSPI200F', change: 0, price: 0, previousClose: 0, failed: true });
      }
    } catch (err) {
      console.warn(`⚠️ KOSPI200F 데이터 수집 실패: ${err.message}`);
      futuresResults.push({ ticker: 'KOSPI200F', change: 0, price: 0, previousClose: 0, failed: true });
    }

    // KOSDAQ150F
    try {
      const futures = await kisApi.getKosdaq150FuturesPrice();
      if (futures) {
        futuresResults.push({
          ticker: 'KOSDAQ150F',
          price: futures.price,
          previousClose: futures.previousClose,
          change: futures.change,
          dataDate: todayKST,
          dataTimestamp: `${todayKST} 06:00`,
        });
      } else {
        console.warn('⚠️ KOSDAQ150F 데이터 null — 기본값 사용');
        futuresResults.push({ ticker: 'KOSDAQ150F', change: 0, price: 0, previousClose: 0, failed: true });
      }
    } catch (err) {
      console.warn(`⚠️ KOSDAQ150F 데이터 수집 실패: ${err.message}`);
      futuresResults.push({ ticker: 'KOSDAQ150F', change: 0, price: 0, previousClose: 0, failed: true });
    }

    return futuresResults;
  })();

  // 병렬 실행
  const [yahooResults, kisResults] = await Promise.all([
    Promise.all(promises),
    kisFuturesPromise
  ]);

  for (const item of yahooResults) {
    results[item.ticker] = item;
  }
  for (const item of kisResults) {
    results[item.ticker] = item;
  }

  return results;
}

/**
 * 2-3. 예측 스코어 계산
 * z-score 정규화: 각 팩터 변동률을 자체 60일 변동성 대비 표준화
 * → VIX ±15%(일상) vs S&P ±2%(이례) 공정 비교
 *
 * @param {Object} factorVol - { ticker: { mean, std } } 팩터별 변동성 (없으면 raw 사용)
 */
function calculatePrediction(data, weights, correlations, factorVol = {}) {
  let score = 0;
  const factors = [];
  let validCount = 0;
  let failedCount = 0;
  const totalActive = Object.values(weights).filter(c => c.weight !== 0).length;

  for (const [ticker, config] of Object.entries(weights)) {
    const d = data[ticker];
    if (!d) continue;

    const change = d.change;
    const w = config.weight;
    const isFailed = d.failed || (change === 0 && d.price === 0);

    // z-score 정규화: 변동성 데이터가 있으면 적용
    let effectiveChange = change;
    let zScore = null;
    if (factorVol[ticker] && factorVol[ticker].std > 0 && !isFailed) {
      const vol = factorVol[ticker];
      zScore = (change - vol.mean) / vol.std;
      effectiveChange = zScore; // z-score 기반 기여도
    }

    const contribution = effectiveChange * w;
    score += contribution;

    if (w !== 0 && !isFailed) validCount++;
    if (isFailed) failedCount++;

    factors.push({
      name: config.name,
      ticker,
      change: +change.toFixed(2),
      weight: w,
      contribution: +contribution.toFixed(4),
      zScore: zScore != null ? +zScore.toFixed(2) : null,
      price: d.price ? +d.price.toFixed(2) : null,
      previousClose: d.previousClose ? +d.previousClose.toFixed(2) : null,
      unit: config.unit || '',
      dataDate: d.dataDate || null,
      dataTimestamp: d.dataTimestamp || null,
      corr: correlations && correlations[ticker] != null
        ? +correlations[ticker].toFixed(3)
        : (config.defaultCorr != null ? config.defaultCorr : null),
      source: config.source || null,
      sourceUrl: config.sourceUrl || null,
    });
  }

  // 기여도 절대값 내림차순 정렬
  factors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  // 신호 판정
  const sig = SIGNAL_TABLE.find(s => score >= s.min);

  // 팩터 신뢰도: 유효 팩터 비율
  const reliability = totalActive > 0 ? +(validCount / totalActive * 100).toFixed(0) : 0;
  const hasZScore = Object.keys(factorVol).length > 0;

  return {
    score: +score.toFixed(3),
    signal: sig.signal,
    emoji: sig.emoji,
    label: sig.label,
    summary: buildSummaryFromFactors(factors, sig),
    vixAlert: detectVixAlertFromFactors(factors),
    factors,
    guidance: sig.guidance,
    expectedChange: calcExpectedChange(score), // 기본값, fetchAndPredict에서 동적 보정으로 덮어씀
    reliability, // 팩터 신뢰도 (0-100%)
    validFactors: validCount,
    failedFactors: failedCount,
    scoreMethod: hasZScore ? 'z-score' : 'raw',
  };
}

/**
 * 2-6. Supabase에서 보정된 가중치 로드
 * 60일 미만이면 DEFAULT_WEIGHTS 사용
 * 60일 이상이면 상관계수 기반 가중치 재계산
 */
async function getActiveWeights() {
  if (!supabase) return { weights: DEFAULT_WEIGHTS, source: 'default', correlations: {} };

  try {
    const { data, error } = await supabase
      .from('overnight_predictions')
      .select('factors, kospi_open_change')
      .not('kospi_open_change', 'is', null)
      .order('prediction_date', { ascending: false })
      .limit(60);

    if (error || !data || data.length < 30) {
      return { weights: DEFAULT_WEIGHTS, source: 'default', correlations: {} };
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
        const isReferenceOnly = DEFAULT_WEIGHTS[ticker].weight === 0;

        const absCorr = Math.abs(corr);
        calibrated[ticker] = {
          ...DEFAULT_WEIGHTS[ticker],
          weight: isReferenceOnly ? 0 : originalSign * absCorr,
        };

        if (!isReferenceOnly) {
          totalAbsCorr += absCorr;
        }
      }
    }

    // 합계 1.0으로 정규화
    if (totalAbsCorr > 0) {
      for (const ticker of tickers) {
        calibrated[ticker].weight = +(calibrated[ticker].weight / totalAbsCorr).toFixed(4);
      }
    }

    return { weights: calibrated, source: 'calibrated', correlations };
  } catch (err) {
    console.warn('⚠️ 가중치 보정 실패, 기본값 사용:', err.message);
    return { weights: DEFAULT_WEIGHTS, source: 'default', correlations: {} };
  }
}

/**
 * 회귀 파라미터 동적 보정 (v2.0)
 * score → kospi_close_change OLS 회귀로 slope, intercept, 잔차σ 계산
 * 20일 미만이면 DEFAULT_REGRESSION 사용
 * 20일 이상이면 EWMA(λ=0.94) 가중 회귀로 최근 데이터 우선 반영
 */
async function getRegressionParams() {
  if (!supabase) return { ...DEFAULT_REGRESSION, source: 'default' };

  try {
    const { data, error } = await supabase
      .from('overnight_predictions')
      .select('score, kospi_close_change')
      .not('kospi_close_change', 'is', null)
      .not('score', 'is', null)
      .order('prediction_date', { ascending: false })
      .limit(60);

    if (error || !data || data.length < 20) {
      return { ...DEFAULT_REGRESSION, source: 'default', n: data?.length || 0 };
    }

    const n = data.length;
    const lambda = 0.94;

    // EWMA 가중치 (data[0]=최신)
    const w = data.map((_, i) => Math.pow(lambda, i));
    const sumW = w.reduce((a, b) => a + b, 0);

    // 가중 평균
    let meanX = 0, meanY = 0;
    for (let i = 0; i < n; i++) {
      meanX += w[i] * data[i].score;
      meanY += w[i] * data[i].kospi_close_change;
    }
    meanX /= sumW;
    meanY /= sumW;

    // 가중 회귀 (slope, intercept)
    let ssXY = 0, ssXX = 0;
    for (let i = 0; i < n; i++) {
      const dx = data[i].score - meanX;
      const dy = data[i].kospi_close_change - meanY;
      ssXY += w[i] * dx * dy;
      ssXX += w[i] * dx * dx;
    }

    if (ssXX === 0) {
      return { ...DEFAULT_REGRESSION, source: 'default', n };
    }

    const slope = ssXY / ssXX;
    const intercept = meanY - slope * meanX;

    // 잔차 σ (가중)
    let ssResid = 0;
    for (let i = 0; i < n; i++) {
      const predicted = slope * data[i].score + intercept;
      const resid = data[i].kospi_close_change - predicted;
      ssResid += w[i] * resid * resid;
    }
    const sigma = Math.sqrt(ssResid / sumW);

    // 클램핑: slope [0.1, 2.0], intercept [-3, 3], sigma [1.5, 4.0]
    // sigma 4.0%: 실제 KOSPI 일일 σ=3.67% 기반 상한
    const result = {
      slope: +Math.min(Math.max(slope, 0.1), 2.0).toFixed(3),
      intercept: +Math.min(Math.max(intercept, -3), 3).toFixed(2),
      sigma: +Math.min(Math.max(sigma, 1.5), 4.0).toFixed(2),
      source: 'ewma_regression',
      n,
    };

    console.log(`📊 회귀 보정: y = ${result.slope}×score + ${result.intercept}, σ=${result.sigma}% (λ=0.94, N=${n})`);
    return result;
  } catch (err) {
    console.warn('⚠️ 회귀 보정 실패, 기본값 사용:', err.message);
    return { ...DEFAULT_REGRESSION, source: 'default' };
  }
}

/**
 * 2-7. 예측 결과 Supabase 저장 (upsert)
 */
async function savePrediction(prediction, weights, weightsSource, previousKospi, regression, expChg, aiInterpretation, previousKospiDate, usMarketDate) {
  if (!supabase) return;

  const today = getTodayKST();

  // 주말/공휴일 날짜로 저장 방지
  const [sy, sm, sd] = today.split('-').map(Number);
  const saveDay = new Date(Date.UTC(sy, sm - 1, sd)).getUTCDay();
  if (saveDay === 0 || saveDay === 6) {
    console.log(`📅 주말(${today}) — 예측 저장 건너뜀`);
    return;
  }

  try {
    const { error } = await supabase
      .from('overnight_predictions')
      .upsert({
        prediction_date: today,
        score: prediction.score,
        signal: prediction.signal,
        factors: prediction.factors,
        weights: weights,
        weights_source: weightsSource,
        previous_kospi: previousKospi,
        kospi_beta: regression?.slope || null,
        ai_interpretation: aiInterpretation,
        expected_change: expChg,
        previous_kospi_date: previousKospiDate,
        us_market_date: usMarketDate,
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
      console.log(`📊 ${date} 예측 레코드 없음 — 업데이트 건너뜜`);
      return;
    }

    // KOSPI(^KS11), KOSDAQ(^KQ11) 데이터 가져오기
    let kospiChange = null, kosdaqChange = null;
    let kospiCloseChange = null, kosdaqCloseChange = null;
    let kospiClosePrice = null, kosdaqClosePrice = null;

    try {
      const kospiQuote = await yahooQuote('^KS11');
      if (kospiQuote.previousClose) {
        kospiChange = +((kospiQuote.open - kospiQuote.previousClose) / kospiQuote.previousClose * 100).toFixed(3);
        kospiCloseChange = +kospiQuote.change.toFixed(3);
        kospiClosePrice = +kospiQuote.price.toFixed(2);
      }
    } catch (e) {
      console.warn('⚠️ KOSPI 데이터 수집 실패:', e.message);
    }

    try {
      const kosdaqQuote = await yahooQuote('^KQ11');
      if (kosdaqQuote.previousClose) {
        kosdaqChange = +((kosdaqQuote.open - kosdaqQuote.previousClose) / kosdaqQuote.previousClose * 100).toFixed(3);
        kosdaqCloseChange = +kosdaqQuote.change.toFixed(3);
        kosdaqClosePrice = +kosdaqQuote.price.toFixed(2);
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

    const updatePayload = {
      kospi_open_change: kospiChange,
      kospi_close_change: kospiCloseChange,
      kosdaq_open_change: kosdaqChange,
      kosdaq_close_change: kosdaqCloseChange,
      actual_direction: actualDirection,
      hit,
    };

    // kospi_close/kosdaq_close 컬럼이 있으면 저장 (신규 컬럼, 없을 수 있음)
    let { error } = await supabase
      .from('overnight_predictions')
      .update({ ...updatePayload, kospi_close: kospiClosePrice, kosdaq_close: kosdaqClosePrice })
      .eq('prediction_date', date);

    // 컬럼 미존재 에러 시 fallback (신규 컬럼 없이 재시도)
    if (error && error.message && error.message.includes('kospi_close')) {
      console.warn('⚠️ kospi_close/kosdaq_close 컬럼 없음, 기본 필드만 저장');
      ({ error } = await supabase
        .from('overnight_predictions')
        .update(updatePayload)
        .eq('prediction_date', date));
    }

    if (error) {
      console.warn('⚠️ 실제 결과 업데이트 실패:', error.message);
    } else {
      console.log(`✅ 실제 결과 업데이트 (${date}): ${actualDirection}, hit=${hit}, kospi=${kospiClosePrice}, kosdaq=${kosdaqClosePrice}`);
    }
  } catch (err) {
    console.warn('⚠️ 실제 결과 업데이트 예외:', err.message);
  }
}

/**
 * 누적 적중률 조회 (10분 캐시)
 */
let _accuracyCache = null;
let _accuracyCacheTime = 0;

async function getAccuracy() {
  if (!supabase) return null;

  // 10분 캐시
  if (_accuracyCache && Date.now() - _accuracyCacheTime < 10 * 60 * 1000) {
    return _accuracyCache;
  }

  try {
    const { data, error } = await supabase
      .from('overnight_predictions')
      .select('hit, score, kospi_close_change, expected_change')
      .not('hit', 'is', null);

    if (error || !data || data.length === 0) return null;

    const total = data.length;
    const hits = data.filter(d => d.hit === true).length;

    // 밴드 적중률 계산
    let bandTotal = 0, bandHits = 0;
    for (const d of data) {
      if (d.kospi_close_change == null) continue;
      const exp = d.expected_change || calcExpectedChange(+d.score, DEFAULT_REGRESSION);
      if (exp && exp.min != null && exp.max != null) {
        bandTotal++;
        if (d.kospi_close_change >= exp.min && d.kospi_close_change <= exp.max) bandHits++;
      }
    }

    _accuracyCache = {
      total,
      hits,
      rate: +(hits / total * 100).toFixed(1),
      bandTotal,
      bandHits,
      bandRate: bandTotal > 0 ? +(bandHits / bandTotal * 100).toFixed(1) : null,
    };
    _accuracyCacheTime = Date.now();
    return _accuracyCache;
  } catch (err) {
    return null;
  }
}

/**
 * 최근 30일 예측 히스토리 조회 (차트용)
 * @returns {Array} [{ date, score, signal, hit, kospiCloseChange }]
 */
async function getRecentHistory(previousKospi, regression) {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('overnight_predictions')
      .select('prediction_date, score, signal, hit, kospi_close_change')
      .order('prediction_date', { ascending: false })
      .limit(30);

    if (error || !data) return [];

    // TOKEN_CACHE 행(KIS 토큰 캐시용 9999-12-31) 및 비정상 데이터 필터링
    const filtered = data.filter(d => d.signal !== 'TOKEN_CACHE' && d.prediction_date < '9999');

    // 차트용 오름차순으로 뒤집기
    const rows = filtered.reverse();

    // KOSPI 절대 지수 역산: 최신 날 종가 = previousKospi, 역방향으로 변동률 적용
    // null인 날은 건너뛰고 다음 유효한 날부터 이어서 역산
    const kospiCloses = new Array(rows.length).fill(null);
    if (previousKospi && rows.length > 0) {
      kospiCloses[rows.length - 1] = previousKospi;
      for (let i = rows.length - 2; i >= 0; i--) {
        // i+1 날의 변동률로 i 날의 종가를 역산
        const nextChange = rows[i + 1].kospi_close_change;
        if (nextChange != null && kospiCloses[i + 1] != null) {
          kospiCloses[i] = Math.round(kospiCloses[i + 1] / (1 + nextChange / 100));
        } else if (kospiCloses[i + 1] != null) {
          // 변동률 없으면 동일 값으로 근사 (체인 유지)
          kospiCloses[i] = kospiCloses[i + 1];
        }
      }
    }

    return rows.map((d, i) => ({
      date: d.prediction_date,
      score: +d.score,
      signal: d.signal,
      hit: d.hit,
      kospiChange: d.kospi_close_change != null ? +d.kospi_close_change : null,
      kospiClose: kospiCloses[i],
      expectedChange: calcExpectedChange(+d.score, regression),
    }));
  } catch (err) {
    return [];
  }
}

/**
 * 캐시된 factors에 unit/corr 필드 보강 (DB에 없을 수 있는 필드)
 */
function enrichFactors(factors) {
  if (!factors) return;
  for (const f of factors) {
    const def = DEFAULT_WEIGHTS[f.ticker];
    if (def) {
      if (!f.unit) f.unit = def.unit || '';
      if (f.corr == null && def.defaultCorr != null) f.corr = def.defaultCorr;
      if (!f.source) f.source = def.source || null;
      if (!f.sourceUrl) f.sourceUrl = def.sourceUrl || null;
    }
  }
}

/**
 * 2-9. 메인 함수: 데이터 수집 + 예측 + 저장
 * 같은 날짜 캐시: Supabase에 이미 저장되어 있으면 읽기
 */
async function fetchAndPredict(bypassCache = false) {
  const today = getTodayKST();

  // 주말 감지: KST 기준 토/일이면 가장 최근 거래일 캐시 반환
  // today는 'YYYY-MM-DD' KST 기준이므로 직접 파싱
  const [yy, mm, dd] = today.split('-').map(Number);
  const kstDay = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay(); // 0=Sun, 6=Sat
  const isWeekend = kstDay === 0 || kstDay === 6;

  if (isWeekend && !bypassCache && supabase) {
    try {
      const { data: lastPred } = await supabase
        .from('overnight_predictions')
        .select('*')
        .lt('prediction_date', today)
        .not('score', 'is', null)
        .order('prediction_date', { ascending: false })
        .limit(1)
        .single();

      if (lastPred && lastPred.score != null) {
        console.log(`📅 주말(${today}) — 최근 거래일(${lastPred.prediction_date}) 캐시 반환`);
        enrichFactors(lastPred.factors);
        const sig = SIGNAL_TABLE.find(s => lastPred.score >= s.min);
        const regression = lastPred.expected_change || await getRegressionParams();
        const expChg = calcExpectedChange(+lastPred.score, regression);
        const [accuracy, history] = await Promise.all([
          getAccuracy(),
          getRecentHistory(lastPred.previous_kospi, regression),
        ]);
        return {
          score: +lastPred.score,
          signal: lastPred.signal,
          emoji: sig.emoji,
          label: sig.label,
          summary: buildSummaryFromFactors(lastPred.factors, sig),
          vixAlert: detectVixAlertFromFactors(lastPred.factors),
          aiInterpretation: !isAiFailure(lastPred.ai_interpretation)
            ? lastPred.ai_interpretation
            : generateRuleBriefing(lastPred.factors || [], sig, +lastPred.score),
          factors: lastPred.factors || [],
          guidance: sig.guidance,
          weightsSource: lastPred.weights_source || (lastPred.weights ? 'calibrated' : 'default'),
          previousKospi: lastPred.previous_kospi,
          regression,
          expectedChange: expChg,
          estimatedKospi: lastPred.previous_kospi ? {
            min: Math.round(lastPred.previous_kospi * (1 + expChg.min / 100)),
            max: Math.round(lastPred.previous_kospi * (1 + expChg.max / 100)),
          } : null,
          accuracy,
          history,
          date: lastPred.prediction_date,
          isWeekendCache: true,
          previousKospiDate: lastPred.previous_kospi_date,
          usMarketDate: lastPred.us_market_date,
          todayResult: lastPred.hit != null ? {
            kospiCloseChange: lastPred.kospi_close_change != null ? +lastPred.kospi_close_change : null,
            kosdaqCloseChange: lastPred.kosdaq_close_change != null ? +lastPred.kosdaq_close_change : null,
            kospiClose: lastPred.kospi_close != null ? +lastPred.kospi_close
              : (lastPred.kospi_close_change != null && lastPred.previous_kospi)
                ? Math.round(lastPred.previous_kospi * (1 + lastPred.kospi_close_change / 100)) : null,
            kosdaqClose: lastPred.kosdaq_close != null ? +lastPred.kosdaq_close : null,
            bandHit: (lastPred.kospi_close_change != null && expChg)
              ? (lastPred.kospi_close_change >= expChg.min && lastPred.kospi_close_change <= expChg.max) : null,
            actualDirection: lastPred.actual_direction,
            hit: lastPred.hit,
          } : null,
          timestamp: lastPred.created_at,
        };
      }
    } catch (e) {
      console.warn('⚠️ 주말 캐시 조회 실패:', e.message);
    }

    // 주말에는 캐시 실패해도 새 예측 생성하지 않음 (토/일 날짜로 저장 방지)
    console.log(`📅 주말(${today}) — 캐시 없음, 예측 생성 건너뜀`);
    return null;
  }

  // KOSPI 전일 종가 (예상 지수 산출용)
  // 1순위: KIS API 활용 (0001 일봉 데이터)
  let previousKospi = null;
  let previousKospiDate = null;
  try {
    const chartData = await kisApi.getIndexChart('0001', 5);
    if (chartData && chartData.length > 0) {
      const todayKSTStr = getTodayKST().replace(/-/g, '');

      let targetItem = chartData[0];
      // 만약 최신 데이터가 오늘 날짜라면, overnightPredictor의 목적상 "전일" 종가를 사용
      if (targetItem.date === todayKSTStr && chartData.length > 1) {
        targetItem = chartData[1];
      }

      previousKospi = targetItem.close;
      previousKospiDate = `${targetItem.date.slice(0, 4)}-${targetItem.date.slice(4, 6)}-${targetItem.date.slice(6, 8)}`;
      console.log(`📈 KOSPI 전일 종가 (KIS API): ${previousKospi} (${previousKospiDate})`);
    }
  } catch (e) {
    console.warn('⚠️ KOSPI 전일 종가 조회 실패(KIS API):', e.message);
  }

  // 2순위: KIS API 실패 시 Naver Finance 폴백
  if (previousKospi === null) {
    try {
      // Naver Finance API는 안정적이며 KOSPI 종가 및 등락률을 제공함
      const naverUrl = `https://m.stock.naver.com/api/index/KOSPI/basic`;
      const naverData = await new Promise((resolve, reject) => {
        https.get(naverUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        }).on('error', reject);
      });

      if (naverData && naverData.closePrice) {
        // Naver API는 현재가(closePrice)와 전일대비(compareToPreviousClosePrice)를 제공
        // 장 개장 전이거나 오늘 휴장일이라면 closePrice가 곧 전일 종가와 동일한 의미를 가짐.
        // 보다 정확한 전일 종가(previousClose) = 현재가 - 전일대비 증감액
        const currentPrice = parseFloat(naverData.closePrice.replace(/,/g, ''));
        const diff = parseFloat((naverData.compareToPreviousClosePrice || '0').replace(/,/g, ''));

        const todayKST = getTodayKST().replace(/-/g, '');
        const tradeDateStr = naverData.localTrdDd; // ex) "20260306"

        if (tradeDateStr === todayKST) {
          // 오늘 장이 열려서 데이터가 오늘 날짜인 경우, "전일 종가"를 구해야 하므로 증감액을 빼줌
          previousKospi = +(currentPrice - diff).toFixed(2);
          // 전일 날짜는 정확히 알기 어렵지만 예측 로직상 값 자체가 중요함
          previousKospiDate = `${tradeDateStr.slice(0, 4)}-${tradeDateStr.slice(4, 6)}-${tradeDateStr.slice(6, 8)} (Derived)`;
        } else {
          // 오늘 장이 안 열렸거나(휴장) 개장 전이라 마지막 거래일 데이터인 경우, 그 자체가 전일 종가임
          previousKospi = currentPrice;
          previousKospiDate = `${tradeDateStr.slice(0, 4)}-${tradeDateStr.slice(4, 6)}-${tradeDateStr.slice(6, 8)}`;
        }

        console.log(`📈 KOSPI 전일 종가 (Naver 폴백): ${previousKospi} (${previousKospiDate})`);
      }
    } catch (e) {
      console.warn('⚠️ KOSPI 전일 종가 폴백 조회 실패 (Naver):', e.message);
    }
  }

  // 캐시 확인: 오늘 이미 예측 저장되어 있고 bypassCache가 false면 읽기
  if (!bypassCache && supabase) {
    try {
      const { data: existing } = await supabase
        .from('overnight_predictions')
        .select('*')
        .eq('prediction_date', today)
        .single();

      if (existing && existing.score != null) {
        // 캐시된 factors가 모두 0이면 (yahoo-finance2 실패 등) 재조회
        const cachedFactors = existing.factors || [];
        const allZero = cachedFactors.length > 0 && cachedFactors.every(f => f.change === 0);
        const expectedCount = Object.keys(DEFAULT_WEIGHTS).length;
        const factorCountMismatch = cachedFactors.length !== expectedCount;
        // KOSPI200F stale 감지: price=previousClose (장 개시 전 기준가 반환 문제)
        const kospi200f = cachedFactors.find(f => f.ticker === 'KOSPI200F');
        const kospi200fStale = kospi200f && kospi200f.change === 0 && kospi200f.price > 0 && kospi200f.price === kospi200f.previousClose;
        if (allZero) {
          console.log(`⚠️ 오늘(${today}) 캐시 factors 전부 0 — 재조회 시도`);
          // 캐시 무시하고 아래 새 예측 로직으로 진행
        } else if (factorCountMismatch) {
          console.log(`⚠️ 오늘(${today}) 캐시 factors ${cachedFactors.length}개 ≠ 현재 ${expectedCount}개 — 재조회 시도`);
          // 팩터 구성 변경 시 캐시 무시
        } else if (kospi200fStale) {
          console.log(`⚠️ 오늘(${today}) 캐시 KOSPI200F stale (price=previousClose=${kospi200f.price}) — 재조회 시도`);
          // KOSPI200F가 stale이면 캐시 무시하고 재조회 (fallback 로직에서 지수 일봉 사용)
        } else {
          console.log(`📊 오늘(${today}) 예측 캐시 사용: ${existing.signal} (${existing.score})`);

          enrichFactors(existing.factors);

          // 신호 판정 재계산
          const sig = SIGNAL_TABLE.find(s => existing.score >= s.min);
          const cachedRegression = existing.expected_change || await getRegressionParams();
          const [accuracy, history] = await Promise.all([getAccuracy(), getRecentHistory(previousKospi, cachedRegression)]);
          const expChg = calcExpectedChange(+existing.score, cachedRegression);

          let aiInterpretation = existing.ai_interpretation;
          if ((isAiFailure(aiInterpretation)) && existing.factors) {
            aiInterpretation = await generateAiInterpretation(existing.factors, sig, existing.score);
            // AI도 실패하면 규칙 기반 fallback
            if (isAiFailure(aiInterpretation)) {
              aiInterpretation = generateRuleBriefing(existing.factors, sig, existing.score);
            }
            // 성공한 해석만 DB에 저장
            if (!isAiFailure(aiInterpretation)) {
              await supabase
                .from('overnight_predictions')
                .update({ ai_interpretation: aiInterpretation })
                .eq('prediction_date', today);
              console.log('💾 캐시된 행에 AI 해석 업데이트 완료');
            }
          } else if (!existing.factors) {
            aiInterpretation = "캐시된 데이터가 부족하여 AI 해석을 생성할 수 없습니다.";
          }

          return {
            score: +existing.score,
            signal: existing.signal,
            emoji: sig.emoji,
            label: sig.label,
            summary: buildSummaryFromFactors(existing.factors, sig),
            vixAlert: detectVixAlertFromFactors(existing.factors),
            aiInterpretation,
            factors: existing.factors || [],
            guidance: sig.guidance,
            weightsSource: existing.weights_source || (existing.weights ? 'calibrated' : 'default'),
            previousKospi,
            regression: cachedRegression,
            expectedChange: expChg,
            estimatedKospi: previousKospi ? {
              min: Math.round(previousKospi * (1 + expChg.min / 100)),
              max: Math.round(previousKospi * (1 + expChg.max / 100)),
            } : null,
            accuracy,
            history,
            date: today,
            isWeekendCache: isWeekend || undefined,
            previousKospiDate: existing.previous_kospi_date || previousKospiDate,
            usMarketDate: existing.us_market_date || null,
            todayResult: existing.hit != null ? {
              kospiCloseChange: existing.kospi_close_change != null ? +existing.kospi_close_change : null,
              kosdaqCloseChange: existing.kosdaq_close_change != null ? +existing.kosdaq_close_change : null,
              kospiClose: existing.kospi_close != null ? +existing.kospi_close
                : (existing.kospi_close_change != null && previousKospi)
                  ? Math.round(previousKospi * (1 + existing.kospi_close_change / 100)) : null,
              kosdaqClose: existing.kosdaq_close != null ? +existing.kosdaq_close : null,
              bandHit: (existing.kospi_close_change != null && expChg)
                ? (existing.kospi_close_change >= expChg.min && existing.kospi_close_change <= expChg.max) : null,
              actualDirection: existing.actual_direction,
              hit: existing.hit,
            } : null,
            timestamp: existing.created_at,
          };
        } // end else (factors not all zero)
      }
    } catch (e) {
      // 캐시 없음 — 새로 계산
    }
  }

  // 새 예측 계산
  const [{ weights, source, correlations }, regression, data, factorVol] = await Promise.all([
    getActiveWeights(),
    getRegressionParams(),
    fetchOvernightData(),
    getFactorVolatility(),
  ]);
  const prediction = calculatePrediction(data, weights, correlations, factorVol);

  // AI 해석 생성
  const sig = SIGNAL_TABLE.find(s => prediction.score >= s.min);
  const aiInterpretation = await generateAiInterpretation(prediction.factors, sig, prediction.score);
  prediction.aiInterpretation = aiInterpretation;

  // usMarketDate 추출 (가장 높은 가중치를 가진 해외 지수 첫번째 요소의 date 사용)
  let usMarketDate = null;
  const usFactor = prediction.factors.find(f => f.ticker === 'ES=F' || f.ticker === '^SOX' || f.ticker === 'NQ=F');
  if (usFactor && data[usFactor.ticker]?.dataDate) {
    usMarketDate = data[usFactor.ticker].dataDate;
  }

  const expChg = calcExpectedChange(prediction.score, regression);

  // 저장
  await savePrediction(prediction, weights, source, previousKospi, regression, expChg, aiInterpretation, previousKospiDate, usMarketDate);

  // 적중률 + 히스토리 조회
  const [accuracy, history] = await Promise.all([getAccuracy(), getRecentHistory(previousKospi, regression)]);

  return {
    ...prediction,
    weightsSource: source,
    previousKospi,
    previousKospiDate,
    usMarketDate,
    regression,
    expectedChange: expChg,
    estimatedKospi: previousKospi ? {
      min: Math.round(previousKospi * (1 + expChg.min / 100)),
      max: Math.round(previousKospi * (1 + expChg.max / 100)),
    } : null,
    accuracy,
    history,
    todayResult: null,
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
  // 기여도 절대값 상위 3개 — KOSPI에 미친 영향 중심으로 서술
  const sorted = [...factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const top3 = sorted.filter(f => f.contribution !== 0).slice(0, 3);
  if (top3.length === 0) return `${factors.length}개 지표 종합 → ${sig.label} 예상`;
  const text = top3.map(f => {
    const impact = f.contribution >= 0 ? '↑' : '↓';
    const sign = f.change >= 0 ? '+' : '';
    return `${f.name}(${sign}${f.change}%)${impact}`;
  }).join(', ');
  return `${text} 등 → ${sig.label} 예상`;
}

function detectVixAlertFromFactors(factors) {
  if (!factors) return null;
  const vix = factors.find(f => f.ticker === '^VIX');
  if (vix && Math.abs(vix.change) >= 15) {
    const dir = vix.change >= 0 ? '급등' : '급락';
    const sign = vix.change >= 0 ? '+' : '';
    return `⚠️ VIX ${dir} ${sign}${vix.change.toFixed(1)}% → 시장 변동성 ${vix.change >= 0 ? '확대' : '축소'} 경고`;
  }
  return null;
}

/**
 * Gemini AI 기반 시장 종합 해석 생성
 * 원인 파악, 노이즈 필터링, 장중 지속력 3가지 관점 기준
 */
async function generateAiInterpretation(factors, sig, score) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "AI 해석을 생성할 수 없습니다. (API 키 누락)";

  // v1.5: 인스턴스를 루프 밖에서 1회만 생성 (성능 최적화)
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"];
  let accumulatedErrors = [];

  // 프롬프트는 모든 모델에서 동일하므로 루프 밖에서 1회만 생성
  const factorsStr = factors.map(f => `${f.name}: ${f.change > 0 ? '+' : ''}${f.change}%`).join(', ');
  const prompt = `
당신은 한국 주식 시황을 예측하는 최고 수준의 증권사 퀀트 애널리스트입니다.
다음 12개 지표의 밤사이 변동률과 시스템이 산출한 예측 스코어를 기반으로, 다가오는 오늘 한국 코스피 시장의 예상 흐름을 300자 내외로 매우 직관적이고 날카롭게 브리핑해주세요.

[데이터]
- 예측 스코어: ${score} (${sig.label})
- 지표 데이터: ${factorsStr}

[참고: 코스피200선물은 KIS API로 야간선물(18:00~06:00 KST) 최종가를 조회한 것으로 가장 최신 데이터이며, 한국 ETF(EWY)는 미국 본장 마감(~06:00 KST) 기준 데이터입니다. 두 지표가 괴리를 보이면 야간선물이 더 최근 심리를 반영합니다.]

[필수 포함 사항 - 반드시 아래 3가지 맥락을 분석하여 유기적인 하나의 단락으로 작성하세요.]
1. 원인과 맥락: 코스피200 선물의 움직임을 중심으로, 반도체(SOX), 나스닥, 원유(CL=F) 등의 등락이 한국 증시에 구체적으로 어떤 산업적/거시적 명분을 제공하고 있는지 설명.
2. 노이즈 필터링: 코스피200 선물과 EWY, 그리고 나머지 10개 지표(Macro Score)가 서로 뒷받침하는지 반박하는지 추세적 신뢰도를 판단.
3. 장중 추세(시초가 vs 종가): 시초가는 선물 가격을 따라가겠지만, VIX, 환율(USDKRW), 국채금리(TNX)의 상태를 보았을 때 장 마감까지 상승세나 하락세가 유지될 수 있는 펀더멘털인지 아니면 장중 되돌림이 나올 환경인지 예측.

가벼운 경어체(해요/합니다)를 사용하고, 각 번호(1, 2, 3)를 매기지 말고 자연스러운 브리핑 텍스트 형태로 출력하세요. 군더더기 인사말은 생략하세요.
`;

  for (const modelName of models) {
    try {
      console.log(`🤖 AI 해석 생성 시도 중 (모델: ${modelName})...`);
      const model = genAI.getGenerativeModel({ model: modelName });

      const result = await model.generateContent(prompt);
      const hostResponse = await result.response;
      const text = hostResponse.text();
      if (!text) throw new Error('Empty AI response');

      console.log(`✅ AI 해석 생성 성공 (모델: ${modelName})`);
      return text.trim();
    } catch (error) {
      console.warn(`⚠️ AI 생성 실패 (${modelName}):`, error.message);
      accumulatedErrors.push(`${modelName}: ${error.status || ''} ${error.message.substring(0, 80)}`);

      // 429 (Too Many Requests) → 12초 대기 후 다음 모델 시도
      if (error.status === 429) {
        console.log('⏳ 429 감지, 12초 대기 후 다음 모델 시도...');
        await new Promise(r => setTimeout(r, 12000));
      }
    }
  }

  // 모든 모델 실패 시 규칙 기반 fallback 브리핑 생성
  console.log('⚠️ 모든 AI 모델 실패 — 규칙 기반 브리핑 생성');
  return generateRuleBriefing(factors, sig, score);
}

/**
 * AI 실패 시 규칙 기반 브리핑 생성
 */
function generateRuleBriefing(factors, sig, score) {
  const sorted = [...factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const top3 = sorted.slice(0, 3);
  const vix = factors.find(f => f.ticker === '^VIX');
  const usdkrw = factors.find(f => f.ticker === 'USDKRW=X');
  const kospi200f = factors.find(f => f.ticker === 'KOSPI200F');

  let brief = '';

  // 방향 요약 — SIGNAL_TABLE 임계점과 동기화 (1.4 / 0.2 / -0.8 / -2.0)
  const ruleSig = SIGNAL_TABLE.find(s => score >= s.min);
  if (ruleSig.signal === 'strong_bullish') {
    brief += `해외 시장 전반이 강세를 보이며 오늘 코스피는 상승 출발이 예상됩니다. `;
  } else if (ruleSig.signal === 'mild_bullish') {
    brief += `해외 시장이 소폭 강세를 보여 코스피는 약보합~소폭 상승이 예상됩니다. `;
  } else if (ruleSig.signal === 'neutral') {
    brief += `해외 시장 혼조세로 코스피 방향성이 불확실합니다. `;
  } else if (ruleSig.signal === 'mild_bearish') {
    brief += `해외 시장 약세 영향으로 코스피는 하락 출발이 예상됩니다. `;
  } else {
    brief += `해외 시장이 전반적으로 급락하며 코스피도 상당한 하방 압력을 받을 것으로 보입니다. `;
  }

  // 주요 팩터 설명
  const topDesc = top3.map(f => {
    const dir = f.change >= 0 ? '상승' : '하락';
    return `${f.name}(${f.change > 0 ? '+' : ''}${f.change}% ${dir})`;
  }).join(', ');
  brief += `주요 영향 요인은 ${topDesc}입니다. `;

  // VIX 경고
  if (vix && vix.change >= 10) {
    brief += `VIX가 ${vix.change.toFixed(1)}% 급등하여 시장 변동성 확대에 주의가 필요합니다. `;
  } else if (vix && vix.change <= -5) {
    brief += `VIX가 하락하며 위험 선호 심리가 개선되고 있습니다. `;
  }

  // 환율
  if (usdkrw && Math.abs(usdkrw.change) >= 0.5) {
    brief += usdkrw.change > 0
      ? `원화 약세(${usdkrw.change > 0 ? '+' : ''}${usdkrw.change}%)도 외국인 매도 압력 요인입니다. `
      : `원화 강세(${usdkrw.change}%)는 외국인 수급에 긍정적입니다. `;
  }

  // KOSPI200F
  if (kospi200f && kospi200f.change !== 0) {
    brief += `코스피200 야간선물은 ${kospi200f.change > 0 ? '+' : ''}${kospi200f.change}%로 마감하여 시초가 방향을 가늠할 수 있습니다.`;
  }

  return brief.trim();
}

module.exports = {
  fetchAndPredict,
  updateActualResult,
  fetchOvernightData,
  calculatePrediction,
  getActiveWeights,
  getRegressionParams,
  DEFAULT_WEIGHTS,
  DEFAULT_REGRESSION,
  generateAiInterpretation,
};
