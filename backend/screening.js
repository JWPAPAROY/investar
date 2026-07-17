const kisApi = require('./kisApi');
const volumeIndicators = require('./volumeIndicators');
const advancedIndicators = require('./advancedIndicators');
// v3.94: TOP3 정렬·시총 플로어·레짐은 공용 모듈 단일 출처. 이 파일의 selectTop3는
//   v3.85(폐기된 isV2Priority 정렬)에 멈춰 있었고 시총 플로어도 빠져 있었다.
const { sortByTop3Order, applyMomentumCapFloor, SCREENING_ACCESSORS } = require('./top3Ranking');
const { detectMarketRegime } = require('./marketRegime');
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
   * 30일 추세 점수 계산 (Trend Score, 0-15점) — v3.23 기준
   *
   * analyzeVolumeAcceleration(30일 4구간 거래량 가속)을 재사용해 0-15점으로 cap.
   * v3.23에서 나머지 3개 컴포넌트(변동성 수축 / 기관 장기매집 / VPD 강화)는 제거됐고,
   * 반환값의 해당 필드는 하위호환용 더미('removed_v3.23')다.
   *
   * ⚠️ 같은 지표가 Momentum(0-15)에도 들어가 100점 중 30점이 한 신호에서 나온다.
   *    CLAUDE.md v2 설계 노트 참고("거래량 가속: r=-0.10, v1 배점 0-30 중복").
   *
   * ⚠️ v3.94 정정: 여기 있던 주석은 v3.20 시절 것("0-40점", 이미 제거된 4개 컴포넌트 배점)
   *    으로 실제와 무관했다. 배점 변경 시 CLAUDE.md와 함께 갱신할 것.
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
    // ⚠️ chartData는 내림차순([0]=오늘)이라 slice(daysAgo)가 "최신 N개 제외" = N일 전 시점.
    //    investorData는 오름차순([0]=가장 오래된 날)이라 같은 slice가 "가장 오래된 N개 제외"가
    //    되어 정반대였다. 5일치만 조회하므로 slice(5)는 항상 빈 배열 → d5State가 영구히 0,
    //    "D-5 대비 기관 진입 가속"(-2~+5) 비교가 축퇴돼 모든 종목이 "신규 진입"으로 보였다.
    //    (v3.94 수정) 오름차순에서 N일 전 시점 = 뒤(최신)에서 N개를 잘라낸다.
    const slicedChartData = chartData.slice(daysAgo);
    const slicedInvestorData = investorData
      ? investorData.slice(0, Math.max(0, investorData.length - daysAgo))
      : [];

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
    // v3.94: 오름차순이므로 최신일(뒤)부터 과거로 세다가 첫 비매수일에 중단 (최대 5일).
    //   기존엔 slice(0,5) = 가장 오래된 5일을 앞에서부터 세고 있었다.
    let institutionalBuyDays = 0;
    if (slicedInvestorData && slicedInvestorData.length > 0) {
      for (let i = slicedInvestorData.length - 1; i >= 0 && institutionalBuyDays < 5; i--) {
        const day = slicedInvestorData[i];
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

    // v3.44: RSI 80→85로 완화 (RSI 80-85 구간 승률 83.3%, 최고수익 +48.49%)
    // 이격도 115→120으로 완화 (강한 모멘텀 종목 과도 필터링 방지)
    const overheated = (rsi > 85) && (disparity > 120);
    let reason = 'normal';

    if (rsi > 85 && disparity > 120) {
      reason = `과열 (RSI ${rsi.toFixed(1)} > 85 AND 이격도 ${disparity.toFixed(1)} > 120)`;
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

    // v3.76: 급등 패널티 구간 재설계 (90일 성과 데이터 기반)
    // +10-15% 종가: 72%승률/+11.9%max → 완화 (-15→-5)
    // +15-20% 종가: 56%승률/+2.7%final → 가장 위험 (-15 유지)
    // +20%+ 종가: 73%승률/+29.5%max → 상한가 모멘텀 (-30→-10)
    if (closeChange >= 20) {
      // 상한가급 종가: 강한 모멘텀 유지 경향 (73% 승률, +29.5% max)
      penalty = -10;
      message = `⚠️ 당일 급등 (종가 +${closeChange.toFixed(1)}%)`;
    } else if (highChange >= 20) {
      // 장중 상한가 but 종가 미달: 매도 압력 존재
      penalty = -20;
      message = `⚠️ 당일 급등 (고가 +${highChange.toFixed(1)}%)`;
    } else if (closeChange >= 15) {
      // 종가 +15-20%: 가장 위험한 구간 (56% 승률, +2.7% final)
      penalty = -15;
      message = `⚠️ 당일 급등 (종가 +${closeChange.toFixed(1)}%)`;
    } else if (highChange >= 15) {
      // 장중 +15% but 종가 미달: 위험 구간
      penalty = -15;
      message = `⚠️ 당일 급등 (고가 +${highChange.toFixed(1)}%)`;
    } else if (closeChange >= 10) {
      // 종가 +10-15%: 양호한 구간 (72% 승률, +11.9% max) → 대폭 완화
      penalty = -5;
      message = `당일 상승 (종가 +${closeChange.toFixed(1)}%)`;
    } else if (closeChange <= -10) {
      // 종가 -10% 이하 급락 → -20점
      penalty = -20;
      message = `⚠️ 당일 급락 (종가 ${closeChange.toFixed(1)}%)`;
    } else if (closeChange <= -5) {
      // 종가 -5% 이하 하락 → -10점
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
   * 5일 모멘텀 점수 계산 (Momentum Score, 0-30점) — v3.23 기준
   * D-5일 vs D-0일 비교로 "지금 막 시작되는" 종목을 포착.
   *
   * - 거래량 가속도:   0-15점 (analyzeVolumeAcceleration 재사용, 30일 4구간)
   * - 연속 상승일:     0-10점 (≥4일 10 / ≥3일 7 / ≥2일 4)
   * - 기관 진입 가속: -2~+5점 (calcInstitutionalEntryScore)
   * - 당일 급등 페널티 (calculateDailyRisePenalty) 적용 후 max(0, x)
   *
   * VPD 개선도는 v3.23에서 완전 제거(VPD는 Base Score에만 반영). 반환값의
   * vpdImprovement는 하위호환용 더미('removed_v3.23')다.
   *
   * ⚠️ v3.94 정정: 여기 있던 주석은 v3.20 시절 것("0-45점", "VPD 개선도 0-20점")으로
   *    실제와 무관했다. 배점 변경 시 CLAUDE.md와 함께 갱신할 것.
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
        // v3.94: 5 → 10일. D-5 시점 상태(calculateStateAtDay(…, 5))가 5일치를 필요로 하는데
        //   5일만 받아서 D-5 수급이 항상 비었다("기관 진입 가속" 비교가 축퇴). 호출 수는 동일.
        kisApi.getInvestorData(stockCode, 10).catch(e => { console.warn(`⚠️ 투자자 데이터 실패 [${stockCode}]: ${e.message}`); return null; })
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

      const recommendation = this.getRecommendation(totalScore, advancedAnalysis.tier, overheating, overheatingV2);
      return {
        stockCode,
        stockName: currentData.stockName,
        currentPrice: currentData.currentPrice,
        changeRate: currentData.changeRate,
        volume: currentData.volume,
        marketCap: currentData.marketCap,
        // v3.65 Tier 1: getCurrentPrice 추가 필드
        sectorName: currentData.sectorName || null,
        foreignRatio: currentData.foreignRatio || 0,
        per: currentData.per || 0,
        pbr: currentData.pbr || 0,
        programNetBuy: currentData.programNetBuy || 0,
        volumeAnalysis,
        advancedAnalysis,
        institutionalFlow, // 신규: 기관/외국인 수급
        riskAdjusted,
        manipulation, // 신규: 작전주 필터
        liquidity, // 신규: 유동성 필터
        previousSurge, // 신규: 과거급등 필터
        volumePriceDivergence, // ⭐ Volume-Price Divergence (거래량 폭발 + 가격 미반영)
        cupAndHandle, // 신규: Cup&Handle 패턴
        triangle, // 신규: Triangle 패턴
        crashCheck, // 🆕 v3.13: 지속적 폭락 감지
        scoreBreakdown, // 신규: 가점/감점 상세 내역
        trendAnalysis, // 추세 분석 (5일 일자별)
        momentumScore, // ⭐ 모멘텀 점수 (D-5 vs D-0, 0-30점)
        trendScore, // ⭐ 추세 점수 (30일 거래량 가속, 0-15점)
        overheating, // Phase 4C 과열 정보 추가
        radarScore, // Radar Scoring 상세
        overheatingV2, // v3.10.0: 과열 감지 v2 (RSI + 이격도)
        totalScore,
        grade: recommendation.grade,
        recommendation,
        rankBadges: rankBadges || {},
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
   * 기본 점수 계산 (Base Score, 0-25점) — v3.23 기준
   * 급등 '예정' 종목 발굴에 최적화. 배점 근거는 CLAUDE.md "점수 체계 상세" 참고.
   *
   * - 거래량 비율: 0-8점  (1.0~2.0배 황금구간 8 / 2~3배 5 / 3~5배 2 / 그 외 0)
   * - VPD raw:    0-7점  (≥3.0→7 / ≥2.0→5 / ≥1.0→4 / ≥0.5→2 / >0→1)
   * - 시총 보정: -5~+7점 (≥1조 +7 / ≥5천억 +5 / ≥3천억 +2 / <3천억 -2 / <1천억 -5)
   * - 되돌림 페널티: -3~0점 (30일 고점 대비 ≥20% -3 / ≥15% -2 / ≥10% -1)
   * - 연속 상승일:  0-5점  (≥4일 +5 / ≥3일 +3 / ≥2일 +1)
   * → 합산 후 min(max(x, 0), 25)
   *
   * ⚠️ v3.94 정정: 여기 있던 주석은 v3.21 시절 것(거래량 0-3, OBV 0-3, VWAP 0-3,
   *   비대칭 0-4, 5일 변동율 0-2)으로 실제 코드와 무관했다. OBV/VWAP/비대칭/5일변동율은
   *   Base Score에 반영되지 않는다. 배점 변경 시 이 주석과 CLAUDE.md를 함께 갱신할 것.
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

  /**
   * 추천 등급 산출 — v3.23 기준
   *
   * 총점(0-100) = Base(0-25) + Whale(0/15/30) + Momentum(0-30) + Trend(0-15) + SignalAdj
   *
   * 등급 (과열이 최우선, 점수 무관):
   * - 과열: RSI > 85 AND 20일 이격도 > 120  → detectOverheatingV2
   * - S+ : ≥90 / S: 75-89 / A: 60-74 / B: 45-59 / C: 30-44 / D: <30
   *
   * ⚠️ v3.94 정정: 여기 있던 주석은 v3.21 시절 것으로 실제와 전혀 달랐다.
   *   ("0-92점 (Base 17 + Momentum 45 + Trend 40 + MultiSignal 6)", 과열 "RSI>80 AND 이격도>115")
   *   등급/과열 기준 변경 시 이 주석과 CLAUDE.md를 함께 갱신할 것.
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

    // 병렬 배치 분석 (3개씩 동시 처리, KIS API 초당 20회 제한 내)
    const BATCH_SIZE = 3;
    for (let i = 0; i < finalStockList.length; i += BATCH_SIZE) {
      const batch = finalStockList.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(stockCode => this.analyzeStock(stockCode))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const stockCode = batch[j];
        analyzed++;

        if (result.status === 'rejected') {
          console.error(`❌ 분석 실패 [${stockCode}]:`, result.reason?.message);
          continue;
        }

        const analysis = result.value;

        // 🆕 v3.13: 지속적 폭락 필터
        if (analysis && analysis.crashCheck && analysis.crashCheck.isCrashing) {
          console.log(`❌ [${analysis.stockName}] ${analysis.crashCheck.message} - 종목 제외`);
          continue;
        }

        // skipScoreFilter가 true면 점수 무시, false면 20점 이상만 (C등급 이상)
        if (analysis && (skipScoreFilter || analysis.totalScore >= 20)) {
          analysis.market = marketMap?.get(stockCode) || null;
          if (!analysis.stockName || analysis.stockName === stockCode || analysis.stockName.startsWith('[')) {
            const poolName = stockNameMap?.get(stockCode);
            if (poolName && poolName !== stockCode && !poolName.startsWith('[')) {
              analysis.stockName = poolName;
            }
          }
          results.push(analysis);
          console.log(`✅ [${results.length}] ${analysis.stockName} (${analysis.stockCode}) - 점수: ${analysis.totalScore.toFixed(1)}`);
        }
      }

      // 배치 간 간격 (100ms) - KIS API rate limit 준수
      await new Promise(resolve => setTimeout(resolve, 100));

      // 진행률 로그
      if (analyzed % 10 === 0) {
        console.log(`📊 분석: ${analyzed}/${finalStockList.length}, 발견: ${results.length}개`);
      }
    }

    // 점수 기준 내림차순 정렬
    results.sort((a, b) => b.totalScore - a.totalScore);

    // v3.65 Tier 2: 기관/외인 순매수 랭킹 매칭 (4회 API 호출)
    try {
      const [instKospi, instKosdaq, frgnKospi, frgnKosdaq] = await Promise.all([
        kisApi.getInstitutionalRanking({ market: '0001', investorType: '2', sortBy: '0' }),
        kisApi.getInstitutionalRanking({ market: '1001', investorType: '2', sortBy: '0' }),
        kisApi.getInstitutionalRanking({ market: '0001', investorType: '1', sortBy: '0' }),
        kisApi.getInstitutionalRanking({ market: '1001', investorType: '1', sortBy: '0' }),
      ]);

      // 종목코드 → 랭킹 정보 매핑
      const rankingMap = new Map();
      const addRanking = (list, type) => {
        if (!list) return;
        list.forEach((item, idx) => {
          const existing = rankingMap.get(item.stockCode) || {};
          if (type === 'inst') {
            existing.instRank = Math.min(existing.instRank || 999, idx + 1);
            existing.instNetBuy = (existing.instNetBuy || 0) + item.netBuyQty;
          } else {
            existing.frgnRank = Math.min(existing.frgnRank || 999, idx + 1);
            existing.frgnNetBuy = (existing.frgnNetBuy || 0) + item.netBuyQty;
          }
          rankingMap.set(item.stockCode, existing);
        });
      };
      addRanking(instKospi, 'inst');
      addRanking(instKosdaq, 'inst');
      addRanking(frgnKospi, 'frgn');
      addRanking(frgnKosdaq, 'frgn');

      // 결과 종목에 랭킹 정보 부착
      let matched = 0;
      results.forEach(stock => {
        const ranking = rankingMap.get(stock.stockCode);
        if (ranking) {
          stock.institutionalRanking = ranking;
          matched++;
        }
      });
      console.log(`📊 기관/외인 랭킹 매칭: ${matched}/${results.length}개 종목`);
    } catch (e) {
      console.warn('⚠️ 기관/외인 랭킹 조회 실패 (스킵):', e.message);
    }

    console.log(`\n✅ 종합 스크리닝 완료!`);
    console.log(`  - 분석: ${analyzed}개`);
    console.log(`  - 발견: ${results.length}개 (20점 이상, C등급+)`);
    console.log(`  - 최종: ${limit ? `상위 ${limit}개` : `전체 ${results.length}개`} 반환\n`);

    const finalResults = limit ? results.slice(0, limit) : results;

    // TOP 3 선정 (전체 결과에서 선정)
    const top3 = await this.selectTop3(results);

    return {
      stocks: finalResults,
      top3: top3,
      metadata: {
        totalAnalyzed: analyzed,
        totalFound: results.length,
        returned: finalResults.length,
        top3Count: top3.length,
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
   * TOP 3 추천 종목 선정 (v3.38 스윗스팟 우선순위)
   *
   * v3.84: 점수 내림차순 단순 정렬 — 스윗스팟 구간 우선순위 및 tier1 시총 우선 제거.
   *   근거: POST(2026-03-26~) 15일 백테스트에서 구간 우선순위 제거 시 금메달 승률 36→57%,
   *         합산 성과 -1.35% → +2.68%, -5% 손실률 48→29%로 개선.
   * 필수 필터: 매수고래/기관≥3일/외인≥3일 + 비과열 + |등락률|<25 + 이격도<150 + 점수≥45
   *
   * @param {Array} allStocks - 전체 종목 배열
   * @returns {Array} - TOP 3 종목 (최대 3개)
   */
  async selectTop3(allStocks) {
    console.log(`\n🔍 TOP 3 선정 시작 (v3.94: 텔레그램/DB 경로와 통일)...`);
    console.log(`  전체 종목: ${allStocks.length}개`);

    // v3.85: 공통 자격 — 80-89 + 이격도 ≥120 결합 패널티 (16건 손절률 50% 데이터 기반)
    const isCommonEligible = (stock) => {
      const hasBuyWhale = (stock.advancedAnalysis?.indicators?.whale || []).some(w => w.type?.includes('매수'));
      const flow = stock.institutionalFlow;
      const instDays = flow?.institutionDays || 0;
      const foreignDays = flow?.foreignDays || 0;
      const hasSupply = hasBuyWhale || instDays >= 3 || foreignDays >= 3;
      const isOverheated = stock.recommendation?.grade === '과열';
      const changeRate = Math.abs(stock.changeRate || 0);
      const score = stock.totalScore || 0;
      const disparity = stock.overheatingV2?.disparity || 100;
      const isS89Trap = score >= 80 && score <= 89 && disparity >= 120;
      return hasSupply && !isOverheated && changeRate < 25 && score >= 45 && !isS89Trap;
    };

    // v3.85: 이격도 단계적 컷 (130 → 140 → 150)
    const dispOf = (s) => s.overheatingV2?.disparity || 100;
    const tiers = [130, 140, 150];
    let baseEligible = [];
    let usedTier = 150;
    for (const tier of tiers) {
      const filtered = allStocks.filter(s => isCommonEligible(s) && dispOf(s) < tier);
      if (filtered.length >= 3) {
        baseEligible = filtered;
        usedTier = tier;
        break;
      }
      baseEligible = filtered;
      usedTier = tier;
    }
    console.log(`  └─ TOP 3 후보: ${baseEligible.length}개 (이격도 < ${usedTier})`);

    // v3.94: 텔레그램/DB 경로(selectSaveTop3)와 통일.
    //   이전엔 여기만 v3.85(isV2Priority → total_score → 수급)에 멈춰 있었다. CLAUDE.md는
    //   v3.86에서 "v385(isV2Priority) 성과 최하위(+4.40%)로 복귀 결정"이라며 폐기했는데
    //   웹 경로에는 반영되지 않아, 폐기된 전략이 프론트엔드 TOP3를 계속 만들고 있었다.
    //   또 applyMomentumCapFloor(v3.90~3.92)가 빠져 있어 텔레그램이 무픽인 날에도 웹은
    //   마이크로캡을 추천했다(2026-07-17 확인: 삼성공조 1,104억 / 파세코 1,606억 —
    //   1조 플로어 탈락 대상). 무픽은 "풀이 나쁘다"는 신호인데 웹만 그 신호를 무력화했다.
    const regime = await detectMarketRegime();
    baseEligible = applyMomentumCapFloor(baseEligible, s => s.marketCap, regime);
    const top3 = sortByTop3Order(baseEligible, SCREENING_ACCESSORS).slice(0, 3);
    console.log(`  └─ TOP 3 확정: ${top3.length}개 (레짐 ${regime}${top3.length === 0 ? ' — 무픽' : ''})`);

    // top3Meta 추가
    const result = top3.map((stock, i) => {
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

    console.log(`\n🏆 TOP 3 선정 완료: ${result.length}개`);
    if (result.length === 0) {
      console.log(`  ⚠️ TOP 3 선정 실패 - 조건 충족 종목 없음`);
    } else {
      result.forEach((stock, i) => {
        console.log(`  ${i + 1}. ${stock.stockName} (${stock.totalScore}점, ${stock.recommendation.grade}등급)`);
      });
    }

    return result;
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
