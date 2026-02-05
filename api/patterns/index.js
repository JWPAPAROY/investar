/**
 * 성공 패턴 분석 API
 * GET /api/recommendations/pattern-analysis
 *
 * 연속 급등주의 신호 패턴을 분석하여 스크리닝 로직 개선에 활용
 */

const supabase = require('../../backend/supabaseClient');

module.exports = async (req, res) => {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    // 1. 전체 패턴 조회
    const { data: patterns, error: patternError } = await supabase
      .from('success_patterns')
      .select('*')
      .order('success_date', { ascending: false });

    if (patternError) {
      // 테이블이 없으면 빈 결과 반환
      if (patternError.code === '42P01') {
        return res.status(200).json({
          success: true,
          message: 'success_patterns 테이블이 없습니다. SQL 스크립트를 실행해주세요.',
          totalPatterns: 0,
          analysis: null
        });
      }
      throw patternError;
    }

    if (!patterns || patterns.length === 0) {
      return res.status(200).json({
        success: true,
        message: '아직 수집된 패턴이 없습니다. 연속 급등주가 발생하면 자동 수집됩니다.',
        totalPatterns: 0,
        analysis: null
      });
    }

    // 2. 신호별 효과 분석
    const signalAnalysis = {
      // 고래 감지
      whale: {
        detected: patterns.filter(p => p.whale_detected),
        notDetected: patterns.filter(p => !p.whale_detected)
      },
      // 확인된 고래
      whaleConfirmed: {
        confirmed: patterns.filter(p => p.whale_confirmed),
        notConfirmed: patterns.filter(p => p.whale_detected && !p.whale_confirmed)
      },
      // 탈출 속도
      escapeVelocity: {
        detected: patterns.filter(p => p.escape_velocity),
        notDetected: patterns.filter(p => !p.escape_velocity)
      },
      // 거래량 추이
      volumeTrend: {
        increasing: patterns.filter(p => p.volume_trend === 'increasing'),
        stable: patterns.filter(p => p.volume_trend === 'stable'),
        decreasing: patterns.filter(p => p.volume_trend === 'decreasing')
      },
      // 상승 패턴
      risePattern: {
        explosive: patterns.filter(p => p.rise_pattern === 'explosive'),
        gradual: patterns.filter(p => p.rise_pattern === 'gradual'),
        slow: patterns.filter(p => p.rise_pattern === 'slow')
      }
    };

    // 통계 계산 함수
    const calcStats = (arr) => {
      if (!arr || arr.length === 0) return { count: 0, avgReturn: 0, avgDays: 0 };
      const avgReturn = arr.reduce((sum, p) => sum + (p.total_return || 0), 0) / arr.length;
      const avgDays = arr.reduce((sum, p) => sum + (p.consecutive_days || 0), 0) / arr.length;
      return {
        count: arr.length,
        avgReturn: parseFloat(avgReturn.toFixed(2)),
        avgDays: parseFloat(avgDays.toFixed(1))
      };
    };

    // 3. 분석 결과 생성
    const analysis = {
      totalPatterns: patterns.length,
      dateRange: {
        first: patterns[patterns.length - 1]?.success_date,
        last: patterns[0]?.success_date
      },

      // 신호별 효과
      signalEffectiveness: {
        whale: {
          detected: calcStats(signalAnalysis.whale.detected),
          notDetected: calcStats(signalAnalysis.whale.notDetected),
          improvement: signalAnalysis.whale.detected.length > 0 && signalAnalysis.whale.notDetected.length > 0
            ? parseFloat((calcStats(signalAnalysis.whale.detected).avgReturn - calcStats(signalAnalysis.whale.notDetected).avgReturn).toFixed(2))
            : null
        },
        whaleConfirmed: {
          confirmed: calcStats(signalAnalysis.whaleConfirmed.confirmed),
          notConfirmed: calcStats(signalAnalysis.whaleConfirmed.notConfirmed),
          improvement: signalAnalysis.whaleConfirmed.confirmed.length > 0 && signalAnalysis.whaleConfirmed.notConfirmed.length > 0
            ? parseFloat((calcStats(signalAnalysis.whaleConfirmed.confirmed).avgReturn - calcStats(signalAnalysis.whaleConfirmed.notConfirmed).avgReturn).toFixed(2))
            : null
        },
        escapeVelocity: {
          detected: calcStats(signalAnalysis.escapeVelocity.detected),
          notDetected: calcStats(signalAnalysis.escapeVelocity.notDetected),
          improvement: signalAnalysis.escapeVelocity.detected.length > 0 && signalAnalysis.escapeVelocity.notDetected.length > 0
            ? parseFloat((calcStats(signalAnalysis.escapeVelocity.detected).avgReturn - calcStats(signalAnalysis.escapeVelocity.notDetected).avgReturn).toFixed(2))
            : null
        },
        volumeTrend: {
          increasing: calcStats(signalAnalysis.volumeTrend.increasing),
          stable: calcStats(signalAnalysis.volumeTrend.stable),
          decreasing: calcStats(signalAnalysis.volumeTrend.decreasing)
        },
        risePattern: {
          explosive: calcStats(signalAnalysis.risePattern.explosive),
          gradual: calcStats(signalAnalysis.risePattern.gradual),
          slow: calcStats(signalAnalysis.risePattern.slow)
        }
      },

      // 등급별 분석
      byGrade: {},

      // MFI 구간별 분석
      byMfi: {
        high: calcStats(patterns.filter(p => p.mfi >= 70)),    // 70+
        medium: calcStats(patterns.filter(p => p.mfi >= 50 && p.mfi < 70)), // 50-70
        low: calcStats(patterns.filter(p => p.mfi < 50))       // <50
      },

      // 권장 사항
      recommendations: []
    };

    // 등급별 통계
    const grades = ['S+', 'S', 'A', 'B', 'C', '과열'];
    grades.forEach(grade => {
      const gradePatterns = patterns.filter(p => p.recommendation_grade === grade);
      if (gradePatterns.length > 0) {
        analysis.byGrade[grade] = calcStats(gradePatterns);
      }
    });

    // 권장 사항 생성
    const whale = analysis.signalEffectiveness.whale;
    if (whale.improvement !== null && whale.improvement > 3) {
      analysis.recommendations.push({
        signal: '고래 감지',
        effect: `+${whale.improvement}%`,
        suggestion: '고래 감지 가중치 유지 또는 증가 권장'
      });
    } else if (whale.improvement !== null && whale.improvement < -3) {
      analysis.recommendations.push({
        signal: '고래 감지',
        effect: `${whale.improvement}%`,
        suggestion: '고래 감지 가중치 감소 검토'
      });
    }

    const escape = analysis.signalEffectiveness.escapeVelocity;
    if (escape.improvement !== null && escape.improvement > 3) {
      analysis.recommendations.push({
        signal: '탈출 속도',
        effect: `+${escape.improvement}%`,
        suggestion: '탈출 속도 보너스 유지 또는 증가 권장'
      });
    }

    const volTrend = analysis.signalEffectiveness.volumeTrend;
    if (volTrend.increasing.count > 0 && volTrend.decreasing.count > 0) {
      const volDiff = volTrend.increasing.avgReturn - volTrend.decreasing.avgReturn;
      if (volDiff > 5) {
        analysis.recommendations.push({
          signal: '거래량 증가 동반',
          effect: `+${volDiff.toFixed(1)}% vs 거래량 감소`,
          suggestion: '거래량 증가 동반 시 추가 가점 검토'
        });
      }
    }

    // 최근 30일 패턴만 별도 분석
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentPatterns = patterns.filter(p =>
      new Date(p.success_date) >= thirtyDaysAgo
    );

    analysis.recent30Days = {
      count: recentPatterns.length,
      avgReturn: recentPatterns.length > 0
        ? parseFloat((recentPatterns.reduce((sum, p) => sum + p.total_return, 0) / recentPatterns.length).toFixed(2))
        : 0,
      topSignals: []
    };

    // 최근 30일 상위 신호 조합
    if (recentPatterns.length >= 5) {
      const whaleRecent = recentPatterns.filter(p => p.whale_detected);
      const escapeRecent = recentPatterns.filter(p => p.escape_velocity);
      const volUpRecent = recentPatterns.filter(p => p.volume_trend === 'increasing');

      if (whaleRecent.length > 0) {
        analysis.recent30Days.topSignals.push({
          signal: '고래 감지',
          count: whaleRecent.length,
          avgReturn: parseFloat((whaleRecent.reduce((s, p) => s + p.total_return, 0) / whaleRecent.length).toFixed(2))
        });
      }
      if (escapeRecent.length > 0) {
        analysis.recent30Days.topSignals.push({
          signal: '탈출 속도',
          count: escapeRecent.length,
          avgReturn: parseFloat((escapeRecent.reduce((s, p) => s + p.total_return, 0) / escapeRecent.length).toFixed(2))
        });
      }
      if (volUpRecent.length > 0) {
        analysis.recent30Days.topSignals.push({
          signal: '거래량 증가',
          count: volUpRecent.length,
          avgReturn: parseFloat((volUpRecent.reduce((s, p) => s + p.total_return, 0) / volUpRecent.length).toFixed(2))
        });
      }

      // 수익률 순 정렬
      analysis.recent30Days.topSignals.sort((a, b) => b.avgReturn - a.avgReturn);
    }

    console.log(`📊 패턴 분석 완료: ${patterns.length}개 패턴, ${analysis.recommendations.length}개 권장 사항`);

    return res.status(200).json({
      success: true,
      totalPatterns: patterns.length,
      analysis,
      // 원본 데이터 (상위 20개만)
      recentPatterns: patterns.slice(0, 20).map(p => ({
        stock_name: p.stock_name,
        success_date: p.success_date,
        consecutive_days: p.consecutive_days,
        total_return: p.total_return,
        recommendation_grade: p.recommendation_grade,
        whale_detected: p.whale_detected,
        volume_trend: p.volume_trend,
        rise_pattern: p.rise_pattern
      }))
    });

  } catch (error) {
    console.error('패턴 분석 실패:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
// v3.29 pattern analysis
