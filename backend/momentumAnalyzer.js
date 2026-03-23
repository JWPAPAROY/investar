/**
 * 장중 모멘텀 분석 모듈 (v3.70)
 * 6차원 복합 시그널로 매수세 유지/이탈 판단
 */

function analyzeIntradayMomentum(stock, prevVolume, minuteData, checkpointVolumes = []) {
  const result = {
    volumeChange: null,       // 전일 동시간대 대비 거래량 변화율(%)
    priceVolumeSignal: null,  // 가격-거래량 관계
    buyStrength: null,        // 체결강도 (매수틱/매도틱 비율, 100=1:1)
    upperShadow: null,        // 윗꼬리 비율(%)
    volumeAccel: null,        // 장중 거래량 가속도
    pricePosition: null,      // 장중 가격 위치 (0~100, 100=고가)
    composite: null,          // 종합 판정
    compositeScore: 0,        // 종합 점수
    emoji: '',
    label: ''
  };

  let score = 0;

  // 1. 거래량 변화 (전일 동시간대 대비)
  if (prevVolume && prevVolume > 0 && stock.volume > 0) {
    const volChange = ((stock.volume - prevVolume) / prevVolume * 100);
    result.volumeChange = Math.round(volChange);
    if (volChange >= 50) score += 1;
    else if (volChange >= 0) score += 0.5;
    else if (volChange >= -30) score += 0;
    else score -= 1;
  }

  // 2. 가격-거래량 관계
  const returnRate = stock.return_rate || 0;
  const volUp = result.volumeChange !== null ? result.volumeChange > 0 : null;
  if (volUp !== null) {
    if (volUp && returnRate > 0) {
      result.priceVolumeSignal = 'volume_confirm';
      score += 0.5;
    } else if (volUp && returnRate < -1) {
      result.priceVolumeSignal = 'sell_pressure';
      score -= 1;
    } else if (!volUp && returnRate > 0) {
      result.priceVolumeSignal = 'thin_rise';
      score += 0;
    } else if (!volUp && returnRate < -1) {
      result.priceVolumeSignal = 'quiet_decline';
      score -= 0.5;
    }
  }

  // 3. 체결강도 (분봉 데이터)
  if (minuteData && minuteData.length > 0) {
    let buyVolume = 0, sellVolume = 0;
    for (const bar of minuteData) {
      if (bar.changeRate > 0) buyVolume += bar.volume;
      else if (bar.changeRate < 0) sellVolume += bar.volume;
      else {
        buyVolume += bar.volume * 0.5;
        sellVolume += bar.volume * 0.5;
      }
    }
    const totalVol = buyVolume + sellVolume;
    if (totalVol > 0) {
      const ratio = sellVolume > 0 ? buyVolume / sellVolume : 2.0;
      result.buyStrength = Math.round(ratio * 100);
      if (ratio >= 1.3) score += 0.5;
      else if (ratio >= 0.8) score += 0;
      else score -= 0.5;
    }
  }

  // 4. 윗꼬리 비율
  if (stock.high > 0 && stock.current_price > 0 && stock.high > stock.current_price) {
    const shadow = ((stock.high - stock.current_price) / stock.high * 100);
    result.upperShadow = Math.round(shadow * 10) / 10;
    if (shadow >= 3) score -= 0.5;
  }

  // 5. 장중 거래량 가속도
  if (checkpointVolumes.length >= 1 && stock.volume > 0) {
    const allVolumes = [...checkpointVolumes, stock.volume];
    const deltas = [];
    for (let i = 1; i < allVolumes.length; i++) {
      deltas.push(Math.max(0, allVolumes[i] - allVolumes[i - 1]));
    }

    if (deltas.length >= 2) {
      const lastDelta = deltas[deltas.length - 1];
      const prevDelta = deltas[deltas.length - 2];

      if (prevDelta > 0) {
        const accelRatio = lastDelta / prevDelta;
        if (accelRatio >= 1.5) {
          result.volumeAccel = 'accelerating';
          score += 0.5;
        } else if (accelRatio >= 0.7) {
          result.volumeAccel = 'steady';
        } else if (accelRatio >= 0.3) {
          result.volumeAccel = 'decelerating';
          score -= 0.5;
        } else {
          result.volumeAccel = 'exhausting';
          score -= 1;
        }
      }
    } else if (deltas.length === 1) {
      const marginalVol = deltas[0];
      const prevCheckVol = checkpointVolumes[0];
      if (prevCheckVol > 0) {
        const ratio = marginalVol / prevCheckVol;
        if (ratio >= 0.8) result.volumeAccel = 'steady';
        else if (ratio >= 0.3) { result.volumeAccel = 'decelerating'; score -= 0.5; }
        else { result.volumeAccel = 'exhausting'; score -= 1; }
      }
    }
  }

  // 6. 장중 가격 위치
  if (stock.high > 0 && stock.low > 0 && stock.high > stock.low) {
    const range = stock.high - stock.low;
    const position = ((stock.current_price - stock.low) / range * 100);
    result.pricePosition = Math.round(Math.min(100, Math.max(0, position)));

    if (result.pricePosition >= 80) {
      score += 0.5;
    } else if (result.pricePosition <= 20) {
      score -= 0.5;
    }
  }

  // 종합 판정
  result.compositeScore = Math.round(score * 10) / 10;
  if (score >= 2.0) {
    result.composite = 'strong'; result.emoji = '🔥'; result.label = '매수세 강력';
  } else if (score >= 0.5) {
    result.composite = 'hold'; result.emoji = '💪'; result.label = '매수세 유지';
  } else if (score >= -0.5) {
    result.composite = 'neutral'; result.emoji = '➖'; result.label = '중립';
  } else if (score >= -1.5) {
    result.composite = 'weak'; result.emoji = '⚠️'; result.label = '매수세 약화';
  } else {
    result.composite = 'exit'; result.emoji = '🚨'; result.label = '매수세 이탈';
  }

  return result;
}

module.exports = { analyzeIntradayMomentum };
