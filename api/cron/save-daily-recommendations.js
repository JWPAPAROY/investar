/**
 * 매일 추천 종목 자동 저장 & 알림 Cron (v3.15)
 *
 * 모드:
 * - save (16:10 KST): 스크리닝 + Supabase 저장
 * - alert (08:30 KST): TOP 3 텔레그램 알림 + 이전 추천 결과
 *
 * TOP 3 선별 전략 (screening.js selectTop3와 동일):
 * - 1순위: 고래 + 황금구간(50-79점) → 승률 76.9%
 * - 2순위: 70점+ 점수순 (고래 무관) → 승률 50.0%
 * - Fallback: 조건 미충족 시 "추천 없음" 알림
 */

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');

/**
 * 텔레그램 메시지 전송
 */
async function sendTelegramMessage(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log('⚠️ 텔레그램 설정 없음 - 알림 건너뜀');
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });

    const result = await response.json();
    if (result.ok) {
      console.log('✅ 텔레그램 알림 전송 성공');
      return true;
    } else {
      console.error('❌ 텔레그램 전송 실패:', result.description);
      return false;
    }
  } catch (error) {
    console.error('❌ 텔레그램 전송 오류:', error.message);
    return false;
  }
}

/**
 * TOP 3 선별 (screening.js selectTop3와 동일한 전략)
 *
 * 1순위: 고래 + 황금구간(50-79점)
 * 2순위: 고래 + 70점+
 * 3순위: 고래 + 40점+
 */
function selectAlertTop3(stocks) {
  if (!stocks || stocks.length === 0) return [];

  const isEligible = (s) => s.whale_detected && s.recommendation_grade !== '과열';

  const top3 = [];

  // 1순위: 고래 + 황금구간(50-79점)
  const priority1 = stocks
    .filter(s => isEligible(s) && s.total_score >= 50 && s.total_score < 80)
    .sort((a, b) => b.total_score - a.total_score);
  top3.push(...priority1.slice(0, 3));

  // 2순위: 고래 + 70점+
  if (top3.length < 3) {
    const priority2 = stocks
      .filter(s => isEligible(s) && s.total_score >= 70 && !top3.some(t => t.stock_code === s.stock_code))
      .sort((a, b) => b.total_score - a.total_score);
    top3.push(...priority2.slice(0, 3 - top3.length));
  }

  // 3순위: 고래 + 40점+
  if (top3.length < 3) {
    const priority3 = stocks
      .filter(s => isEligible(s) && s.total_score >= 40 && !top3.some(t => t.stock_code === s.stock_code))
      .sort((a, b) => b.total_score - a.total_score);
    top3.push(...priority3.slice(0, 3 - top3.length));
  }

  return top3;
}

/**
 * 고래 감지 종목 선별 (TOP 3에 포함되지 않은 종목)
 * 승률 89%, 평균 +4.30% (14일 실적 기준)
 */
function selectWhaleStocks(stocks, top3) {
  if (!stocks || stocks.length === 0) return [];

  const top3Codes = (top3 || []).map(s => s.stock_code);

  // 고래 감지 종목 (과열 포함, TOP 3 제외)
  return stocks
    .filter(s =>
      s.whale_detected &&
      !top3Codes.includes(s.stock_code)
    )
    .sort((a, b) => b.total_score - a.total_score);
}

/**
 * 알림 메시지 생성 (TOP 3 + 고래 감지 + 최근 3일 결과)
 * @param {Array} top3 - 오늘의 TOP 3
 * @param {Array} whaleStocks - 고래 감지 종목 (TOP 3 제외)
 * @param {string} date - 기준일
 * @param {Array} prevDayResults - [{ date, stocks: [...] }, ...]
 */
function formatAlertMessage(top3, whaleStocks, date, prevDayResults) {
  let message = '';

  // ── 오늘의 TOP 3 ──
  if ((!top3 || top3.length === 0) && (!whaleStocks || whaleStocks.length === 0)) {
    message += `📊 <b>Investar 알림</b> (${date})\n\n`;
    message += `조건을 충족하는 종목이 없습니다.\n`;
    message += `다음 거래일을 기다려주세요.\n\n`;
  } else {
    if (top3 && top3.length > 0) {
      message += `🏆 <b>오늘의 TOP 3 추천 종목</b>\n`;
      message += `📅 ${date} 기준\n\n`;

      top3.forEach((stock, i) => {
        const medal = ['🥇', '🥈', '🥉'][i];
        const stopLoss5 = Math.floor(stock.recommended_price * 0.95);

        message += `${medal} <b>${stock.stock_name}</b> (${stock.stock_code})\n`;
        message += `   📊 ${stock.total_score.toFixed(1)}점 | ${stock.recommendation_grade}등급\n`;
        message += `   💰 ${stock.recommended_price.toLocaleString()}원\n`;
        message += `   🛡️ 손절가: ${stopLoss5.toLocaleString()}원 (-5%)\n`;

        const categories = [];
        if (stock.whale_detected) categories.push('🐋고래');
        if (stock.accumulation_detected) categories.push('🤫매집');
        if (categories.length > 0) {
          message += `   ${categories.join(' ')}\n`;
        }
        message += `\n`;
      });
    }

    // ── 고래 감지 종목 ──
    if (whaleStocks && whaleStocks.length > 0) {
      message += `🐋 <b>고래 감지 종목</b>\n`;
      whaleStocks.forEach((stock, i) => {
        const stopLoss5 = Math.floor(stock.recommended_price * 0.95);
        const overheatTag = stock.recommendation_grade === '과열' ? ' ⚠️과열' : '';
        message += `  ${i + 1}. <b>${stock.stock_name}</b> (${stock.stock_code})${overheatTag}\n`;
        message += `     ${stock.total_score.toFixed(1)}점 | ${stock.recommendation_grade}등급 | ${stock.recommended_price.toLocaleString()}원\n`;
        message += `     🛡️ 손절: ${stopLoss5.toLocaleString()}원\n`;
      });
      message += `\n`;
    }
  }

  // ── 최근 3일 추천 결과 ──
  if (prevDayResults && prevDayResults.length > 0) {
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 <b>지난 추천 결과</b>\n\n`;

    prevDayResults.forEach(day => {
      message += `📅 ${day.date} 추천\n`;
      day.stocks.forEach((stock, i) => {
        const r = stock.latestReturn;
        const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
        const emoji = r >= 0 ? '✅' : '❌';
        const priceStr = stock.latestPrice ? stock.latestPrice.toLocaleString() : '?';
        const dateTag = stock.priceDate !== day.date ? ` (${stock.priceDate})` : '';
        const whaleTag = stock.whale_detected ? ' 🐋' : '';

        message += `  ${i + 1}. ${stock.stock_name}${whaleTag} → ${priceStr}원${dateTag} ${returnStr} ${emoji}\n`;
      });
      message += `\n`;
    });
  }

  message += `💡 <i>고래 감지 승률 89% | 고래+황금구간 전략</i>\n`;
  message += `🔗 https://investar-xi.vercel.app`;

  return message;
}

/**
 * 어제 날짜 구하기 (KST 기준)
 */
function getYesterdayDateKST() {
  const now = new Date();
  // UTC+9 적용
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  // 하루 전
  kstNow.setDate(kstNow.getDate() - 1);
  return kstNow.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  const mode = req.query.mode || 'save';
  console.log(`📊 Cron 실행 (mode: ${mode})\n`);

  try {
    // Supabase 비활성화 체크
    if (!supabase) {
      console.log('⚠️ Supabase 미설정 - 건너뜀');
      return res.status(200).json({
        success: false,
        message: 'Supabase not configured'
      });
    }

    // =============================================
    // 🔔 ALERT 모드: 아침 알림 (08:30 KST)
    // =============================================
    if (mode === 'alert') {
      console.log('🔔 아침 알림 모드 시작...');

      const yesterday = getYesterdayDateKST();
      console.log(`📅 조회 날짜: ${yesterday}`);

      // Step 1: 어제 저장된 종목 조회
      const { data: stocks, error } = await supabase
        .from('screening_recommendations')
        .select('*')
        .eq('recommendation_date', yesterday)
        .eq('is_active', true)
        .order('total_score', { ascending: false });

      if (error) {
        console.error('❌ Supabase 조회 실패:', error);
        return res.status(500).json({ success: false, error: error.message });
      }

      // Step 2: TOP 3 선별 + 고래 감지 종목
      const top3 = selectAlertTop3(stocks || []);
      const whaleStocks = selectWhaleStocks(stocks || [], top3);
      console.log(`✅ TOP 3 선정: ${top3.length}개, 고래 감지: ${whaleStocks.length}개`);
      top3.forEach((s, i) => {
        console.log(`  TOP ${i + 1}. ${s.stock_name} (${s.total_score}점, 고래:${s.whale_detected})`);
      });
      whaleStocks.forEach((s, i) => {
        console.log(`  🐋 ${i + 1}. ${s.stock_name} (${s.total_score}점)`);
      });

      // Step 3: 최근 3일치 추천 종목 성과 조회
      let prevDayResults = []; // [{ date, stocks: [...] }, ...]
      try {
        // 최근 3개 추천일 찾기 (yesterday 이전, 중복 제거)
        const { data: prevDateRows } = await supabase
          .from('screening_recommendations')
          .select('recommendation_date')
          .lt('recommendation_date', yesterday)
          .order('recommendation_date', { ascending: false });

        // 중복 날짜 제거 후 최근 3일
        const uniqueDates = [...new Set((prevDateRows || []).map(r => r.recommendation_date))].slice(0, 3);
        console.log(`📅 이전 추천일: ${uniqueDates.join(', ') || '없음'}`);

        for (const prevDate of uniqueDates) {
          // 해당 날짜 종목 조회
          const { data: prevStocks } = await supabase
            .from('screening_recommendations')
            .select('*')
            .eq('recommendation_date', prevDate)
            .eq('is_active', true)
            .order('total_score', { ascending: false });

          // TOP 3 + 고래 감지 종목 통합
          const prevTop3 = selectAlertTop3(prevStocks || []);
          const prevWhale = selectWhaleStocks(prevStocks || [], prevTop3);
          const prevAll = [...prevTop3, ...prevWhale];
          if (prevAll.length === 0) continue;

          const dayStocks = [];
          for (const stock of prevAll) {
            const { data: priceData } = await supabase
              .from('recommendation_daily_prices')
              .select('closing_price, tracking_date')
              .eq('recommendation_id', stock.id)
              .order('tracking_date', { ascending: false })
              .limit(1);

            const latest = priceData?.[0];
            const latestPrice = latest?.closing_price || stock.recommended_price;
            const returnRate = ((latestPrice - stock.recommended_price) / stock.recommended_price) * 100;

            dayStocks.push({
              stock_name: stock.stock_name,
              stock_code: stock.stock_code,
              recommended_price: stock.recommended_price,
              latestPrice: latestPrice,
              latestReturn: returnRate,
              priceDate: latest?.tracking_date || prevDate,
              whale_detected: stock.whale_detected
            });
          }

          if (dayStocks.length > 0) {
            prevDayResults.push({ date: prevDate, stocks: dayStocks });
          }
        }
        console.log(`✅ 이전 추천 결과: ${prevDayResults.length}일치`);
      } catch (prevError) {
        console.warn('⚠️ 이전 추천 결과 조회 실패 (무시):', prevError.message);
      }

      // Step 4: 텔레그램 알림 전송
      const message = formatAlertMessage(top3, whaleStocks, yesterday, prevDayResults);
      const sent = await sendTelegramMessage(message);

      return res.status(200).json({
        success: true,
        mode: 'alert',
        date: yesterday,
        top3Count: top3.length,
        whaleCount: whaleStocks.length,
        telegramSent: sent,
        stocks: top3.map(s => ({
          stockCode: s.stock_code,
          stockName: s.stock_name,
          score: s.total_score,
          grade: s.recommendation_grade,
          whale: s.whale_detected
        })),
        whaleStocks: whaleStocks.map(s => ({
          stockCode: s.stock_code,
          stockName: s.stock_name,
          score: s.total_score,
          grade: s.recommendation_grade
        })),
        prevDayResults
      });
    }

    // =============================================
    // 💾 SAVE 모드: 저장 (16:10 KST) - 기존 로직
    // =============================================
    console.log('💾 저장 모드 시작...');

    // Step 1: 종합 스크리닝 (전체 종목)
    console.log('🔍 종합 스크리닝 실행 중...');
    const { stocks } = await screener.screenAllStocks('ALL');

    if (!stocks || stocks.length === 0) {
      console.log('⚠️ 추천 종목 없음');
      return res.status(200).json({
        success: true,
        saved: 0,
        message: 'No stocks to save'
      });
    }

    // Step 2: 저장 구간(50-89점) 필터링
    const filteredStocks = stocks.filter(stock => {
      const score = stock.totalScore;
      return score >= 50 && score < 90;
    });

    console.log(`✅ 스크리닝 완료: ${stocks.length}개 중 ${filteredStocks.length}개 (저장 구간 50-89)`);

    if (filteredStocks.length === 0) {
      return res.status(200).json({
        success: true,
        saved: 0,
        message: 'No B+ grade stocks found'
      });
    }

    // Step 3: Supabase에 저장
    const today = new Date().toISOString().slice(0, 10);

    const recommendations = filteredStocks.map(stock => ({
      recommendation_date: today,
      stock_code: stock.stockCode,
      stock_name: (stock.stockName && stock.stockName.trim() !== '' && !stock.stockName.startsWith('['))
        ? stock.stockName
        : stock.stockCode,  // 종목명이 비어있거나 [코드] 형태면 코드만 저장
      recommended_price: stock.currentPrice || 0,
      recommendation_grade: stock.recommendation?.grade || 'D',
      total_score: stock.totalScore || 0,

      // 추천 근거
      change_rate: stock.changeRate || 0,
      volume: stock.volume || 0,
      market_cap: stock.marketCap || 0,

      whale_detected: stock.advancedAnalysis?.indicators?.whale?.length > 0 || false,
      accumulation_detected: stock.advancedAnalysis?.indicators?.accumulation?.detected || false,
      mfi: stock.volumeAnalysis?.indicators?.mfi || 50,
      volume_ratio: stock.volumeAnalysis?.current?.volumeMA20
        ? (stock.volume / stock.volumeAnalysis.current.volumeMA20)
        : 0,

      is_active: true
    }));

    const { data, error } = await supabase
      .from('screening_recommendations')
      .upsert(recommendations, {
        onConflict: 'recommendation_date,stock_code',
        ignoreDuplicates: false
      })
      .select();

    if (error) {
      console.error('❌ Supabase 저장 실패:', error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    console.log(`✅ ${data.length}개 추천 종목 저장 완료 (${today})`);

    // ⭐ v3.10.0: 추천 당일 가격도 함께 저장 (즉시 성과 집계)
    if (data && data.length > 0) {
      const dailyPrices = data.map(rec => ({
        recommendation_id: rec.id,
        tracking_date: today,
        closing_price: rec.recommended_price,
        change_rate: rec.change_rate || 0,
        volume: rec.volume || 0,
        cumulative_return: 0, // 추천 당일은 0%
        days_since_recommendation: 0
      }));

      const { error: dailyError } = await supabase
        .from('recommendation_daily_prices')
        .upsert(dailyPrices, {
          onConflict: 'recommendation_id,tracking_date',
          ignoreDuplicates: false
        });

      if (dailyError) {
        console.warn('⚠️ 당일 가격 저장 실패 (무시):', dailyError.message);
      } else {
        console.log(`✅ ${dailyPrices.length}개 당일 가격 저장 완료`);
      }
    }

    // 등급별 통계
    const gradeStats = {
      과열: filteredStocks.filter(s => s.recommendation.grade === '과열').length,
      'S+': filteredStocks.filter(s => s.recommendation.grade === 'S+').length,
      S: filteredStocks.filter(s => s.recommendation.grade === 'S').length,
      A: filteredStocks.filter(s => s.recommendation.grade === 'A').length,
      B: filteredStocks.filter(s => s.recommendation.grade === 'B').length
    };
    console.log(`   등급: 과열(${gradeStats.과열}) S+(${gradeStats['S+']}) S(${gradeStats.S}) A(${gradeStats.A}) B(${gradeStats.B})\n`);

    return res.status(200).json({
      success: true,
      saved: data.length,
      date: today,
      grades: gradeStats,
      recommendations: data.map(r => ({
        stockCode: r.stock_code,
        stockName: r.stock_name,
        grade: r.recommendation_grade,
        score: r.total_score
      }))
    });

  } catch (error) {
    console.error('❌ 일일 추천 저장 실패:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
