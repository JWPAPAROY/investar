/**
 * 성공 패턴 분석 API v2
 *
 * GET /api/patterns - 성공 패턴 통계 및 인사이트 조회
 * POST /api/patterns - 성공 패턴 수집 (10%+ 수익 종목)
 *
 * 목적: 수익률 +10% 달성 종목의 추천 시점 지표 특징 추출
 */

const supabase = require('../../backend/supabaseClient');

module.exports = async (req, res) => {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    // GET with ?collect=true 또는 POST → 수집 실행
    const shouldCollect = req.method === 'POST' || req.query.collect === 'true';

    if (shouldCollect) {
      // 성공 패턴 수집 (10%+ 달성 종목 탐색)
      return await collectSuccessPatterns(req, res);
    } else if (req.method === 'GET') {
      // 성공 패턴 분석 결과 조회
      return await getPatternAnalysis(req, res);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('패턴 API 오류:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * 성공 패턴 수집 (10%+ 수익 달성 종목)
 */
async function collectSuccessPatterns(req, res) {
  const SUCCESS_THRESHOLD = 10; // 10% 수익률 기준
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n📊 성공 패턴 수집 시작 (기준: +${SUCCESS_THRESHOLD}%)`);

  // 1. 활성 추천 종목 조회 (최근 90일, 페이지네이션)
  const startDateStr = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let recommendations = [];
  let recPage = 0;
  while (true) {
    const { data: pageData, error: recError } = await supabase
      .from('screening_recommendations')
      .select('*')
      .eq('is_active', true)
      .gte('recommendation_date', startDateStr)
      .order('recommendation_date', { ascending: false })
      .range(recPage * 1000, (recPage + 1) * 1000 - 1);

    if (recError) {
      console.error('추천 조회 실패:', recError);
      return res.status(500).json({ error: recError.message });
    }
    if (!pageData || pageData.length === 0) break;
    recommendations = recommendations.concat(pageData);
    if (pageData.length < 1000) break;
    recPage++;
  }

  console.log(`   활성 추천: ${recommendations.length}개`);

  // 2. 이미 수집된 패턴 ID 일괄 조회
  let existingRecIds = new Set();
  const recIds = recommendations.map(r => r.id);
  for (let b = 0; b < recIds.length; b += 300) {
    const { data: existingData } = await supabase
      .from('success_patterns')
      .select('recommendation_id')
      .in('recommendation_id', recIds.slice(b, b + 300));
    if (existingData) existingData.forEach(e => existingRecIds.add(e.recommendation_id));
  }
  console.log(`   기존 패턴: ${existingRecIds.size}개 (스킵)`);

  // 이미 수집된 것 제외
  const uncollectedRecs = recommendations.filter(r => !existingRecIds.has(r.id));
  console.log(`   미수집 추천: ${uncollectedRecs.length}개 확인 대상`);

  // 3. 일별 가격 일괄 조회 (배치)
  let allPrices = [];
  const uncollectedIds = uncollectedRecs.map(r => r.id);
  for (let b = 0; b < uncollectedIds.length; b += 300) {
    const { data: priceData } = await supabase
      .from('recommendation_daily_prices')
      .select('recommendation_id, tracking_date, cumulative_return')
      .in('recommendation_id', uncollectedIds.slice(b, b + 300))
      .order('tracking_date', { ascending: true });
    if (priceData) allPrices = allPrices.concat(priceData);
  }

  // recommendation_id별로 그룹핑
  const priceMap = new Map();
  allPrices.forEach(p => {
    if (!priceMap.has(p.recommendation_id)) priceMap.set(p.recommendation_id, []);
    priceMap.get(p.recommendation_id).push(p);
  });

  // 4. 각 추천의 최고 수익률 확인
  const successPatterns = [];

  for (const rec of uncollectedRecs) {
    const prices = priceMap.get(rec.id);
    if (!prices || prices.length === 0) continue;

    const maxReturn = Math.max(...prices.map(p => p.cumulative_return || 0));
    const currentReturn = prices[prices.length - 1]?.cumulative_return || 0;

    if (maxReturn >= SUCCESS_THRESHOLD) {
      const successPrice = prices.find(p => p.cumulative_return >= SUCCESS_THRESHOLD);
      const successDate = successPrice?.tracking_date || today;
      const daysToSuccess = Math.round(
        (new Date(successDate) - new Date(rec.recommendation_date)) / (24 * 60 * 60 * 1000)
      );

      successPatterns.push({
        recommendation_id: rec.id,
        stock_code: rec.stock_code,
        stock_name: rec.stock_name,
        success_date: successDate,
        recommendation_date: rec.recommendation_date,
        days_to_success: daysToSuccess,
        max_return: parseFloat(maxReturn.toFixed(2)),
        final_return: parseFloat(currentReturn.toFixed(2)),
        recommendation_grade: rec.recommendation_grade,
        total_score: rec.total_score,
        volume_ratio: rec.volume_ratio,
        volume_acceleration_score: rec.volume_acceleration_score,
        volume_acceleration_trend: rec.volume_acceleration_trend,
        asymmetric_ratio: rec.asymmetric_ratio,
        asymmetric_signal: rec.asymmetric_signal,
        obv_trend: rec.obv_trend,
        volume_5d_change_rate: rec.volume_5d_change_rate,
        whale_detected: rec.whale_detected,
        whale_confirmed: rec.whale_confirmed,
        whale_volume_ratio: rec.whale_volume_ratio,
        whale_price_change: rec.whale_price_change,
        rsi: rec.rsi,
        mfi: rec.mfi,
        disparity: rec.disparity,
        vwap_divergence: rec.vwap_divergence,
        daily_change_rate: rec.change_rate,
        consecutive_rise_days: rec.consecutive_rise_days,
        escape_velocity: rec.escape_velocity,
        escape_closing_strength: rec.escape_closing_strength,
        upper_shadow_ratio: rec.upper_shadow_ratio,
        institution_buy_days: rec.institution_buy_days,
        foreign_buy_days: rec.foreign_buy_days,
        accumulation_detected: rec.accumulation_detected,
        vpd_score: rec.vpd_score,
        vpd_raw: rec.vpd_raw,
        market_cap: rec.market_cap
      });
      console.log(`   ✅ ${rec.stock_name} (+${maxReturn.toFixed(1)}%, ${daysToSuccess}일)`);
    }
  }

  // 3. 성공 패턴 저장
  if (successPatterns.length > 0) {
    const { error: insertError } = await supabase
      .from('success_patterns')
      .insert(successPatterns);

    if (insertError) {
      console.error('패턴 저장 실패:', insertError);
      return res.status(500).json({ error: insertError.message });
    }
  }

  console.log(`\n📊 수집 완료: ${successPatterns.length}개 새 패턴`);

  // 4. 기존 패턴 중 null 지표 백필 (v3.30 이전 수집분, 페이지네이션)
  let backfilled = 0;
  try {
    let nullPatterns = [];
    let npPage = 0;
    while (true) {
      const { data: npData } = await supabase
        .from('success_patterns')
        .select('id, recommendation_id')
        .is('rsi', null)
        .range(npPage * 1000, (npPage + 1) * 1000 - 1);
      if (!npData || npData.length === 0) break;
      nullPatterns = nullPatterns.concat(npData);
      if (npData.length < 1000) break;
      npPage++;
    }

    if (nullPatterns.length > 0) {
      // .in() 배치 분할 (300개씩)
      const recIds = nullPatterns.map(p => p.recommendation_id);
      let recs = [];
      for (let b = 0; b < recIds.length; b += 300) {
        const { data: batchData } = await supabase
          .from('screening_recommendations')
          .select('id, asymmetric_ratio, asymmetric_signal, rsi, mfi, disparity, vwap_divergence, escape_velocity, escape_closing_strength, upper_shadow_ratio, institution_buy_days, foreign_buy_days')
          .in('id', recIds.slice(b, b + 300));
        if (batchData) recs = recs.concat(batchData);
      }

      if (recs.length > 0) {
        const recMap = new Map(recs.map(r => [r.id, r]));
        for (const pat of nullPatterns) {
          const src = recMap.get(pat.recommendation_id);
          if (src && (src.rsi !== null || src.asymmetric_ratio !== null || src.disparity !== null)) {
            const updates = {};
            if (src.asymmetric_ratio !== null) updates.asymmetric_ratio = src.asymmetric_ratio;
            if (src.asymmetric_signal !== null) updates.asymmetric_signal = src.asymmetric_signal;
            if (src.rsi !== null) updates.rsi = src.rsi;
            if (src.mfi !== null) updates.mfi = src.mfi;
            if (src.disparity !== null) updates.disparity = src.disparity;
            if (src.vwap_divergence !== null) updates.vwap_divergence = src.vwap_divergence;
            if (src.escape_velocity !== null) updates.escape_velocity = src.escape_velocity;
            if (src.escape_closing_strength !== null) updates.escape_closing_strength = src.escape_closing_strength;
            if (src.upper_shadow_ratio !== null) updates.upper_shadow_ratio = src.upper_shadow_ratio;
            if (src.institution_buy_days !== null) updates.institution_buy_days = src.institution_buy_days;
            if (src.foreign_buy_days !== null) updates.foreign_buy_days = src.foreign_buy_days;

            if (Object.keys(updates).length > 0) {
              await supabase.from('success_patterns').update(updates).eq('id', pat.id);
              backfilled++;
            }
          }
        }
        if (backfilled > 0) console.log(`🔄 백필 완료: ${backfilled}개 패턴 지표 업데이트`);
      }
    }
  } catch (e) {
    console.warn('⚠️ 백필 실패:', e.message);
  }

  return res.status(200).json({
    success: true,
    message: `${successPatterns.length}개 성공 패턴 수집 완료${backfilled > 0 ? `, ${backfilled}개 백필` : ''}`,
    collected: successPatterns.length,
    backfilled,
    patterns: successPatterns.map(p => ({
      stock_name: p.stock_name,
      max_return: p.max_return,
      days_to_success: p.days_to_success
    }))
  });
}

/**
 * 성공 패턴 분석 결과 조회
 */
async function getPatternAnalysis(req, res) {
  // 1. 전체 패턴 조회 (페이지네이션)
  let patterns = [];
  let patPage = 0;
  while (true) {
    const { data: pageData, error } = await supabase
      .from('success_patterns')
      .select('*')
      .order('success_date', { ascending: false })
      .range(patPage * 1000, (patPage + 1) * 1000 - 1);

    if (error) {
      console.error('패턴 조회 실패:', error);
      return res.status(500).json({ error: error.message });
    }
    if (!pageData || pageData.length === 0) break;
    patterns = patterns.concat(pageData);
    if (pageData.length < 1000) break;
    patPage++;
  }

  if (!patterns || patterns.length === 0) {
    return res.status(200).json({
      success: true,
      message: '아직 수집된 성공 패턴이 없습니다. POST /api/patterns로 수집을 실행하세요.',
      totalPatterns: 0,
      analysis: null
    });
  }

  // 2. 통계 계산 함수들
  const calcStats = (values) => {
    const valid = values.filter(v => v !== null && v !== undefined && !isNaN(v));
    if (valid.length === 0) return null;

    const sorted = [...valid].sort((a, b) => a - b);
    const sum = valid.reduce((a, b) => a + b, 0);

    return {
      count: valid.length,
      avg: parseFloat((sum / valid.length).toFixed(2)),
      median: parseFloat(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
      min: parseFloat(Math.min(...valid).toFixed(2)),
      max: parseFloat(Math.max(...valid).toFixed(2)),
      stddev: parseFloat(Math.sqrt(valid.reduce((sq, n) => sq + Math.pow(n - sum / valid.length, 2), 0) / valid.length).toFixed(2))
    };
  };

  const calcDistribution = (values, bucketSize) => {
    const valid = values.filter(v => v !== null && v !== undefined && !isNaN(v));
    const buckets = {};

    valid.forEach(v => {
      const bucket = Math.floor(v / bucketSize) * bucketSize;
      const key = `${bucket}-${bucket + bucketSize}`;
      buckets[key] = (buckets[key] || 0) + 1;
    });

    return Object.entries(buckets)
      .map(([range, count]) => ({ range, count, pct: parseFloat((count / valid.length * 100).toFixed(1)) }))
      .sort((a, b) => parseFloat(a.range) - parseFloat(b.range));
  };

  // 3. 분석 결과 생성
  const analysis = {
    // 기본 통계
    summary: {
      totalPatterns: patterns.length,
      avgMaxReturn: parseFloat((patterns.reduce((s, p) => s + (p.max_return || 0), 0) / patterns.length).toFixed(2)),
      avgDaysToSuccess: parseFloat((patterns.reduce((s, p) => s + (p.days_to_success || 0), 0) / patterns.length).toFixed(1)),
      dateRange: {
        first: patterns[patterns.length - 1]?.success_date,
        last: patterns[0]?.success_date
      }
    },

    // ========================================
    // 거래량 기준 지표 분석
    // ========================================
    volumeIndicators: {
      volumeRatio: (() => {
        const stats = calcStats(patterns.map(p => p.volume_ratio));
        return stats ? { ...stats, distribution: calcDistribution(patterns.map(p => p.volume_ratio), 0.5), insight: null } : null;
      })(),
      asymmetricRatio: (() => {
        const stats = calcStats(patterns.map(p => p.asymmetric_ratio));
        return stats ? { ...stats, distribution: calcDistribution(patterns.map(p => p.asymmetric_ratio), 0.3) } : null;
      })(),
      volume5dChange: calcStats(patterns.map(p => p.volume_5d_change_rate)),
      volumeAcceleration: {
        distribution: {
          strong_acceleration: patterns.filter(p => p.volume_acceleration_trend === 'strong_acceleration').length,
          acceleration: patterns.filter(p => p.volume_acceleration_trend === 'acceleration').length,
          mixed: patterns.filter(p => p.volume_acceleration_trend === 'mixed').length,
          deceleration: patterns.filter(p => p.volume_acceleration_trend === 'deceleration').length
        }
      },
      whaleStats: {
        detected: patterns.filter(p => p.whale_detected).length,
        confirmed: patterns.filter(p => p.whale_confirmed).length,
        avgVolumeRatio: calcStats(patterns.filter(p => p.whale_detected).map(p => p.whale_volume_ratio))
      }
    },

    // ========================================
    // 시세 기준 지표 분석
    // ========================================
    priceIndicators: {
      rsi: (() => {
        const stats = calcStats(patterns.map(p => p.rsi));
        return stats ? { ...stats, distribution: calcDistribution(patterns.map(p => p.rsi), 10) } : null;
      })(),
      mfi: (() => {
        const stats = calcStats(patterns.map(p => p.mfi));
        return stats ? { ...stats, distribution: calcDistribution(patterns.map(p => p.mfi), 10) } : null;
      })(),
      disparity: (() => {
        const stats = calcStats(patterns.map(p => p.disparity));
        return stats ? { ...stats, distribution: calcDistribution(patterns.map(p => p.disparity), 5) } : null;
      })(),
      vwapDivergence: calcStats(patterns.map(p => p.vwap_divergence)),
      dailyChange: calcStats(patterns.map(p => p.daily_change_rate)),
      escapeVelocity: {
        detected: patterns.filter(p => p.escape_velocity).length,
        avgClosingStrength: calcStats(patterns.filter(p => p.escape_velocity).map(p => p.escape_closing_strength))
      },
      upperShadow: calcStats(patterns.map(p => p.upper_shadow_ratio))
    },

    // ========================================
    // 수급 기준 지표 분석
    // ========================================
    institutionalIndicators: {
      institutionBuyDays: {
        ...calcStats(patterns.map(p => p.institution_buy_days)),
        distribution: {
          '0일': patterns.filter(p => !p.institution_buy_days || p.institution_buy_days === 0).length,
          '1-2일': patterns.filter(p => p.institution_buy_days >= 1 && p.institution_buy_days <= 2).length,
          '3일+': patterns.filter(p => p.institution_buy_days >= 3).length
        }
      },
      foreignBuyDays: {
        ...calcStats(patterns.map(p => p.foreign_buy_days)),
        distribution: {
          '0일': patterns.filter(p => !p.foreign_buy_days || p.foreign_buy_days === 0).length,
          '1-2일': patterns.filter(p => p.foreign_buy_days >= 1 && p.foreign_buy_days <= 2).length,
          '3일+': patterns.filter(p => p.foreign_buy_days >= 3).length
        }
      }
    },

    // ========================================
    // 등급/점수 분석
    // ========================================
    gradeAnalysis: {
      distribution: {
        'S+': patterns.filter(p => p.recommendation_grade === 'S+').length,
        'S': patterns.filter(p => p.recommendation_grade === 'S').length,
        'A': patterns.filter(p => p.recommendation_grade === 'A').length,
        'B': patterns.filter(p => p.recommendation_grade === 'B').length,
        'C': patterns.filter(p => p.recommendation_grade === 'C').length
      },
      scoreStats: calcStats(patterns.map(p => p.total_score)),
      scoreDistribution: calcDistribution(patterns.map(p => p.total_score), 10)
    },

    // ========================================
    // 인사이트 (임계값 조정 제안)
    // ========================================
    insights: []
  };

  // 4. 인사이트 생성
  const insights = [];

  // 거래량 비율 인사이트
  if (analysis.volumeIndicators.volumeRatio?.median) {
    const vr = analysis.volumeIndicators.volumeRatio;
    insights.push({
      indicator: '거래량 비율',
      current: '2.5배 이상 가점',
      finding: `성공 종목 중앙값: ${vr.median}배 (범위: ${vr.min}~${vr.max})`,
      suggestion: vr.median < 2.0
        ? `${vr.median.toFixed(1)}배 이상으로 완화 검토`
        : '현재 기준 적절'
    });
  }

  // MFI 인사이트
  if (analysis.priceIndicators.mfi?.median) {
    const mfi = analysis.priceIndicators.mfi;
    insights.push({
      indicator: 'MFI',
      current: '70↑ 강한유입 기준',
      finding: `성공 종목 중앙값: ${mfi.median} (범위: ${mfi.min}~${mfi.max})`,
      suggestion: mfi.median < 60
        ? '50~70 구간이 최적일 수 있음'
        : '현재 기준 적절'
    });
  }

  // RSI 인사이트
  if (analysis.priceIndicators.rsi?.median) {
    const rsi = analysis.priceIndicators.rsi;
    insights.push({
      indicator: 'RSI',
      current: '85↑ 과열 기준',
      finding: `성공 종목 중앙값: ${rsi.median} (범위: ${rsi.min}~${rsi.max})`,
      suggestion: rsi.max < 85
        ? '성공 종목 대부분 RSI 85 미만 - 과열 기준 유효'
        : '일부 고RSI 종목도 성공'
    });
  }

  // 비대칭 비율 인사이트
  if (analysis.volumeIndicators.asymmetricRatio?.median) {
    const ar = analysis.volumeIndicators.asymmetricRatio;
    insights.push({
      indicator: '비대칭 비율',
      current: '1.5↑ 강한 매수세',
      finding: `성공 종목 중앙값: ${ar.median} (범위: ${ar.min}~${ar.max})`,
      suggestion: ar.median > 1.3
        ? '비대칭 비율이 높을수록 성공 확률↑'
        : '비대칭 비율 단독으로는 예측력 낮음'
    });
  }

  // 고래 감지 인사이트
  if (analysis.volumeIndicators.whaleStats) {
    const whaleRate = (analysis.volumeIndicators.whaleStats.detected / patterns.length * 100).toFixed(1);
    insights.push({
      indicator: '고래 감지',
      current: '감지 시 +15~30점',
      finding: `성공 종목 중 ${whaleRate}%가 고래 감지`,
      suggestion: parseFloat(whaleRate) > 50
        ? '고래 감지가 성공과 높은 상관관계'
        : '고래 미감지 종목도 성공 가능'
    });
  }

  // 이격도 인사이트
  if (analysis.priceIndicators.disparity?.median) {
    const disp = analysis.priceIndicators.disparity;
    insights.push({
      indicator: '이격도(20일)',
      current: '120↑ 과열 기준',
      finding: `성공 종목 중앙값: ${disp.median} (범위: ${disp.min}~${disp.max})`,
      suggestion: disp.median < 110
        ? '성공 종목 대부분 이격도 110 미만 - 과열 전 진입이 유리'
        : disp.median > 120
          ? '고이격도 종목도 성공 가능 - 기준 완화 검토'
          : '현재 과열 기준(120) 적절'
    });
  }

  // 거래량 가속도 인사이트
  if (analysis.volumeIndicators.volumeAcceleration?.distribution) {
    const va = analysis.volumeIndicators.volumeAcceleration.distribution;
    const total = patterns.length;
    const accelRate = (((va.strong_acceleration || 0) + (va.acceleration || 0)) / total * 100).toFixed(1);
    insights.push({
      indicator: '거래량 가속도',
      current: '가속 시 Momentum 가점',
      finding: `성공 종목 중 ${accelRate}%가 가속 패턴 (강한: ${va.strong_acceleration || 0}개, 일반: ${va.acceleration || 0}개)`,
      suggestion: parseFloat(accelRate) > 60
        ? '거래량 가속이 성공과 높은 상관관계'
        : '가속 없이도 성공 가능 - 다른 지표와 병행 판단'
    });
  }

  // 기관 매수일 인사이트
  const instStats = calcStats(patterns.map(p => p.institution_buy_days));
  if (instStats?.median !== null && instStats?.median !== undefined) {
    const inst3plus = patterns.filter(p => p.institution_buy_days >= 3).length;
    const inst0 = patterns.filter(p => !p.institution_buy_days || p.institution_buy_days === 0).length;
    insights.push({
      indicator: '기관 매수일',
      current: 'Supply Score 0-10점',
      finding: `성공 종목 중앙값: ${instStats.median}일 (3일+: ${inst3plus}개, 0일: ${inst0}개)`,
      suggestion: instStats.median >= 2
        ? '기관 연속매수가 성공과 높은 상관관계 - 현재 가점 유지'
        : '기관 매수 없이도 성공 가능 - 다른 신호와 병행'
    });
  }

  // 외국인 매수일 인사이트
  const foreignStats = calcStats(patterns.map(p => p.foreign_buy_days));
  if (foreignStats?.median !== null && foreignStats?.median !== undefined) {
    const for3plus = patterns.filter(p => p.foreign_buy_days >= 3).length;
    insights.push({
      indicator: '외국인 매수일',
      current: 'Supply Score 0-8점',
      finding: `성공 종목 중앙값: ${foreignStats.median}일 (3일+: ${for3plus}개)`,
      suggestion: foreignStats.median >= 2
        ? '외국인 매수 지속이 성공 신호'
        : '외국인 매수 단독으로는 예측력 제한적'
    });
  }

  // 쌍방수급 인사이트
  const dualBuy = patterns.filter(p => (p.institution_buy_days || 0) >= 2 && (p.foreign_buy_days || 0) >= 2);
  const singleBuy = patterns.filter(p =>
    ((p.institution_buy_days || 0) >= 2 || (p.foreign_buy_days || 0) >= 2) &&
    !((p.institution_buy_days || 0) >= 2 && (p.foreign_buy_days || 0) >= 2)
  );
  if (patterns.length > 0) {
    const dualAvgReturn = dualBuy.length > 0
      ? (dualBuy.reduce((s, p) => s + (p.max_return || 0), 0) / dualBuy.length).toFixed(1)
      : 0;
    const singleAvgReturn = singleBuy.length > 0
      ? (singleBuy.reduce((s, p) => s + (p.max_return || 0), 0) / singleBuy.length).toFixed(1)
      : 0;
    insights.push({
      indicator: '쌍방수급 (기관+외국인)',
      current: '동시 매수 시 보너스 0-7점',
      finding: `쌍방: ${dualBuy.length}개(평균+${dualAvgReturn}%) vs 단독: ${singleBuy.length}개(평균+${singleAvgReturn}%)`,
      suggestion: parseFloat(dualAvgReturn) > parseFloat(singleAvgReturn)
        ? '쌍방수급이 단독 대비 수익률 우위 - 보너스 유지'
        : '단독 수급도 충분한 성과 - 쌍방 보너스 축소 검토'
    });
  }

  // 연속 상승일 인사이트
  const riseStats = calcStats(patterns.map(p => p.consecutive_rise_days));
  if (riseStats?.median !== null && riseStats?.median !== undefined) {
    insights.push({
      indicator: '연속 상승일',
      current: '4일+ → +10점 (Momentum)',
      finding: `성공 종목 중앙값: ${riseStats.median}일 (범위: ${riseStats.min}~${riseStats.max})`,
      suggestion: riseStats.median <= 2
        ? '초기 상승(1-2일)에 진입하는 것이 최적'
        : riseStats.median >= 4
          ? '연속 상승 후 진입도 유효 - 추세 추종'
          : '2-3일 상승이 최적 진입 구간'
    });
  }

  // 시가총액 인사이트
  const capStats = calcStats(patterns.map(p => p.market_cap));
  if (capStats?.median) {
    const capBillion = (capStats.median / 100000000).toFixed(0);
    const largeCap = patterns.filter(p => (p.market_cap || 0) >= 1000000000000).length;  // 1조+
    const smallCap = patterns.filter(p => (p.market_cap || 0) < 300000000000).length;  // 3000억 미만
    insights.push({
      indicator: '시가총액',
      current: '1조↑ +7점, 3000억↓ -2점',
      finding: `성공 종목 중앙값: ${capBillion}억 (1조+: ${largeCap}개, 3000억↓: ${smallCap}개)`,
      suggestion: largeCap > smallCap
        ? '대형주 중심으로 성공 - 시총 가점 유효'
        : '소형주에서도 성공 빈번 - 시총 페널티 완화 검토'
    });
  }

  // VPD 원시값 인사이트
  const vpdStats = calcStats(patterns.map(p => p.vpd_raw));
  if (vpdStats?.median !== null && vpdStats?.median !== undefined) {
    insights.push({
      indicator: 'VPD (거래량-가격 괴리)',
      current: '≥3.0 → 7점, ≥2.0 → 5점',
      finding: `성공 종목 중앙값: ${vpdStats.median} (범위: ${vpdStats.min}~${vpdStats.max})`,
      suggestion: vpdStats.median >= 2.0
        ? 'VPD 높은 종목이 성공 확률↑ - 핵심 지표 확인'
        : vpdStats.median >= 1.0
          ? 'VPD 1.0 이상이면 충분 - 하한 완화 가능'
          : 'VPD 단독 예측력 낮음 - 다른 지표와 병행'
    });
  }

  // 탈출속도 인사이트
  const escapeDetected = patterns.filter(p => p.escape_velocity);
  const escapeNot = patterns.filter(p => !p.escape_velocity);
  if (escapeDetected.length > 0 || escapeNot.length > 0) {
    const escAvg = escapeDetected.length > 0
      ? (escapeDetected.reduce((s, p) => s + (p.max_return || 0), 0) / escapeDetected.length).toFixed(1)
      : 0;
    const noEscAvg = escapeNot.length > 0
      ? (escapeNot.reduce((s, p) => s + (p.max_return || 0), 0) / escapeNot.length).toFixed(1)
      : 0;
    insights.push({
      indicator: '탈출속도',
      current: '달성 시 +5점',
      finding: `달성: ${escapeDetected.length}개(평균+${escAvg}%) vs 미달성: ${escapeNot.length}개(평균+${noEscAvg}%)`,
      suggestion: parseFloat(escAvg) > parseFloat(noEscAvg)
        ? '탈출속도 달성이 높은 수익과 상관 - 가점 유지'
        : '탈출속도 미달성도 성공 가능 - 가점 과대 여부 검토'
    });
  }

  // 윗꼬리 비율 인사이트
  const shadowStats = calcStats(patterns.map(p => p.upper_shadow_ratio));
  if (shadowStats?.median !== null && shadowStats?.median !== undefined) {
    const highShadow = patterns.filter(p => (p.upper_shadow_ratio || 0) >= 30).length;
    insights.push({
      indicator: '윗꼬리 비율',
      current: '≥30% → 고래 강도 50% 감소',
      finding: `성공 종목 중앙값: ${shadowStats.median}% (30%↑: ${highShadow}개/${patterns.length}개)`,
      suggestion: highShadow === 0
        ? '성공 종목에서 윗꼬리 과다 없음 - 현재 페널티 유효'
        : `윗꼬리 30%+ 중 ${highShadow}개 성공 - 페널티 과도 여부 검토`
    });
  }

  // 당일 등락률 인사이트
  const changeStats = calcStats(patterns.map(p => p.daily_change_rate));
  if (changeStats?.median !== null && changeStats?.median !== undefined) {
    insights.push({
      indicator: '진입 시 당일 등락률',
      current: '≥10% → -15점 페널티',
      finding: `성공 종목 중앙값: ${changeStats.median > 0 ? '+' : ''}${changeStats.median}% (범위: ${changeStats.min}~${changeStats.max}%)`,
      suggestion: changeStats.median < 5
        ? '소폭 상승(0-5%) 시 진입이 최적'
        : changeStats.median >= 10
          ? '급등 중 진입도 성공 가능 - 페널티 기준 상향 검토'
          : '중간 상승(5-10%) 진입이 최적 구간'
    });
  }

  // 점수 구간별 수익률 인사이트
  const scoreRanges = [
    { label: '90+', min: 90, max: 101 },
    { label: '70-89', min: 70, max: 90 },
    { label: '50-69', min: 50, max: 70 },
    { label: '50 미만', min: 0, max: 50 }
  ];
  const rangeResults = scoreRanges.map(r => {
    const group = patterns.filter(p => (p.total_score || 0) >= r.min && (p.total_score || 0) < r.max);
    return {
      label: r.label,
      count: group.length,
      avgReturn: group.length > 0 ? (group.reduce((s, p) => s + (p.max_return || 0), 0) / group.length).toFixed(1) : 0
    };
  }).filter(r => r.count > 0);
  if (rangeResults.length > 0) {
    const bestRange = rangeResults.reduce((best, r) => parseFloat(r.avgReturn) > parseFloat(best.avgReturn) ? r : best);
    insights.push({
      indicator: '점수 구간별 수익률',
      current: 'TOP3: 50-69 → 80-89 우선',
      finding: rangeResults.map(r => `${r.label}점: ${r.count}개(+${r.avgReturn}%)`).join(' | '),
      suggestion: `${bestRange.label}점 구간이 평균 +${bestRange.avgReturn}%로 최고 수익률`
    });
  }

  // 달성 소요일 인사이트
  const daysStats = calcStats(patterns.map(p => p.days_to_success));
  if (daysStats?.median !== null && daysStats?.median !== undefined) {
    const fast = patterns.filter(p => (p.days_to_success || 0) <= 5).length;
    const slow = patterns.filter(p => (p.days_to_success || 0) > 14).length;
    insights.push({
      indicator: '+10% 달성 소요일',
      current: '추적 기간 3일 (텔레그램)',
      finding: `중앙값: ${daysStats.median}일 (5일 이내: ${fast}개, 14일+: ${slow}개)`,
      suggestion: daysStats.median <= 5
        ? '대부분 5일 내 달성 - 단기 추적 전략 유효'
        : daysStats.median <= 14
          ? '1-2주 보유가 최적 - 추적 기간 연장 고려'
          : '장기 보유 필요 - 손절/익절 기준 재검토'
    });
  }

  // 고래 확인 vs 미확인 인사이트
  const whaleConfirmed = patterns.filter(p => p.whale_confirmed);
  const whaleUnconfirmed = patterns.filter(p => p.whale_detected && !p.whale_confirmed);
  if (whaleConfirmed.length > 0 || whaleUnconfirmed.length > 0) {
    const confAvg = whaleConfirmed.length > 0
      ? (whaleConfirmed.reduce((s, p) => s + (p.max_return || 0), 0) / whaleConfirmed.length).toFixed(1) : 0;
    const unconfAvg = whaleUnconfirmed.length > 0
      ? (whaleUnconfirmed.reduce((s, p) => s + (p.max_return || 0), 0) / whaleUnconfirmed.length).toFixed(1) : 0;
    insights.push({
      indicator: '고래 확인 vs 미확인',
      current: '확인 +30점, 미확인 +15점',
      finding: `확인: ${whaleConfirmed.length}개(+${confAvg}%) vs 미확인: ${whaleUnconfirmed.length}개(+${unconfAvg}%)`,
      suggestion: parseFloat(confAvg) > parseFloat(unconfAvg)
        ? '확인된 고래가 수익률 우위 - 30점/15점 차등 유효'
        : '미확인 고래도 수익률 양호 - 차등 축소 검토'
    });
  }

  // 각 인사이트에 needsReview 플래그 추가 (검토/완화/재검토/축소/상향/과대/과도 키워드 포함 시)
  const reviewKeywords = ['검토', '완화', '재검토', '축소', '상향', '과대', '과도', '연장'];
  insights.forEach(ins => {
    ins.needsReview = reviewKeywords.some(kw => ins.suggestion.includes(kw));
  });

  analysis.insights = insights;

  // 5. 최근 패턴 목록 (stock_code 기준 중복 제거, 최신 성공만 상위 20개)
  const seenCodes = new Set();
  const recentPatterns = patterns
    .filter(p => {
      const code = p.stock_code || p.stock_name;
      if (seenCodes.has(code)) return false;
      seenCodes.add(code);
      return true;
    })
    .slice(0, 20)
    .map(p => ({
      stock_name: p.stock_name,
      stock_code: p.stock_code,
      success_date: p.success_date,
      max_return: p.max_return,
      days_to_success: p.days_to_success,
      recommendation_grade: p.recommendation_grade,
      total_score: p.total_score,
      volume_ratio: p.volume_ratio,
      mfi: p.mfi,
      whale_detected: p.whale_detected
    }));

  console.log(`📊 패턴 분석 완료: ${patterns.length}개 패턴, ${insights.length}개 인사이트`);

  return res.status(200).json({
    success: true,
    totalPatterns: patterns.length,
    analysis,
    recentPatterns
  });
}
