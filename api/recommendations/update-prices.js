/**
 * 추천 종목 일별 가격 업데이트 API
 * POST /api/recommendations/update-prices
 *
 * 활성 추천 종목의 오늘 종가를 기록 (Cron Job용)
 */

const { createClient } = require('@supabase/supabase-js');
const kisApi = require('../../backend/kisApi');
const { isTradingDay, getTodayDateKST, tradingDaysSince } = require('../../backend/marketCalendar');

// Supabase 서비스 롤 클라이언트 (RLS 우회 가능)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

module.exports = async (req, res) => {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Vercel Cron은 GET으로 호출하므로 GET/POST 모두 허용
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Supabase 비활성화 시
  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase not configured'
    });
  }

  try {
    const startTime = Date.now();
    // v3.94: UTC 날짜(new Date().toISOString())를 쓰고 있었음. 16:05 KST cron에서는 우연히
    //   UTC 날짜와 일치해 드러나지 않았으나, 00:00~09:00 KST 실행 시 전날로 기록된다.
    const today = getTodayDateKST();

    // 수동 가격 업데이트 모드: ?stockCode=001440&price=31750
    const manualStockCode = req.query.stockCode;
    const manualPrice = parseInt(req.query.price);

    if (manualStockCode && manualPrice > 0) {
      console.log(`🔧 수동 가격 업데이트: ${manualStockCode} → ${manualPrice}원`);

      // 해당 종목의 활성 추천 찾기
      const { data: recs, error: findError } = await supabase
        .from('screening_recommendations')
        .select('id, stock_code, stock_name, recommended_price')
        .eq('stock_code', manualStockCode)
        .eq('is_active', true);

      if (findError || !recs || recs.length === 0) {
        return res.status(404).json({
          success: false,
          error: `종목 ${manualStockCode} 활성 추천 없음`
        });
      }

      // 각 추천에 대해 가격 업데이트
      const updates = recs.map(rec => {
        const cumulativeReturn = rec.recommended_price > 0
          ? ((manualPrice - rec.recommended_price) / rec.recommended_price * 100)
          : 0;
        return {
          recommendation_id: rec.id,
          tracking_date: today,
          closing_price: manualPrice,
          change_rate: 0,
          volume: 0,
          cumulative_return: parseFloat(cumulativeReturn.toFixed(2)),
          days_since_recommendation: 0
        };
      });

      const { error: upsertError } = await supabase
        .from('recommendation_daily_prices')
        .upsert(updates, { onConflict: 'recommendation_id,tracking_date' });

      if (upsertError) {
        return res.status(500).json({ success: false, error: upsertError.message });
      }

      return res.status(200).json({
        success: true,
        mode: 'manual',
        stockCode: manualStockCode,
        price: manualPrice,
        updated: recs.length,
        stocks: recs.map(r => ({ name: r.stock_name, return: ((manualPrice - r.recommended_price) / r.recommended_price * 100).toFixed(2) + '%' }))
      });
    }

    // v3.94: 휴장일 가드. 이 파일에는 가드가 없어 휴장일에도 cron이 돌았고, 장이 안 열려
    //   전 거래일 종가가 그대로 복제된 "유령 관측"이 기록됐다 (2026-06-03 지방선거일 703행).
    //   유령 행은 days_since_recommendation 한 칸을 차지해 이후 D+N을 전부 하루씩 밀어버린다.
    //   수동 모드(?stockCode=&price=)는 위에서 이미 반환되므로 영향 없음.
    if (!isTradingDay(today)) {
      console.log(`🏖️ 오늘(${today})은 휴장일 — 가격 업데이트 건너뜀`);
      return res.status(200).json({ success: true, message: `Not a trading day (${today}) — skipped`, skipped: true });
    }

    console.log(`\n📊 [${today}] 추천 종목 가격 업데이트 시작...\n`);

    // 30일+ 경과 추천 자동 만료
    const expiryCutoff = new Date();
    expiryCutoff.setDate(expiryCutoff.getDate() - 30);
    const expiryCutoffStr = expiryCutoff.toISOString().slice(0, 10);

    const { data: expired, error: expireError } = await supabase
      .from('screening_recommendations')
      .update({
        is_active: false,
        closed_at: new Date().toISOString(),
        close_reason: 'expired'
      })
      .eq('is_active', true)
      .lt('recommendation_date', expiryCutoffStr)
      .select('id');

    if (!expireError && expired && expired.length > 0) {
      console.log(`🕐 ${expired.length}개 추천 자동 만료 (30일+ 경과)`);
    }

    // 활성 추천 종목 조회 (페이지네이션 — Supabase 1000행 제한 대응)
    let activeRecs = [];
    let arPage = 0;
    while (true) {
      const { data: pageData, error: fetchError } = await supabase
        .from('screening_recommendations')
        .select('id, stock_code, stock_name, recommended_price, recommendation_date')
        .eq('is_active', true)
        .range(arPage * 1000, (arPage + 1) * 1000 - 1);

      if (fetchError) {
        console.error('활성 추천 조회 실패:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }
      if (!pageData || pageData.length === 0) break;
      activeRecs = activeRecs.concat(pageData);
      if (pageData.length < 1000) break;
      arPage++;
    }

    if (activeRecs.length === 0) {
      console.log('활성 추천 종목 없음');
      return res.status(200).json({
        success: true,
        updated: 0,
        message: 'No active recommendations'
      });
    }

    // KST 기준 장 운영 시간 체크
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    const kstMin = now.getUTCMinutes();
    const kstDay = now.getUTCDay();
    // 장중: 09:00~15:30 (15:30 이후는 종가 확정 대기 → getDailyChart만 사용)
    const isMarketHours = kstHour >= 9 && (kstHour < 15 || (kstHour === 15 && kstMin < 30)) && kstDay >= 1 && kstDay <= 5;

    console.log(`활성 추천: ${activeRecs.length}개 (장${isMarketHours ? ' 운영중' : ' 마감'})`);

    // 각 종목 가격 조회 (병렬 처리 최적화)
    const dailyPrices = [];
    let successCount = 0;

    const BATCH_SIZE = 10;

    // 단일 종목 가격 조회 함수
    async function fetchStockPrice(rec) {
      try {
        let closingPrice = null;  // null로 시작 (실패 감지용)
        let changeRate = 0;
        let volume = 0;

        if (isMarketHours) {
          // 장중: getCurrentPrice 시도 → 실패 시 getDailyChart 폴백
          const currentData = await kisApi.getCurrentPrice(rec.stock_code);
          if (currentData?.currentPrice) {
            closingPrice = currentData.currentPrice;
            changeRate = currentData.changeRate || 0;
            volume = currentData.volume || 0;
          } else {
            const chartData = await kisApi.getDailyChart(rec.stock_code, 2);
            if (chartData && chartData.length > 0 && chartData[0].close) {
              closingPrice = chartData[0].close;
              volume = chartData[0].volume || 0;
              if (chartData.length > 1 && chartData[1].close > 0) {
                changeRate = ((closingPrice - chartData[1].close) / chartData[1].close * 100);
              }
            }
          }
        } else {
          // 장 마감: getDailyChart만 1회 호출 (getCurrentPrice 스킵)
          try {
            const chartData = await kisApi.getDailyChart(rec.stock_code, 2);
            if (chartData && chartData.length > 0 && chartData[0].close) {
              closingPrice = chartData[0].close;
              volume = chartData[0].volume || 0;
              if (chartData.length > 1 && chartData[1].close > 0) {
                changeRate = ((closingPrice - chartData[1].close) / chartData[1].close * 100);
              }
            }
          } catch (chartError) {
            console.warn(`❌ 종가 조회 실패 [${rec.stock_code}]:`, chartError.message);
          }
        }

        // 가격 조회 실패 시 null 반환 (이전 가격 유지)
        if (!closingPrice) {
          console.warn(`⚠️ 가격 미조회 [${rec.stock_code} ${rec.stock_name}]: 이전 가격 유지`);
          return null;
        }

        // 경과 거래일 계산 (D+N의 N)
        // v3.94: 달력일 차이를 쓰고 있었으나 행은 거래일에만 생기므로 D+N에 구멍이 났다.
        //   실측(2026-04-01~07-05, n=2131): 금요일 추천의 D+1 존재율 0%(토요일),
        //   수·목요일 추천의 D+10 존재율 0%(토·일). weekly-diagnostic이 pIdx[recId][k]로
        //   직접 인덱싱하므로 해당 건은 조용히 탈락했고, active_policy(D+1→D+10) 평가가
        //   월·화 추천(≈39%)만으로 이뤄지고 있었다. 거래일 기준이면 요일과 무관하게 항상 존재.
        //   프론트엔드가 표시하는 "평일 N일 후"와도 이제 일치한다.
        const daysSince = tradingDaysSince(rec.recommendation_date, today);

        // 누적 수익률 계산
        const cumulativeReturn = rec.recommended_price > 0
          ? ((closingPrice - rec.recommended_price) / rec.recommended_price * 100)
          : 0;

        // 일별 가격 데이터 반환
        return {
          recommendation_id: rec.id,
          tracking_date: today,
          closing_price: closingPrice,
          change_rate: parseFloat(changeRate.toFixed(2)),
          volume: volume,
          cumulative_return: parseFloat(cumulativeReturn.toFixed(2)),
          days_since_recommendation: daysSince
        };
      } catch (error) {
        console.warn(`가격 조회 실패 [${rec.stock_code}]:`, error.message);
        return null;
      }
    }

    // 자동 재시도 설정
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 1000; // 1초
    let remainingRecs = [...activeRecs];
    let retryCount = 0;

    // 배치 단위 병렬 처리 + 자동 재시도
    while (remainingRecs.length > 0 && retryCount <= MAX_RETRIES) {
      if (retryCount > 0) {
        console.log(`\n🔄 재시도 ${retryCount}/${MAX_RETRIES}: ${remainingRecs.length}개 종목...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }

      const failedRecs = [];

      for (let i = 0; i < remainingRecs.length; i += BATCH_SIZE) {
        const batch = remainingRecs.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(remainingRecs.length / BATCH_SIZE);
        console.log(`배치 ${batchNum}/${totalBatches}: ${batch.length}개 종목 처리 중...`);

        // 배치 내 종목들을 병렬로 처리
        const batchResults = await Promise.all(batch.map(async (rec) => {
          const result = await fetchStockPrice(rec);
          return { rec, result };
        }));

        // 성공/실패 분류
        for (const { rec, result } of batchResults) {
          if (result !== null) {
            dailyPrices.push(result);
            successCount++;
          } else {
            failedRecs.push(rec);
          }
        }

        if (i + BATCH_SIZE < remainingRecs.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      // 실패한 종목만 다음 재시도 대상
      remainingRecs = failedRecs;
      retryCount++;

      // 모두 성공하면 루프 종료
      if (remainingRecs.length === 0) {
        console.log(`✅ 모든 종목 업데이트 성공!`);
        break;
      }

      // 타임아웃 방지: 45초 초과 시 중단
      const elapsed = Date.now() - startTime;
      if (elapsed > 45000) {
        console.warn(`⚠️ 타임아웃 임박 (${Math.floor(elapsed/1000)}초), 재시도 중단`);
        break;
      }
    }

    if (remainingRecs.length > 0) {
      console.warn(`⚠️ 최종 실패: ${remainingRecs.length}개 종목`);
      console.warn(`실패 목록: ${remainingRecs.map(r => r.stock_name).join(', ')}`);
    }

    // Supabase에 일괄 저장 (upsert = 있으면 업데이트, 없으면 삽입)
    if (dailyPrices.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from('recommendation_daily_prices')
        .upsert(dailyPrices, {
          onConflict: 'recommendation_id,tracking_date',
          ignoreDuplicates: false  // 항상 최신 데이터로 업데이트
        });

      if (insertError) {
        console.error('일별 가격 저장 실패:', insertError);
        return res.status(500).json({ error: insertError.message });
      }
    }

    console.log(`\n✅ 가격 업데이트 완료: ${successCount}/${activeRecs.length}개\n`);

    return res.status(200).json({
      success: true,
      date: today,
      total: activeRecs.length,
      updated: successCount,
      failed: activeRecs.length - successCount
    });

  } catch (error) {
    console.error('가격 업데이트 실패:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
