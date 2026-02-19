const kisApi = require('./kisApi');
const volumeIndicators = require('./volumeIndicators');
const advancedIndicators = require('./advancedIndicators');
const smartPatternMiner = require('./smartPatternMining');

/**
 * 전체 종목 스크리닝 및 추천
 */
class StockScreener {
  constructor() {
    this.cachedResults = null;
    this.cacheTimestamp = null;
    this.cacheDuration = 60 * 60 * 1000; // 1시간 캐시
    this.savedPatterns = smartPatternMiner.loadSavedPatterns(); // 저장된 패턴 로드

  }

  /**
   * 추세 분석 (최근 5일 일자별)
   * @param {Array} chartData - 일봉 데이터
   * @param {Object} currentData - 현재가 정보 (실시간)
   */
  calculateTrendAnalysis(chartData, currentData = null) {
    if (!chartData || chartData.length < 6) {
      return null;
    }

    // 최근 5일 + 기준일(6일전) 필요
    const dailyData = [];

    for (let i = 0; i < 5; i++) {
      const today = chartData[i];
      const yesterday = chartData[i + 1];

      if (!today || !yesterday) continue;

      // 오늘(i=0) 데이터는 현재가 사용, 과거는 종가 사용
      const todayPrice = (i === 0 && currentData) ? currentData.currentPrice : today.close;
      const todayVolume = (i === 0 && currentData) ? currentData.volume : today.volume;

      // 전일 대비 주가 변동률
      const priceChange = ((todayPrice - yesterday.close) / yesterday.close) * 100;

      // 전일 대비 거래량 증가율
      const volumeChange = ((todayVolume - yesterday.volume) / yesterday.volume) * 100;

      // 해당 기간(1일~5일)의 누적 변동률
      const periodStart = chartData[i];
      const periodEnd = chartData[Math.min(i + (i + 1), chartData.length - 1)]; // i일 전부터 현재까지
      const periodPriceChange = periodEnd ? ((todayPrice - periodEnd.close) / periodEnd.close) * 100 : 0;
      const periodVolumeChange = periodEnd ? ((todayVolume - periodEnd.volume) / periodEnd.volume) * 100 : 0;

      dailyData.push({
        dayIndex: i + 1, // 1일전 = 오늘, 2일전 = 어제, ...
        date: today.date,
        close: todayPrice,  // 오늘은 현재가, 과거는 종가
        volume: todayVolume,  // 오늘은 누적거래량, 과거는 종가 거래량
        isToday: i === 0,  // 오늘 여부
        priceChange: parseFloat(priceChange.toFixed(2)),
        volumeChange: parseFloat(volumeChange.toFixed(2)),
        periodPriceChange: parseFloat(periodPriceChange.toFixed(2)),
        periodVolumeChange: parseFloat(periodVolumeChange.toFixed(2))
      });
    }

    // 기하평균 계산 함수
    const calculateGeometricMean = (changes) => {
      if (changes.length === 0) return 0;
      // 변동율을 승수로 변환 (예: +5% → 1.05, -3% → 0.97)
      const multipliers = changes.map(c => 1 + (c / 100));
      // 모든 승수를 곱함
      const product = multipliers.reduce((acc, val) => acc * val, 1);
      // n제곱근
      const geometricMean = Math.pow(product, 1 / multipliers.length);
      // 다시 백분율로 변환
      return ((geometricMean - 1) * 100).toFixed(2);
    };

    return {
      dailyData: dailyData, // 최근 5일 (0=오늘, 1=어제, 2=그저께, ...)
      summary: {
        totalPriceChange: dailyData.length > 0 ? dailyData[dailyData.length - 1].periodPriceChange : 0,
        totalVolumeChange: dailyData.length > 0 ? dailyData[dailyData.length - 1].periodVolumeChange : 0,
        // 기하평균 적용
        avgDailyPriceChange: dailyData.length > 0 ?
          calculateGeometricMean(dailyData.map(d => d.priceChange)) : 0,
        avgDailyVolumeChange: dailyData.length > 0 ?
          calculateGeometricMean(dailyData.map(d => d.volumeChange)) : 0
      }
    };
  }

  /**
   * 거래량 점진적 증가 (Volume Acceleration) 분석 (0-15점) ⬆️ 강화!
   * 30일 데이터 내에서 점진적 거래량 증가 패턴 감지
   * "조용한 매집" 신호 - 급증이 아닌 서서히 증가
   *
   * v3.9: 10→15점 확대 (Trend Score 비중 강화)
   */
  analyzeVolumeAcceleration(chartData) {
    if (!chartData || chartData.length < 25) {
      return { score: 0, detected: false, trend: 'insufficient_data' };
    }

    // 30일을 4개 구간으로 분할 (최근 → 과거)
    // Recent 5 days (D-0 to D-4)
    // Mid 5 days (D-5 to D-9)
    // Old 10 days (D-10 to D-19)
    // Oldest 10 days (D-20 to D-29)

    const recent5 = chartData.slice(0, 5);
    const mid5 = chartData.slice(5, 10);
    const old10 = chartData.slice(10, 20);
    const oldest10 = chartData.slice(20, 30);

    // 각 구간 평균 거래량 계산
    const avgRecent = recent5.reduce((sum, d) => sum + d.volume, 0) / recent5.length;
    const avgMid = mid5.reduce((sum, d) => sum + d.volume, 0) / mid5.length;
    const avgOld = old10.reduce((sum, d) => sum + d.volume, 0) / old10.length;
    const avgOldest = oldest10.reduce((sum, d) => sum + d.volume, 0) / oldest10.length;

    // 점진적 증가 패턴 감지
    // 각 구간이 이전 구간보다 증가해야 함
    const recentVsMid = avgRecent / avgMid; // Recent > Mid
    const midVsOld = avgMid / avgOld;       // Mid > Old
    const oldVsOldest = avgOld / avgOldest;  // Old > Oldest

    // 점진적 증가 조건 (점수 1.5배 확대)
    let score = 0;
    let trend = 'flat';

    // v3.18: moderate/weak 기준 완화 + mild 등급 추가
    if (recentVsMid > 1.1 && midVsOld > 1.1 && oldVsOldest > 1.0) {
      score = 15;
      trend = 'strong_acceleration';
    } else if (recentVsMid > 1.1 && midVsOld > 1.0) {
      score = 11;
      trend = 'moderate_acceleration';
    } else if (recentVsMid > 1.1) {
      score = 7;
      trend = 'weak_acceleration';
    } else if (recentVsMid > 1.0 && midVsOld > 1.0) {
      score = 4;
      trend = 'mild_acceleration';
    }

    return {
      score: parseFloat(score.toFixed(2)),
      detected: score > 0,
      trend,
      details: {
        avgRecent: Math.round(avgRecent),
        avgMid: Math.round(avgMid),
        avgOld: Math.round(avgOld),
        avgOldest: Math.round(avgOldest),
        recentVsMid: parseFloat(recentVsMid.toFixed(2)),
        midVsOld: parseFloat(midVsOld.toFixed(2)),
        oldVsOldest: parseFloat(oldVsOldest.toFixed(2))
      }
    };
  }

  /**
   * v3.36: 단기 거래량 모멘텀 (0-15점)
   * 최근 3일 평균 vs 이전 7일 평균 비교
   * analyzeVolumeAcceleration(30일 장기)과 다른 시간축
   */
  analyzeShortTermVolumeMomentum(chartData) {
    if (!chartData || chartData.length < 10) {
      return { score: 0, ratio: 0, trend: 'insufficient_data' };
    }

    const recent3 = chartData.slice(0, 3);
    const prev7 = chartData.slice(3, 10);

    const avgRecent = recent3.reduce((sum, d) => sum + d.volume, 0) / recent3.length;
    const avgPrev = prev7.reduce((sum, d) => sum + d.volume, 0) / prev7.length;

    if (avgPrev === 0) return { score: 0, ratio: 0, trend: 'no_volume' };

    const ratio = avgRecent / avgPrev;

    let score = 0;
    let trend = 'flat';

    if (ratio > 2.0) { score = 15; trend = 'strong_surge'; }
    else if (ratio > 1.5) { score = 11; trend = 'moderate_surge'; }
    else if (ratio > 1.2) { score = 7; trend = 'mild_surge'; }
    else if (ratio > 1.0) { score = 4; trend = 'slight_increase'; }

    return {
      score,
      ratio: parseFloat(ratio.toFixed(2)),
      trend,
      details: { avgRecent: Math.round(avgRecent), avgPrev: Math.round(avgPrev) }
    };
  }

  /**
   * 기관/외국인 장기 매집 (Institutional Accumulation) 분석 (0-5점)
   * investorData에서 장기 매수 패턴 감지
   */
  analyzeInstitutionalAccumulation(investorData) {
    if (!investorData || investorData.length === 0) {
      return { score: 0, detected: false, strength: 'none', days: 0 };
    }

    // v3.18: 총 매수일 카운트 (연속 아닌 전체), 기관/외국인 개별 추적
    let combinedBuyDays = 0;
    let institutionBuyDays = 0;
    let foreignBuyDays = 0;
    let totalNetBuy = 0;

    for (const day of investorData) {
      const institutionNet = parseInt(day.institution?.netBuyQty || day.institution_net_buy || 0);
      const foreignNet = parseInt(day.foreign?.netBuyQty || day.foreign_net_buy || 0);

      if (institutionNet > 0) institutionBuyDays++;
      if (foreignNet > 0) foreignBuyDays++;
      if (institutionNet + foreignNet > 0) {
        combinedBuyDays++;
        totalNetBuy += (institutionNet + foreignNet);
      }
    }

    const bestSingleCount = Math.max(institutionBuyDays, foreignBuyDays);

    // 점수 부여
    let score = 0;
    let strength = 'none';

    if (combinedBuyDays >= 4) {
      score = 5;
      strength = 'strong';
    } else if (combinedBuyDays >= 3) {
      score = 4;
      strength = 'moderate';
    } else if (combinedBuyDays >= 2) {
      score = 3;
      strength = 'mild';
    } else if (bestSingleCount >= 3) {
      score = 2;
      strength = 'single_accumulation';
    } else if (bestSingleCount >= 2) {
      score = 1;
      strength = 'weak';
    }

    return {
      score,
      detected: score > 0,
      strength,
      days: combinedBuyDays,
      institutionBuyDays,
      foreignBuyDays,
      totalNetBuy
    };
  }

  /**
   * 변동성 수축 (Volatility Contraction) 분석 (0-10점) 🆕 NEW
   * 볼린저밴드 수축 = 급등 전조 신호
   *
   * v3.9: Gemini 제안 - 선행 지표 추가
   */
  analyzeVolatilityContraction(chartData) {
    if (!chartData || chartData.length < 25) {
      return { score: 0, detected: false, trend: 'insufficient_data' };
    }

    // 최근 5일 vs 과거 20일 가격 변동폭 비교
    const recent5 = chartData.slice(0, 5);
    const old20 = chartData.slice(5, 25);

    // 각 구간의 평균 일간 변동률 계산
    const calcAvgDailyRange = (slice) => {
      const ranges = slice.map(d => ((d.high - d.low) / d.low) * 100);
      return ranges.reduce((sum, r) => sum + r, 0) / ranges.length;
    };

    const recentVolatility = calcAvgDailyRange(recent5);
    const oldVolatility = calcAvgDailyRange(old20);

    // 변동성 수축 비율
    const contractionRatio = recentVolatility / oldVolatility;

    let score = 0;
    let trend = 'expanding';

    // 변동성이 수축할수록 높은 점수 (급등 전조!)
    // v3.18: 안정/소폭확장도 인정 (기존 기준이 너무 엄격하여 전원 0점)
    if (contractionRatio <= 0.5) {
      score = 10;
      trend = 'strong_contraction';
    } else if (contractionRatio <= 0.7) {
      score = 8;
      trend = 'moderate_contraction';
    } else if (contractionRatio <= 0.85) {
      score = 6;
      trend = 'mild_contraction';
    } else if (contractionRatio <= 1.0) {
      score = 4;
      trend = 'stable';
    } else if (contractionRatio <= 1.2) {
      score = 2;
      trend = 'mild_expansion';
    }

    return {
      score: parseFloat(score.toFixed(2)),
      detected: score > 0,
      trend,
      details: {
        recentVolatility: parseFloat(recentVolatility.toFixed(2)),
        oldVolatility: parseFloat(oldVolatility.toFixed(2)),
        contractionRatio: parseFloat(contractionRatio.toFixed(2))
      }
    };
  }

  /**
   * VPD 강화 추세 (VPD Strengthening) 분석 (0-5점)
   * 최근 VPD가 과거보다 개선되었는지 확인
   */
  analyzeVPDStrengthening(chartData) {
    if (!chartData || chartData.length < 15) {
      return { score: 0, detected: false, trend: 'insufficient_data' };
    }

    // Recent 5 days VPD vs Old 10 days VPD 비교
    const recent5 = chartData.slice(0, 5);
    const old10 = chartData.slice(10, 20);

    // 각 구간의 평균 거래량 비율 계산
    const calcAvgVolumeRatio = (slice) => {
      const avgVol = slice.reduce((sum, d) => sum + d.volume, 0) / slice.length;
      const latest = slice[0];
      return latest.volume / avgVol;
    };

    const recentVolumeRatio = calcAvgVolumeRatio(recent5);
    const oldVolumeRatio = calcAvgVolumeRatio(old10);

    // 가격 변동률 계산
    const calcAvgPriceChange = (slice) => {
      const start = slice[slice.length - 1];
      const end = slice[0];
      return Math.abs((end.close - start.close) / start.close);
    };

    const recentPriceChange = calcAvgPriceChange(recent5);
    const oldPriceChange = calcAvgPriceChange(old10);

    // VPD = 거래량 증가 - 가격 변동
    // 거래량은 늘었지만 가격은 덜 움직였다 = VPD 강화
    const recentVPD = recentVolumeRatio - recentPriceChange;
    const oldVPD = oldVolumeRatio - oldPriceChange;
    const vpdImprovement = recentVPD - oldVPD;

    let score = 0;
    let trend = 'flat';

    if (vpdImprovement > 0.5) {
      score = 5; // VPD 대폭 개선
      trend = 'strong_improvement';
    } else if (vpdImprovement > 0.2) {
      score = 3; // VPD 개선
      trend = 'moderate_improvement';
    } else if (vpdImprovement > 0) {
      score = 1; // VPD 약간 개선
      trend = 'weak_improvement';
    }

    return {
      score,
      detected: score > 0,
      trend,
      details: {
        recentVPD: parseFloat(recentVPD.toFixed(2)),
        oldVPD: parseFloat(oldVPD.toFixed(2)),
        improvement: parseFloat(vpdImprovement.toFixed(2))
      }
    };
  }

  /**
   * 30일 추세 점수 계산 (Trend Score) (0-40점)
   * KIS API 30일 제한 내에서 매집 패턴 분석
   *
   * v3.20: 기여도 기반 리밸런싱 (Radar Scoring Track 2)
   * - 거래량 점진 증가: 0-20점 (유지)
   * - 변동성 수축: 0-5점 (10→5 축소, 구조적 한계)
   * - 기관/외국인 장기 매집: 0-8점 (5→8 확대)
   * - VPD 강화 추세: 0-7점 (5→7 확대)
   */
  calculateTrendScore(chartData, investorData) {
    if (!chartData || chartData.length < 25) {
      return {
        totalScore: 0,
        volumeAcceleration: { score: 0, detected: false, trend: 'insufficient_data' },
        volatilityContraction: { score: 0, detected: false, trend: 'removed_v3.23' },
        institutionalAccumulation: { score: 0, detected: false, trend: 'removed_v3.23' },
        vpdStrengthening: { score: 0, detected: false, trend: 'removed_v3.23' }
      };
    }

    // ========================================
    // v3.23: 거래량 가속도 복원 (0-15점)
    // VPD 강화 추세 제거 (VPD는 Base Score에만 반영)
    // 거래량 가속도: +20.12% 효과성 (백테스트 검증)
    // ========================================

    // 거래량 가속도 (0-15점) - 기존 함수 재활용
    const volumeAccel = this.analyzeVolumeAcceleration(chartData);
    const scaledAccel = Math.min(volumeAccel.score, 15);

    return {
      totalScore: parseFloat(scaledAccel.toFixed(2)),
      volumeAcceleration: { score: scaledAccel, ...volumeAccel },
      // 제거된 컴포넌트 (하위 호환)
      volatilityContraction: { score: 0, detected: false, trend: 'removed_v3.23' },
      institutionalAccumulation: { score: 0, detected: false, trend: 'removed_v3.23' },
      vpdStrengthening: { score: 0, detected: false, trend: 'removed_v3.23' }
    };
  }

  /**
   * ========================================
   * 5일 변화율 (Momentum) 시스템
   * ========================================
   * 핵심: D-5일 vs D-0일(현재) 비교
   * "지금 막 시작되는" 종목 포착
   */

  /**
   * 특정 시점(D-N일)의 상태 계산
   * @param {Array} chartData - 일봉 데이터 (최신순, [0]=오늘)
   * @param {Array} investorData - 투자자 데이터
   * @param {number} daysAgo - 며칠 전 (0=오늘, 5=5일전)
   */
  calculateStateAtDay(chartData, investorData, daysAgo) {
    if (!chartData || chartData.length < daysAgo + 10) {
      return null;
    }

    // D-N일 기준으로 데이터 슬라이스
    const slicedChartData = chartData.slice(daysAgo);
    const slicedInvestorData = investorData ? investorData.slice(daysAgo) : [];

    // 1. 거래량 평균 (최근 5일)
    const recent5 = slicedChartData.slice(0, 5);
    const avgVolume = recent5.reduce((sum, d) => sum + d.volume, 0) / recent5.length;

    // 2. VPD 계산
    const currentPrice = slicedChartData[0].close;
    const avgPrice20 = slicedChartData.slice(0, 20).reduce((sum, d) => sum + d.close, 0) / 20;
    const avgVol20 = slicedChartData.slice(0, 20).reduce((sum, d) => sum + d.volume, 0) / 20;

    const volumeRatio = slicedChartData[0].volume / avgVol20;
    const priceChange = ((currentPrice - avgPrice20) / avgPrice20) * 100;
    const priceRatio = Math.abs(priceChange) / 100 + 1.0;
    const vpd = volumeRatio - priceRatio;

    // 3. 거래량 기반 간이 점수 (패턴 강화 추세 비교용)
    const leadingScore = Math.min(volumeRatio * 5, 80); // 0-80점 추정

    // 4. 기관/외국인 순매수 상태
    let institutionalBuyDays = 0;
    if (slicedInvestorData && slicedInvestorData.length > 0) {
      for (const day of slicedInvestorData.slice(0, 5)) {
        const institutionNet = parseInt(day.institution?.netBuyQty || day.institution_net_buy || 0);
        const foreignNet = parseInt(day.foreign?.netBuyQty || day.foreign_net_buy || 0);
        if (institutionNet + foreignNet > 0) {
          institutionalBuyDays++;
        } else {
          break;
        }
      }
    }

    return {
      date: slicedChartData[0].date,
      avgVolume,
      vpd,
      volumeRatio,
      priceChange,
      leadingScore,
      institutionalBuyDays
    };
  }

  /**
   * 1. 거래량 가속도 점수 (0-15점)
   * D-5일 평균 vs D-0일 평균 비교
   */
  calcVolumeAccelerationScore(d5State, d0State) {
    if (!d5State || !d0State) {
      return { score: 0, ratio: 0, trend: 'unknown' };
    }

    const ratio = d0State.avgVolume / d5State.avgVolume;
    let score = 0;
    let trend = 'flat';

    if (ratio >= 3.0) {
      score = 15; // 3배 증가 - 폭발적 시작!
      trend = 'explosive';
    } else if (ratio >= 2.0) {
      score = 10; // 2배 증가 - 강한 시작
      trend = 'strong';
    } else if (ratio >= 1.5) {
      score = 5; // 1.5배 증가 - 조용한 시작
      trend = 'moderate';
    } else if (ratio < 0.7) {
      score = -5; // 거래량 감소 - 페널티
      trend = 'declining';
    }

    return {
      score,
      ratio: parseFloat(ratio.toFixed(2)),
      trend,
      d5Volume: Math.round(d5State.avgVolume),
      d0Volume: Math.round(d0State.avgVolume)
    };
  }

  /**
   * 2. VPD 개선도 점수 (0-10점)
   * D-5일 VPD vs D-0일 VPD 비교
   */
  calcVPDImprovementScore(d5State, d0State) {
    if (!d5State || !d0State) {
      return { score: 0, improvement: 0, trend: 'unknown' };
    }

    const improvement = d0State.vpd - d5State.vpd;
    let score = 0;
    let trend = 'flat';

    // 음수→양수 전환 (가장 중요!)
    if (d5State.vpd < 0 && d0State.vpd > 0) {
      score = 10;
      trend = 'reversal'; // 전환 신호!
    } else if (improvement >= 2.0) {
      score = 7; // 대폭 개선
      trend = 'strong_improvement';
    } else if (improvement >= 1.0) {
      score = 5; // 개선
      trend = 'improvement';
    } else if (improvement >= 0.5) {
      score = 3; // 약간 개선
      trend = 'slight_improvement';
    } else if (improvement < -1.0) {
      score = -5; // 악화 - 페널티
      trend = 'deterioration';
    }

    return {
      score,
      improvement: parseFloat(improvement.toFixed(2)),
      trend,
      d5VPD: parseFloat(d5State.vpd.toFixed(2)),
      d0VPD: parseFloat(d0State.vpd.toFixed(2))
    };
  }

  /**
   * 3. 선행 지표 강화 점수 (0-10점)
   * D-5일 선행점수 vs D-0일 선행점수 비교
   */
  calcPatternStrengtheningScore(d5State, d0State) {
    if (!d5State || !d0State || d5State.leadingScore === 0) {
      return { score: 0, ratio: 0, trend: 'unknown' };
    }

    const ratio = d0State.leadingScore / d5State.leadingScore;
    let score = 0;
    let trend = 'flat';

    if (ratio >= 2.0) {
      score = 10; // 2배 강화 - 패턴 형성!
      trend = 'pattern_forming';
    } else if (ratio >= 1.5) {
      score = 7; // 1.5배 강화
      trend = 'strengthening';
    } else if (ratio >= 1.2) {
      score = 4; // 1.2배 강화
      trend = 'slight_strengthening';
    } else if (ratio < 0.8) {
      score = -3; // 약화 - 페널티
      trend = 'weakening';
    }

    return {
      score,
      ratio: parseFloat(ratio.toFixed(2)),
      trend,
      d5Score: parseFloat(d5State.leadingScore.toFixed(1)),
      d0Score: parseFloat(d0State.leadingScore.toFixed(1))
    };
  }

  /**
   * 4. 기관 진입 가속 점수 (0-5점)
   * D-5일 수급 vs D-0일 수급 비교
   */
  calcInstitutionalEntryScore(d5State, d0State) {
    if (!d5State || !d0State) {
      return { score: 0, trend: 'unknown' };
    }

    const d5Days = d5State.institutionalBuyDays;
    const d0Days = d0State.institutionalBuyDays;

    let score = 0;
    let trend = 'no_change';

    // D-5일에는 없었는데 D-0일에 시작 (가장 중요!)
    if (d5Days === 0 && d0Days >= 3) {
      score = 5;
      trend = 'new_entry'; // 막 진입!
    } else if (d5Days === 0 && d0Days >= 1) {
      score = 3;
      trend = 'starting_entry';
    } else if (d0Days > d5Days && d0Days >= 3) {
      score = 4; // 증가 + 연속 3일
      trend = 'accelerating';
    } else if (d0Days > d5Days) {
      score = 2; // 증가
      trend = 'increasing';
    } else if (d0Days < d5Days) {
      score = -2; // 감소 - 페널티
      trend = 'decreasing';
    }

    return {
      score,
      trend,
      d5Days,
      d0Days
    };
  }

  // Golden Zones 시스템 제거됨 (v3.19) — 종목 풀과 구조적 모순으로 감지 0건


  /**
   * RSI(14) 계산
   * @param {Array} chartData - 일봉 데이터 (최신순, [0]=오늘)
   * @param {number} period - RSI 기간 (기본값: 14)
   * @returns {number} RSI 값 (0-100)
   */
  calculateRSI(chartData, period = 14) {
    if (!chartData || chartData.length < period + 1) {
      return 50; // 기본값
    }

    // 가격 변동 계산 (최신 → 과거 순서이므로 역순으로 계산)
    const changes = [];
    for (let i = chartData.length - 1; i > 0; i--) {
      const change = chartData[i - 1].close - chartData[i].close;
      changes.push(change);
    }

    // 최근 14개 변동만 사용
    const recentChanges = changes.slice(-period);

    // 상승폭 평균 (U), 하락폭 평균 (D) 계산
    let avgGain = 0;
    let avgLoss = 0;

    for (const change of recentChanges) {
      if (change > 0) {
        avgGain += change;
      } else {
        avgLoss += Math.abs(change);
      }
    }

    avgGain = avgGain / period;
    avgLoss = avgLoss / period;

    // RSI 계산
    if (avgLoss === 0) {
      return 100; // 모두 상승
    }

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return parseFloat(rsi.toFixed(2));
  }

  /**
   * 이격도(Disparity) 계산
   * @param {Array} chartData - 일봉 데이터 (최신순, [0]=오늘)
   * @param {number} currentPrice - 현재가
   * @param {number} period - 이동평균 기간 (기본값: 20)
   * @returns {number} 이격도 (%) - 현재가 / 이동평균 × 100
   */
  calculateDisparity(chartData, currentPrice, period = 20) {
    if (!chartData || chartData.length < period) {
      return 100; // 기본값 (이격도 100 = 이평선과 일치)
    }

    // 최근 N일 이동평균 계산
    const recentPrices = chartData.slice(0, period).map(d => d.close);
    const ma = recentPrices.reduce((sum, price) => sum + price, 0) / period;

    // 이격도 = (현재가 / 이동평균) × 100
    const disparity = (currentPrice / ma) * 100;

    return parseFloat(disparity.toFixed(2));
  }

  /**
   * 과열 감지 (Overheating Detection) v3.10.0 NEW
   * @param {Array} chartData - 일봉 데이터
   * @param {number} currentPrice - 현재가
   * @returns {Object} { overheated, rsi, disparity, reason }
   *
   * 기준: RSI(14) > 80 AND 이격도(20일) > 115 (v3.18.1: OR→AND 변경)
   * v3.18.1: OR 조건이 82% 과열 → AND로 변경하여 진짜 과열만 감지
   */
  detectOverheatingV2(chartData, currentPrice) {
    if (!chartData || !currentPrice) {
      return { overheated: false, rsi: 50, disparity: 100, reason: 'insufficient_data' };
    }

    const rsi = this.calculateRSI(chartData, 14);
    const disparity = this.calculateDisparity(chartData, currentPrice, 20);

    // v3.18.1: OR→AND 변경 (RSI와 이격도 모두 과열이어야 과열 판정)
    const overheated = (rsi > 80) && (disparity > 115);
    let reason = 'normal';

    if (rsi > 80 && disparity > 115) {
      reason = `과열 (RSI ${rsi.toFixed(1)} > 80 AND 이격도 ${disparity.toFixed(1)} > 115)`;
    }

    return {
      overheated,
      rsi: parseFloat(rsi.toFixed(2)),
      disparity: parseFloat(disparity.toFixed(2)),
      reason
    };
  }

  /**
   * 당일 급등/급락 페널티 계산 (strong) ⬆️ 강화!
   * 목적: "이미 급등/급락한" 종목 강력 감점
   * @param {Array} chartData - 일봉 데이터
   * @returns {Object} { penalty: -30~0, details }
   *
   * v3.10.0: +15% 이상 급등 시 -30점 (Track 2 Momentum 45점의 67%)
   * v3.10.1: 🆕 급락 페널티 추가 (-10% 이하 -20점, -5% 이하 -10점)
   */
  calculateDailyRisePenalty(chartData) {
    if (!chartData || chartData.length < 2) {
      return { penalty: 0, closeChange: 0, highChange: 0, message: 'insufficient_data' };
    }

    const today = chartData[0]; // D-0일 (오늘)
    const yesterday = chartData[1]; // D-1일 (어제)

    // 1. 전일 대비 종가 변동률
    const closeChange = ((today.close - yesterday.close) / yesterday.close) * 100;

    // 2. 전일 대비 장중 고가 변동률 (상한가 감지)
    const highChange = ((today.high - yesterday.close) / yesterday.close) * 100;

    let penalty = 0;
    let message = 'normal';

    // v3.10.0: 급등 페널티 강화 (Radar Scoring 기준)
    if (highChange >= 20) {
      // 장중 고가 +20% 이상 (상한가 포함) → -30점
      penalty = -30;
      message = `⚠️ 당일 급등 (고가 +${highChange.toFixed(1)}%)`;
    } else if (highChange >= 15) {
      // 장중 고가 +15% 이상 → -30점
      penalty = -30;
      message = `⚠️ 당일 급등 (고가 +${highChange.toFixed(1)}%)`;
    } else if (closeChange >= 10) {
      // 종가 +10% 이상 → -15점
      penalty = -15;
      message = `당일 상승 (종가 +${closeChange.toFixed(1)}%)`;
    } else if (closeChange <= -10) {
      // 🆕 종가 -10% 이하 급락 → -20점
      penalty = -20;
      message = `⚠️ 당일 급락 (종가 ${closeChange.toFixed(1)}%)`;
    } else if (closeChange <= -5) {
      // 🆕 종가 -5% 이하 하락 → -10점
      penalty = -10;
      message = `당일 하락 (종가 ${closeChange.toFixed(1)}%)`;
    }

    return {
      penalty,
      closeChange: parseFloat(closeChange.toFixed(2)),
      highChange: parseFloat(highChange.toFixed(2)),
      message
    };
  }

  /**
   * 지속적 폭락 감지 (v3.13 NEW) ⭐
   * 목적: 단일일 급락이 아닌 "최근 며칠간 지속적 하락" 감지
   * @param {Array} chartData - 일봉 데이터
   * @returns {Object} { isCrashing: boolean, cumulativeDecline: number, consecutiveDown: number, message: string }
   *
   * 백테스트 동기:
   * - 유일에너테크 사례: 당일은 -3% (페널티 없음), 5일간 누적 -18% (폭락)
   * - 현재 시스템은 당일 급락만 감지 → 지속적 하락 미감지
   *
   * 필터링 기준:
   * 1. 최근 5일간 누적 -15% 이상
   * 2. 또는 3일 연속 하락 + 누적 -10% 이상
   */
  detectContinuousDecline(chartData) {
    if (!chartData || chartData.length < 6) {
      return { isCrashing: false, cumulativeDecline: 0, consecutiveDown: 0, message: null };
    }

    // 최근 5일 데이터
    const recent5 = chartData.slice(0, 5);
    const startPrice = recent5[4].close;  // 5일 전 종가
    const endPrice = recent5[0].close;    // 오늘 종가

    // 누적 하락률 계산
    const cumulativeDecline = ((endPrice - startPrice) / startPrice) * 100;

    // 연속 하락일 수 계산 (오늘부터 과거로)
    let consecutiveDown = 0;
    for (let i = 0; i < recent5.length - 1; i++) {
      if (recent5[i].close < recent5[i + 1].close) {
        consecutiveDown++;
      } else {
        break;
      }
    }

    // 폭락 판정
    const isCrashing =
      cumulativeDecline <= -15 ||  // 5일간 -15% 이상 폭락
      (consecutiveDown >= 3 && cumulativeDecline <= -10);  // 3일 연속 하락 + -10% 이상

    const message = isCrashing
      ? `⚠️ 최근 폭락 (5일간 ${cumulativeDecline.toFixed(1)}%, ${consecutiveDown}일 연속 하락)`
      : null;

    return {
      isCrashing,
      cumulativeDecline: parseFloat(cumulativeDecline.toFixed(2)),
      consecutiveDown,
      message
    };
  }

  /**
   * 5일 변화율 종합 점수 계산 (Momentum Score) (0-45점)
   * v3.20: 기여도 기반 리밸런싱 (Radar Scoring Track 2)
   * - 거래량 가속도: 0-15점 (18→15 축소)
   * - VPD 개선도: 0-20점 (12→20 확대, 핵심 철학 지표)
   * - 기관 진입 가속: 0-10점 (5→10 확대)
   * - 선행 지표 강화: 제거 (Volume Acceleration과 중복)
   */
  calculate5DayMomentum(chartData, investorData) {
    if (!chartData || chartData.length < 10) {
      return {
        totalScore: 0,
        volumeAcceleration: { score: 0, trend: 'insufficient_data' },
        vpdImprovement: { score: 0, trend: 'insufficient_data' },
        institutionalEntry: { score: 0, trend: 'insufficient_data' }
      };
    }

    // D-5일 상태
    const d5State = this.calculateStateAtDay(chartData, investorData, 5);

    // D-0일 (현재) 상태
    const d0State = this.calculateStateAtDay(chartData, investorData, 0);

    if (!d5State || !d0State) {
      return {
        totalScore: 0,
        volumeAcceleration: { score: 0, trend: 'insufficient_data' },
        vpdImprovement: { score: 0, trend: 'insufficient_data' },
        institutionalEntry: { score: 0, trend: 'insufficient_data' }
      };
    }

    // ========================================
    // v3.23: 진짜 모멘텀 지표로 재설계
    // Momentum(0-30) = 거래량 가속도(0-15) + 연속상승(0-10) + 기관진입(0-5)
    // VPD Improvement 완전 제거 (VPD는 Base Score에만 반영)
    // ========================================

    // 1. 거래량 가속도 (0-15점) - 기존 함수 재활용
    const volumeAccel = this.analyzeVolumeAcceleration(chartData);
    const scaledVolAccel = Math.min(volumeAccel.score, 15);

    // 2. 연속 상승일 보너스 (0-10점)
    let consecutiveRise = 0;
    if (chartData && chartData.length >= 5) {
      for (let i = 0; i < Math.min(5, chartData.length - 1); i++) {
        if (chartData[i].close > chartData[i + 1].close) {
          consecutiveRise++;
        } else {
          break;
        }
      }
    }
    const riseBonus = consecutiveRise >= 4 ? 10 : consecutiveRise >= 3 ? 7 : consecutiveRise >= 2 ? 4 : 0;

    // 3. 기관 진입 가속 (0-5점) - 기존 로직 유지
    const institutionalEntry = this.calcInstitutionalEntryScore(d5State, d0State);
    const scaledInstitutional = Math.min(institutionalEntry.score, 5);

    const totalScore = Math.max(0,
      scaledVolAccel +
      riseBonus +
      scaledInstitutional
    );

    return {
      totalScore: parseFloat(totalScore.toFixed(2)),
      volumeAcceleration: { score: scaledVolAccel, ...volumeAccel },
      consecutiveRise: { days: consecutiveRise, bonus: riseBonus },
      institutionalEntry: { score: scaledInstitutional, ...institutionalEntry },
      vpdImprovement: { score: 0, trend: 'removed_v3.23' }, // 하위 호환
      d5State,
      d0State
    };
  }

  /**
   * 단일 종목 분석 (Phase 4 통합)
   */
  async analyzeStock(stockCode) {
    try {
      // 현재가, 일봉, 투자자 데이터 가져오기
      const [currentData, chartData, investorData] = await Promise.all([
        kisApi.getCurrentPrice(stockCode),
        kisApi.getDailyChart(stockCode, 30).catch(async (e) => {
          console.warn(`⚠️ 차트 데이터 1차 실패 [${stockCode}]: ${e.message}, 300ms 후 재시도...`);
          await new Promise(r => setTimeout(r, 300));
          return kisApi.getDailyChart(stockCode, 30).catch(e2 => {
            console.error(`❌ 차트 데이터 2차 실패 [${stockCode}]: ${e2.message}`);
            return null;
          });
        }),
        kisApi.getInvestorData(stockCode, 5).catch(e => { console.warn(`⚠️ 투자자 데이터 실패 [${stockCode}]: ${e.message}`); return null; })
      ]);

      // getCurrentPrice 또는 chartData가 없으면 스킵
      if (!currentData || !chartData || chartData.length === 0) {
        console.warn(`⚠️ 필수 데이터 부족 [${stockCode}]: currentData=${!!currentData}, chartData=${chartData?.length || 0}건`);
        return null;
      }

      // 거래량 지표 분석
      const volumeAnalysis = volumeIndicators.analyzeVolume(chartData);

      // 창의적 지표 분석 (Phase 4 신규 지표 포함, v3.16: 시총 전달)
      const advancedAnalysis = advancedIndicators.analyzeAdvanced(chartData, currentData.marketCap);

      // 신규 지표 추가
      const institutionalFlow = advancedIndicators.checkInstitutionalFlow(investorData);
      // breakoutConfirmation: 점수 미반영 + 프론트엔드 미사용 → 제거 (v3.36)
      const riskAdjusted = advancedIndicators.calculateRiskAdjustedScore(chartData);

      // 필터링 강화: 작전주, 유동성, 과거급등
      const manipulation = advancedIndicators.detectManipulation(chartData, currentData.marketCap);
      const liquidity = advancedIndicators.checkLiquidity(chartData);
      const previousSurge = advancedIndicators.checkPreviousSurge(chartData);

      // Volume-Price Divergence: "거래량 폭발 + 가격 미반영" 신호 (VPM 대체)
      const volumePriceDivergence = volumeIndicators.calculateVolumePriceDivergence(
        chartData,
        currentData.currentPrice
      );

      // 차트 패턴 인식
      const cupAndHandle = advancedIndicators.detectCupAndHandle(chartData);
      const triangle = advancedIndicators.detectTriangle(chartData);

      // 추세 분석 (5일/10일/20일) - 현재가 정보 포함
      const trendAnalysis = this.calculateTrendAnalysis(chartData, currentData);

      // ========================================
      // 점수 계산: v3.23 Radar Scoring (데이터 기반 재설계)
      // Base(0-25) + Momentum(0-30) + Trend(0-15) + Whale(0-30) = 0-100점
      // ========================================

      const baseScore = this.calculateTotalScore(volumeAnalysis, advancedAnalysis, null, chartData, currentData.currentPrice, volumePriceDivergence, trendAnalysis, currentData.marketCap);

      let momentumScore = this.calculate5DayMomentum(chartData, investorData);
      const d0DailyPenalty = this.calculateDailyRisePenalty(chartData);
      momentumScore.totalScore = Math.max(0, momentumScore.totalScore + d0DailyPenalty.penalty);
      momentumScore.dailyRisePenalty = d0DailyPenalty;

      const trendScore = this.calculateTrendScore(chartData, investorData);

      // ========================================
      // v3.23: 고래 보너스 유지, VPD는 Base Score에만 반영
      // 총점(0-100) = Base(0-25) + Whale(0-30) + Momentum(0-30) + Trend(0-15)
      // ========================================
      // v3.25: 매수고래 확인 보너스 (확인 조건 충족 시 +30, 미확인 시 +15)
      const buyWhales = (advancedAnalysis?.indicators?.whale || []).filter(w => w.type?.includes('매수'));
      const isWhale = buyWhales.length > 0;
      let whaleBonus = 0;
      let whaleConfirmed = false;
      if (isWhale) {
        // 확인 조건: 탈출 속도, 강한 매수세, 거래량 가속 중 하나 이상
        const hasEscape = advancedAnalysis?.indicators?.escape?.detected;
        const hasStrongBuying = advancedAnalysis?.indicators?.asymmetric?.signal?.includes('강한 매수세');
        const hasAcceleration = momentumScore.volumeAcceleration?.trend?.includes('acceleration');
        whaleConfirmed = hasEscape || hasStrongBuying || hasAcceleration;
        whaleBonus = whaleConfirmed ? 30 : 15;
      }

      // 점수 합산
      const rawScore = baseScore + whaleBonus + momentumScore.totalScore + trendScore.totalScore;
      let totalScore = Math.min(rawScore, 100); // v3.22: Cap 100

      const radarScore = {
        baseScore: parseFloat(baseScore.toFixed(2)),
        whaleBonus: whaleBonus,
        momentumScore: momentumScore,
        trendScore: trendScore,
        total: parseFloat(totalScore.toFixed(2))
      };

      if (whaleBonus > 0) {
        console.log(`🐋 Whale Bonus: +${whaleBonus}점 (${whaleConfirmed ? '확인됨' : '미확인'})`);
      }

      // 과열 감지
      const overheatingV2 = this.detectOverheatingV2(chartData, currentData.currentPrice);

      const volumeRatio = volumeAnalysis.current.volumeMA20
        ? volumeAnalysis.current.volume / volumeAnalysis.current.volumeMA20
        : 1;
      const overheating = advancedIndicators.checkOverheating(
        chartData,
        currentData.currentPrice,
        volumeRatio,
        volumeAnalysis.indicators.mfi
      );

      // v3.24: 윗꼬리 과다 감점 (-10점, 승률 66.7%, 수익 +0.83%)
      if (advancedAnalysis?.indicators?.escape?.signal?.includes('윗꼬리 과다')) {
        totalScore -= 10;
        console.log(`  ⚠️ 윗꼬리 과다 감점: -10점`);
      }

      // v3.24: 탈출 속도 보너스 (+5점, 승률 100%, 수익 +23.58%)
      if (advancedAnalysis?.indicators?.escape?.detected) {
        totalScore += 5;
        console.log(`  🚀 탈출 속도 보너스: +5점`);
      }

      // v3.26: 매도고래 최근 3일 내 감점 (-10점)
      const sellWhales = (advancedAnalysis?.indicators?.whale || [])
        .filter(w => w.type?.includes('매도'));
      let sellWhalePenalty = 0;
      if (sellWhales.length > 0) {
        const recentSellWhales = sellWhales.filter(w => {
          const whaleIdx = chartData.findIndex(d => d.date === w.date);
          return whaleIdx >= 0 && whaleIdx <= 3;
        });
        if (recentSellWhales.length > 0) {
          sellWhalePenalty = -10;
          totalScore += sellWhalePenalty;
          console.log(`  🐳 매도고래 감점: -10점 (${recentSellWhales.length}건, 최근 3일)`);
        }
      }

      // 최종 점수 확정 (NaN 방지)
      totalScore = isNaN(totalScore) ? 0 : parseFloat(Math.min(Math.max(totalScore, 0), 100).toFixed(2));

      // ========================================
      // v3.37: 데이터 기반 v2 스코어링 (상관관계 분석 결과 반영)
      // Base(0-15) + Whale(0/15/30) + Supply(0-25) + Momentum(0-20) + Trend(0-10) + SignalAdj
      //
      // 상관관계 기반 배점:
      //   기관+외국인 합산 r=+0.21 → Supply(0-25) 신설
      //   연속 상승일 r=+0.12 → Momentum 핵심 (0-12)
      //   거래량 비율 1.0-1.5x 최적 → Base 거래량 스윗스팟 반영
      //   RSI 50-70 최적 → Momentum RSI존 보너스
      //   거래량 가속 r=-0.10 → Trend 축소 (0-10)
      // ========================================
      const v2 = (() => {
        // ── v2 Base Score (0-15): 종목 품질 ──
        let v2Base = 0;

        // 거래량 비율 (0-6): 스윗스팟 1.0-1.5x (승률 68.8%, 수익 +20.57%)
        if (volumeAnalysis.current.volumeMA20) {
          const vr = volumeAnalysis.current.volume / volumeAnalysis.current.volumeMA20;
          if (vr >= 1.0 && vr <= 1.5) v2Base += 6;       // 스윗스팟 (최고 수익)
          else if (vr > 1.5 && vr < 2.0) v2Base += 4;
          else if (vr >= 2.0 && vr < 3.0) v2Base += 2;
          else if (vr >= 0.8 && vr < 1.0) v2Base += 1;
          // vr >= 3.0 or < 0.8 → 0점
        }

        // VPD (0-5): 핵심 컨셉 유지
        if (volumePriceDivergence && volumePriceDivergence.divergence > 0) {
          const div = volumePriceDivergence.divergence;
          if (div >= 3.0) v2Base += 5;
          else if (div >= 2.0) v2Base += 4;
          else if (div >= 1.0) v2Base += 3;
          else if (div >= 0.5) v2Base += 1;
        }

        // 시총 보정 (-3 ~ +4): 축소
        if (currentData.marketCap) {
          const mc = currentData.marketCap / 100000000;
          if (mc < 1000) v2Base -= 3;
          else if (mc < 3000) v2Base -= 1;
          else if (mc >= 10000) v2Base += 4;
          else if (mc >= 5000) v2Base += 3;
          else if (mc >= 3000) v2Base += 1;
        }

        v2Base = Math.min(Math.max(v2Base, 0), 15);

        // ── v2 Supply Score (0-25): 기관/외국인 수급 (r=+0.21, 최강 알파) ──
        let v2Supply = 0;
        const instDays = institutionalFlow?.institutionDays || 0;
        const foreignDays = institutionalFlow?.foreignDays || 0;

        // 기관 연속 매수일 (0-10): r=+0.15
        if (instDays >= 5) v2Supply += 10;
        else if (instDays >= 4) v2Supply += 8;
        else if (instDays >= 3) v2Supply += 6;    // 3일+: 승률 82.8%, 수익 +12.91%
        else if (instDays >= 2) v2Supply += 3;
        else if (instDays >= 1) v2Supply += 1;

        // 외국인 연속 매수일 (0-8): r=+0.21
        if (foreignDays >= 5) v2Supply += 8;
        else if (foreignDays >= 4) v2Supply += 6;
        else if (foreignDays >= 3) v2Supply += 5;  // 3일+: 승률 83.3%, 수익 +12.93%
        else if (foreignDays >= 2) v2Supply += 3;
        else if (foreignDays >= 1) v2Supply += 1;

        // 쌍방 수급 보너스 (0-7): 동반매수 시 승률 94.7%, 수익 +15.67%
        if (instDays >= 3 && foreignDays >= 3) v2Supply += 7;
        else if (instDays >= 2 && foreignDays >= 2) v2Supply += 5;  // 핵심 조건
        else if ((instDays >= 3 && foreignDays >= 1) || (foreignDays >= 3 && instDays >= 1)) v2Supply += 3;

        v2Supply = Math.min(v2Supply, 25);

        // ── v2 Momentum Score (0-20): 단기 모멘텀 ──
        let v2Mom = 0;

        // 연속 상승일 (0-12): r=+0.12, 3일 승률 82.4%, 수익 +15.59%
        if (chartData && chartData.length >= 5) {
          let cnt = 0;
          for (let i = 0; i < Math.min(5, chartData.length - 1); i++) {
            if (chartData[i].close > chartData[i + 1].close) cnt++;
            else break;
          }
          if (cnt >= 4) v2Mom += 12;
          else if (cnt >= 3) v2Mom += 9;
          else if (cnt >= 2) v2Mom += 5;
          else if (cnt >= 1) v2Mom += 2;
        }

        // RSI 존 보너스 (0-5): RSI 50-70 구간 승률 63.4%, 수익 +7.58%
        const rsiVal = overheatingV2?.rsi || 50;
        if (rsiVal >= 50 && rsiVal <= 70) v2Mom += 5;
        else if (rsiVal >= 40 && rsiVal < 50) v2Mom += 3;
        else if (rsiVal > 70 && rsiVal <= 80) v2Mom += 2;
        // RSI < 40 or > 80 → 0점

        // 기관 진입 가속 (0-3): 축소 (Supply에서 주로 반영)
        const v2InstEntry = momentumScore.institutionalEntry?.score || 0;
        v2Mom += Math.min(Math.max(v2InstEntry, 0), 3);

        // 당일 급등 페널티
        v2Mom = Math.max(0, Math.min(v2Mom + d0DailyPenalty.penalty, 20));

        // ── v2 Trend Score (0-10): 장기 추세 (r=-0.10이므로 축소) ──
        // 기존 15점 → 10점 캡
        const v2Trend = Math.min(trendScore.totalScore, 10);

        // ── v2 합산 ──
        let v2Raw = v2Base + whaleBonus + v2Supply + v2Mom + v2Trend;

        // SignalAdj 동일 적용
        if (advancedAnalysis?.indicators?.escape?.signal?.includes('윗꼬리 과다')) v2Raw -= 10;
        if (advancedAnalysis?.indicators?.escape?.detected) v2Raw += 5;
        if (sellWhalePenalty) v2Raw += sellWhalePenalty;

        const v2Total = isNaN(v2Raw) ? 0 : parseFloat(Math.min(Math.max(v2Raw, 0), 100).toFixed(2));

        return {
          totalScore: v2Total,
          breakdown: {
            base: v2Base,
            whale: whaleBonus,
            supply: v2Supply,
            supplyDetail: { instDays, foreignDays, dualBonus: (instDays >= 2 && foreignDays >= 2) },
            momentum: v2Mom,
            momentumDetail: { consecutiveRise: v2Mom - Math.min(Math.max(v2InstEntry, 0), 3) - (rsiVal >= 50 && rsiVal <= 70 ? 5 : rsiVal >= 40 && rsiVal < 50 ? 3 : rsiVal > 70 && rsiVal <= 80 ? 2 : 0), rsiZone: rsiVal, instEntry: Math.min(Math.max(v2InstEntry, 0), 3), dailyPenalty: d0DailyPenalty.penalty },
            trend: v2Trend
          }
        };
      })();

      // ========================================
      // 가점/감점 상세 내역 (스코어 카드) v3.10.0
      // ========================================
      const scoreBreakdown = {
        scoringTrack: 'Data-Driven Scoring v3.26',

        structure: {
          base: '0-25점 (거래량+VPD+시총+되돌림+연속상승)',
          whale: '0-30점 (고래 감지 보너스)',
          momentum: '0-30점 (거래량 가속도+연속상승+기관 진입)',
          trend: '0-15점 (거래량 점진 증가 추세)'
        },

        // 1. 기본 점수 (0-25점) v3.23 → v3.39: 서브 점수 포함
        baseScore: parseFloat(baseScore.toFixed(2)),
        baseComponents: {
          volumeRatio: { name: '거래량 비율 (0-8)', score: this._baseDetail?.volumeRatio || 0 },
          vpd: { name: 'VPD (0-7)', score: this._baseDetail?.vpd || 0 },
          marketCap: { name: '시총 보정 (-5~+7)', score: this._baseDetail?.marketCap || 0 },
          drawdown: { name: '되돌림 (-3~0)', score: this._baseDetail?.drawdown || 0 },
          consecutiveRise: { name: '연속상승 (0-5)', score: this._baseDetail?.consecutiveRise || 0 }
        },

        // 2. 고래 감지 보너스 (0/15/30점) v3.25
        whaleBonus: {
          name: '고래 감지 (0/15/30점)',
          score: whaleBonus,
          detected: isWhale,
          confirmed: whaleConfirmed,
          details: !isWhale ? '고래 미감지' : whaleConfirmed ? '확인된 고래 → +30점' : '미확인 고래 → +15점'
        },

        // 3. 모멘텀 점수 (0-30점) v3.23
        momentumScore: parseFloat(momentumScore.totalScore.toFixed(2)),
        momentumComponents: {
          volumeAcceleration: {
            name: '거래량 가속도 (0-15점)',
            score: momentumScore.volumeAcceleration?.score || 0,
            trend: momentumScore.volumeAcceleration?.trend || 'N/A',
            details: `거래량 추세: ${momentumScore.volumeAcceleration?.trend || 'N/A'}`
          },
          consecutiveRise: {
            name: '연속 상승일 보너스 (0-10점)',
            score: momentumScore.consecutiveRise?.bonus || 0,
            trend: momentumScore.consecutiveRise?.days >= 3 ? 'strong' : momentumScore.consecutiveRise?.days >= 2 ? 'moderate' : 'weak',
            details: `최근 ${momentumScore.consecutiveRise?.days || 0}일 연속 상승`
          },
          institutionalEntry: {
            name: '기관 진입 가속 (0-5점)',
            score: momentumScore.institutionalEntry?.score || 0,
            trend: momentumScore.institutionalEntry?.trend || 'N/A',
            details: `D-5: ${momentumScore.institutionalEntry?.d5Days || 0}일 → D-0: ${momentumScore.institutionalEntry?.d0Days || 0}일`
          }
        },

        // 4. 추세 점수 (0-15점) v3.23
        trendScore: parseFloat(trendScore.totalScore.toFixed(2)),
        trendComponents: {
          volumeAcceleration: {
            name: '거래량 점진 증가 추세 (0-15점)',
            score: trendScore.volumeAcceleration?.score || 0,
            trend: trendScore.volumeAcceleration?.trend || 'N/A'
          }
        },

        // v3.26: 신호 기반 가감점 (매도고래 감점 추가)
        signalAdjustments: {
          escapeVelocityBonus: advancedAnalysis?.indicators?.escape?.detected ? 5 : 0,
          upperShadowPenalty: advancedAnalysis?.indicators?.escape?.signal?.includes('윗꼬리 과다') ? -10 : 0,
          sellWhalePenalty: sellWhalePenalty
        },

        finalScore: parseFloat(totalScore.toFixed(2)),
        maxScore: 100,
        formula: 'Base(0-25) + Whale(0/15/30) + Momentum(0-30) + Trend(0-15) + SignalAdj = Total(0-100) [v3.26]'
      };

      // 랭킹 뱃지 가져오기
      const rankBadges = kisApi.getCachedRankBadges(stockCode);

      // 🆕 v3.13: 지속적 폭락 감지
      const crashCheck = this.detectContinuousDecline(chartData);

      // 🆕 v3.34: 방어 전략 점수 계산 (병렬 운영)
      const defenseResult = this.calculateDefenseScore(
        volumeAnalysis, advancedAnalysis, chartData, currentData.currentPrice,
        investorData, riskAdjusted, crashCheck, currentData.marketCap
      );

      const recommendation = this.getRecommendation(totalScore, advancedAnalysis.tier, overheating, overheatingV2);
      return {
        stockCode,
        stockName: currentData.stockName,
        currentPrice: currentData.currentPrice,
        changeRate: currentData.changeRate,
        volume: currentData.volume,
        marketCap: currentData.marketCap,
        volumeAnalysis,
        advancedAnalysis,
        institutionalFlow, // 신규: 기관/외국인 수급
        riskAdjusted, // 위험조정 점수 (방어 전략에서 사용)
        manipulation, // 신규: 작전주 필터
        liquidity, // 신규: 유동성 필터
        previousSurge, // 신규: 과거급등 필터
        volumePriceDivergence, // ⭐ Volume-Price Divergence (거래량 폭발 + 가격 미반영)
        cupAndHandle, // 신규: Cup&Handle 패턴
        triangle, // 신규: Triangle 패턴
        crashCheck, // 🆕 v3.13: 지속적 폭락 감지
        scoreBreakdown, // 신규: 가점/감점 상세 내역
        trendAnalysis, // 추세 분석 (5일 일자별)
        momentumScore, // ⭐ 변화율 점수 (D-5 vs D-0, 0-40점)
        trendScore, // ⭐ 추세 점수 (30일 모멘텀, 0-20점)
        overheating, // Phase 4C 과열 정보 추가
        radarScore, // Radar Scoring 상세
        overheatingV2, // v3.10.0: 과열 감지 v2 (RSI + 이격도)
        totalScore,
        grade: recommendation.grade,
        recommendation,
        rankBadges: rankBadges || {},
        // v3.34: 방어 전략
        defenseScore: defenseResult.totalScore,
        defenseGrade: defenseResult.grade,
        defenseBreakdown: defenseResult.breakdown,
        // v3.36: 스코어링 v2 병렬 비교
        totalScoreV2: v2.totalScore,
        scoreV2Breakdown: v2.breakdown
      };
    } catch (error) {
      console.error(`❌ 종목 분석 실패 [${stockCode}]:`, error.message);
      return null;
    }
  }

  /**
   * 기본 점수 계산 (Base Score) v3.10.0 - Radar Scoring
   * 급등 '예정' 종목 발굴에 최적화
   *
   * v3.21: 5일 거래량 변동율 점수 추가 (품질 체크, 0-17점)
   * - 거래량 비율: 0-3점
   * - OBV 추세: 0-3점
   * - VWAP 모멘텀: 0-3점 (이진→단계별 거리 기반)
   * - 비대칭 비율: 0-4점 (매수세만 가점, 매도세 0점)
   * - VPD raw: 0-3점 (핵심 철학 지표 직접 반영)
   * - 5일 거래량 변동율: 0-2점 🆕 (단기 거래량 추세)
   * - 되돌림 페널티: -2~0점
   */
  calculateTotalScore(volumeAnalysis, advancedAnalysis, trendScore = null, chartData = null, currentPrice = null, volumePriceDivergence = null, trendAnalysis = null, marketCap = null) {
    let baseScore = 0;
    // v3.39: 개별 서브 컴포넌트 점수 기록
    let volumeRatioScore = 0, vpdScore = 0, marketCapScore = 0, drawdownScore = 0, riseScore = 0;

    // ========================================
    // v3.23: 데이터 기반 Base Score 강화
    // Base(0-25) = 거래량(8) + VPD(7) + 시총(-5~+7) + 되돌림(-3~0) + 연속상승(0-5)
    // VPD는 Base Score에만 반영 (Momentum/Trend에서 제거)
    // ========================================

    // 1. 거래량 비율 (0-8점) v3.23: 5→8 확대
    // 데이터: 1-2x 승률 78.9%/+21.77%, 5x+ 승률 55.9%/+3.21%
    if (volumeAnalysis.current.volumeMA20) {
      const volumeRatio = volumeAnalysis.current.volume / volumeAnalysis.current.volumeMA20;
      if (volumeRatio >= 1.0 && volumeRatio < 2.0) volumeRatioScore = 8;       // 황금구간
      else if (volumeRatio >= 2.0 && volumeRatio < 3.0) volumeRatioScore = 5;  // 적정 증가
      else if (volumeRatio >= 3.0 && volumeRatio < 5.0) volumeRatioScore = 2;  // 과다 시작
      baseScore += volumeRatioScore;
    }

    // 2. VPD raw (0-7점) v3.23: 5→7 확대 (유일한 VPD 반영 위치)
    // "거래량 폭발 + 가격 미반영" 현재 상태를 점수화
    if (volumePriceDivergence && volumePriceDivergence.divergence > 0) {
      const div = volumePriceDivergence.divergence;
      if (div >= 3.0) vpdScore = 7;
      else if (div >= 2.0) vpdScore = 5;
      else if (div >= 1.0) vpdScore = 4;
      else if (div >= 0.5) vpdScore = 2;
      else if (div > 0) vpdScore = 1;
      baseScore += vpdScore;
    }

    // 3. 시총 보정 (-5 ~ +7점) v3.23: 대형주 보너스 확대
    // 데이터: 소형주(<1000억) 승률 11.1%/-2.88%, 대형주(5000억+) 70%/+11.44%
    if (marketCap) {
      const mcBillion = marketCap / 100000000; // 억 단위
      if (mcBillion < 1000) marketCapScore = -5;
      else if (mcBillion < 3000) marketCapScore = -2;
      else if (mcBillion >= 10000) marketCapScore = 7;
      else if (mcBillion >= 5000) marketCapScore = 5;
      else if (mcBillion >= 3000) marketCapScore = 2;
      baseScore += marketCapScore;
    }

    // 4. 고점 대비 되돌림 페널티 (-3~0점)
    if (chartData && currentPrice) {
      const recentHigh = Math.max(...chartData.slice(0, 30).map(d => d.high));
      const drawdownPercent = ((recentHigh - currentPrice) / recentHigh) * 100;

      if (drawdownPercent >= 20) drawdownScore = -3;
      else if (drawdownPercent >= 15) drawdownScore = -2;
      else if (drawdownPercent >= 10) drawdownScore = -1;
      baseScore += drawdownScore;
    }

    // 5. 연속 상승일 보너스 (0-5점) 🆕 v3.23
    if (chartData && chartData.length >= 5) {
      let consecutiveRise = 0;
      for (let i = 0; i < Math.min(5, chartData.length - 1); i++) {
        if (chartData[i].close > chartData[i + 1].close) {
          consecutiveRise++;
        } else {
          break;
        }
      }
      if (consecutiveRise >= 4) riseScore = 5;
      else if (consecutiveRise >= 3) riseScore = 3;
      else if (consecutiveRise >= 2) riseScore = 1;
      baseScore += riseScore;
    }

    const finalBase = Math.min(Math.max(baseScore, 0), 25);
    // v3.39: 서브 컴포넌트를 _baseDetail에 저장 (scoreBreakdown에서 참조)
    this._baseDetail = { volumeRatio: volumeRatioScore, vpd: vpdScore, marketCap: marketCapScore, drawdown: drawdownScore, consecutiveRise: riseScore };
    return finalBase;
  }

  // ========================================
  // v3.34: 방어 전략 스코어링 (Defense Strategy)
  // DefenseTotal = Recovery(0-30) + SmartMoney(0-25) + Stability(0-25) + Safety(0-20) + SignalAdj
  // ========================================

  /**
   * 방어 전략 점수 계산
   * 하락장에서 과매도 반등 + 기관 수급 기반 안전한 종목 선별
   */
  calculateDefenseScore(volumeAnalysis, advancedAnalysis, chartData, currentPrice, investorData, riskAdjusted, crashCheck, marketCap) {
    if (!chartData || chartData.length < 20) {
      return { totalScore: 0, breakdown: {}, grade: 'D-D' };
    }

    // === 1. Recovery Score (0-30점): 과매도 반등 신호 ===
    const rsi = this.calculateRSI(chartData, 14);
    const mfi = volumeAnalysis?.indicators?.mfi || 50;
    const disparity = this.calculateDisparity(chartData, currentPrice, 20);

    // RSI 과매도 (0-12점)
    let rsiScore = 0;
    if (rsi >= 25 && rsi < 35) rsiScore = 12;
    else if (rsi >= 35 && rsi < 45) rsiScore = 9;
    else if (rsi >= 20 && rsi < 25) rsiScore = 6;
    else if (rsi >= 45 && rsi < 50) rsiScore = 4;
    else if (rsi < 20) rsiScore = 2;

    // MFI 회복 (0-10점)
    let mfiScore = 0;
    if (mfi >= 20 && mfi < 30) mfiScore = 10;
    else if (mfi >= 30 && mfi < 40) mfiScore = 7;
    else if (mfi >= 15 && mfi < 20) mfiScore = 5;
    else if (mfi >= 40 && mfi < 50) mfiScore = 3;

    // 이격도 할인 (0-8점)
    let disparityScore = 0;
    if (disparity >= 90 && disparity < 95) disparityScore = 8;
    else if (disparity >= 85 && disparity < 90) disparityScore = 6;
    else if (disparity >= 95 && disparity < 98) disparityScore = 5;
    else if (disparity >= 98 && disparity < 100) disparityScore = 2;
    else if (disparity < 85) disparityScore = 1;

    const recoveryScore = Math.min(rsiScore + mfiScore + disparityScore, 30);

    // === 2. SmartMoney Score (0-25점): 기관/외국인 수급 ===
    let instBuyDays = 0;
    let foreignBuyDays = 0;

    if (investorData && investorData.length > 0) {
      // 기관 연속 매수일 (최근부터 과거로)
      for (const day of investorData) {
        const instNet = parseInt(day.institution?.netBuyQty || day.institution_net_buy || 0);
        if (instNet > 0) instBuyDays++;
        else break;
      }
      // 외국인 연속 매수일
      for (const day of investorData) {
        const foreignNet = parseInt(day.foreign?.netBuyQty || day.foreign_net_buy || 0);
        if (foreignNet > 0) foreignBuyDays++;
        else break;
      }
    }

    // 기관 점수 (0-12점)
    let instScore = 0;
    if (instBuyDays >= 5) instScore = 12;
    else if (instBuyDays >= 4) instScore = 10;
    else if (instBuyDays >= 3) instScore = 7;
    else if (instBuyDays >= 2) instScore = 4;
    else if (instBuyDays >= 1) instScore = 1;

    // 외국인 점수 (0-8점)
    let foreignScore = 0;
    if (foreignBuyDays >= 5) foreignScore = 8;
    else if (foreignBuyDays >= 4) foreignScore = 6;
    else if (foreignBuyDays >= 3) foreignScore = 4;
    else if (foreignBuyDays >= 2) foreignScore = 2;

    // 쌍방 수급 보너스 (0-5점)
    let dualBonus = 0;
    if (instBuyDays >= 3 && foreignBuyDays >= 3) dualBonus = 5;
    else if (instBuyDays >= 2 && foreignBuyDays >= 2) dualBonus = 3;
    else if ((instBuyDays >= 3 && foreignBuyDays >= 1) || (foreignBuyDays >= 3 && instBuyDays >= 1)) dualBonus = 2;

    const smartMoneyScore = Math.min(instScore + foreignScore + dualBonus, 25);

    // === 3. Stability Score (0-25점): 바닥 안정성 ===

    // 3-1. 거래량 안정성 (0-10점)
    const volumeRatio = volumeAnalysis?.current?.volumeMA20
      ? volumeAnalysis.current.volume / volumeAnalysis.current.volumeMA20 : 1;
    const recent5Volumes = chartData.slice(0, 5).map(d => d.volume);
    const avgVol5 = recent5Volumes.reduce((a, b) => a + b, 0) / 5;
    const stdVol5 = Math.sqrt(recent5Volumes.reduce((s, v) => s + Math.pow(v - avgVol5, 2), 0) / 5);
    const volumeCV = avgVol5 > 0 ? stdVol5 / avgVol5 : 1;

    let volumeStabilityScore = 0;
    if (volumeRatio >= 0.8 && volumeRatio <= 1.5 && volumeCV < 0.3) volumeStabilityScore = 10;
    else if (volumeRatio >= 0.8 && volumeRatio <= 1.5 && volumeCV < 0.5) volumeStabilityScore = 7;
    else if (volumeRatio > 1.5 && volumeRatio <= 2.5 && volumeCV < 0.5) volumeStabilityScore = 5;
    else if (volumeRatio >= 0.5 && volumeRatio < 0.8 && volumeCV < 0.3) volumeStabilityScore = 4;
    else if (volumeRatio > 2.5) volumeStabilityScore = 2;
    else if (volumeRatio < 0.5) volumeStabilityScore = 1;

    // 3-2. 변동성 수축 (0-8점)
    const volatility = this.analyzeVolatilityContraction(chartData);
    const contractionRatio = volatility.details?.contractionRatio || (volatility.score > 0 ? 0.7 : 1.1);
    let volatilityScore = 0;
    if (contractionRatio <= 0.4) volatilityScore = 8;
    else if (contractionRatio <= 0.6) volatilityScore = 6;
    else if (contractionRatio <= 0.8) volatilityScore = 4;
    else if (contractionRatio <= 1.0) volatilityScore = 2;

    // 3-3. 바닥 형성 (0-7점)
    const bottomFormation = advancedAnalysis?.indicators?.bottomFormation || { detected: false };
    let bottomScore = 0;
    if (bottomFormation.detected) {
      bottomScore = 7;
    } else {
      // 부분 조건 체크
      const recentHigh = Math.max(...chartData.slice(0, 30).map(d => d.high));
      const decline = ((currentPrice - recentHigh) / recentHigh) * 100;
      const hasDecline = decline < -15;

      if (hasDecline) {
        const recent5Vol = chartData.slice(0, 5).reduce((s, d) => s + d.volume, 0) / 5;
        const old20Vol = chartData.slice(5, 25).reduce((s, d) => s + d.volume, 0) / 20;
        const volDrying = old20Vol > 0 ? (recent5Vol / old20Vol) < 0.5 : false;

        const recent5Prices = chartData.slice(0, 5).map(d => d.close);
        const priceRange = ((Math.max(...recent5Prices) - Math.min(...recent5Prices)) / currentPrice) * 100;
        const priceStable = priceRange < 3;

        if (hasDecline && volDrying) bottomScore = 4;
        else if (hasDecline && priceStable) bottomScore = 3;
        else bottomScore = 1;
      }
    }

    const stabilityScore = Math.min(volumeStabilityScore + volatilityScore + bottomScore, 25);

    // === 4. Safety Score (0-20점): 리스크 관리 ===
    const mcBillion = marketCap ? marketCap / 100000000 : 0; // 억 단위

    // 시총 안전성 (0-10점)
    let marketCapScore = 0;
    if (mcBillion >= 100000) marketCapScore = 10;       // 10조+
    else if (mcBillion >= 50000) marketCapScore = 8;    // 5조+
    else if (mcBillion >= 30000) marketCapScore = 6;    // 3조+
    else if (mcBillion >= 10000) marketCapScore = 4;    // 1조+
    else if (mcBillion >= 5000) marketCapScore = 2;     // 5000억+

    // 위험조정 수익률 (0-5점) — Sharpe 음수가 타겟
    const sharpe = parseFloat(riskAdjusted?.sharpeRatio || 0);
    let sharpeScore = 0;
    if (sharpe < -1.0) sharpeScore = 5;
    else if (sharpe < -0.5) sharpeScore = 3;
    else if (sharpe < 0) sharpeScore = 2;

    // 낙폭 포지셔닝 (0-5점)
    const recentHigh = Math.max(...chartData.slice(0, 30).map(d => d.high));
    const drawdownPct = ((recentHigh - currentPrice) / recentHigh) * 100;
    let drawdownScore = 0;
    if (drawdownPct >= 15 && drawdownPct < 25) drawdownScore = 5;
    else if (drawdownPct >= 25 && drawdownPct < 35) drawdownScore = 4;
    else if (drawdownPct >= 10 && drawdownPct < 15) drawdownScore = 3;
    else if (drawdownPct >= 35) drawdownScore = 1;

    const safetyScore = Math.min(marketCapScore + sharpeScore + drawdownScore, 20);

    // === 5. Signal Adjustments ===
    let signalAdj = 0;

    // 비대칭 매수세 보너스
    const asymmetricRatio = advancedAnalysis?.indicators?.asymmetric?.ratio || 1;
    if (asymmetricRatio > 1.5) signalAdj += 5;

    // 폭락 진행 중 감점
    if (crashCheck?.isCrashing) signalAdj -= 15;

    // 매도고래 최근 3일 감점
    const sellWhales = (advancedAnalysis?.indicators?.whale || []).filter(w => w.type?.includes('매도'));
    if (sellWhales.length > 0) {
      const recentSellWhales = sellWhales.filter(w => {
        const whaleIdx = chartData.findIndex(d => d.date === w.date);
        return whaleIdx >= 0 && whaleIdx <= 3;
      });
      if (recentSellWhales.length > 0) signalAdj -= 10;
    }

    // 최종 점수
    const rawScore = recoveryScore + smartMoneyScore + stabilityScore + safetyScore + signalAdj;
    const totalScore = parseFloat(Math.min(Math.max(rawScore, 0), 100).toFixed(2));

    const breakdown = {
      recovery: { total: recoveryScore, rsi: rsiScore, mfi: mfiScore, disparity: disparityScore, rsiValue: parseFloat(rsi.toFixed(1)), mfiValue: parseFloat(mfi.toFixed(1)), disparityValue: parseFloat(disparity.toFixed(1)) },
      smartMoney: { total: smartMoneyScore, institution: instScore, foreign: foreignScore, dualBonus, instBuyDays, foreignBuyDays },
      stability: { total: stabilityScore, volumeStability: volumeStabilityScore, volatility: volatilityScore, bottomFormation: bottomScore, volumeCV: parseFloat(volumeCV.toFixed(2)), contractionRatio: parseFloat(contractionRatio.toFixed(2)) },
      safety: { total: safetyScore, marketCap: marketCapScore, sharpe: sharpeScore, drawdown: drawdownScore, drawdownPct: parseFloat(drawdownPct.toFixed(1)) },
      signalAdj,
      formula: 'Recovery(0-30) + SmartMoney(0-25) + Stability(0-25) + Safety(0-20) + SignalAdj [v3.34]'
    };

    const grade = this.getDefenseRecommendation(totalScore);

    return { totalScore, breakdown, grade };
  }

  /**
   * 방어 전략 등급 산출 (D- 접두사로 모멘텀과 구분)
   */
  getDefenseRecommendation(defenseScore, overheatingV2 = null) {
    if (overheatingV2 && overheatingV2.overheated) return 'D-과열';
    if (defenseScore >= 85) return 'D-S+';
    if (defenseScore >= 70) return 'D-S';
    if (defenseScore >= 55) return 'D-A';
    if (defenseScore >= 40) return 'D-B';
    if (defenseScore >= 25) return 'D-C';
    return 'D-D';
  }

  /**
   * 추천 등급 산출 v3.21 - Radar Scoring + 7-Tier Grade System
   *
   * Radar Scoring: 0-92점 (Base 17 + Momentum 45 + Trend 40 + MultiSignal 6) [v3.21]
   *
   * 7-Tier Grade System (Priority Order):
   * - 과열 (priority 0): RSI > 80 AND 이격도 > 115
   * - S+: 90점+ (이론적 최고)
   * - S: 75-89 points
   * - A: 60-74 points
   * - B: 45-59 points
   * - C: 30-44 points
   * - D: <30 points
   */
  getRecommendation(score, tier, overheating, overheatingV2 = null) {
    let grade, text, color, tooltip;

    // v3.16: 과열 감지 시 점수 무관하게 "과열" 등급 (v3.13 "과열=기회" 전략 제거)
    // 실제 성과: 64% 승률, +1.08% 평균, 28% 폭락률 → 과열은 경고로 복원
    if (overheatingV2 && overheatingV2.overheated) {
      grade = '과열';
      text = '⚠️ 과열 경고';
      color = '#ff0000';
      tooltip = `${overheatingV2.reason} - 단기 조정 가능성 높음`;
      return { grade, text, color, tier, overheating: overheatingV2.reason, tooltip };
    }

    // 등급 체계 (점수 내림차순, 7-Tier System)
    if (score >= 90) {
      // S+ 등급 (90점 만점)
      grade = 'S+';
      text = '🌟 최상위 매수';
      color = '#ff0000';
      tooltip = '완벽한 Radar Score - 강력한 급등 신호';
    } else if (score >= 75) {
      // S 등급 (75-89점)
      grade = 'S';
      text = '🔥 최우선 매수';
      color = '#ff4444';
      tooltip = '거래량 폭발, 기관 본격 매수';
    } else if (score >= 60) {
      // A 등급 (60-74점)
      grade = 'A';
      text = '🟢 적극 매수';
      color = '#00cc00';
      tooltip = '거래량 증가 시작, 기관 초기 진입';
    } else if (score >= 45) {
      // B 등급 (45-59점)
      grade = 'B';
      text = '🟡 매수 고려';
      color = '#ffaa00';
      tooltip = '선행 패턴 감지, 진입 검토';
    } else if (score >= 30) {
      // C 등급 (30-44점)
      grade = 'C';
      text = '🟠 관망';
      color = '#ff9966';
      tooltip = '약한 신호, 관망 권장';
    } else {
      // D 등급 (<30점)
      grade = 'D';
      text = '⚫ 비추천';
      color = '#cccccc';
      tooltip = '선행 지표 미감지';
    }

    // v3.26: tier 기반 텍스트 오버라이드 제거
    // 고래/탈출속도는 시그널 UI에서 이미 충분히 표시되므로 등급 텍스트 유지

    // 기존 과열 경고 (v3.9 호환성 유지)
    if (overheating.warning) {
      text = `⚠️ ${text} (과열주의)`;
    } else if (overheating.heatScore > 50) {
      text = `⚠️ ${text} (신중)`;
    }

    // v3.12 타이밍 경고 (백테스팅 검증 결과 기반)
    let timingWarning = null;

    if (score >= 70 && score < 80) {
      // 70-79점: 대박 구간 (12개, 평균 +60.28%)
      timingWarning = {
        type: 'jackpot',
        badge: '🚀 대박 구간',
        color: '#ff0000',
        message: '평균 +60.28% 수익 구간 (백테스트 검증)'
      };
    } else if (score >= 50 && score < 60) {
      // 50-59점: 안정 구간 (65개, 평균 +2.08%, 승률 50.77%)
      timingWarning = {
        type: 'golden',
        badge: '🎯 안정 구간',
        color: '#00cc00',
        message: '승률 50.77%, 평균 +2.08% (백테스트 검증)'
      };
    } else if (score >= 60 && score < 70) {
      // 60-69점: 혼재 구간 (평균 -0.75%)
      timingWarning = {
        type: 'caution',
        badge: '⚠️ 신중 진입',
        color: '#ffaa00',
        message: '성과 혼재 구간, 신중한 진입 필요'
      };
    } else if (score < 50) {
      // 45-49점: 위험 구간 (37개, 평균 -5.13%)
      timingWarning = {
        type: 'weak',
        badge: '⚠️ 신호 약함',
        color: '#ff6666',
        message: '평균 -5.13%, 위험 구간 (백테스트 검증)'
      };
    } else if (score >= 80) {
      // 80+점: 과열 의심 (4개, 평균 +7.60%, 샘플 부족)
      timingWarning = {
        type: 'overheat',
        badge: '🔥 과열 의심',
        color: '#ff4444',
        message: '샘플 부족으로 불안정, 신중 진입'
      };
    }

    return {
      grade,
      text,
      color,
      tier,
      overheating: overheating.message,
      tooltip,
      timingWarning // v3.12 NEW
    };
  }

  /**
   * 조용한 누적 패턴 종목 찾기 (거래량 점진 증가)
   * 거래량 급증이 아닌 "서서히" 증가하는 패턴 - 급등 전조
   */
  async findGradualAccumulationStocks(market = 'ALL', targetCount = 10) {
    console.log('🐌 조용한 누적 패턴 종목 탐색 시작...');

    const { codes: allStocks } = await kisApi.getAllStockList(market);
    const gradualStocks = [];
    let scanned = 0;

    // 전체 종목 중 랜덤하게 샘플링하여 효율성 높이기
    const shuffled = [...allStocks].sort(() => Math.random() - 0.5);

    for (const stockCode of shuffled) {
      if (gradualStocks.length >= targetCount) break;
      if (scanned >= 100) break; // 최대 100개만 스캔

      try {
        scanned++;
        const chartData = await kisApi.getDailyChart(stockCode, 30);

        // advancedIndicators에서 gradualAccumulation만 검사
        const advancedIndicators = require('./advancedIndicators');
        const gradualCheck = advancedIndicators.detectGradualAccumulation(chartData);

        if (gradualCheck.detected) {
          gradualStocks.push(stockCode);
          console.log(`  ✅ [${gradualStocks.length}/${targetCount}] 조용한 누적 발견: ${stockCode}`);
        }

        // API 호출 간격
        await new Promise(resolve => setTimeout(resolve, 200));

        if (scanned % 10 === 0) {
          console.log(`  📊 스캔: ${scanned}개, 발견: ${gradualStocks.length}/${targetCount}`);
        }
      } catch (error) {
        // 에러 무시하고 계속 진행
      }
    }

    console.log(`✅ 조용한 누적 ${gradualStocks.length}개 발견 (스캔: ${scanned}개)`);
    return gradualStocks;
  }

  /**
   * 전체 종목 스크리닝 (100개 풀 기반)
   * 거래량 급증 30 + 거래량 20 + 거래대금 10 = 60개 * 2시장 = 120개 (중복 제거 후 ~100개)
   * @param {string} market - 시장 구분
   * @param {number} limit - 반환 개수 제한
   * @param {boolean} skipScoreFilter - true면 점수 필터 건너뜀 (패턴 매칭용)
   */
  async screenAllStocks(market = 'ALL', limit, skipScoreFilter = false) {
    console.log(`🔍 종합 TOP 스크리닝 시작 (100개 풀${limit ? `, 상위 ${limit}개 반환` : ', 전체 반환'})...\n`);

    // 종목 풀 생성 (KIS API 또는 fallback 하드코딩 리스트)
    const { codes: finalStockList, marketMap, nameMap: stockNameMap } = await kisApi.getAllStockList(market);
    console.log(`✅ 종목 풀: ${finalStockList.length}개 확보\n`);

    // KIS API 디버그 정보 가져오기
    const kisApiDebug = kisApi._lastPoolDebug || { note: 'No debug info available' };

    console.log(`\n📊 전체 종목 분석 시작...\n`);

    const results = [];
    let analyzed = 0;

    // 전체 100개 분석
    for (const stockCode of finalStockList) {
      try {
        const analysis = await this.analyzeStock(stockCode);
        analyzed++;

        // 🆕 v3.13: 지속적 폭락 필터
        // 목적: 유일에너테크 같은 폭락 중 종목 추천 방지
        if (analysis && analysis.crashCheck && analysis.crashCheck.isCrashing) {
          console.log(`❌ [${analysis.stockName}] ${analysis.crashCheck.message} - 종목 제외`);
          continue; // 폭락 종목은 완전 차단
        }

        // skipScoreFilter가 true면 점수 무시, false면 20점 이상만 (C등급 이상)
        if (analysis && (skipScoreFilter || analysis.totalScore >= 20)) {
          analysis.market = marketMap?.get(stockCode) || null;
          // nameMap에서 종목명 보완 (getCurrentPrice에서 누락된 경우)
          if (!analysis.stockName || analysis.stockName === stockCode || analysis.stockName.startsWith('[')) {
            const poolName = stockNameMap?.get(stockCode);
            if (poolName && poolName !== stockCode && !poolName.startsWith('[')) {
              analysis.stockName = poolName;
            }
          }
          results.push(analysis);
          console.log(`✅ [${results.length}] ${analysis.stockName} (${analysis.stockCode}) - 점수: ${analysis.totalScore.toFixed(1)}`);
        }

        // API 호출 간격 (200ms)
        await new Promise(resolve => setTimeout(resolve, 200));

        // 진행률 로그
        if (analyzed % 10 === 0) {
          console.log(`📊 분석: ${analyzed}/${finalStockList.length}, 발견: ${results.length}개`);
        }
      } catch (error) {
        console.error(`❌ 분석 실패 [${stockCode}]:`, error.message);
      }
    }

    // 점수 기준 내림차순 정렬
    results.sort((a, b) => b.totalScore - a.totalScore);

    console.log(`\n✅ 종합 스크리닝 완료!`);
    console.log(`  - 분석: ${analyzed}개`);
    console.log(`  - 발견: ${results.length}개 (20점 이상, C등급+)`);
    console.log(`  - 최종: ${limit ? `상위 ${limit}개` : `전체 ${results.length}개`} 반환\n`);

    const finalResults = limit ? results.slice(0, limit) : results;

    // TOP 3 선정 (전체 결과에서 선정)
    const top3 = this.selectTop3(results);
    const defenseTop3 = this.selectDefenseTop3(results);

    return {
      stocks: finalResults,
      top3: top3,  // 🆕 TOP 3 추천 종목
      defenseTop3: defenseTop3,  // v3.34: 방어 TOP 3
      metadata: {
        totalAnalyzed: analyzed,
        totalFound: results.length,
        returned: finalResults.length,
        top3Count: top3.length,  // 🆕 TOP 3 개수
        defenseTop3Count: defenseTop3.length,
        poolSize: finalStockList.length,
        debug: {
          finalStockListSample: finalStockList.slice(0, 10),
          finalStockListLength: finalStockList.length,
          kisApiDebug: kisApiDebug
        }
      }
    };
  }

  /**
   * 특정 카테고리 필터링 (Vercel stateless 환경 대응)
   */
  async screenByCategory(category, market = 'ALL', limit) {
    console.log(`🔍 ${category} 카테고리 스크리닝 시작${limit ? ` (최대 ${limit}개)` : ' (전체 조회)'}...`);

    const { codes: stockList } = await kisApi.getAllStockList(market);
    const results = [];
    let analyzed = 0;
    let found = 0;

    // 카테고리별 필터 함수 (v3.22: 매집 제거, 고래만 유지)
    const categoryFilters = {
      'whale': (analysis) => analysis.advancedAnalysis.indicators.whale.length > 0
    };

    const filterFn = categoryFilters[category] || (() => true);

    // 조건에 맞는 종목을 찾을 때까지 분석 (최대 전체 리스트)
    // limit이 없으면 전체 스캔, 있으면 limit 개수까지만
    for (let i = 0; i < stockList.length && (limit ? found < limit : true); i++) {
      const stockCode = stockList[i];

      try {
        const analysis = await this.analyzeStock(stockCode);
        analyzed++;

        if (analysis && filterFn(analysis)) {
          results.push(analysis);
          found++;
          console.log(`✅ [${found}${limit ? `/${limit}` : ''}] ${analysis.stockName} - ${category} 조건 충족`);
        }

        // API 호출 간격 (200ms)
        await new Promise(resolve => setTimeout(resolve, 200));

        // 진행률 로그
        if (analyzed % 10 === 0) {
          console.log(`📊 분석: ${analyzed}개, 발견: ${found}${limit ? `/${limit}` : ''}개`);
        }
      } catch (error) {
        console.error(`❌ 분석 실패 [${stockCode}]:`, error.message);
      }
    }

    // 점수 기준 내림차순 정렬
    results.sort((a, b) => b.totalScore - a.totalScore);

    console.log(`✅ ${category} 스크리닝 완료! ${analyzed}개 분석, ${found}개 발견`);

    return {
      stocks: results,
      metadata: {
        category,
        totalAnalyzed: analyzed,
        totalFound: found,
        returned: results.length
      }
    };
  }

  /**
   * TOP 3 추천 종목 선정 (Fallback 로직 포함)
   *
   * 시뮬레이션 결과 기반 전략:
   * - 1순위: 고래 + 황금구간(50-79점) - 승률 76.9%, 평균 +27.02%
   * - 2순위: 고래 + 60점 이상 - 승률 71.4%
   * - 3순위: 고래 단독 - 승률 64.7%, 평균 +20.31%
   *
   * @param {Array} allStocks - 전체 종목 배열
   * @returns {Array} - TOP 3 종목 (최대 3개)
   */
  selectTop3(allStocks) {
    console.log(`\n🔍 TOP 3 선정 시작...`);
    console.log(`  전체 종목: ${allStocks.length}개`);

    // v3.35: 매수고래 + 비과열 → 점수 내림차순 TOP 3
    const eligible = allStocks.filter(stock => {
      const hasBuyWhale = (stock.advancedAnalysis?.indicators?.whale || []).some(w => w.type?.includes('매수'));
      const isOverheated = stock.recommendation?.grade === '과열';
      return hasBuyWhale && !isOverheated;
    });

    console.log(`  └─ TOP 3 후보 (매수고래+비과열): ${eligible.length}개`);

    const top3 = eligible
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 3)
      .map((stock, i) => {
        const currentPrice = stock.currentPrice || 0;
        return {
          ...stock,
          top3Meta: {
            rank: i + 1,
            stopLoss: {
              loss5: Math.floor(currentPrice * 0.95),
              loss7: Math.floor(currentPrice * 0.93),
              loss10: Math.floor(currentPrice * 0.90)
            }
          }
        };
      });

    console.log(`\n🏆 TOP 3 선정 완료: ${top3.length}개`);
    if (top3.length === 0) {
      console.log(`  ⚠️ TOP 3 선정 실패 - 매수고래 감지 종목 없음`);
    } else {
      top3.forEach((stock, i) => {
        console.log(`  ${i + 1}. ${stock.stockName} (${stock.totalScore}점, ${stock.recommendation.grade}등급)`);
      });
    }

    return top3;
  }

  /**
   * v3.34: 방어 전략 TOP 3 선별
   * 기관/외국인 수급 기반 과매도 반등 종목 선별
   */
  selectDefenseTop3(allStocks) {
    console.log(`\n🛡️ 방어 TOP 3 선정 시작...`);

    const isEligible = (s) => {
      const flow = s.institutionalFlow;
      const instDays = flow?.institutionDays || 0;
      const foreignDays = flow?.foreignDays || 0;
      const hasSmartMoney = instDays >= 3 || foreignDays >= 3;
      const isNotCrashing = !s.crashCheck?.isCrashing;
      const isNotOverheated = s.recommendation?.grade !== '과열';
      const mcBillion = s.marketCap ? s.marketCap / 100000000 : 0;
      const hasMinMarketCap = mcBillion >= 5000;
      return hasSmartMoney && isNotCrashing && isNotOverheated && hasMinMarketCap;
    };

    const getDualBonus = (s) => {
      const flow = s.institutionalFlow;
      const instDays = flow?.institutionDays || 0;
      const foreignDays = flow?.foreignDays || 0;
      return instDays >= 2 && foreignDays >= 2;
    };

    const addMeta = (stock, priority) => {
      const currentPrice = stock.currentPrice || 0;
      const mcBillion = stock.marketCap ? stock.marketCap / 100000000 : 0;
      const isLargeCap = mcBillion >= 50000; // 5조+
      return {
        ...stock,
        defenseTop3Meta: {
          priority,
          stopLoss: {
            caution: Math.floor(currentPrice * (isLargeCap ? 0.96 : 0.97)),
            cut: Math.floor(currentPrice * (isLargeCap ? 0.94 : 0.95))
          }
        }
      };
    };

    const top3 = [];

    // 1순위: 쌍방수급 + 55-84점
    const p1 = allStocks.filter(s => isEligible(s) && s.defenseScore >= 55 && s.defenseScore < 85 && getDualBonus(s))
      .sort((a, b) => b.defenseScore - a.defenseScore).map(s => addMeta(s, 1));
    top3.push(...p1.slice(0, 3));

    // 2순위: 55점+
    if (top3.length < 3) {
      const p2 = allStocks.filter(s => isEligible(s) && s.defenseScore >= 55 && !top3.some(t => t.stockCode === s.stockCode))
        .sort((a, b) => b.defenseScore - a.defenseScore).map(s => addMeta(s, 2));
      top3.push(...p2.slice(0, 3 - top3.length));
    }

    // 3순위: 40점+
    if (top3.length < 3) {
      const p3 = allStocks.filter(s => isEligible(s) && s.defenseScore >= 40 && !top3.some(t => t.stockCode === s.stockCode))
        .sort((a, b) => b.defenseScore - a.defenseScore).map(s => addMeta(s, 3));
      top3.push(...p3.slice(0, 3 - top3.length));
    }

    console.log(`🛡️ 방어 TOP 3 선정 완료: ${top3.length}개`);
    top3.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.stockName} (방어 ${s.defenseScore}점, ${s.defenseGrade}) P${s.defenseTop3Meta.priority}`);
    });

    return top3;
  }

  /**
   * 캐시 초기화
   */
  clearCache() {
    this.cachedResults = null;
    this.cacheTimestamp = null;
    console.log('🗑️ 캐시 초기화 완료');
  }
}

module.exports = new StockScreener();
