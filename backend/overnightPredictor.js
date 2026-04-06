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
  'KOSPI200F': { name: '코스피200선물', weight: +0.20, unit: 'pt', defaultCorr: null, source: 'KRX', sourceUrl: null },
  'KOSDAQ150F': { name: '코스닥150선물', weight: 0, unit: 'pt', defaultCorr: null, source: 'KRX', sourceUrl: null },
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

// ─── 신호 판정 테이블 (54건 기반, 2026-04-06 재조정) ───
// neutral 구간 축소: -0.8~+0.2 → -0.4~+0.15 (기존 neutral 0% 적중 → 80% 개선)
// score -0.4~-0.5 구간이 실제 하락(03-31 -4.26%, 03-30 -2.97%)이므로 bearish 분류가 정확
const SIGNAL_TABLE = [
  { min: 1.4, signal: 'strong_bullish', emoji: '🔴🔴', label: '강한 상승', guidance: '모멘텀 전략 적극 활용, 갭업 예상 구간' },
  { min: 0.15, signal: 'mild_bullish', emoji: '🔴', label: '약한 상승', guidance: '모멘텀 전략 유효, 분할 매수 구간' },
  { min: -0.4, signal: 'neutral', emoji: '⚪', label: '중립', guidance: '방향 불명확, 스코어 부호 방향 참고' },
  { min: -2.0, signal: 'mild_bearish', emoji: '🔵', label: '약한 하락', guidance: '보수적 접근, 방어 전략 고려' },
  { min: -Infinity, signal: 'strong_bearish', emoji: '🔵🔵', label: '강한 하락', guidance: '방어 전략 중심, 갭다운 대비' },
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
  // 밴드: ±0.67σ (약 50% 확률 범위 / IQR 수준)
  // 기존 1.0σ는 일일 변동성 대비 너무 넓어 사용자에게 모호함을 줌.
  const band = reg.sigma * 0.67;

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
    // range=5d: 월요일/연휴 후에도 최소 2거래일 데이터 확보 (range=2d는 토일만 커버되어 0% 버그)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
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
          const rawCloses = result.indicators?.quote?.[0]?.close || [];
          const rawOpens = result.indicators?.quote?.[0]?.open || [];
          const timestamps = result.timestamp || [];

          // null/undefined 제거하여 유효 거래일만 추출
          const valid = [];
          for (let i = 0; i < rawCloses.length; i++) {
            if (rawCloses[i] != null && rawCloses[i] > 0) {
              valid.push({ close: rawCloses[i], open: rawOpens[i], ts: timestamps[i] });
            }
          }

          // 같은 날짜 중복 제거 (월요일 장 개시 전 Yahoo가 금요일 데이터를 2개 반환하는 현상 대응)
          // 같은 UTC 날짜의 엔트리가 여러 개면 마지막 것만 유지
          const deduped = [];
          for (let i = 0; i < valid.length; i++) {
            const dateStr = new Date(valid[i].ts * 1000).toISOString().slice(0, 10);
            if (deduped.length > 0) {
              const lastDateStr = new Date(deduped[deduped.length - 1].ts * 1000).toISOString().slice(0, 10);
              if (dateStr === lastDateStr) {
                // 같은 날짜 → 기존 엔트리를 최신으로 교체
                deduped[deduped.length - 1] = valid[i];
                continue;
              }
            }
            deduped.push(valid[i]);
          }

          let dataDate = null;
          let dataTimestamp = null;
          if (deduped.length > 0) {
            const lastTs = deduped[deduped.length - 1].ts;
            if (lastTs) {
              const d = new Date(lastTs * 1000);
              dataDate = d.toISOString().slice(0, 10);
              const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
              dataTimestamp = kst.toISOString().replace('T', ' ').slice(0, 16);
            }
          }

          // 유효 거래일 2개 이상: 마지막 2일 종가로 변동률 계산
          if (deduped.length >= 2) {
            const prev = deduped[deduped.length - 2];
            const curr = deduped[deduped.length - 1];
            const change = ((curr.close - prev.close) / prev.close) * 100;
            resolve({
              price: curr.close,
              previousClose: prev.close,
              chartPreviousClose: meta.chartPreviousClose || meta.previousClose || prev.close,
              open: curr.open || curr.close,
              change: +change.toFixed(4),
              dataDate,
              dataTimestamp,
            });
            return;
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
        const factors = Array.isArray(row.factors) ? row.factors : (typeof row.factors === 'string' ? JSON.parse(row.factors) : []);
        const f = factors.find(f => f.ticker === ticker);
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

// DB fallback 제거됨 (v3.61): 과거 데이터를 현재 데이터로 오인하는 버그 방지
// KIS API 실패 시 failed: true로 처리하여 예측 스코어에서 제외

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
  // 1순위: CM(야간선물) 마켓코드로 직접 조회 — 마감 후에도 최종 종가 유지
  // 2순위: 정규선물 실시간 조회 (getKospi200FuturesPrice 등 — F/JF/CME 다단계 fallback)
  const kisFuturesPromise = (async () => {
    const todayKST = getTodayKST();
    const futuresResults = [];

    const kisTickers = ['KOSPI200F', 'KOSDAQ150F'];
    const cmCodes = {
      'KOSPI200F': ['10100000', 'A01606'],
      'KOSDAQ150F': ['10600000', 'A06606'],
    };
    const getters = {
      'KOSPI200F': () => kisApi.getKospi200FuturesPrice(),
      'KOSDAQ150F': () => kisApi.getKosdaq150FuturesPrice(),
    };

    for (const ticker of kisTickers) {
      let found = false;

      // 1순위: CM(야간선물) 직접 조회 — 06:00 마감 종가를 08:00에도 반환
      for (const code of cmCodes[ticker]) {
        try {
          await kisApi.rateLimiter.acquire();
          const token = await kisApi.getAccessToken();
          const result = await kisApi._queryFuturesPrice(token, code, 'CM');
          if (result && result.price > 0 && result.change !== 0) {
            console.log(`🌙 ${ticker} CM 직접 조회: ${result.price} (${result.change >= 0 ? '+' : ''}${result.change}%)`);
            futuresResults.push({
              ticker,
              price: result.price,
              previousClose: result.previousClose,
              change: result.change,
              dataDate: todayKST,
              dataTimestamp: `${todayKST} 06:00`,
              nightSession: true,
            });
            found = true;
            break;
          }
        } catch (err) {
          console.warn(`⚠️ ${ticker} CM+${code} 조회 실패: ${err.message}`);
        }
      }

      if (found) continue;

      // 2순위: 정규선물 다단계 fallback (F → JF → CME)
      try {
        const futures = await getters[ticker]();
        if (futures && futures.price > 0) {
          futuresResults.push({
            ticker,
            price: futures.price,
            previousClose: futures.previousClose,
            change: futures.change,
            dataDate: todayKST,
            dataTimestamp: `${todayKST} 06:00`,
          });
          if (futures.change === 0) console.log(`ℹ️ ${ticker} change=0 (장 개시 전 — 유효 처리, 기여도 0)`);
        } else {
          console.warn(`⚠️ ${ticker} KIS API 데이터 없음 — failed 처리`);
          futuresResults.push({ ticker, change: 0, price: 0, previousClose: 0, failed: true });
        }
      } catch (err) {
        console.warn(`⚠️ ${ticker} 데이터 수집 실패: ${err.message} — failed 처리`);
        futuresResults.push({ ticker, change: 0, price: 0, previousClose: 0, failed: true });
      }
    }

    return futuresResults;
  })();

  // 3. 병렬 실행
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
    const isFailed = d.failed || (change === 0 && (d.price === 0 || d.price == null));

    // z-score 정규화 및 아웃라이어 댐핑 (v1.2)
    let effectiveChange = change;
    let zScore = null;
    if (factorVol[ticker] && factorVol[ticker].std > 0 && !isFailed) {
      const vol = factorVol[ticker];
      zScore = (change - vol.mean) / vol.std;
      
      // z-score 클램핑: ±3.0σ (극단적 변동이 반영을 독점하는 것 방지)
      const clampedZ = Math.min(Math.max(zScore, -3.0), 3.0);
      effectiveChange = clampedZ;
    } else if (!isFailed) {
      // 변동성 데이터 없을 때 단순 클램핑 (±10% 수준)
      effectiveChange = Math.min(Math.max(change, -10.0), 10.0);
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
      failed: isFailed || undefined,
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
        const factors = Array.isArray(row.factors) ? row.factors : (typeof row.factors === 'string' ? JSON.parse(row.factors) : []);
        const factor = factors.find(f => f.ticker === ticker);
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

    // 핵심 팩터 최소 가중치 보장
    // KOSPI200F는 가장 직접적 선행지표이나, stale 데이터로 상관계수 계산 불가 시
    // DEFAULT 가중치 이하로 떨어지는 문제 방지
    const MIN_WEIGHT_RATIO = {
      'KOSPI200F': 0.20,  // 야간선물 — 최소 20% (DEFAULT와 동일)
      '^SOX': 0.12,       // 반도체 — 최소 12%
    };
    // 정규화 전에 floor 적용 (totalAbsCorr 기준)
    for (const [ticker, minRatio] of Object.entries(MIN_WEIGHT_RATIO)) {
      if (calibrated[ticker] && calibrated[ticker].weight !== 0) {
        const sign = Math.sign(calibrated[ticker].weight);
        const currentRatio = Math.abs(calibrated[ticker].weight) / totalAbsCorr;
        if (currentRatio < minRatio) {
          calibrated[ticker].weight = sign * minRatio * totalAbsCorr;
        }
      }
    }
    // totalAbsCorr 재계산 (floor 적용 후)
    totalAbsCorr = tickers.reduce((s, t) => s + Math.abs(calibrated[t].weight), 0);

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

    // 실제 방향 판정 (KOSPI 종가 기준, flat ±1.0%)
    let actualDirection = 'flat';
    if (kospiCloseChange > 1.0) actualDirection = 'up';
    else if (kospiCloseChange < -1.0) actualDirection = 'down';

    // hit 판정: direction_lean — neutral도 score 부호 방향이면 적중 인정
    let hit = false;
    const predSignal = pred.signal;
    if ((predSignal.includes('bullish') && actualDirection === 'up') ||
      (predSignal.includes('bearish') && actualDirection === 'down')) {
      hit = true;
    } else if (predSignal === 'neutral') {
      if (actualDirection === 'flat') hit = true;
      else if (pred.score > 0 && actualDirection === 'up') hit = true;
      else if (pred.score < 0 && actualDirection === 'down') hit = true;
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
      .lt('prediction_date', '8888-01-01')
      .order('prediction_date', { ascending: false })
      .limit(30);

    if (error || !data) return [];

    // 특수 날짜 행 필터링 (9999-12-31: 토큰 캐시, 8888-12-31: 야간선물 캐시)
    const filtered = data.filter(d => d.signal !== 'TOKEN_CACHE' && d.prediction_date < '8888');

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
        // 주요 팩터 stale 감지: failed 플래그, price=0, change=0+price=previousClose
        const isFactorStale = (ticker) => {
          const f = cachedFactors.find(x => x.ticker === ticker);
          return !f || f.failed || f.price === null || f.price === 0 || (f.change === 0 && f.price > 0 && f.price === f.previousClose);
        };
        const kospi200fStale = isFactorStale('KOSPI200F');
        // 가중치 있는(활성) 팩터 중 change=0인 비율이 높으면 stale (월요일/연휴 Yahoo range=2d 버그 대응)
        const activeFactors = cachedFactors.filter(f => {
          const cfg = DEFAULT_WEIGHTS[f.ticker];
          return cfg && cfg.weight !== 0;
        });
        const zeroActiveCount = activeFactors.filter(f => f.change === 0 && !f.failed).length;
        const tooManyZeros = activeFactors.length > 0 && zeroActiveCount >= Math.ceil(activeFactors.length * 0.5);
        if (allZero) {
          console.log(`⚠️ 오늘(${today}) 캐시 factors 전부 0 — 재조회 시도`);
          // 캐시 무시하고 아래 새 예측 로직으로 진행
        } else if (factorCountMismatch) {
          console.log(`⚠️ 오늘(${today}) 캐시 factors ${cachedFactors.length}개 ≠ 현재 ${expectedCount}개 — 재조회 시도`);
          // 팩터 구성 변경 시 캐시 무시
        } else if (kospi200fStale) {
          console.log(`⚠️ 오늘(${today}) 캐시 KOSPI200F stale — 재조회 시도`);
          // KOSPI200F가 stale이면 캐시 무시하고 재조회
        } else if (tooManyZeros) {
          console.log(`⚠️ 오늘(${today}) 캐시 활성 팩터 중 ${zeroActiveCount}/${activeFactors.length}개 change=0 — 재조회 시도`);
          // 월요일/연휴 후 Yahoo range=2d 버그로 다수 팩터 0% → 재조회
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
            } : await getLatestTodayResult(),
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

  // 적중률 + 히스토리 + 최신 적중결과 조회
  const [accuracy, history, latestResult] = await Promise.all([
    getAccuracy(),
    getRecentHistory(previousKospi, regression),
    getLatestTodayResult(),
  ]);

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
    date: today,
    isWeekendCache: isWeekend || undefined,
    todayResult: latestResult,
    timestamp: new Date().toISOString(),
  };
}

// ─── 유틸리티 ───

/**
 * DB에서 가장 최근 적중 결과(hit != null)를 조회하여 todayResult 객체 생성
 * 주말 캐시 실패, 평일 16:10 이전 등 todayResult가 없는 모든 경로에서 fallback으로 사용
 */
async function getLatestTodayResult() {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('overnight_predictions')
      .select('prediction_date, score, signal, hit, kospi_close_change, kosdaq_close_change, kospi_close, kosdaq_close, actual_direction, previous_kospi, expected_change, created_at')
      .not('hit', 'is', null)
      .order('prediction_date', { ascending: false })
      .limit(1)
      .single();
    if (!data) return null;
    const expChg = data.expected_change;
    return {
      predictionDate: data.prediction_date,
      kospiCloseChange: data.kospi_close_change != null ? +data.kospi_close_change : null,
      kosdaqCloseChange: data.kosdaq_close_change != null ? +data.kosdaq_close_change : null,
      kospiClose: data.kospi_close != null ? +data.kospi_close
        : (data.kospi_close_change != null && data.previous_kospi)
          ? Math.round(data.previous_kospi * (1 + data.kospi_close_change / 100)) : null,
      kosdaqClose: data.kosdaq_close != null ? +data.kosdaq_close : null,
      bandHit: (data.kospi_close_change != null && expChg)
        ? (data.kospi_close_change >= expChg.min && data.kospi_close_change <= expChg.max) : null,
      actualDirection: data.actual_direction,
      hit: data.hit,
    };
  } catch (e) {
    return null;
  }
}

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

  // 방향 요약 — SIGNAL_TABLE 임계점과 동기화 (1.4 / 0.15 / -0.4 / -2.0)
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

// ─── 야간선물 캐시 (05:10 KST 저장 → 08:00 KST 읽기) ───

const NIGHT_FUTURES_CACHE_DATE = '8888-12-31'; // 특수 날짜 키 (토큰 캐시와 별도)

/**
 * 야간선물 종가 조회 및 Supabase 캐시 저장
 * cron에서 호출 — 야간장 데이터 캡처
 *
 * KIS API 마켓코드: CM(야간선물) + 정규선물 코드(10100000, A01606 등)
 * 정규장 마감 후에도 CM으로 야간선물 종가 조회 가능 (F는 정규장 시세만 반환)
 */
async function saveNightFutures() {
  if (!supabase) {
    console.warn('⚠️ Supabase 미설정 — 야간선물 저장 불가');
    return null;
  }

  const todayKST = getTodayKST();
  console.log(`🌙 야간선물 종가 조회 시작 (${todayKST})`);

  const nightFutures = [
    { ticker: 'KOSPI200F', name: '코스피200 야간선물', codes: ['10100000', 'A01606'] },
    { ticker: 'KOSDAQ150F', name: '코스닥150 야간선물', codes: ['10600000', 'A06606'] },
  ];

  const results = [];

  for (const { ticker, name, codes } of nightFutures) {
    let found = false;
    for (const code of codes) {
      try {
        await kisApi.rateLimiter.acquire();
        const token = await kisApi.getAccessToken();
        const result = await kisApi._queryFuturesPrice(token, code, 'CM');

        if (result && result.price > 0) {
          const entry = {
            ticker,
            code,
            price: result.price,
            previousClose: result.previousClose,
            change: result.change,
            capturedAt: new Date().toISOString(),
          };
          results.push(entry);
          console.log(`✅ ${name} (CM+${code}): ${result.price} (${result.change >= 0 ? '+' : ''}${result.change}%)`);
          found = true;
          break;
        }
      } catch (err) {
        console.warn(`⚠️ ${name} (CM+${code}) 실패: ${err.message}`);
      }
    }
    if (!found) {
      console.warn(`⚠️ ${name}: 모든 코드 실패`);
      results.push({ ticker, code: '', price: 0, previousClose: 0, change: 0, failed: true });
    }
  }

  // Supabase에 캐시 저장 (overnight_predictions 테이블의 특수 날짜 행 재활용)
  try {
    const cacheData = {
      date: todayKST,
      results,
      savedAt: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('overnight_predictions')
      .upsert({
        prediction_date: NIGHT_FUTURES_CACHE_DATE,
        factors: cacheData,
        score: 0,
        signal: 'night_futures_cache',
      }, { onConflict: 'prediction_date' });

    if (error) {
      console.warn('⚠️ 야간선물 캐시 저장 실패:', error.message);
    } else {
      console.log(`✅ 야간선물 캐시 저장 완료 (${todayKST})`);
    }
  } catch (err) {
    console.warn('⚠️ 야간선물 캐시 저장 예외:', err.message);
  }

  return results;
}

/**
 * 야간선물 캐시 로드 (08:00 KST alert 모드에서 호출)
 * @returns {Object|null} { KOSPI200F: { change, price, ... }, KOSDAQ150F: { ... } }
 */
async function loadNightFutures() {
  if (!supabase) return null;

  try {
    const { data: cache } = await supabase
      .from('overnight_predictions')
      .select('factors')
      .eq('prediction_date', NIGHT_FUTURES_CACHE_DATE)
      .single();

    if (!cache || !cache.factors || !cache.factors.date) return null;

    const todayKST = getTodayKST();
    if (cache.factors.date !== todayKST) {
      console.log(`ℹ️ 야간선물 캐시 날짜 불일치: ${cache.factors.date} ≠ ${todayKST}`);
      return null;
    }

    const result = {};
    for (const r of cache.factors.results) {
      if (!r.failed && r.price > 0 && r.change !== 0) {
        result[r.ticker] = {
          ticker: r.ticker,
          price: r.price,
          previousClose: r.previousClose,
          change: r.change,
          dataDate: todayKST,
          dataTimestamp: r.capturedAt || `${todayKST} 04:55`,
          nightSession: true,
        };
      }
    }

    if (Object.keys(result).length > 0) {
      console.log(`🌙 야간선물 캐시 로드 성공: ${Object.keys(result).join(', ')}`);
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    console.warn('⚠️ 야간선물 캐시 로드 실패:', err.message);
    return null;
  }
}

module.exports = {
  fetchAndPredict,
  updateActualResult,
  fetchOvernightData,
  calculatePrediction,
  getActiveWeights,
  getRegressionParams,
  saveNightFutures,
  loadNightFutures,
  DEFAULT_WEIGHTS,
  DEFAULT_REGRESSION,
  generateAiInterpretation,
};
