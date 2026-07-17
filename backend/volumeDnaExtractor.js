/**
 * 거래량 DNA 추출 시스템 (Volume DNA Extractor)
 *
 * 목적: 과거 급등주들의 "급등 전 거래량 패턴"을 추출하여,
 *      현재 시장에서 같은 패턴을 가진 종목을 찾아내는 시스템
 *
 * 핵심 철학: "거래량이 주가에 선행한다"
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 v3.94 (2026-07-17): 이 파일은 **시간축이 뒤집힌 채** 동작한다. (보류 — 미수정)
 *
 * 이 파일은 chartData가 **오름차순**이라 가정하지만, kisApi.getDailyChart()는
 * **내림차순**([0]=최신)을 반환하고 filterByDateRange()는 필터만 할 뿐 정렬하지 않는다.
 *
 *   calculateSegmentedAverage():
 *     const early = data.slice(0, earlyEnd);   // ← 내림차순에선 **최신** 구간이다
 *     const late  = data.slice(midEnd);        // ← 실제로는 **가장 오래된** 구간이다
 *     if (avgLate > avgMid && avgMid > avgEarly) trend = 'accelerating';
 *
 * → early/mid/late가 뒤집혀 **'accelerating'(거래량 가속) 판정이 실제로는 감속을 의미한다.**
 *   가중 평균(overall = early*0.2 + mid*0.3 + late*0.5)의 "후반 50%" 가중치도 실제로는
 *   가장 오래된 구간에 실린다. data[i-1](prevVolume)은 실제로는 다음날이고,
 *   slice(-5)는 가장 오래된 5개다(CLAUDE.md가 금지한 패턴).
 *
 * ⚠️ smartPatternMining.js와 달리 **이 모듈은 살아 있다** — 프론트엔드(index.html)가
 *   /api/patterns/volume-dna 를 호출한다. 즉 사용자에게 뒤집힌 분석이 표시된다.
 *   다만 점수·TOP3에는 반영되지 않으므로 추천 자체를 오염시키지는 않는다.
 *
 * 보류 사유와 재개 조건은 CLAUDE.md "3-3. 선행 지표" 및 To-Do #6-A(깔때기 뒤집기) 참고.
 * 고칠 때는 입력을 오름차순으로 정규화(`[...chartData].reverse()`)하는 편이 안전하다 —
 * 이 파일 전체가 오름차순 전제로 쓰여 있기 때문이다.
 * ══════════════════════════════════════════════════════════════════════════
 */

const kisApi = require('./kisApi');

class VolumeDnaExtractor {
  constructor() {
    this.patterns = null;  // 추출된 DNA 패턴 캐시
  }

  // ============================================
  // 1. 시간 가중치 유틸리티 함수
  // ============================================

  /**
   * 지수 가중 이동 평균 (Exponential Moving Average)
   * @param {Array} data - 데이터 배열 (최근 데이터가 뒤쪽)
   * @param {string} field - 추출할 필드명
   * @param {number} halfLife - 반감기 (기본 5일)
   * @returns {number} 가중 평균값
   */
  calculateEMA(data, field, halfLife = 5) {
    const n = data.length;
    if (n === 0) return 0;

    let totalWeight = 0;
    let weightedSum = 0;

    for (let i = 0; i < n; i++) {
      const daysFromEnd = n - 1 - i;  // 최근일 = 0, 과거일수록 증가
      const weight = Math.exp(-daysFromEnd / halfLife);

      const value = typeof data[i][field] === 'number'
        ? data[i][field]
        : parseFloat(data[i][field]) || 0;

      weightedSum += value * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * 구간별 가중 평균 (3구간 분할)
   * @param {Array} data - 데이터 배열
   * @param {string} field - 추출할 필드명
   * @returns {Object} { early, mid, late, overall, trend }
   */
  calculateSegmentedAverage(data, field) {
    const n = data.length;
    if (n === 0) return { early: 0, mid: 0, late: 0, overall: 0, trend: 'flat' };

    // 3구간 분할
    const earlyEnd = Math.floor(n * 0.4);
    const midEnd = Math.floor(n * 0.7);

    const early = data.slice(0, earlyEnd);
    const mid = data.slice(earlyEnd, midEnd);
    const late = data.slice(midEnd);

    const avgEarly = this.average(early, field);
    const avgMid = this.average(mid, field);
    const avgLate = this.average(late, field);

    // 가중 평균 (후반 50%, 중반 30%, 초반 20%)
    const overall = avgEarly * 0.2 + avgMid * 0.3 + avgLate * 0.5;

    // 트렌드 판단
    let trend = 'flat';
    if (avgLate > avgMid && avgMid > avgEarly) {
      trend = 'accelerating';  // 가속 (이상적)
    } else if (avgLate < avgMid && avgMid < avgEarly) {
      trend = 'decelerating';  // 감속
    } else {
      trend = 'mixed';
    }

    return {
      early: avgEarly,
      mid: avgMid,
      late: avgLate,
      overall,
      trend
    };
  }

  /**
   * 하이브리드 거래량 분석 (EMA + 구간별 + 최근 5일)
   * @param {Array} data - 차트 데이터
   * @returns {Object} 종합 거래량 분석 결과
   */
  analyzeVolumePattern(data) {
    if (!data || data.length < 10) {
      return { error: '데이터 부족 (최소 10일 필요)' };
    }

    // 1. 거래량 증가율 계산 (전일 대비 %)
    const volumeRates = data.map((day, i) => {
      if (i === 0) return 0;
      const prevVolume = data[i - 1].volume;
      if (prevVolume === 0) return 0;
      return ((day.volume - prevVolume) / prevVolume) * 100;
    });

    // 2. 전체 평균
    const overallAvg = this.average(volumeRates.map((rate, i) => ({ rate })), 'rate');

    // 3. 지수 가중 평균 (최근 강조)
    const emaAvg = this.calculateEMA(
      volumeRates.map(rate => ({ rate })),
      'rate',
      5
    );

    // 4. 구간별 분석
    const segmented = this.calculateSegmentedAverage(
      volumeRates.map(rate => ({ rate })),
      'rate'
    );

    // 5. 최근 5일 평균
    const recent5d = this.average(
      volumeRates.slice(-5).map(rate => ({ rate })),
      'rate'
    );

    // 6. 종합 점수 (EMA 40% + 구간별 30% + 최근5일 30%)
    const compositeScore = emaAvg * 0.4 + segmented.overall * 0.3 + recent5d * 0.3;

    // 7. 급등 임박성
    const urgency = recent5d > emaAvg ? 'high' : 'low';

    return {
      overallAvg: parseFloat(overallAvg.toFixed(2)),
      emaAvg: parseFloat(emaAvg.toFixed(2)),
      segmented: {
        early: parseFloat(segmented.early.toFixed(2)),
        mid: parseFloat(segmented.mid.toFixed(2)),
        late: parseFloat(segmented.late.toFixed(2)),
        trend: segmented.trend
      },
      recent5d: parseFloat(recent5d.toFixed(2)),
      compositeScore: parseFloat(compositeScore.toFixed(2)),
      urgency
    };
  }

  /**
   * 기관/외국인 순매수 분석
   * @param {Array} investorData - 투자자별 데이터
   * @returns {Object} 세력 매매 분석 결과
   */
  analyzeInstitutionFlow(investorData) {
    if (!investorData || investorData.length === 0) {
      return { institution: null, foreign: null };
    }

    // 기관 순매수 분석
    const institutionBuys = investorData.map(d => d.institution.netBuyQty);
    const institutionTotal = institutionBuys.reduce((sum, qty) => sum + qty, 0);

    // 연속 매수일 계산
    let institutionConsecutiveDays = 0;
    for (let i = institutionBuys.length - 1; i >= 0; i--) {
      if (institutionBuys[i] > 0) institutionConsecutiveDays++;
      else break;
    }

    // 외국인 순매수 분석
    const foreignBuys = investorData.map(d => d.foreign.netBuyQty);
    const foreignTotal = foreignBuys.reduce((sum, qty) => sum + qty, 0);

    let foreignConsecutiveDays = 0;
    for (let i = foreignBuys.length - 1; i >= 0; i--) {
      if (foreignBuys[i] > 0) foreignConsecutiveDays++;
      else break;
    }

    return {
      institution: {
        totalBuy: institutionTotal,
        consecutiveDays: institutionConsecutiveDays,
        avgDaily: institutionTotal / investorData.length,
        intensity: institutionConsecutiveDays >= 5 ? 'strong' :
                   institutionConsecutiveDays >= 3 ? 'moderate' : 'weak'
      },
      foreign: {
        totalBuy: foreignTotal,
        consecutiveDays: foreignConsecutiveDays,
        avgDaily: foreignTotal / investorData.length,
        intensity: foreignConsecutiveDays >= 5 ? 'strong' :
                   foreignConsecutiveDays >= 3 ? 'moderate' : 'weak'
      }
    };
  }

  // ============================================
  // 2. 개별 종목 패턴 추출
  // ============================================

  /**
   * 단일 종목의 거래량 패턴 추출
   * @param {string} stockCode - 종목코드
   * @param {string} startDate - 시작일 (YYYYMMDD)
   * @param {string} endDate - 종료일 (YYYYMMDD)
   * @returns {Promise<Object>} 추출된 패턴
   */
  async extractStockPattern(stockCode, startDate, endDate) {
    try {
      console.log(`  🔍 ${stockCode}: ${startDate} ~ ${endDate} 패턴 추출 중...`);

      // 1. 차트 데이터 조회 (여유 10일)
      const chartData = await kisApi.getDailyChart(stockCode, 40);

      // 2. 날짜 범위 필터링
      const targetPeriod = this.filterByDateRange(chartData, startDate, endDate);

      if (targetPeriod.length < 10) {
        console.warn(`  ⚠️ ${stockCode}: 데이터 부족 (${targetPeriod.length}일)`);
        return { error: `데이터 부족 (${targetPeriod.length}일)` };
      }

      console.log(`  ✓ ${stockCode}: ${targetPeriod.length}일 데이터 확보`);

      // 3. 거래량 패턴 분석
      const volumePattern = this.analyzeVolumePattern(targetPeriod);

      // 4. 기관/외국인 데이터 조회 (선택적)
      let institutionFlow = null;
      try {
        const investorData = await kisApi.getInvestorData(stockCode, targetPeriod.length);
        const filteredInvestorData = this.filterByDateRange(
          investorData,
          startDate,
          endDate
        );
        institutionFlow = this.analyzeInstitutionFlow(filteredInvestorData);
      } catch (error) {
        console.warn(`  ⚠️ ${stockCode}: 투자자 데이터 조회 실패 (선택적 지표)`);
        institutionFlow = { institution: null, foreign: null };
      }

      return {
        stockCode,
        startDate,
        endDate,
        days: targetPeriod.length,
        pattern: {
          volumeRate: volumePattern,
          institutionFlow: institutionFlow.institution,
          foreignFlow: institutionFlow.foreign
        }
      };

    } catch (error) {
      console.error(`  ❌ ${stockCode}: 패턴 추출 실패 - ${error.message}`);
      return { error: error.message };
    }
  }

  // ============================================
  // 3. 공통 DNA 추출 (교집합)
  // ============================================

  /**
   * 여러 종목의 공통 패턴 추출
   * @param {Array} stockPatterns - 개별 종목 패턴 배열
   * @returns {Object} 공통 DNA
   */
  extractCommonDNA(stockPatterns) {
    const validPatterns = stockPatterns.filter(p => !p.error);

    if (validPatterns.length < 2) {
      return { error: '최소 2개 종목의 유효한 패턴 필요' };
    }

    console.log(`\n🧬 공통 DNA 추출: ${validPatterns.length}개 종목 분석 중...\n`);

    const commonDNA = {};

    // 1. 거래량 증가율 패턴
    const volumeRates = validPatterns.map(p => p.pattern.volumeRate);

    commonDNA.volumeRate = {
      avgEMA: this.average(volumeRates.map(v => ({ val: v.emaAvg })), 'val'),
      avgRecent5d: this.average(volumeRates.map(v => ({ val: v.recent5d })), 'val'),
      commonTrend: this.findCommonTrend(volumeRates),
      threshold: {
        emaMin: Math.min(...volumeRates.map(v => v.emaAvg)) * 0.7,  // 최소값의 70%
        recent5dMin: Math.min(...volumeRates.map(v => v.recent5d)) * 0.7
      }
    };

    // 2. 기관 순매수 패턴 (데이터 있는 경우만)
    const institutionFlows = validPatterns
      .map(p => p.pattern.institutionFlow)
      .filter(f => f !== null);

    if (institutionFlows.length > 0) {
      commonDNA.institutionFlow = {
        avgConsecutiveDays: this.average(
          institutionFlows.map(f => ({ val: f.consecutiveDays })),
          'val'
        ),
        commonIntensity: this.findCommonIntensity(institutionFlows),
        threshold: {
          minConsecutiveDays: Math.floor(
            Math.min(...institutionFlows.map(f => f.consecutiveDays)) * 0.5
          )
        }
      };
    }

    // 3. 외국인 순매수 패턴
    const foreignFlows = validPatterns
      .map(p => p.pattern.foreignFlow)
      .filter(f => f !== null);

    if (foreignFlows.length > 0) {
      commonDNA.foreignFlow = {
        avgConsecutiveDays: this.average(
          foreignFlows.map(f => ({ val: f.consecutiveDays })),
          'val'
        ),
        commonIntensity: this.findCommonIntensity(foreignFlows),
        threshold: {
          minConsecutiveDays: Math.floor(
            Math.min(...foreignFlows.map(f => f.consecutiveDays)) * 0.5
          )
        }
      };
    }

    // 4. DNA 강도 계산
    const dnaStrength = this.calculateDNAStrength(commonDNA, validPatterns.length);

    return {
      commonDNA,
      dnaStrength,
      basedOnStocks: validPatterns.length,
      extractedAt: new Date().toISOString()
    };
  }

  // ============================================
  // 4. DNA 매칭 및 스코어링
  // ============================================

  /**
   * 현재 종목과 DNA 패턴 매칭 점수 계산
   * @param {Object} currentPattern - 현재 종목의 패턴
   * @param {Object} commonDNA - 공통 DNA
   * @returns {Object} 매칭 점수
   */
  calculateMatchScore(currentPattern, commonDNA) {
    const details = {};
    let totalScore = 0;
    let maxScore = 0;

    // 1. 거래량 증가율 매칭
    if (commonDNA.volumeRate && currentPattern.volumeRate) {
      const emaMatch = currentPattern.volumeRate.emaAvg >= commonDNA.volumeRate.threshold.emaMin
        ? 100
        : (currentPattern.volumeRate.emaAvg / commonDNA.volumeRate.threshold.emaMin) * 100;

      const recent5dMatch = currentPattern.volumeRate.recent5d >= commonDNA.volumeRate.threshold.recent5dMin
        ? 100
        : (currentPattern.volumeRate.recent5d / commonDNA.volumeRate.threshold.recent5dMin) * 100;

      const volumeScore = (Math.min(100, emaMatch) + Math.min(100, recent5dMatch)) / 2;

      details.volumeRate = {
        score: parseFloat(volumeScore.toFixed(2)),
        current: {
          emaAvg: currentPattern.volumeRate.emaAvg,
          recent5d: currentPattern.volumeRate.recent5d
        },
        threshold: commonDNA.volumeRate.threshold
      };

      totalScore += volumeScore;
      maxScore += 100;
    }

    // 2. 기관 순매수 매칭
    if (commonDNA.institutionFlow && currentPattern.institutionFlow) {
      const consecutiveMatch = currentPattern.institutionFlow.consecutiveDays >= commonDNA.institutionFlow.threshold.minConsecutiveDays
        ? 100
        : (currentPattern.institutionFlow.consecutiveDays / commonDNA.institutionFlow.threshold.minConsecutiveDays) * 100;

      details.institutionFlow = {
        score: Math.min(100, consecutiveMatch),
        current: currentPattern.institutionFlow.consecutiveDays,
        threshold: commonDNA.institutionFlow.threshold.minConsecutiveDays
      };

      totalScore += Math.min(100, consecutiveMatch);
      maxScore += 100;
    }

    // 3. 외국인 순매수 매칭
    if (commonDNA.foreignFlow && currentPattern.foreignFlow) {
      const consecutiveMatch = currentPattern.foreignFlow.consecutiveDays >= commonDNA.foreignFlow.threshold.minConsecutiveDays
        ? 100
        : (currentPattern.foreignFlow.consecutiveDays / commonDNA.foreignFlow.threshold.minConsecutiveDays) * 100;

      details.foreignFlow = {
        score: Math.min(100, consecutiveMatch),
        current: currentPattern.foreignFlow.consecutiveDays,
        threshold: commonDNA.foreignFlow.threshold.minConsecutiveDays
      };

      totalScore += Math.min(100, consecutiveMatch);
      maxScore += 100;
    }

    const finalScore = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

    return {
      totalScore: parseFloat(finalScore.toFixed(2)),
      details
    };
  }

  // ============================================
  // 유틸리티 함수
  // ============================================

  average(arr, field) {
    if (!arr || arr.length === 0) return 0;
    const sum = arr.reduce((acc, item) => {
      const val = typeof item[field] === 'number'
        ? item[field]
        : parseFloat(item[field]) || 0;
      return acc + val;
    }, 0);
    return sum / arr.length;
  }

  filterByDateRange(data, startDate, endDate) {
    return data.filter(item => {
      const date = item.date || item.stck_bsop_date;
      return date >= startDate && date <= endDate;
    });
  }

  findCommonTrend(volumeRates) {
    const trends = volumeRates.map(v => v.segmented.trend);
    const accelerating = trends.filter(t => t === 'accelerating').length;
    const total = trends.length;

    return accelerating / total >= 0.6 ? 'accelerating' : 'mixed';
  }

  findCommonIntensity(flows) {
    const intensities = flows.map(f => f.intensity);
    const strong = intensities.filter(i => i === 'strong').length;
    const total = intensities.length;

    if (strong / total >= 0.6) return 'strong';
    if (strong / total >= 0.3) return 'moderate';
    return 'weak';
  }

  calculateDNAStrength(commonDNA, numStocks) {
    // DNA 강도 = 지표 일치도 + 종목 수 보너스
    let strength = 0;

    if (commonDNA.volumeRate) strength += 40;
    if (commonDNA.institutionFlow) strength += 30;
    if (commonDNA.foreignFlow) strength += 30;

    // 종목 수 보너스 (3개 이상일 때)
    if (numStocks >= 3) strength += 10;
    if (numStocks >= 5) strength += 10;

    return Math.min(100, strength);
  }

  // ============================================
  // 5. 현재 시장 스캔 (Phase 2)
  // ============================================

  /**
   * 현재 시장의 모든 종목을 DNA와 매칭
   * @param {Object} commonDNA - 추출된 공통 DNA
   * @param {Array} stockPool - 스캔할 종목 풀 (기본: screening.js의 53개)
   * @param {Object} options - 옵션 { matchThreshold: 70, limit: 10, days: 25 }
   * @returns {Promise<Array>} 매칭된 종목 목록
   */
  async scanMarketForDNA(commonDNA, stockPool = null, options = {}) {
    const {
      matchThreshold = 70,  // 최소 매칭 점수
      limit = 10,           // 최대 반환 개수
      days = 25             // 최근 N일 패턴 분석
    } = options;

    try {
      console.log('\n🔍 현재 시장 DNA 스캔 시작...\n');
      console.log(`  - 매칭 임계값: ${matchThreshold}점`);
      console.log(`  - 분석 기간: 최근 ${days}일`);
      console.log(`  - 최대 반환: ${limit}개\n`);

      // 1. 종목 풀 가져오기 (없으면 KIS API에서 동적 로드)
      if (!stockPool) {
        const { codes: stockCodes } = await kisApi.getAllStockList('ALL');
        // stockPool 형식으로 변환 (code, name)
        stockPool = stockCodes.map(code => ({ code, name: code }));
        console.log(`  ✓ 종목 풀: ${stockPool.length}개 종목 로드\n`);
      }

      // 2. 병렬 처리를 위한 배치 설정 (10개씩)
      const batchSize = 10;
      const batches = [];
      for (let i = 0; i < stockPool.length; i += batchSize) {
        batches.push(stockPool.slice(i, i + batchSize));
      }

      console.log(`  📦 배치 처리: ${batches.length}개 배치 (각 ${batchSize}개)\n`);

      // 3. 각 종목 분석 및 매칭 점수 계산
      const matchedStocks = [];
      let processedCount = 0;

      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(async (stock) => {
            try {
              // 최근 N일 차트 데이터 조회
              const chartData = await kisApi.getDailyChart(stock.code, days);

              if (chartData.length < 10) {
                console.log(`  ⚠️ ${stock.name} (${stock.code}): 데이터 부족 (${chartData.length}일)`);
                return null;
              }

              // 거래량 패턴 분석
              const volumePattern = this.analyzeVolumePattern(chartData);
              if (volumePattern.error) {
                return null;
              }

              // 기관/외국인 데이터 조회 (선택적)
              let institutionFlow = { institution: null, foreign: null };
              try {
                const investorData = await kisApi.getInvestorData(stock.code, days);
                institutionFlow = this.analyzeInstitutionFlow(investorData);
              } catch (error) {
                // 투자자 데이터 없어도 거래량 패턴으로 매칭 가능
              }

              // DNA 매칭 점수 계산
              const currentPattern = {
                volumeRate: volumePattern,
                institutionFlow: institutionFlow.institution,
                foreignFlow: institutionFlow.foreign
              };

              const matchScore = this.calculateMatchScore(currentPattern, commonDNA);

              // 임계값 이상만 반환
              if (matchScore.totalScore >= matchThreshold) {
                console.log(`  ✅ ${stock.name} (${stock.code}): ${matchScore.totalScore}점 - 매칭!`);
                return {
                  stockCode: stock.code,
                  stockName: stock.name,
                  matchScore: matchScore.totalScore,
                  scoreDetails: matchScore.details,
                  pattern: currentPattern,
                  analyzedDays: chartData.length
                };
              } else {
                console.log(`  ⏭️ ${stock.name} (${stock.code}): ${matchScore.totalScore}점 - 미달`);
                return null;
              }

            } catch (error) {
              console.error(`  ❌ ${stock.name} (${stock.code}): 분석 실패 - ${error.message}`);
              return null;
            }
          })
        );

        // null 제거 후 추가
        const validResults = batchResults.filter(r => r !== null);
        matchedStocks.push(...validResults);

        processedCount += batch.length;
        console.log(`\n  진행률: ${processedCount}/${stockPool.length} (${((processedCount / stockPool.length) * 100).toFixed(1)}%)\n`);

        // Rate limiting을 위한 약간의 지연 (배치 간 1초)
        if (batches.indexOf(batch) < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // 4. 매칭 점수 내림차순 정렬 및 제한
      matchedStocks.sort((a, b) => b.matchScore - a.matchScore);
      const topMatches = matchedStocks.slice(0, limit);

      console.log('\n━'.repeat(60));
      console.log(`✅ DNA 스캔 완료!\n`);
      console.log(`  - 분석 종목: ${stockPool.length}개`);
      console.log(`  - 매칭 종목: ${matchedStocks.length}개`);
      console.log(`  - 반환 종목: ${topMatches.length}개\n`);

      if (topMatches.length > 0) {
        console.log('🏆 TOP 매칭 종목:\n');
        topMatches.forEach((stock, i) => {
          console.log(`  ${i + 1}. ${stock.stockName} (${stock.stockCode}) - ${stock.matchScore}점`);
        });
        console.log('');
      }

      return topMatches;

    } catch (error) {
      console.error('❌ DNA 스캔 실패:', error.message);
      throw error;
    }
  }
}

module.exports = new VolumeDnaExtractor();
