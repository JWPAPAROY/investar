/**
 * 거래량 기반 기술적 지표 계산 모듈
 */

/**
 * OBV (On-Balance Volume) 계산
 * 거래량 누적 지표로 매수/매도 압력 파악
 */
function calculateOBV(chartData) {
  const obv = [];
  let obvValue = 0;

  for (let i = 0; i < chartData.length; i++) {
    if (i === 0) {
      obvValue = chartData[i].volume;
    } else {
      if (chartData[i].close > chartData[i - 1].close) {
        obvValue += chartData[i].volume;  // 상승시 거래량 추가
      } else if (chartData[i].close < chartData[i - 1].close) {
        obvValue -= chartData[i].volume;  // 하락시 거래량 차감
      }
      // 동일가는 변화 없음
    }

    obv.push({
      date: chartData[i].date,
      obv: obvValue
    });
  }

  return obv;
}

/**
 * 거래량 이동평균 계산
 * @param {Array} chartData - 차트 데이터
 * @param {number} period - 이동평균 기간
 */
function calculateVolumeMA(chartData, period = 20) {
  const volumeMA = [];

  for (let i = 0; i < chartData.length; i++) {
    if (i < period - 1) {
      volumeMA.push({
        date: chartData[i].date,
        volumeMA: null
      });
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += chartData[i - j].volume;
      }
      volumeMA.push({
        date: chartData[i].date,
        volumeMA: Math.round(sum / period)
      });
    }
  }

  return volumeMA;
}

/**
 * MFI (Money Flow Index) 계산
 * RSI의 거래량 버전 - 0~100 사이 값
 * 80 이상: 과매수, 20 이하: 과매도
 */
function calculateMFI(chartData, period = 14) {
  const mfi = [];

  for (let i = 0; i < chartData.length; i++) {
    if (i < period) {
      mfi.push({
        date: chartData[i].date,
        mfi: null
      });
      continue;
    }

    let positiveFlow = 0;
    let negativeFlow = 0;

    for (let j = i - period + 1; j <= i; j++) {
      const typicalPrice = (chartData[j].high + chartData[j].low + chartData[j].close) / 3;
      const rawMoneyFlow = typicalPrice * chartData[j].volume;

      if (j > 0) {
        const prevTypicalPrice = (chartData[j - 1].high + chartData[j - 1].low + chartData[j - 1].close) / 3;

        if (typicalPrice > prevTypicalPrice) {
          positiveFlow += rawMoneyFlow;
        } else if (typicalPrice < prevTypicalPrice) {
          negativeFlow += rawMoneyFlow;
        }
      }
    }

    const moneyFlowRatio = negativeFlow === 0 ? 100 : positiveFlow / negativeFlow;
    const mfiValue = 100 - (100 / (1 + moneyFlowRatio));

    mfi.push({
      date: chartData[i].date,
      mfi: mfiValue.toFixed(2)
    });
  }

  return mfi;
}

/**
 * VWAP (Volume Weighted Average Price) 계산
 * 거래량 가중 평균 가격
 */
function calculateVWAP(chartData) {
  const vwap = [];
  let cumulativeTPV = 0;  // 누적 (Typical Price × Volume)
  let cumulativeVolume = 0;

  // chartData는 내림차순(최신=0), VWAP은 과거→현재로 누적해야 함
  for (let i = chartData.length - 1; i >= 0; i--) {
    const typicalPrice = (chartData[i].high + chartData[i].low + chartData[i].close) / 3;
    cumulativeTPV += typicalPrice * chartData[i].volume;
    cumulativeVolume += chartData[i].volume;

    vwap.unshift({  // unshift로 원래 내림차순 순서 유지
      date: chartData[i].date,
      vwap: cumulativeVolume === 0 ? 0 : (cumulativeTPV / cumulativeVolume).toFixed(2)
    });
  }

  return vwap;
}

/**
 * 거래량 급증 탐지
 * 평균 거래량 대비 현재 거래량 비율 계산
 */
function detectVolumeSurge(chartData, threshold = 2.0) {
  const signals = [];
  const volumeMA = calculateVolumeMA(chartData, 20);

  for (let i = 0; i < chartData.length; i++) {
    if (volumeMA[i].volumeMA) {
      const ratio = chartData[i].volume / volumeMA[i].volumeMA;

      if (ratio >= threshold) {
        signals.push({
          date: chartData[i].date,
          volume: chartData[i].volume,
          averageVolume: volumeMA[i].volumeMA,
          ratio: ratio.toFixed(2),
          priceChange: chartData[i].close - chartData[i - 1]?.close || 0,
          signal: ratio >= 3 ? '🔥 초대량' : '⚠️ 급증'
        });
      }
    }
  }

  return signals;
}

/**
 * A/D Line (Accumulation/Distribution Line) 계산
 * 매집/분산 판단 지표
 */
function calculateADLine(chartData) {
  const adLine = [];
  let adValue = 0;

  for (let i = 0; i < chartData.length; i++) {
    const { high, low, close, volume } = chartData[i];

    // Money Flow Multiplier
    const mfm = ((close - low) - (high - close)) / (high - low || 1);

    // Money Flow Volume
    const mfv = mfm * volume;

    adValue += mfv;

    adLine.push({
      date: chartData[i].date,
      adLine: adValue.toFixed(2)
    });
  }

  return adLine;
}

/**
 * 종합 거래량 분석
 *
 * v3.20: chartData는 내림차순(최신=0)이지만 계산 함수들은 오름차순(과거→최신)을 기대.
 * v3.17에서 반환 인덱스만 수정했으나 계산 자체가 역방향이라 volumeMA20/MFI가 null.
 * 근본 수정: 오름차순으로 변환 후 계산, 최신 값은 마지막 인덱스에서 추출.
 */
function analyzeVolume(chartData) {
  const latestData = chartData[0];  // 내림차순 원본에서 최신 데이터

  // 계산 함수용 오름차순 변환 (과거→최신)
  const ascending = [...chartData].reverse();
  const lastIdx = ascending.length - 1;

  const volumeMA20 = calculateVolumeMA(ascending, 20);
  const obv = calculateOBV(ascending);
  const mfi = calculateMFI(ascending, 14);
  const vwap = calculateVWAP(chartData); // v3.17에서 이미 내림차순 대응
  const adLine = calculateADLine(ascending);
  const volumeSurge = detectVolumeSurge(ascending, 1.5);

  // 오름차순 결과의 마지막 인덱스 = 최신(오늘) 데이터
  return {
    current: {
      date: latestData.date,
      price: latestData.close,
      volume: latestData.volume,
      volumeMA20: volumeMA20[lastIdx]?.volumeMA
    },
    indicators: {
      obv: obv[lastIdx]?.obv,
      mfi: parseFloat(mfi[lastIdx]?.mfi),
      vwap: parseFloat(vwap[0]?.vwap), // VWAP은 이미 내림차순 결과
      adLine: parseFloat(adLine[lastIdx]?.adLine)
    },
    signals: {
      volumeSurge: volumeSurge.slice(-5).reverse(),  // 최근 5개, 내림차순 변환
      mfiSignal: getMFISignal(parseFloat(mfi[lastIdx]?.mfi)),
      obvTrend: getOBVTrend(obv.slice(-10)),  // 최근 10개 (오름차순, getOBVTrend가 기대하는 형태)
      priceVsVWAP: latestData.close > parseFloat(vwap[0]?.vwap) ? '상승세' : '하락세'
    },
    chartData: {
      volumeMA20: [...volumeMA20].reverse(),  // 내림차순 반환 (프론트엔드 호환)
      obv: [...obv].reverse(),
      mfi: [...mfi].reverse(),
      vwap: vwap,  // 이미 내림차순
      adLine: [...adLine].reverse()
    }
  };
}

/**
 * MFI 신호 해석
 */
function getMFISignal(mfiValue) {
  if (!mfiValue) return '데이터 부족';
  if (mfiValue >= 80) return '🔴 과매수 (매도 고려)';
  if (mfiValue <= 20) return '🟢 과매도 (매수 고려)';
  return '⚪ 중립';
}

/**
 * OBV 추세 판단
 */
function getOBVTrend(obvData) {
  if (obvData.length < 2) return '데이터 부족';

  const recent = obvData.slice(-3).map(d => d.obv);
  const isRising = recent[2] > recent[1] && recent[1] > recent[0];
  const isFalling = recent[2] < recent[1] && recent[1] < recent[0];

  if (isRising) return '📈 상승 (매수세 우세)';
  if (isFalling) return '📉 하락 (매도세 우세)';
  return '➡️ 횡보';
}

/**
 * VPT (Volume Price Trend) 계산
 * 거래량과 가격의 상관관계를 누적으로 추적
 */
function calculateVPT(chartData) {
  const vpt = [];
  let vptValue = 0;

  for (let i = 0; i < chartData.length; i++) {
    if (i === 0) {
      vptValue = chartData[i].volume;
    } else {
      const priceChange = (chartData[i].close - chartData[i - 1].close) / chartData[i - 1].close;
      vptValue += chartData[i].volume * priceChange;
    }

    vpt.push({
      date: chartData[i].date,
      vpt: vptValue
    });
  }

  return vpt;
}

/**
 * VPT Slope 계산 (5일 기준)
 * 양수: 상승 추세, 음수: 하락 추세
 */
function calculateVPTSlope(vptData) {
  if (vptData.length < 5) return 0;

  const recent = vptData[0].vpt;      // 최신
  const fiveDaysAgo = vptData[4].vpt;  // 5일전

  return (recent - fiveDaysAgo) / 5;
}

/**
 * Volume-Price Divergence 분석
 * 핵심 철학: "거래량 폭발 + 가격 미반영 = 급등 예정 신호"
 *
 * @param {Array} chartData - 차트 데이터 (내림차순: [0] = 최신)
 * @param {number} currentPrice - 현재가
 * @returns {Object} divergence 분석 결과
 */
function calculateVolumePriceDivergence(chartData, currentPrice) {
  if (chartData.length < 20) {
    return {
      score: 0,
      signal: '데이터 부족',
      divergence: 0,
      volumeRatio: 0,
      priceRatio: 1.0,
      priceChange: 0,
      details: '최소 20일 데이터 필요'
    };
  }

  // 최근 20일 평균 거래량
  const recentVolumes = chartData.slice(0, 20).map(d => d.volume);
  const avgVolume = recentVolumes.reduce((sum, v) => sum + v, 0) / 20;

  // 최근 20일 평균 가격
  const recentPrices = chartData.slice(0, 20).map(d => d.close);
  const avgPrice = recentPrices.reduce((sum, p) => sum + p, 0) / 20;

  // 최신 데이터
  const latestVolume = chartData[0].volume;

  // Volume Ratio 계산
  const volumeRatio = latestVolume / avgVolume;

  // Price Ratio 계산 (절대값 사용 + 1.0)
  const priceChange = ((currentPrice - avgPrice) / avgPrice) * 100;
  const priceRatio = Math.abs(currentPrice - avgPrice) / avgPrice + 1.0;

  // Divergence 계산
  const divergence = volumeRatio - priceRatio;

  // VPT Slope 계산 (하락 추세 필터링)
  // v3.20: VPT는 오름차순(과거→최신) 누적이 필요. chartData는 내림차순이므로 변환
  const vpt = calculateVPT([...chartData].reverse());
  // 오름차순 VPT의 마지막 5일로 slope 계산
  const vptSlope = vpt.length >= 5
    ? (vpt[vpt.length - 1].vpt - vpt[vpt.length - 5].vpt) / 5
    : 0;

  // 점수 계산 로직
  let score = 0;
  let signal = '';
  let details = '';

  // 1. Quiet Accumulation (최고 점수: 28-35점)
  // 거래량 3배 이상 && 가격 변동 ±10% 이내 && VPT 상승
  if (divergence >= 3.0 && Math.abs(priceChange) <= 10 && vptSlope >= 0) {
    score = 28 + Math.min(divergence * 2, 7);  // 28~35점
    signal = '🔥 최우선 매수 - 거래량 폭발, 가격 미반영';
    details = `조용한 매집 (Quiet Accumulation): divergence ${divergence.toFixed(2)}`;
  }
  // 2. Early Stage (20-27점)
  // divergence 2.0-3.0 && 가격 ±15% 이내 && VPT 상승
  else if (divergence >= 2.0 && divergence < 3.0 && Math.abs(priceChange) <= 15 && vptSlope >= 0) {
    score = 20 + Math.min(divergence * 2, 7);  // 20~27점
    signal = '🟢 적극 매수 - 초기 단계 매집';
    details = `초기 매집 (Early Stage): divergence ${divergence.toFixed(2)}`;
  }
  // 3. Moderate (12-19점)
  // divergence 1.0-2.0 && VPT 상승
  else if (divergence >= 1.0 && divergence < 2.0 && vptSlope >= 0) {
    score = 12 + Math.min(divergence * 4, 7);  // 12~19점
    signal = '🟡 매수 고려 - 관심 필요';
    details = `보통 수준 (Moderate): divergence ${divergence.toFixed(2)}`;
  }
  // 4. Weak Signal (5-11점)
  // divergence 0.5-1.0 && VPT 상승
  else if (divergence >= 0.5 && divergence < 1.0 && vptSlope >= 0) {
    score = 5 + Math.min(divergence * 6, 6);  // 5~11점
    signal = '⚪ 약한 신호';
    details = `약한 신호 (Weak): divergence ${divergence.toFixed(2)}`;
  }
  // 5. Already Surged (페널티: -15~-25점)
  // 가격 20% 이상 급등 또는 VPT 하락 추세
  else if (Math.abs(priceChange) > 20 || vptSlope < 0) {
    const penalty = Math.min(Math.abs(priceChange - 20), 10);
    score = -15 - penalty;  // -15~-25점
    signal = '🔴 관망 - 이미 급등 또는 하락 추세';
    details = vptSlope < 0
      ? `하락 추세 (VPT slope: ${vptSlope.toFixed(2)})`
      : `이미 급등 (가격 변동: ${priceChange.toFixed(1)}%)`;
  }
  // 6. No Signal (0점)
  else {
    score = 0;
    signal = '⚫ 신호 없음';
    details = `divergence ${divergence.toFixed(2)} (기준 미달)`;
  }

  return {
    score: Math.round(score),
    signal,
    divergence: parseFloat(divergence.toFixed(2)),
    volumeRatio: parseFloat(volumeRatio.toFixed(2)),
    priceRatio: parseFloat(priceRatio.toFixed(2)),
    priceChange: parseFloat(priceChange.toFixed(2)),
    vptSlope: parseFloat(vptSlope.toFixed(2)),
    avgVolume: Math.round(avgVolume),
    avgPrice: Math.round(avgPrice),
    details
  };
}

module.exports = {
  calculateOBV,
  calculateVolumeMA,
  calculateMFI,
  calculateVWAP,
  calculateADLine,
  detectVolumeSurge,
  analyzeVolume,
  calculateVPT,
  calculateVPTSlope,
  calculateVolumePriceDivergence
};
