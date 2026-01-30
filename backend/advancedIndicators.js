/**
 * 창의적인 거래량 기반 지표 모듈
 * 1. 고래 감지 (Whale Detection)
 * 2. 조용한 매집 (Silent Accumulation)
 * 3. 탈출 속도 (Escape Velocity)
 * 4. 유동성 고갈 (Liquidity Drain)
 */

/**
 * 1. 고래 감지 지표 (Whale Detection)
 * 평소 대비 대량 거래 + 급격한 가격 변동 감지
 * 기관/외국인 등 큰 손의 매매 패턴 포착
 * + 윗꼬리 필터링 추가 (30% 이상 시 점수 감점)
 */
function detectWhale(chartData, marketCap = 0) {
  const recentData = chartData.slice(0, 10); // 최근 10일 (chartData[0]=오늘, 내림차순)
  const avgVolume = chartData.slice(10, 30).reduce((sum, d) => sum + d.volume, 0) / Math.min(20, chartData.slice(10, 30).length || 1);

  // v3.16: 시총 기반 거래량 기준 차등 적용
  // 대형주는 거래대금 자체가 크므로 낮은 배수도 의미 있음
  let volumeThreshold = 2.5; // 소형주 (<1조): 기본 2.5배
  if (marketCap >= 10000000000000) {       // 대형주 (10조+)
    volumeThreshold = 1.5;
  } else if (marketCap >= 1000000000000) { // 중형주 (1조~10조)
    volumeThreshold = 2.0;
  }

  const whaleSignals = [];

  for (let i = 1; i < recentData.length; i++) {
    const data = recentData[i];
    const volumeRatio = data.volume / avgVolume;
    const priceChange = Math.abs((data.close - data.open) / data.open * 100);

    // 윗꼬리 비율 계산
    const range = data.high - data.low;
    const upperShadow = range > 0
      ? ((data.high - data.close) / range) * 100
      : 0;

    // 고가 대비 낙폭
    const highDecline = data.high > 0
      ? ((data.high - data.close) / data.high) * 100
      : 0;

    // 고래 감지 조건 (시총별 차등):
    // 대형주(10조+): 1.5배, 중형주(1~10조): 2.0배, 소형주(<1조): 2.5배
    if (volumeRatio >= volumeThreshold && priceChange >= 3) {
      const isUpWhale = data.close > data.open; // 상승 고래 vs 하락 고래

      // 기본 강도 점수
      let intensity = volumeRatio * priceChange / 10;

      // 윗꼬리 페널티: 30% 이상이면 강도 50% 감소
      let upperShadowPenalty = 0;
      if (isUpWhale && upperShadow >= 30) {
        intensity = intensity * 0.5; // 50% 감점
        upperShadowPenalty = upperShadow;
      }

      whaleSignals.push({
        date: data.date,
        type: isUpWhale ? '🐋 매수 고래' : '🐳 매도 고래',
        volumeRatio: volumeRatio.toFixed(2),
        priceChange: priceChange.toFixed(2),
        volume: data.volume,
        intensity: intensity,
        upperShadow: upperShadow.toFixed(1),
        highDecline: highDecline.toFixed(1),
        warning: upperShadowPenalty > 0 ? `⚠️ 윗꼬리 ${upperShadow.toFixed(1)}% (되돌림 위험)` : null
      });
    }
  }

  return whaleSignals;
}

/**
 * 2. 조용한 매집 지표 (Silent Accumulation)
 * 가격은 횡보하지만 거래량이 꾸준히 증가
 * 큰 손들의 물량 모으기 패턴 감지
 * 5일 데이터로도 작동 가능하도록 개선
 */
function detectSilentAccumulation(chartData) {
  const dataLength = chartData.length;

  // 데이터가 5일 미만이면 분석 불가
  if (dataLength < 5) {
    return {
      detected: false,
      priceVolatility: '0.00',
      volumeGrowth: '0.00',
      avgPrice: 0,
      signal: '데이터 부족',
      score: 0
    };
  }

  // 사용 가능한 모든 데이터 사용
  const recent = chartData.slice(-Math.min(20, dataLength));

  // 종가 기준 가격 변동폭 계산
  const prices = recent.map(d => d.close);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const priceRange = ((maxPrice - minPrice) / avgPrice) * 100;

  // 거래량 추세 계산 (데이터 양에 따라 동적 분할)
  let volumeGrowth = 0;

  if (recent.length >= 10) {
    // 10일 이상: 전반부 vs 후반부
    const midPoint = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, midPoint);
    const secondHalf = recent.slice(midPoint);
    const avgVolumeFirst = firstHalf.reduce((sum, d) => sum + d.volume, 0) / firstHalf.length;
    const avgVolumeSecond = secondHalf.reduce((sum, d) => sum + d.volume, 0) / secondHalf.length;
    volumeGrowth = ((avgVolumeSecond - avgVolumeFirst) / avgVolumeFirst) * 100;
  } else {
    // 5~9일: 첫날 vs 마지막날 거래량 비교
    const firstVolume = recent[0].volume;
    const lastVolume = recent[recent.length - 1].volume;
    volumeGrowth = ((lastVolume - firstVolume) / firstVolume) * 100;
  }

  // 조용한 매집 조건 (완화):
  // 1. 종가 기준 가격 변동 10% 이내 - 횡보 구간
  // 2. 거래량 증가 (0% 이상) - 증가 또는 유지
  const isSilentAccumulation = priceRange <= 10 && volumeGrowth > 0;

  return {
    detected: isSilentAccumulation,
    priceRange: priceRange.toFixed(2),
    volumeGrowth: volumeGrowth.toFixed(2),
    avgPrice: Math.round(avgPrice),
    maxPrice: Math.round(maxPrice),
    minPrice: Math.round(minPrice),
    signal: isSilentAccumulation ? '🤫 조용한 매집 진행중' : '없음',
    score: isSilentAccumulation ? Math.min(volumeGrowth, 25) : 0
  };
}

/**
 * 3. 탈출 속도 지표 (Escape Velocity)
 * 저항선 돌파 + 거래량 폭발 조합
 * 모멘텀 시작 시점 포착
 * + Closing Strength 검증 추가 (윗꼬리 필터)
 */
function detectEscapeVelocity(chartData) {
  const recent = chartData.slice(0, 30); // 최근 30일 (chartData[0]=오늘, 내림차순)
  const latest = recent[0];    // 최신 = 오늘
  const yesterday = recent[1]; // 어제

  // 최근 30일 중 최근 5일 제외한 고가 (저항선)
  const resistance = Math.max(...recent.slice(5).map(d => d.high));

  // 평균 거래량 (최근 5일 제외)
  const avgVolume = recent.slice(5).reduce((sum, d) => sum + d.volume, 0) / Math.min(25, recent.slice(5).length);

  // Closing Strength: 종가가 당일 거래범위에서 차지하는 위치 (0~100%)
  const range = latest.high - latest.low;
  const closingStrength = range > 0
    ? ((latest.close - latest.low) / range) * 100
    : 50;

  // 윗꼬리 비율: 고가 대비 종가 하락폭
  const upperShadow = range > 0
    ? ((latest.high - latest.close) / range) * 100
    : 0;

  // 고가 대비 낙폭 (%)
  const highDecline = latest.high > 0
    ? ((latest.high - latest.close) / latest.high) * 100
    : 0;

  // 탈출 속도 조건:
  // 1. 현재 종가가 저항선 돌파
  // 2. 거래량이 평균의 2배 이상
  // 3. 상승 캔들 (종가 > 시가)
  // 4. Closing Strength 70% 이상 (강한 마감)
  // 5. 고가 대비 낙폭 10% 미만 (윗꼬리 제한)
  const breaksResistance = latest.close > resistance;
  const volumeSurge = latest.volume / avgVolume >= 2;
  const isGreenCandle = latest.close > latest.open;
  const strongClosing = closingStrength >= 70;
  const acceptableDecline = highDecline < 10;

  const detected = breaksResistance && volumeSurge && isGreenCandle && strongClosing && acceptableDecline;

  // 모멘텀 강도 계산 (Closing Strength 반영)
  const momentum = detected ?
    ((latest.close - resistance) / resistance * 100) * (latest.volume / avgVolume) * (closingStrength / 100) : 0;

  return {
    detected,
    resistance: Math.round(resistance),
    currentPrice: latest.close,
    volumeRatio: (latest.volume / avgVolume).toFixed(2),
    priceBreakout: ((latest.close - resistance) / resistance * 100).toFixed(2),
    closingStrength: closingStrength.toFixed(1),
    upperShadow: upperShadow.toFixed(1),
    highDecline: highDecline.toFixed(1),
    signal: detected ? '🚀 탈출 속도 달성' :
            !acceptableDecline ? `⚠️ 윗꼬리 과다 (고가대비 -${highDecline.toFixed(1)}%)` :
            !strongClosing ? '⚠️ 약한 마감' : '없음',
    momentum: momentum.toFixed(2),
    score: detected ? momentum : 0,
    warning: !acceptableDecline || !strongClosing ? '장중 급등 후 되돌림 - 추가 하락 위험' : null
  };
}

/**
 * 4. 유동성 고갈 지표 (Liquidity Drain)
 * 거래량 급감 + 변동성 축소
 * 큰 움직임 직전 신호 (스프링 압축)
 */
function detectLiquidityDrain(chartData) {
  const recent = chartData.slice(0, 10); // 최근 10일 (chartData[0]=오늘, 내림차순)
  const previous = chartData.slice(10, 30); // 이전 20일

  // 평균 거래량 비교
  const avgVolumeRecent = recent.reduce((sum, d) => sum + d.volume, 0) / 10;
  const avgVolumePrevious = previous.reduce((sum, d) => sum + d.volume, 0) / 20;
  const volumeDecline = ((avgVolumeRecent - avgVolumePrevious) / avgVolumePrevious) * 100;

  // 변동성 비교 (최근 vs 이전)
  const calcVolatility = (data) => {
    const ranges = data.map(d => ((d.high - d.low) / d.close) * 100);
    return ranges.reduce((a, b) => a + b, 0) / ranges.length;
  };

  const volatilityRecent = calcVolatility(recent);
  const volatilityPrevious = calcVolatility(previous);
  const volatilityDecline = ((volatilityRecent - volatilityPrevious) / volatilityPrevious) * 100;

  // 유동성 고갈 조건:
  // 1. 거래량 감소 (-30% 이하)
  // 2. 변동성 감소 (-20% 이하)
  const detected = volumeDecline < -30 && volatilityDecline < -20;

  return {
    detected,
    volumeDecline: volumeDecline.toFixed(2),
    volatilityDecline: volatilityDecline.toFixed(2),
    avgVolumeRecent: Math.round(avgVolumeRecent),
    signal: detected ? '💧 유동성 고갈 (폭발 대기)' : '없음',
    score: detected ? Math.abs(volumeDecline + volatilityDecline) : 0
  };
}

/**
 * 비대칭 거래량 지표 (Asymmetric Volume)
 * 상승일 거래량 vs 하락일 거래량 비교
 * 실제 매수세/매도세 강도 측정
 */
function calculateAsymmetricVolume(chartData) {
  const recent = chartData.slice(0, 20); // 최근 20일

  let upVolume = 0;
  let downVolume = 0;
  let upDays = 0;
  let downDays = 0;

  recent.forEach(day => {
    if (day.close > day.open) {
      upVolume += day.volume;
      upDays++;
    } else if (day.close < day.open) {
      downVolume += day.volume;
      downDays++;
    }
  });

  const ratio = downVolume === 0 ? 100 : (upVolume / downVolume);

  return {
    upVolume,
    downVolume,
    upDays,
    downDays,
    ratio: ratio.toFixed(2),
    signal: ratio > 1.5 ? '📈 강한 매수세' : ratio < 0.7 ? '📉 강한 매도세' : '⚖️ 균형',
    score: Math.abs(ratio - 1) * 50 // 1에서 멀수록 높은 점수
  };
}

/**
 * 거래량 3일 연속 순증 체크
 */
function checkVolumeConsecutiveIncrease(chartData, days = 3) {
  const recent = chartData.slice(0, days + 1); // 최근 N+1일 (내림차순: [0]=오늘)

  if (recent.length < days + 1) {
    return { consecutive: false, days: 0 };
  }

  // 내림차순이므로 recent[0]=오늘, recent[1]=어제...
  // 연속 증가: 오늘>어제>그제 = recent[0]>recent[1]>recent[2]
  let consecutiveDays = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i].volume > recent[i + 1].volume) {
      consecutiveDays++;
    } else {
      break; // 연속 끊김
    }
  }

  return {
    consecutive: consecutiveDays >= days,
    days: consecutiveDays,
    volumes: recent.map(d => d.volume)
  };
}

/**
 * Phase 4A-1: 조용한 거래량 누적 패턴
 * 급등 전에 거래량이 점진적으로 증가하는 패턴 감지
 * + 거래량 3일 연속 순증 조건 추가
 */
function detectGradualAccumulation(chartData) {
  const recent20 = chartData.slice(0, 20); // 최근 20일 (내림차순: [0]=오늘)
  const volumeTrend = [];

  // 5일 단위로 거래량 평균 계산 (내림차순이므로 [0-4]=최근, [15-19]=가장 오래됨)
  // 점진적 증가를 보려면 오래된→최근 순으로 비교해야 함
  for (let i = 3; i >= 0; i--) {
    const period = recent20.slice(i * 5, (i + 1) * 5);
    const avgVolume = period.reduce((sum, d) => sum + d.volume, 0) / period.length;
    volumeTrend.push(avgVolume);
  }

  // 점진적 증가: 각 주차마다 10% 이상 증가 (오래된→최근)
  const isGradualIncrease =
    volumeTrend[1] > volumeTrend[0] * 1.1 &&
    volumeTrend[2] > volumeTrend[1] * 1.1 &&
    volumeTrend[3] > volumeTrend[2] * 1.1;

  // 가격은 안정적 (최근 20일 변동폭 5% 이내)
  const currentPrice = recent20[0].close;  // 오늘 가격
  const oldestPrice = recent20[recent20.length - 1].close;  // 20일 전 가격
  const priceChange = Math.abs((currentPrice - oldestPrice) / oldestPrice);
  const priceStable = priceChange < 0.05;

  // 거래량 3일 연속 순증 체크
  const volumeCheck = checkVolumeConsecutiveIncrease(chartData, 3);

  // 증가율 계산
  const growthRate = ((volumeTrend[3] - volumeTrend[0]) / volumeTrend[0]) * 100;

  // 기존 조건 + 3일 연속 순증 조건
  const detected = isGradualIncrease && priceStable && volumeCheck.consecutive;

  return {
    detected,
    signal: detected ? '🐌 조용한 누적 (급등 전조)' : '없음',
    volumeTrend: volumeTrend.map(v => Math.round(v)),
    growthRate: growthRate.toFixed(1),
    priceChange: (priceChange * 100).toFixed(2),
    volumeConsecutive: volumeCheck.consecutive,
    consecutiveDays: volumeCheck.days,
    score: detected ? Math.min(growthRate, 80) : 0,
    interpretation: detected
      ? `세력이 가격 자극 없이 물량 모으는 중 (${volumeCheck.days}일 연속 거래량 증가), 1~2주 후 급등 가능성`
      : volumeCheck.consecutive
      ? '거래량 연속 증가 중이나 가격 변동폭 큼'
      : '패턴 미발견',
    readyIn: detected ? '7~14일' : null
  };
}

/**
 * Phase 4A-2: 스마트머니 유입 지표
 * 대형 거래(기관/외국인) vs 소형 거래(개인) 비교
 */
function detectSmartMoney(chartData) {
  const recent10 = chartData.slice(0, 10); // 최근 10일

  // 거래량 기준 정렬 (복사본 사용)
  const sortedByVolume = [...recent10].sort((a, b) => b.volume - a.volume);

  // 상위 30% (대형 거래일 - 기관/외국인 추정)
  const bigVolumeDays = sortedByVolume.slice(0, 3);
  const bigVolumeMovement = bigVolumeDays.reduce(
    (sum, d) => sum + (d.close - d.open) / d.open,
    0
  );

  // 하위 70% (소형 거래일 - 개인 추정)
  const smallVolumeDays = sortedByVolume.slice(3);
  const smallVolumeMovement = smallVolumeDays.reduce(
    (sum, d) => sum + (d.close - d.open) / d.open,
    0
  );

  // 스마트머니 매수: 대형 거래일엔 상승, 소형 거래일엔 하락
  const smartMoneyBuying = bigVolumeMovement > 0 && smallVolumeMovement < 0;

  // 대형 거래 평균 수익률
  const bigAvgReturn = (bigVolumeMovement / 3) * 100;
  const smallAvgReturn = (smallVolumeMovement / 7) * 100;

  const ratio = smallVolumeMovement !== 0
    ? Math.abs(bigVolumeMovement / smallVolumeMovement)
    : 10;

  const detected = smartMoneyBuying && ratio > 2;

  return {
    detected,
    signal: detected ? '🧠 스마트머니 유입' : '없음',
    bigVolumeReturn: bigAvgReturn.toFixed(2),
    smallVolumeReturn: smallAvgReturn.toFixed(2),
    ratio: ratio.toFixed(2),
    score: detected ? Math.min(ratio * 20, 70) : 0,
    interpretation: detected
      ? '기관/외국인이 사고 개인이 파는 중 - 기회'
      : '스마트머니 유입 미확인'
  };
}

/**
 * Phase 4A-3: 저점 매집 패턴 (역발상)
 * 하락 후 거래량 급감 → 바닥 신호
 */
function detectBottomFormation(chartData) {
  const recent30 = chartData.slice(0, 30); // 최근 30일 (내림차순: [0]=오늘)

  // 1단계: 30일 내 고점 대비 15% 이상 하락
  const highPrice = Math.max(...recent30.map(d => d.high));
  const currentPrice = recent30[0].close; // 오늘 가격
  const decline = ((currentPrice - highPrice) / highPrice) * 100;
  const declined = decline < -15;

  // 2단계: 최근 5일간 거래량 급감 (공포 소멸)
  const recentVolume =
    recent30.slice(0, 5).reduce((sum, d) => sum + d.volume, 0) / 5;
  const avgVolume =
    recent30.slice(5, 25).reduce((sum, d) => sum + d.volume, 0) / 20;
  const volumeRatio = recentVolume / avgVolume;
  const volumeDrying = volumeRatio < 0.5;

  // 3단계: 가격 횡보 (바닥 다지기) - 최근 5일 변동 3% 이내
  const recent5Prices = recent30.slice(0, 5).map(d => d.close);
  const maxPrice = Math.max(...recent5Prices);
  const minPrice = Math.min(...recent5Prices);
  const priceRange = ((maxPrice - minPrice) / currentPrice) * 100;
  const priceStable = priceRange < 3;

  const detected = declined && volumeDrying && priceStable;

  return {
    detected,
    signal: detected ? '🌱 저점 형성 (반등 대기)' : '없음',
    highPrice: Math.round(highPrice),
    currentPrice: Math.round(currentPrice),
    decline: decline.toFixed(1),
    volumeRatio: volumeRatio.toFixed(2),
    priceRange: priceRange.toFixed(2),
    score: detected ? Math.abs(decline) * 2 : 0,
    interpretation: detected
      ? '악재 소진 + 매도세 고갈 = 반등 임박 (단, 추가 하락 리스크 있음)'
      : '저점 패턴 미형성',
    readyIn: detected ? '3~7일' : null
  };
}

/**
 * Phase 4B-1: 저항선 돌파 "직전" 포착
 */
function detectBreakoutPreparation(chartData) {
  const recent30 = chartData.slice(0, 30); // 최근 30일 (내림차순: [0]=오늘)
  const currentPrice = recent30[0].close; // 오늘 가격

  // 저항선 계산 (최근 5일 제외한 25일의 고점)
  const resistance = Math.max(...recent30.slice(5).map(d => d.high));

  // 저항선 터치 횟수 (2% 이내 접근)
  const touchCount = recent30.filter(
    d => Math.abs(d.high - resistance) / resistance < 0.02
  ).length;

  // 현재 저항선 바로 아래 (3% 이내)
  const gapPercent = ((resistance - currentPrice) / currentPrice) * 100;
  const nearResistance = gapPercent >= 0 && gapPercent < 3;

  // 거래량 증가 추세 (돌파 준비)
  const recent5Volume =
    recent30.slice(0, 5).reduce((sum, d) => sum + d.volume, 0) / 5;
  const prev5Volume =
    recent30.slice(5, 10).reduce((sum, d) => sum + d.volume, 0) / 5;
  const volumeIncreasing = recent5Volume > prev5Volume * 1.3;

  const detected = touchCount >= 3 && nearResistance && volumeIncreasing;

  return {
    detected,
    signal: detected ? '🚪 저항선 돌파 준비' : '없음',
    resistance: Math.round(resistance),
    currentPrice: Math.round(currentPrice),
    gap: gapPercent.toFixed(2),
    touchCount,
    volumeGrowth: ((recent5Volume / prev5Volume - 1) * 100).toFixed(1),
    score: detected ? 90 : 0,
    interpretation: detected
      ? `${touchCount}번 도전 끝에 돌파 임박 - 저항선 ${Math.round(resistance)}원 돌파 시 매수`
      : '돌파 준비 단계 아님',
    triggerPrice: detected ? Math.round(resistance * 1.01) : null
  };
}

/**
 * Phase 4C: 과열 감지 필터
 * 고점 매수 방지
 * + 고가 대비 낙폭 체크 추가 (10% 이상 경고)
 */
function checkOverheating(chartData, currentPrice, volumeRatio, mfi) {
  const recent10 = chartData.slice(0, 10); // 최근 10일 (내림차순: [0]=오늘)
  const latest = chartData[0];

  // 1. 최근 10일간 30% 이상 급등
  const firstPrice = recent10[recent10.length - 1].close; // 10일 전 가격
  const surgePercent = ((currentPrice - firstPrice) / firstPrice) * 100;
  const surge = surgePercent > 30;

  // 2. 거래량이 평소 10배 이상
  const extremeVolume = volumeRatio > 10;

  // 3. MFI 90 이상 (극과매수)
  const extremeOverbought = mfi > 90;

  // 4. 고가 대비 낙폭 체크 (당일 고가 → 종가 하락)
  const highDecline = latest.high > 0
    ? ((latest.high - latest.close) / latest.high) * 100
    : 0;
  const significantDecline = highDecline >= 10; // 10% 이상 하락

  // 5. Closing Strength (종가 위치)
  const range = latest.high - latest.low;
  const closingStrength = range > 0
    ? ((latest.close - latest.low) / range) * 100
    : 50;
  const weakClosing = closingStrength < 50; // 하단 50% 이내 마감

  const warning = surge && extremeVolume && extremeOverbought;
  const pullbackWarning = significantDecline || weakClosing; // 되돌림 경고

  // 과열도 점수 (0~100, 높을수록 위험)
  let heatScore = 0;
  if (surgePercent > 50) heatScore += 40;
  else if (surgePercent > 30) heatScore += 25;

  if (volumeRatio > 15) heatScore += 35;
  else if (volumeRatio > 10) heatScore += 20;

  if (mfi > 95) heatScore += 25;
  else if (mfi > 90) heatScore += 15;

  // 고가 대비 낙폭 페널티 추가
  if (highDecline >= 15) heatScore += 30; // 15% 이상 급락
  else if (highDecline >= 10) heatScore += 20; // 10% 이상 하락

  return {
    warning,
    pullbackWarning,
    heatScore: Math.min(heatScore, 100),
    surge: surge,
    surgePercent: surgePercent.toFixed(1),
    extremeVolume: extremeVolume,
    extremeOverbought: extremeOverbought,
    highDecline: highDecline.toFixed(1),
    closingStrength: closingStrength.toFixed(1),
    message: warning
      ? '⚠️ 과열 종목 - 단기 조정 위험 높음'
      : pullbackWarning && highDecline >= 10
      ? `⚠️ 장중 되돌림 (고가대비 -${highDecline.toFixed(1)}%)`
      : heatScore > 50
      ? '⚠️ 과열 징후 - 신중 매수'
      : '✅ 정상 범위',
    recommendation: warning
      ? '매수 대기 (10~20% 조정 후 재진입 권장)'
      : pullbackWarning && highDecline >= 10
      ? `1일 급등 후 되돌림 - 익일 추가 하락 가능성 (고가 ${latest.high.toLocaleString()}원 돌파 대기)`
      : heatScore > 50
      ? '소량 분할 매수 권장'
      : '정상 매수 가능',
    scorePenalty: warning ? -50 : pullbackWarning && highDecline >= 10 ? -40 : heatScore > 50 ? -25 : 0
  };
}

/**
 * 종합 분석 및 점수화 (Phase 4 통합)
 */
function analyzeAdvanced(chartData, marketCap = 0) {
  // 기존 지표
  const whale = detectWhale(chartData, marketCap);
  const accumulation = detectSilentAccumulation(chartData);
  const escape = detectEscapeVelocity(chartData);
  const drain = detectLiquidityDrain(chartData);
  const asymmetric = calculateAsymmetricVolume(chartData);

  // Phase 4 신규 지표
  const gradualAccumulation = detectGradualAccumulation(chartData);
  const smartMoney = detectSmartMoney(chartData);
  const bottomFormation = detectBottomFormation(chartData);
  const breakoutPrep = detectBreakoutPreparation(chartData);

  // 종합 점수 계산 (0-100)
  let totalScore = 0;

  // 고래 감지 점수 (최대 25점)
  if (whale.length > 0) {
    const maxIntensity = Math.max(...whale.map(w => w.intensity));
    totalScore += Math.min(maxIntensity, 25);
  }

  // 조용한 매집 점수 (최대 25점)
  if (accumulation.detected) {
    totalScore += Math.min(accumulation.score / 2, 25);
  }

  // 탈출 속도 점수 (최대 30점)
  if (escape.detected) {
    totalScore += Math.min(escape.score, 30);
  }

  // 유동성 고갈 점수 (최대 10점)
  if (drain.detected) {
    totalScore += Math.min(drain.score / 5, 10);
  }

  // 비대칭 거래량 점수 (최대 10점)
  totalScore += Math.min(asymmetric.score / 5, 10);

  // Phase 4A: 선행 지표 보너스 (최대 30점)
  if (gradualAccumulation.detected) {
    totalScore += Math.min(gradualAccumulation.score / 3, 15);
  }
  if (smartMoney.detected) {
    totalScore += Math.min(smartMoney.score / 5, 10);
  }
  if (bottomFormation.detected) {
    totalScore += Math.min(bottomFormation.score / 3, 15);
  }

  // Phase 4B: 타이밍 지표 (최대 20점)
  if (breakoutPrep.detected) {
    totalScore += Math.min(breakoutPrep.score / 5, 20);
  }

  // 매수/매도 추천 (과열 체크 전)
  let recommendation = '관망';
  if (totalScore >= 70) recommendation = '🟢 강력 매수';
  else if (totalScore >= 50) recommendation = '🟡 매수 고려';
  else if (totalScore >= 30) recommendation = '⚪ 주목';
  else recommendation = '⚫ 관망';

  // 신호 수집 (중복 제거)
  const signals = [];

  // 고래 감지: 여러 건이 있어도 하나로 통합
  if (whale.length > 0) {
    const buyWhales = whale.filter(w => w.type.includes('매수'));
    const sellWhales = whale.filter(w => w.type.includes('매도'));
    if (buyWhales.length > 0) {
      signals.push(buyWhales.length === 1 ? '🐋 매수고래' : `🐋 매수고래 (${buyWhales.length}건)`);
    }
    if (sellWhales.length > 0) {
      signals.push(sellWhales.length === 1 ? '🐳 매도고래' : `🐳 매도고래 (${sellWhales.length}건)`);
    }
  }

  // 다른 신호들 추가 (없음 제외)
  [accumulation.signal, escape.signal, drain.signal, asymmetric.signal,
   gradualAccumulation.signal, smartMoney.signal, bottomFormation.signal, breakoutPrep.signal]
    .filter(s => s && s !== '없음')
    .forEach(s => signals.push(s));

  // 종목 티어 분류
  let tier = 'normal'; // normal, watch, buy, wait
  let readyIn = null;

  if (gradualAccumulation.detected || bottomFormation.detected) {
    tier = 'watch'; // 관심 종목 (선행 지표)
    readyIn = gradualAccumulation.readyIn || bottomFormation.readyIn;
  }

  if (breakoutPrep.detected || (escape.detected && totalScore >= 60)) {
    tier = 'buy'; // 매수 신호 (트리거 발동)
  }

  return {
    indicators: {
      // 기존 지표
      whale,
      accumulation,
      escape,
      drain,
      asymmetric,
      // Phase 4 신규 지표
      gradualAccumulation,
      smartMoney,
      bottomFormation,
      breakoutPrep
    },
    totalScore: Math.round(totalScore),
    recommendation,
    signals,
    tier,
    readyIn,
    triggerPrice: breakoutPrep.triggerPrice
  };
}

/**
 * 신규 지표 0: 기관/외국인 수급 분석 (Institutional Flow)
 * 연속 순매수일 체크
 */
function checkInstitutionalFlow(investorData) {
  if (!investorData || investorData.length < 3) {
    return {
      detected: false,
      institutionDays: 0,
      foreignDays: 0,
      signal: '데이터 부족',
      score: 0
    };
  }

  // 연속 순매수일 계산
  let institutionConsecutive = 0;
  let foreignConsecutive = 0;

  for (const day of investorData) {
    if (day.institution.netBuyQty > 0) {
      institutionConsecutive++;
    } else {
      break;
    }
  }

  for (const day of investorData) {
    if (day.foreign.netBuyQty > 0) {
      foreignConsecutive++;
    } else {
      break;
    }
  }

  const institutionBuying = institutionConsecutive >= 3;
  const foreignBuying = foreignConsecutive >= 3;
  const bothBuying = institutionBuying && foreignBuying;

  return {
    detected: institutionBuying || foreignBuying,
    institutionDays: institutionConsecutive,
    foreignDays: foreignConsecutive,
    signal: bothBuying ? '🔥 기관+외국인 동반 매수' :
            institutionBuying ? '🏢 기관 연속 매수' :
            foreignBuying ? '🌍 외국인 연속 매수' : '없음',
    score: bothBuying ? 15 : (institutionBuying || foreignBuying) ? 10 : 0,
    interpretation: bothBuying
      ? `기관 ${institutionConsecutive}일 + 외국인 ${foreignConsecutive}일 연속 매수 - 강한 신호`
      : institutionBuying
      ? `기관 ${institutionConsecutive}일 연속 순매수 중`
      : foreignBuying
      ? `외국인 ${foreignConsecutive}일 연속 순매수 중`
      : '스마트 머니 유입 미확인'
  };
}

/**
 * 신규 지표 1: 돌파 확인 (Breakout Confirmation)
 * 20일 고가 돌파 + 거래량 동반 여부 확인
 */
function detectBreakoutConfirmation(chartData, currentPrice, currentVolume) {
  const recent20 = chartData.slice(0, 20); // 최근 20일

  // 20일 고가 (저항선)
  const resistance20d = Math.max(...recent20.map(d => d.high));

  // 평균 거래량
  const avgVolume = recent20.reduce((sum, d) => sum + d.volume, 0) / 20;

  // 돌파 조건
  const breakout = currentPrice > resistance20d;
  const volumeConfirmation = currentVolume >= avgVolume * 2; // 2배 이상

  const confirmed = breakout && volumeConfirmation;

  return {
    detected: confirmed,
    resistance: Math.round(resistance20d),
    currentPrice: Math.round(currentPrice),
    breakoutPercent: ((currentPrice - resistance20d) / resistance20d * 100).toFixed(2),
    volumeRatio: (currentVolume / avgVolume).toFixed(2),
    signal: confirmed ? '✅ 돌파 확인 (거래량 동반)' :
            breakout ? '⚠️ 돌파했으나 거래량 부족' : '돌파 전',
    score: confirmed ? 15 : 0,
    interpretation: confirmed
      ? `20일 저항선 ${Math.round(resistance20d)}원 돌파 성공 - 추가 상승 기대`
      : '돌파 미확인'
  };
}

/**
 * 신규 지표 2: 이상 탐지 (Anomaly Detection)
 * Z-Score 기반 통계적 이상치 감지
 */
function detectAnomaly(chartData) {
  const recent20 = chartData.slice(0, 20); // 최근 20일
  const latest = recent20[0]; // 오늘

  // 거래량 Z-Score 계산
  const volumes = recent20.map(d => d.volume);
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const stdDev = Math.sqrt(
    volumes.reduce((sum, v) => sum + Math.pow(v - avgVolume, 2), 0) / volumes.length
  );

  const zScore = stdDev > 0 ? (latest.volume - avgVolume) / stdDev : 0;

  // 이상치 판단 (|Z-Score| > 3)
  const isAnomaly = Math.abs(zScore) > 3;
  const isSurge = zScore > 3; // 급등
  const isDrop = zScore < -3; // 급락

  return {
    detected: isAnomaly,
    zScore: zScore.toFixed(2),
    avgVolume: Math.round(avgVolume),
    currentVolume: latest.volume,
    stdDev: Math.round(stdDev),
    signal: isSurge ? '🚨 이상 급등 (통계적)' :
            isDrop ? '📉 이상 급락' : '정상 범위',
    score: isAnomaly ? Math.min(Math.abs(zScore) * 3, 10) : 0,
    interpretation: isSurge
      ? `평균 대비 ${zScore.toFixed(1)} 표준편차 급등 - 비정상적 거래량`
      : isDrop
      ? `평균 대비 ${Math.abs(zScore).toFixed(1)} 표준편차 급락 - 거래 감소`
      : '정상 거래량 범위'
  };
}

/**
 * 신규 지표 3: 위험 조정 점수 (Risk-Adjusted Score)
 * 변동성(표준편차) 대비 수익률 계산 (Sharpe Ratio 간소화 버전)
 */
function calculateRiskAdjustedScore(chartData) {
  const recent20 = chartData.slice(0, 20); // 최근 20일

  // 일별 수익률 계산
  const returns = [];
  for (let i = 1; i < recent20.length; i++) {
    const ret = (recent20[i].close - recent20[i - 1].close) / recent20[i - 1].close;
    returns.push(ret);
  }

  // 평균 수익률
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  // 표준편차 (변동성)
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Sharpe Ratio 간소화 (무위험 수익률 0 가정)
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

  // 평가
  const isGood = sharpeRatio > 1.0; // Sharpe > 1.0: 좋음
  const isExcellent = sharpeRatio > 2.0; // Sharpe > 2.0: 매우 좋음

  return {
    sharpeRatio: sharpeRatio.toFixed(2),
    avgReturn: (avgReturn * 100).toFixed(2),
    volatility: (stdDev * 100).toFixed(2),
    signal: isExcellent ? '🌟 위험 대비 수익 우수' :
            isGood ? '✅ 위험 대비 수익 양호' :
            sharpeRatio < 0 ? '⚠️ 위험 대비 손실' : '보통',
    score: isGood ? Math.min(sharpeRatio * 5, 10) : 0,
    interpretation: isExcellent
      ? '낮은 변동성으로 안정적 상승 - 저위험 고수익'
      : isGood
      ? '수익/위험 비율 양호 - 추천'
      : sharpeRatio < 0
      ? '변동성 높고 수익 마이너스 - 위험'
      : '보통 수준'
  };
}

/**
 * 신규 지표 4: Confluence (합류점) 점수
 * 여러 지표가 동시에 신호를 보내면 신뢰도 증가
 */
function calculateConfluenceScore(analysisResult, additionalIndicators = {}) {
  const signals = [];

  // 기존 지표 신호 수집
  if (analysisResult.indicators.whale?.length > 0) {
    signals.push({ name: '고래 감지', weight: 1.0, score: 10 });
  }
  if (analysisResult.indicators.accumulation?.detected) {
    signals.push({ name: '조용한 매집', weight: 1.2, score: 12 });
  }
  if (analysisResult.indicators.escape?.detected) {
    signals.push({ name: '탈출 속도', weight: 1.5, score: 15 });
  }
  if (analysisResult.indicators.gradualAccumulation?.detected) {
    signals.push({ name: '조용한 누적', weight: 1.3, score: 13 });
  }
  if (analysisResult.indicators.smartMoney?.detected) {
    signals.push({ name: '스마트머니', weight: 1.1, score: 11 });
  }
  if (analysisResult.indicators.breakoutPrep?.detected) {
    signals.push({ name: '돌파 준비', weight: 1.4, score: 14 });
  }

  // 신규 지표 신호 수집
  if (additionalIndicators.institutionalFlow?.detected) {
    signals.push({ name: '기관/외국인 매수', weight: 1.3, score: 13 });
  }
  if (additionalIndicators.breakoutConfirmation?.detected) {
    signals.push({ name: '돌파 확인', weight: 1.5, score: 15 });
  }
  if (additionalIndicators.anomaly?.detected) {
    signals.push({ name: '이상 급등', weight: 1.0, score: 10 });
  }
  if (additionalIndicators.riskAdjusted?.sharpeRatio > 1.0) {
    signals.push({ name: '위험 대비 양호', weight: 0.8, score: 8 });
  }

  // Confluence 점수 계산
  const confluenceCount = signals.length;
  let confluenceScore = 0;

  if (confluenceCount >= 5) {
    // 5개 이상 신호 = 매우 강한 신호 (+20점)
    confluenceScore = 20;
  } else if (confluenceCount >= 3) {
    // 3~4개 신호 = 강한 신호 (+15점)
    confluenceScore = 15;
  } else if (confluenceCount >= 2) {
    // 2개 신호 = 중간 신호 (+10점)
    confluenceScore = 10;
  } else if (confluenceCount === 1) {
    // 1개 신호만 = 약한 신호 (+5점)
    confluenceScore = 5;
  }

  return {
    confluenceCount,
    signals: signals.map(s => s.name),
    confluenceScore,
    signal: confluenceCount >= 5 ? '🔥🔥🔥 초강력 합류점 (5개+)' :
            confluenceCount >= 3 ? '🔥🔥 강력 합류점 (3~4개)' :
            confluenceCount >= 2 ? '🔥 중간 합류점 (2개)' :
            confluenceCount === 1 ? '⚠️ 단일 신호' : '없음',
    interpretation: confluenceCount >= 3
      ? `${confluenceCount}개 지표가 동시 신호 - 신뢰도 매우 높음`
      : confluenceCount >= 2
      ? `${confluenceCount}개 지표가 신호 - 신뢰도 중간`
      : '단일 신호 또는 신호 없음 - 신중 필요'
  };
}

/**
 * 신규 지표 5: 신호 신선도 (Signal Freshness)
 * 최근 1~2일 내 발생한 신호만 높은 점수
 */
function calculateSignalFreshness(chartData, analysisResult, additionalIndicators = {}) {
  // chartData[0]=오늘, chartData[1]=어제 (아래 latestDate/yesterdayDate에서 직접 참조)
  const latestDate = chartData[0].date;  // chartData는 내림차순 (최신 데이터가 0번 인덱스)
  const yesterdayDate = chartData.length >= 2 ? chartData[1].date : null;  // 1번 인덱스가 어제

  const freshSignals = [];
  let freshnessScore = 0;

  // 고래 감지 신선도 (최근 2일 내 발생)
  if (analysisResult.indicators.whale?.length > 0) {
    const recentWhale = analysisResult.indicators.whale.filter(w =>
      w.date === latestDate || w.date === yesterdayDate
    );
    if (recentWhale.length > 0) {
      freshSignals.push({ name: '고래 감지', days: recentWhale[0].date === latestDate ? 0 : 1 });
      freshnessScore += recentWhale[0].date === latestDate ? 10 : 7;
    }
  }

  // 조용한 매집 (항상 최근 데이터 기반)
  if (analysisResult.indicators.accumulation?.detected) {
    freshSignals.push({ name: '조용한 매집', days: 0 });
    freshnessScore += 8;
  }

  // 탈출 속도 (최근 데이터 기반)
  if (analysisResult.indicators.escape?.detected) {
    freshSignals.push({ name: '탈출 속도', days: 0 });
    freshnessScore += 10;
  }

  // 돌파 확인 (최근 데이터)
  if (additionalIndicators.breakoutConfirmation?.detected) {
    freshSignals.push({ name: '돌파 확인', days: 0 });
    freshnessScore += 12;
  }

  // 기관/외국인 매수 (연속일이므로 신선도 높음)
  if (additionalIndicators.institutionalFlow?.detected) {
    freshSignals.push({ name: '기관/외국인', days: 0 });
    freshnessScore += 10;
  }

  // 이상 급등 (최근 데이터)
  if (additionalIndicators.anomaly?.detected) {
    freshSignals.push({ name: '이상 급등', days: 0 });
    freshnessScore += 8;
  }

  // 신선도 평가
  const isFresh = freshSignals.length >= 2;
  const isVeryFresh = freshSignals.length >= 3;

  return {
    freshSignals: freshSignals.map(s => `${s.name} (D-${s.days})`),
    freshCount: freshSignals.length,
    freshnessScore: Math.min(freshnessScore, 15), // 최대 15점
    signal: isVeryFresh ? '🟢 매우 신선한 신호 (3개+)' :
            isFresh ? '🟡 신선한 신호 (2개)' :
            freshSignals.length === 1 ? '⚪ 단일 신선 신호' : '⚫ 오래된 신호',
    interpretation: isVeryFresh
      ? `${freshSignals.length}개 신호가 최근 1~2일 내 발생 - 즉시 대응 필요`
      : isFresh
      ? `${freshSignals.length}개 신호가 신선함 - 빠른 대응 권장`
      : '신호가 오래되었거나 없음 - 관망'
  };
}

/**
 * ========================================
 * VPM (Volume-Price Momentum) 통합 지표
 * ========================================
 */

/**
 * 거래량 예측 (선형회귀)
 * 최근 20일 데이터로 내일 거래량 예측
 */
function predictVolume(chartData) {
  const recent20 = chartData.slice(0, 20); // 최근 20일 (내림차순: [0]=오늘)

  // 선형회귀: y = a*x + b
  const n = recent20.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  // 내림차순이므로 recent20[0]=오늘(가장 최근). x축은 오래된→최근 순으로 매핑
  recent20.forEach((d, i) => {
    const x = n - i; // 20, 19, ..., 1 (오래된=20, 오늘=1 → 시간 순)
    const y = d.volume;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  });

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // 내일(21일) 예측
  const predicted = slope * (n + 1) + intercept;
  const avgVolume = sumY / n;

  // 가속도 감지 (최근 5일 vs 이전 15일)
  const recent5 = recent20.slice(0, 5);   // 최근 5일
  const before15 = recent20.slice(5, 20); // 이전 15일

  const slope_recent = recent5.reduce((sum, d, i) => sum + (d.volume * (i + 1)), 0) / 15;
  const slope_before = before15.reduce((sum, d, i) => sum + (d.volume * (i + 1)), 0) / 120;

  const acceleration = slope_recent / slope_before;
  const trend = acceleration > 1.3 ? "accelerating" :
                acceleration > 0.8 ? "steady" : "decelerating";

  // 신뢰도 계산 (R-squared 간소화)
  const meanY = avgVolume;
  let ssTotal = 0, ssResidual = 0;
  recent20.forEach((d, i) => {
    const x = i + 1;
    const yActual = d.volume;
    const yPredicted = slope * x + intercept;
    ssTotal += Math.pow(yActual - meanY, 2);
    ssResidual += Math.pow(yActual - yPredicted, 2);
  });
  const rSquared = 1 - (ssResidual / ssTotal);
  const confidence = Math.max(Math.min(rSquared * 100, 95), 50); // 50-95%

  return {
    predicted: Math.round(predicted),
    current: recent20[0].volume, // 오늘 거래량
    average: Math.round(avgVolume),
    ratio: (predicted / avgVolume).toFixed(2),
    trend,
    acceleration: acceleration.toFixed(2),
    confidence: Math.round(confidence),
    signal: predicted > avgVolume * 1.5 ? "🚀 거래량 급증 예상" :
            predicted > avgVolume * 1.2 ? "📈 거래량 증가 예상" :
            predicted < avgVolume * 0.8 ? "📉 거래량 감소 예상" : "보통"
  };
}

/**
 * VPT (Volume Price Trend) 계산
 * OBV보다 정교함 - 가격 변동률 반영
 */
function calculateVPT(chartData) {
  const vptValues = [];
  let vpt = 0;

  for (let i = 1; i < chartData.length; i++) {
    const priceChange = (chartData[i].close - chartData[i - 1].close) / chartData[i - 1].close;
    vpt += chartData[i].volume * priceChange;
    vptValues.push(vpt);
  }

  // VPT 추세 분석 (최근 5일)
  const recent5 = vptValues.slice(-5);
  const before5 = vptValues.slice(-10, -5);

  const avgRecent = recent5.reduce((a, b) => a + b, 0) / 5;
  const avgBefore = before5.reduce((a, b) => a + b, 0) / 5;

  const slope = avgRecent - avgBefore;
  const trend = slope > 0 ? "rising" : slope < 0 ? "falling" : "flat";

  return {
    values: vptValues,
    current: vptValues[vptValues.length - 1],
    slope: slope.toFixed(2),
    trend,
    signal: trend === "rising" ? "🟢 자금 유입" :
            trend === "falling" ? "🔴 자금 유출" : "⚪ 횡보"
  };
}

/**
 * Divergence 분석 (맥락 고려)
 * 검증된 로직만 사용
 */
function analyzeVolumePriceDivergence(chartData, vpt, institutionalFlow) {
  const recent5 = chartData.slice(0, 5);   // 최근 5일 (chartData[0]=오늘, 내림차순)
  const recent30 = chartData.slice(0, 30); // 최근 30일

  // 가격 추세 (최신 vs 과거: [0]=오늘, [4]=5일전, [29]=30일전)
  const priceChange5d = (recent5[0].close - recent5[recent5.length - 1].close) / recent5[recent5.length - 1].close;
  const priceChange30d = (recent30[0].close - recent30[recent30.length - 1].close) / recent30[recent30.length - 1].close;

  // 거래량 추세
  const avgVol_recent = recent5.reduce((sum, d) => sum + d.volume, 0) / 5;
  const avgVol_before = chartData.slice(5, 25).reduce((sum, d) => sum + d.volume, 0) / Math.min(20, chartData.slice(5, 25).length || 1);
  const volumeChange = (avgVol_recent - avgVol_before) / avgVol_before;

  // VPT 추세
  const vptSlope = parseFloat(vpt.slope);

  // === 패턴 1: 거래량↑ + 가격 횡보 (검증됨) ===
  if (volumeChange > 0.2 && Math.abs(priceChange5d) < 0.03) {
    return {
      pattern: "accumulation",
      signal: "🟢 조용한 매집",
      prediction: "상승 예상",
      confidence: 80,
      reason: "가격 자극 없는 거래량 증가 = 세력 매집",
      evidence: "학술 검증됨 (Granville)",
      priceMove: "+5~10%",
      timeframe: "1~3일"
    };
  }

  // === 패턴 2: 거래량↑ + 가격↓ (맥락 필수) ===
  if (volumeChange > 0.3 && priceChange5d < -0.05) {
    // 조건 A: VPT 상승 (매수세 우세)
    if (vptSlope > 0) {
      return {
        pattern: "bullish_divergence",
        signal: "🟢 저점 매집",
        prediction: "반등 예상",
        confidence: 70,
        reason: "VPT 상승 = 하락 중 매수세 유입",
        evidence: "VPT 이론 (검증됨)",
        priceMove: "+5~15%",
        timeframe: "2~5일"
      };
    }

    // 조건 B: 기관/외국인 매수 (강력)
    if (institutionalFlow?.detected) {
      return {
        pattern: "institutional_accumulation",
        signal: "🟢 기관 매집",
        prediction: "반등 예상",
        confidence: 75,
        reason: "하락장에서 기관/외국인 매수",
        evidence: "기관 수급 데이터 (실제)",
        priceMove: "+8~15%",
        timeframe: "1~5일"
      };
    }

    // 조건 C: VPT 하락 (매도세 우세)
    if (vptSlope < 0) {
      return {
        pattern: "panic_selling",
        signal: "🔴 패닉 매도",
        prediction: "추가 하락 위험",
        confidence: 70,
        reason: "VPT 하락 = 공포 매도 진행",
        evidence: "VPT 이론",
        priceMove: "-5~15%",
        timeframe: "1~3일"
      };
    }
  }

  // === 패턴 3: 거래량↓ + 가격↑ (맥락 필수) ===
  if (volumeChange < -0.2 && priceChange5d > 0.05) {
    // 조건 A: 초기 상승 (정상)
    if (priceChange30d < 0.10 && vptSlope > 0) {
      return {
        pattern: "healthy_uptrend",
        signal: "🟢 건강한 상승",
        prediction: "상승 지속",
        confidence: 65,
        reason: "초기 상승, 거래량 정상화 자연스러움",
        evidence: "경험적 관찰",
        priceMove: "+5~10%",
        timeframe: "3~7일"
      };
    }

    // 조건 B: 과열 (위험)
    if (priceChange30d > 0.30) {
      return {
        pattern: "weakening_momentum",
        signal: "🔴 모멘텀 약화",
        prediction: "조정 위험",
        confidence: 70,
        reason: "30% 급등 후 거래량 감소 = 피크아웃",
        evidence: "경험적 관찰",
        priceMove: "-5~10%",
        timeframe: "1~3일"
      };
    }

    // 조건 C: VPT 여전히 상승 (OK)
    if (vptSlope > 0) {
      return {
        pattern: "consolidation",
        signal: "🟡 정상 조정",
        prediction: "상승 지속 가능",
        confidence: 60,
        reason: "VPT 상승 = 자금 유입 지속",
        evidence: "VPT 이론",
        priceMove: "+3~8%",
        timeframe: "3~7일"
      };
    }
  }

  // === 패턴 4: 거래량↑ + 가격↑ (이상적) ===
  if (volumeChange > 0.3 && priceChange5d > 0.05) {
    return {
      pattern: "strong_uptrend",
      signal: "🔥 강한 상승",
      prediction: "추가 상승 기대",
      confidence: 85,
      reason: "거래량 동반 상승 = 건강한 상승세",
      evidence: "기술적 분석 정석",
      priceMove: "+10~20%",
      timeframe: "1~3일"
    };
  }

  // === 패턴 없음 ===
  return {
    pattern: "neutral",
    signal: "⚪ 중립",
    prediction: "관망",
    confidence: 50,
    reason: "명확한 신호 없음",
    evidence: "N/A",
    priceMove: "±3%",
    timeframe: "불명"
  };
}

/**
 * VPM 통합 함수
 * 거래량 예측 + VPT + Divergence → 가격 방향 예측
 */
function calculateVPM(chartData, currentPrice, currentVolume, institutionalFlow) {
  // 1. 거래량 예측
  const volumeForecast = predictVolume(chartData);

  // 2. VPT 계산
  const vpt = calculateVPT(chartData);

  // 3. Divergence 분석
  const divergence = analyzeVolumePriceDivergence(chartData, vpt, institutionalFlow);

  // 4. 가격 방향 예측 (신뢰도 70% 이상만)
  let priceDirection = {
    prediction: "관망",
    probability: 50,
    expectedMove: "±3%",
    timeframe: "불명"
  };

  if (divergence.confidence >= 70) {
    priceDirection = {
      prediction: divergence.prediction,
      probability: divergence.confidence,
      expectedMove: divergence.priceMove,
      timeframe: divergence.timeframe
    };
  }

  // 5. 점수 계산
  let score = 0;

  // Divergence 점수
  if (divergence.confidence >= 80 && divergence.signal.includes("🟢")) {
    score += 25; // 강력 매수
  } else if (divergence.confidence >= 70 && divergence.signal.includes("🟢")) {
    score += 20; // 매수
  } else if (divergence.confidence >= 80 && divergence.signal.includes("🔥")) {
    score += 30; // 최고 매수
  } else if (divergence.signal.includes("🔴")) {
    score -= 20; // 위험
  }

  // 거래량 예측 가속 점수
  if (volumeForecast.trend === "accelerating") {
    score += 10;
  }

  // VPT 추세 점수
  if (vpt.trend === "rising") {
    score += 5;
  }

  return {
    volumeForecast,
    vpt,
    divergence,
    priceDirection,
    score: Math.min(Math.max(score, -20), 35), // -20 ~ +35점
    signal: divergence.signal,
    summary: `${divergence.signal} | 거래량 ${volumeForecast.signal} | VPT ${vpt.signal}`
  };
}

/**
 * ========================================
 * 차트 패턴 인식 (Pattern Recognition)
 * ========================================
 */

/**
 * Cup and Handle 패턴 감지
 * U자형 바닥 + 손잡이 형성 → 돌파 임박
 */
function detectCupAndHandle(chartData) {
  if (chartData.length < 30) {
    return { detected: false, signal: "데이터 부족" };
  }

  const recent30 = chartData.slice(0, 30); // 최근 30일 (내림차순: [0]=오늘)

  // 1. Cup 형성 (U자형): 하락 → 바닥 → 상승
  // 내림차순이므로: [20-29]=가장 오래됨(초반), [10-19]=중간, [0-9]=최근
  const firstThird = recent30.slice(20, 30); // 가장 오래된 10일 (cup 시작)
  const middleThird = recent30.slice(10, 20); // 중간 10일 (cup 바닥)
  const lastThird = recent30.slice(0, 10);    // 최근 10일 (cup 회복)

  const firstAvg = firstThird.reduce((sum, d) => sum + d.close, 0) / 10;
  const middleAvg = middleThird.reduce((sum, d) => sum + d.close, 0) / 10;
  const lastAvg = lastThird.reduce((sum, d) => sum + d.close, 0) / 10;

  // Cup 조건: 중간이 가장 낮고, 양쪽이 비슷한 높이
  const cupFormed = middleAvg < firstAvg * 0.9 &&
                    lastAvg > middleAvg * 1.05 &&
                    Math.abs(lastAvg - firstAvg) / firstAvg < 0.1;

  if (!cupFormed) {
    return { detected: false, signal: "Cup 미형성" };
  }

  // 2. Handle 형성 (작은 하락 후 횡보) - 최근 5일
  const handle = recent30.slice(0, 5);
  const handleHigh = Math.max(...handle.map(d => d.high));
  const handleLow = Math.min(...handle.map(d => d.low));
  const handleRange = (handleHigh - handleLow) / handleLow;

  const handleFormed = handleRange < 0.08; // 8% 이내 변동

  // 3. 거래량 패턴 (Cup 중간에 감소, Handle에서 증가)
  const cupVolAvg = middleThird.reduce((sum, d) => sum + d.volume, 0) / 10;
  const handleVolAvg = handle.reduce((sum, d) => sum + d.volume, 0) / 5;
  const volumeIncreasing = handleVolAvg > cupVolAvg * 1.2;

  const detected = cupFormed && handleFormed && volumeIncreasing;

  return {
    detected,
    signal: detected ? "🏆 Cup&Handle 패턴 (돌파 임박)" : "패턴 미완성",
    cupDepth: ((firstAvg - middleAvg) / firstAvg * 100).toFixed(1),
    handleRange: (handleRange * 100).toFixed(1),
    volumeConfirm: volumeIncreasing,
    score: detected ? 20 : 0,
    interpretation: detected
      ? `U자형 바닥 완성 + 손잡이 형성 → 돌파 시 +15~30% 상승 기대`
      : "패턴 형성 중"
  };
}

/**
 * Triangle 패턴 감지 (삼각수렴)
 * 고점 낮아지고 저점 높아지면서 수렴 → 돌파 임박
 */
function detectTriangle(chartData) {
  if (chartData.length < 20) {
    return { detected: false, signal: "데이터 부족" };
  }

  const recent20 = chartData.slice(0, 20); // 최근 20일 (내림차순: [0]=오늘)

  // 고점/저점 찾기 (내림차순 데이터에서 시간순 비교)
  const highs = [];
  const lows = [];

  for (let i = 1; i < recent20.length - 1; i++) {
    // 고점: 양쪽보다 높음
    if (recent20[i].high > recent20[i - 1].high &&
        recent20[i].high > recent20[i + 1].high) {
      highs.push({ index: i, value: recent20[i].high });
    }
    // 저점: 양쪽보다 낮음
    if (recent20[i].low < recent20[i - 1].low &&
        recent20[i].low < recent20[i + 1].low) {
      lows.push({ index: i, value: recent20[i].low });
    }
  }

  if (highs.length < 2 || lows.length < 2) {
    return { detected: false, signal: "고점/저점 부족" };
  }

  // 내림차순이므로 highs[0]=최근, highs[last]=오래됨
  // 시간순(오래됨→최근) 고점 추세: 하향이면 수렴
  const highSlope = (highs[0].value - highs[highs.length - 1].value) / (highs.length - 1);

  // 시간순 저점 추세: 상향이면 수렴
  const lowSlope = (lows[0].value - lows[lows.length - 1].value) / (lows.length - 1);

  // Triangle 조건: 고점 하향 + 저점 상향 (수렴)
  const triangleFormed = highSlope < 0 && lowSlope > 0;

  // 수렴도 (범위가 좁아지는 정도) — 내림차순이므로 [last]=오래됨, [0]=최근
  const initialRange = highs[highs.length - 1].value - lows[lows.length - 1].value; // 오래된 범위
  const currentRange = highs[0].value - lows[0].value; // 최근 범위
  const convergence = (1 - currentRange / initialRange) * 100;

  // 거래량 감소 (삼각수렴 특징) — 내림차순: [0-9]=최근, [10-19]=오래됨
  const recentVolTotal = recent20.slice(0, 10).reduce((sum, d) => sum + d.volume, 0) / 10;
  const olderVolTotal = recent20.slice(10, 20).reduce((sum, d) => sum + d.volume, 0) / 10;
  const volumeDecreasing = recentVolTotal < olderVolTotal * 0.8;

  const detected = triangleFormed && convergence > 30 && volumeDecreasing;

  return {
    detected,
    signal: detected ? "📐 Triangle 패턴 (돌파 임박)" : "패턴 미형성",
    type: "symmetrical", // 대칭 삼각형
    convergence: convergence.toFixed(1),
    volumePattern: volumeDecreasing ? "감소 중 (정상)" : "비정상",
    score: detected ? 15 : 0,
    interpretation: detected
      ? `삼각수렴 ${convergence.toFixed(0)}% 완성 → 돌파 방향으로 +10~20% 움직임`
      : "패턴 형성 중"
  };
}

/**
 * 신규 지표 6: 작전주 필터 (Manipulation Detection)
 * 저시가총액 + 급등락 반복 패턴 감지
 */
function detectManipulation(chartData, marketCap) {
  // 1. 저시가총액 체크 (500억 미만)
  const lowMarketCap = marketCap < 50000000000; // 500억원

  // 2. 급등락 반복 패턴 체크 (최근 20일)
  const recent20 = chartData.slice(0, 20);
  const priceChanges = [];

  for (let i = 1; i < recent20.length; i++) {
    const change = ((recent20[i].close - recent20[i - 1].close) / recent20[i - 1].close) * 100;
    priceChanges.push(change);
  }

  // 10% 이상 급등/급락 일수
  const surgeDays = priceChanges.filter(c => c >= 10).length;
  const dropDays = priceChanges.filter(c => c <= -10).length;
  const volatileDays = surgeDays + dropDays;

  // 작전주 의심: 저시총 + 급등락 5일 이상
  const suspected = lowMarketCap && volatileDays >= 5;

  return {
    suspected,
    marketCap: Math.round(marketCap / 100000000), // 억원 단위
    volatileDays,
    surgeDays,
    dropDays,
    signal: suspected ? '⚠️ 작전주 의심' : '정상',
    scorePenalty: suspected ? -30 : 0, // 30점 감점
    interpretation: suspected
      ? `저시총(${Math.round(marketCap / 100000000)}억) + 급등락 ${volatileDays}일 - 작전주 의심`
      : '정상 종목'
  };
}

/**
 * 신규 지표 7: 유동성 필터 (Liquidity Check)
 * 일평균 거래대금 체크
 */
function checkLiquidity(chartData) {
  const recent10 = chartData.slice(0, 10); // 최근 10일

  // 일평균 거래대금 계산 (원 단위)
  const avgTradingValue = recent10.reduce((sum, d) => sum + d.tradingValue, 0) / 10;

  // 최소 거래대금 기준: 10억원
  const minTradingValue = 1000000000; // 10억원
  const sufficient = avgTradingValue >= minTradingValue;

  // 초저유동성: 1억원 미만
  const veryLow = avgTradingValue < 100000000; // 1억원

  return {
    sufficient,
    avgTradingValue: Math.round(avgTradingValue / 100000000), // 억원 단위
    minRequired: Math.round(minTradingValue / 100000000), // 억원 단위
    signal: veryLow ? '⚠️ 초저유동성' :
            !sufficient ? '⚠️ 유동성 부족' : '✅ 유동성 충분',
    scorePenalty: veryLow ? -40 : !sufficient ? -20 : 0,
    interpretation: veryLow
      ? `일평균 거래대금 ${Math.round(avgTradingValue / 100000000)}억원 - 매매 어려움`
      : !sufficient
      ? `일평균 거래대금 ${Math.round(avgTradingValue / 100000000)}억원 - 기준(10억) 미달`
      : `일평균 거래대금 ${Math.round(avgTradingValue / 100000000)}억원 - 충분`
  };
}

/**
 * 신규 지표 8: 과거 급등 이력 필터 (Previous Surge Filter)
 * 최근 30일 내 이미 급등한 종목 제외
 */
function checkPreviousSurge(chartData) {
  const recent30 = chartData.slice(0, 30); // 최근 30일 (내림차순: [0]=오늘)

  // 30일 전 가격 대비 현재 가격
  const oldestPrice = recent30[recent30.length - 1].close; // 30일 전
  const currentPrice = recent30[0].close; // 오늘
  const totalChange = ((currentPrice - oldestPrice) / oldestPrice) * 100;

  // 40% 이상 이미 급등
  const alreadySurged = totalChange >= 40;

  // 최근 10일간 추가 급등 여부 (20% 이상)
  const recent10 = recent30.slice(0, 10);
  const recent10Change = ((recent10[0].close - recent10[recent10.length - 1].close) / recent10[recent10.length - 1].close) * 100;
  const recentSurge = recent10Change >= 20;

  return {
    alreadySurged,
    totalChange: totalChange.toFixed(2),
    recent10Change: recent10Change.toFixed(2),
    signal: alreadySurged ? '⚠️ 이미 급등' : '✅ 정상 범위',
    scorePenalty: alreadySurged ? -25 : 0,
    interpretation: alreadySurged
      ? `최근 30일간 ${totalChange.toFixed(1)}% 상승 - 고점 매수 위험`
      : recentSurge
      ? `최근 10일간 ${recent10Change.toFixed(1)}% 상승 - 모멘텀 있음`
      : '정상 가격 범위'
  };
}

module.exports = {
  detectWhale,
  detectSilentAccumulation,
  detectEscapeVelocity,
  detectLiquidityDrain,
  calculateAsymmetricVolume,
  checkVolumeConsecutiveIncrease,
  detectGradualAccumulation,
  detectSmartMoney,
  detectBottomFormation,
  detectBreakoutPreparation,
  checkOverheating,
  analyzeAdvanced,
  // 신규 지표
  checkInstitutionalFlow,
  detectBreakoutConfirmation,
  detectAnomaly,
  calculateRiskAdjustedScore,
  calculateConfluenceScore,
  calculateSignalFreshness,
  detectManipulation,
  checkLiquidity,
  checkPreviousSurge,
  // VPM 통합 지표
  predictVolume,
  calculateVPT,
  analyzeVolumePriceDivergence,
  calculateVPM,
  // 차트 패턴 인식
  detectCupAndHandle,
  detectTriangle
};
