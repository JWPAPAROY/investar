/**
 * 매일 추천 종목 자동 저장 & 알림 Cron (v3.30)
 *
 * 모드:
 * - save  (16:10 KST): 스크리닝 + Supabase 저장 + 내일 TOP 3 알림
 * - alert (08:30 KST): 전날 SAVE TOP 3 알림 + D-2부터 과거 성과
 * - track (10:00/11:30/13:30/15:00 KST): TOP 3 장중 주가 추적
 *
 * TOP 3 선별 전략:
 * - 1순위: 매수고래 + 황금구간(50-89점)
 * - 2순위: 매수고래 + 70점+
 * - 3순위: 매수고래 + 40점+
 */

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');
const kisApi = require('../../backend/kisApi');

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
 * v3.24: 매수고래만 대상 (매도고래 제외)
 *
 * 1순위: 매수고래 + 황금구간(50-79점)
 * 2순위: 매수고래 + 70점+
 * 3순위: 매수고래 + 40점+
 */
function selectAlertTop3(stocks) {
  if (!stocks || stocks.length === 0) return [];

  const isEligible = (s) => s.whale_detected && s.recommendation_grade !== '과열';

  const top3 = [];

  // 1순위: 고래 + 황금구간(50-89점) — v3.25: 상한 확대 (S등급 실적 반영)
  const priority1 = stocks
    .filter(s => isEligible(s) && s.total_score >= 50 && s.total_score < 90)
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
 * v3.25: save 모드용 TOP 3 선별 (스크리닝 결과 객체 사용)
 * 고래 상세 정보를 포함한 실시간 데이터 기반
 */
function selectSaveTop3(stocks) {
  if (!stocks || stocks.length === 0) return [];

  const isEligible = (s) => {
    const hasBuyWhale = (s.advancedAnalysis?.indicators?.whale || []).some(w => w.type?.includes('매수'));
    const isOverheated = s.recommendation?.grade === '과열';
    return hasBuyWhale && !isOverheated;
  };

  const top3 = [];

  // 1순위: 고래 + 황금구간(50-89점)
  const p1 = stocks.filter(s => isEligible(s) && s.totalScore >= 50 && s.totalScore < 90)
    .sort((a, b) => b.totalScore - a.totalScore);
  top3.push(...p1.slice(0, 3));

  if (top3.length < 3) {
    const p2 = stocks.filter(s => isEligible(s) && s.totalScore >= 70 && !top3.some(t => t.stockCode === s.stockCode))
      .sort((a, b) => b.totalScore - a.totalScore);
    top3.push(...p2.slice(0, 3 - top3.length));
  }
  if (top3.length < 3) {
    const p3 = stocks.filter(s => isEligible(s) && s.totalScore >= 40 && !top3.some(t => t.stockCode === s.stockCode))
      .sort((a, b) => b.totalScore - a.totalScore);
    top3.push(...p3.slice(0, 3 - top3.length));
  }

  return top3;
}

/**
 * v3.27: SAVE 메시지 (오후 16:10)
 * 🌆 오늘의 결산 (오전 추천 성과 + 내일 TOP 3)
 */
function formatSaveAlertMessage(nextTop3, morningResults, date) {
  // 날짜 포맷: 2026-02-05 → 02/05
  const dateShort = date.slice(5).replace('-', '/');
  let msg = `🌆 <b>오늘의 결산</b> (${dateShort})\n\n`;

  // ── 1. 어제 추천 당일 성과 ──
  if (morningResults && morningResults.length > 0) {
    msg += `📊 <b>어제 추천 당일 성과</b>\n`;
    let winCount = 0;
    let totalReturn = 0;

    morningResults.forEach((stock, i) => {
      const medal = ['🥇', '🥈', '🥉'][i];
      const startPrice = stock.recommendPrice;
      const endPrice = stock.closingPrice;
      const r = stock.returnRate;
      const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
      const emoji = r >= 0 ? '✅' : '❌';
      if (r >= 0) winCount++;
      totalReturn += r;

      msg += `  ${medal} ${stock.stockName}: ${startPrice.toLocaleString()} → ${endPrice.toLocaleString()}원 (${returnStr}) ${emoji}\n`;
    });

    const avgReturn = totalReturn / morningResults.length;
    const winRate = (winCount / morningResults.length * 100).toFixed(0);
    msg += `\n  📈 평균: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}% | 승률: ${winRate}%\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  // ── 2. 내일을 위한 TOP 3 ──
  if (!nextTop3 || nextTop3.length === 0) {
    msg += `🏆 <b>내일을 위한 TOP 3</b>\n`;
    msg += `조건을 충족하는 종목이 없습니다.\n`;
  } else {
    msg += `🏆 <b>내일을 위한 TOP 3</b>\n\n`;

    nextTop3.forEach((stock, i) => {
      const medal = ['🥇', '🥈', '🥉'][i];
      const price = stock.currentPrice || 0;
      const sl5 = Math.floor(price * 0.95);
      const sl7 = Math.floor(price * 0.93);
      const grade = stock.recommendation?.grade || '?';
      const gradeDisplay = grade === '과열' ? '과열 ⚠️' : `${grade}등급`;

      msg += `${medal} <b>${stock.stockName}</b> (${stock.totalScore}점, ${gradeDisplay})\n`;
      msg += `   💰 현재가: ${price.toLocaleString()}원\n`;
      msg += `   🛡️ 손절: ${sl5.toLocaleString()}원(-5%) / ${sl7.toLocaleString()}원(-7%)\n`;

      // 최근 주가
      const chart = stock.trendAnalysis?.dailyData || [];
      if (chart.length >= 2) {
        msg += `   📈 최근 주가:`;
        chart.slice(0, 3).forEach(d => {
          const chg = d.priceChange != null ? (d.priceChange >= 0 ? `+${d.priceChange.toFixed(1)}%` : `${d.priceChange.toFixed(1)}%`) : '';
          const dateStr = d.date ? `(${d.date.slice(4, 6)}/${d.date.slice(6, 8)})` : '';
          msg += ` ${dateStr} ${d.close ? d.close.toLocaleString() : '?'}원${chg ? '(' + chg + ')' : ''}`;
        });
        msg += '\n';
      }
      msg += `\n`;
    });
  }

  return msg;
}

/**
 * v3.27: ALERT 메시지 (아침 08:30)
 * 🌅 오늘의 매수 전략 + 과거 추천 성과
 */
function formatAlertMessage(top3, whaleStocks, date, prevDayResults) {
  // 날짜 포맷: 2026-02-05 → 02/05
  const dateShort = date.slice(5).replace('-', '/');
  let message = `🌅 <b>오늘의 매수 전략</b> (${dateShort})\n\n`;

  // ── 오늘의 TOP 3 ──
  if (!top3 || top3.length === 0) {
    message += `조건을 충족하는 종목이 없습니다.\n`;
    message += `다음 거래일을 기다려주세요.\n`;
  } else {
    message += `🏆 <b>오늘의 TOP 3</b>\n\n`;

    top3.forEach((stock, i) => {
      const medal = ['🥇', '🥈', '🥉'][i];
      const price = stock.recommended_price || 0;
      const sl5 = Math.floor(price * 0.95);
      const sl7 = Math.floor(price * 0.93);
      const grade = stock.recommendation_grade || '?';

      message += `${medal} <b>${stock.stock_name}</b> (${stock.stock_code})\n`;
      message += `   📊 ${stock.total_score.toFixed(0)}점 | ${grade}등급\n`;
      message += `   💰 현재가: ${price.toLocaleString()}원\n`;
      message += `   🛡️ 손절: ${sl5.toLocaleString()}원(-5%) / ${sl7.toLocaleString()}원(-7%)\n`;

      // 최근 주가 (Alert 모드에서 추가된 부분)
      if (stock.dailyData && stock.dailyData.length >= 2) {
        message += `   📈 최근 주가:`;
        stock.dailyData.slice(0, 3).forEach(d => {
          const chg = d.priceChange != null ? (d.priceChange >= 0 ? `+${d.priceChange.toFixed(1)}%` : `${d.priceChange.toFixed(1)}%`) : '';
          const dateStr = d.date ? `(${d.date.slice(4, 6)}/${d.date.slice(6, 8)})` : '';
          message += ` ${dateStr} ${d.close ? d.close.toLocaleString() : '?'}원${chg ? '(' + chg + ')' : ''}`;
        });
        message += '\n';
      }
      message += `\n`;
    });
  }

  // ── 과거 추천 성과 ──
  if (prevDayResults && prevDayResults.length > 0) {
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 <b>과거 추천 성과</b>\n\n`;

    prevDayResults.forEach((day, dayIndex) => {
      // 날짜 포맷
      const dayShort = day.date.slice(5).replace('-', '/');
      const daysAgo = dayIndex === 0 ? '어제' : `${dayIndex + 1}일 전`;
      message += `📅 ${daysAgo}(${dayShort}) 추천\n`;

      // TOP 3만 표시 (최대 3개)
      const displayStocks = day.stocks.slice(0, 3);
      let winCount = 0;
      let totalReturn = 0;

      displayStocks.forEach((stock, i) => {
        const r = stock.latestReturn;
        const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
        const emoji = r >= 0 ? '✅' : '❌';
        if (r >= 0) winCount++;
        totalReturn += r;

        message += `  ${i + 1}. ${stock.stock_name} → ${returnStr} ${emoji}\n`;
      });

      // 평균 수익률, 승률
      if (displayStocks.length > 0) {
        const avgReturn = totalReturn / displayStocks.length;
        const winRate = (winCount / displayStocks.length * 100).toFixed(0);
        message += `  📊 평균: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(1)}% | 승률: ${winRate}%\n`;
      }
      message += `\n`;
    });
  }

  return message;
}


/**
 * v3.30: TRACK 메시지 (장중 10:00/11:30/13:30/15:00)
 * 📊 오늘의 TOP 3 주가 추적
 */
function formatTrackMessage(trackResults, timeStr, recDate) {
  const dateShort = recDate.slice(5).replace('-', '/');
  let msg = `📊 <b>주가 추적</b> (${timeStr})\n\n`;

  let winCount = 0;
  let totalReturn = 0;
  let validCount = 0;

  trackResults.forEach((stock, i) => {
    const medal = ['🥇', '🥈', '🥉'][i];
    const recPrice = stock.recommended_price.toLocaleString();
    const gradeDisplay = stock.grade === '과열' ? '과열 ⚠️' : `${stock.grade}등급`;

    if (stock.current_price > 0) {
      const r = stock.return_rate;
      const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
      const emoji = r >= 0 ? '✅' : '❌';
      if (r >= 0) winCount++;
      totalReturn += r;
      validCount++;

      msg += `${medal} <b>${stock.stock_name}</b> (${gradeDisplay})\n`;
      msg += `   💰 ${recPrice} → ${stock.current_price.toLocaleString()}원 (${returnStr}) ${emoji}\n`;
    } else {
      msg += `${medal} <b>${stock.stock_name}</b> (${gradeDisplay})\n`;
      msg += `   💰 ${recPrice}원 → ⚠️ 조회실패\n`;
    }
  });

  if (validCount > 0) {
    const avgReturn = totalReturn / validCount;
    const winRate = (winCount / validCount * 100).toFixed(0);
    msg += `\n📈 평균: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(1)}% | 승률: ${winRate}%`;
  }

  return msg;
}

/**
 * 오늘 날짜 구하기 (KST 기준)
 */
function getTodayDateKST() {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  return kstNow.toISOString().slice(0, 10);
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
    // v3.30: 전날 SAVE 결과 사용 + D-2부터 과거 성과
    // =============================================
    if (mode === 'alert') {
      console.log('🔔 아침 알림 모드 시작 (전날 SAVE 결과 기반)...');

      const today = getTodayDateKST();
      console.log(`📅 기준 날짜: ${today}`);

      // Step 1: 전날 SAVE 결과에서 TOP 3 가져오기 (Supabase 조회)
      console.log('🔍 전날 SAVE 결과 조회 중...');
      const { data: saveDateRows } = await supabase
        .from('screening_recommendations')
        .select('recommendation_date')
        .lt('recommendation_date', today)
        .order('recommendation_date', { ascending: false });

      const latestSaveDate = [...new Set((saveDateRows || []).map(r => r.recommendation_date))][0];

      if (!latestSaveDate) {
        console.log('⚠️ 이전 SAVE 데이터 없음');
        return res.status(200).json({
          success: false,
          mode: 'alert',
          message: 'No previous save data'
        });
      }
      console.log(`📅 최근 SAVE 날짜: ${latestSaveDate}`);

      const { data: savedStocks } = await supabase
        .from('screening_recommendations')
        .select('*')
        .eq('recommendation_date', latestSaveDate)
        .eq('is_active', true)
        .order('total_score', { ascending: false });

      // Step 2: TOP 3 선별 (SAVE와 동일한 selectAlertTop3 사용)
      const top3 = selectAlertTop3(savedStocks || []).slice(0, 3);
      console.log(`✅ TOP 3 선정: ${top3.length}개`);

      top3.forEach((s, i) => {
        console.log(`  TOP ${i + 1}. ${s.stock_name} (${s.total_score}점, 고래:${s.whale_detected})`);
      });

      // Step 3: 과거 추천 종목 성과 조회 (D-2부터, D-1은 아직 가격 미업데이트)
      let prevDayResults = []; // [{ date, stocks: [...] }, ...]
      try {
        // 최근 3개 추천일 찾기 (latestSaveDate 이전 = D-2부터)
        const { data: prevDateRows } = await supabase
          .from('screening_recommendations')
          .select('recommendation_date')
          .lt('recommendation_date', latestSaveDate)
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

          // TOP 3만 선별 (selectSaveTop3와 동일한 기준 적용)
          const prevTop3 = selectAlertTop3(prevStocks || []).slice(0, 3);
          if (prevTop3.length === 0) continue;

          const dayStocks = [];
          for (const stock of prevTop3) {
            // v3.27: Supabase 저장된 종가 사용 (타임아웃 방지)
            let latestPrice = stock.recommended_price;
            let priceDate = prevDate;

            const { data: priceData } = await supabase
              .from('recommendation_daily_prices')
              .select('closing_price, tracking_date')
              .eq('recommendation_id', stock.id)
              .order('tracking_date', { ascending: false })
              .limit(1);

            if (priceData?.[0]) {
              latestPrice = priceData[0].closing_price;
              priceDate = priceData[0].tracking_date;
            }

            const returnRate = ((latestPrice - stock.recommended_price) / stock.recommended_price) * 100;

            dayStocks.push({
              stock_name: stock.stock_name,
              stock_code: stock.stock_code,
              recommended_price: stock.recommended_price,
              latestPrice: latestPrice,
              latestReturn: returnRate,
              priceDate: priceDate
            });
          }

          if (dayStocks.length > 0) {
            prevDayResults.push({ date: prevDate, stocks: dayStocks });
          }
        }
        console.log(`✅ 이전 추천 결과: ${prevDayResults.length}일치 (실시간 현재가 반영)`);
      } catch (prevError) {
        console.warn('⚠️ 이전 추천 결과 조회 실패 (무시):', prevError.message);
      }

      // Step 5: 텔레그램 알림 전송
      const message = formatAlertMessage(top3, [], today, prevDayResults);
      const sent = await sendTelegramMessage(message);

      return res.status(200).json({
        success: true,
        mode: 'alert',
        date: today,
        top3Count: top3.length,
        telegramSent: sent,
        stocks: top3.map(s => ({
          stockCode: s.stock_code,
          stockName: s.stock_name,
          score: s.total_score,
          grade: s.recommendation_grade,
          whale: s.whale_detected
        })),
        prevDayResults
      });
    }

    // =============================================
    // 📊 TRACK 모드: 장중 주가 추적 (10:00/11:30/13:30/15:00 KST)
    // =============================================
    if (mode === 'track') {
      const now = new Date();
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstNow = new Date(now.getTime() + kstOffset);
      const kstTimeStr = `${String(kstNow.getHours()).padStart(2, '0')}:${String(kstNow.getMinutes()).padStart(2, '0')}`;
      console.log(`📊 주가 추적 모드 시작 (${kstTimeStr} KST)...`);

      const today = getTodayDateKST();

      // Step 1: 가장 최근 SAVE 날짜 찾기
      const { data: saveDateRows } = await supabase
        .from('screening_recommendations')
        .select('recommendation_date')
        .lt('recommendation_date', today)
        .order('recommendation_date', { ascending: false });

      const latestSaveDate = [...new Set((saveDateRows || []).map(r => r.recommendation_date))][0];

      if (!latestSaveDate) {
        console.log('⚠️ 추적할 추천 데이터 없음');
        return res.status(200).json({ success: false, mode: 'track', message: 'No data to track' });
      }

      // Step 2: 해당 날짜 종목에서 TOP 3 선별
      const { data: savedStocks } = await supabase
        .from('screening_recommendations')
        .select('*')
        .eq('recommendation_date', latestSaveDate)
        .eq('is_active', true)
        .order('total_score', { ascending: false });

      const top3 = selectAlertTop3(savedStocks || []).slice(0, 3);

      if (top3.length === 0) {
        console.log('⚠️ 추적할 TOP 3 없음');
        return res.status(200).json({ success: false, mode: 'track', message: 'No TOP 3 to track' });
      }

      // Step 3: 각 종목 현재가 조회 (최대 3회 재시도)
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 1000;
      const trackResults = [];

      for (const stock of top3) {
        let priceData = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            priceData = await kisApi.getCurrentPrice(stock.stock_code);
            if (priceData?.currentPrice) break;
            console.warn(`⚠️ ${stock.stock_name} 현재가 0 (${attempt}/${MAX_RETRIES})`);
          } catch (err) {
            console.warn(`⚠️ ${stock.stock_name} 조회 실패 (${attempt}/${MAX_RETRIES}): ${err.message}`);
          }
          if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY));
        }

        const currentPrice = priceData?.currentPrice || 0;
        const returnRate = (stock.recommended_price > 0 && currentPrice > 0)
          ? ((currentPrice - stock.recommended_price) / stock.recommended_price * 100)
          : 0;

        trackResults.push({
          stock_name: stock.stock_name,
          stock_code: stock.stock_code,
          recommended_price: stock.recommended_price,
          current_price: currentPrice,
          return_rate: returnRate,
          change_rate: priceData?.changeRate || 0,
          grade: stock.recommendation_grade
        });
      }

      // Step 4: 메시지 포맷 및 전송
      const trackMsg = formatTrackMessage(trackResults, kstTimeStr, latestSaveDate);
      const sent = await sendTelegramMessage(trackMsg);

      return res.status(200).json({
        success: true,
        mode: 'track',
        time: kstTimeStr,
        date: latestSaveDate,
        telegramSent: sent,
        stocks: trackResults
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

    const recommendations = filteredStocks.map(stock => {
      // 고래 정보 추출
      const buyWhales = (stock.advancedAnalysis?.indicators?.whale || []).filter(w => w.type?.includes('매수'));
      const hasBuyWhale = buyWhales.length > 0;
      const whaleConfirmed = stock.advancedAnalysis?.indicators?.whaleConfirmed || false;
      const whaleInfo = buyWhales[0] || {};

      // 거래량 비율 계산
      const volumeRatio = stock.volumeAnalysis?.current?.volumeMA20
        ? (stock.volume / stock.volumeAnalysis.current.volumeMA20)
        : 0;

      // VWAP 괴리율 계산
      const vwapDivergence = stock.volumeAnalysis?.indicators?.vwap && stock.currentPrice
        ? ((stock.currentPrice - stock.volumeAnalysis.indicators.vwap) / stock.volumeAnalysis.indicators.vwap * 100)
        : null;

      // 윗꼬리 비율 (최근 일봉에서 계산)
      const latestCandle = stock.trendAnalysis?.dailyData?.[0];
      const upperShadowRatio = latestCandle && latestCandle.high !== latestCandle.low
        ? ((latestCandle.high - latestCandle.close) / (latestCandle.high - latestCandle.low) * 100)
        : null;

      return {
        recommendation_date: today,
        stock_code: stock.stockCode,
        stock_name: (stock.stockName && stock.stockName.trim() !== '' && !stock.stockName.startsWith('['))
          ? stock.stockName
          : stock.stockCode,
        recommended_price: stock.currentPrice || 0,
        recommendation_grade: stock.recommendation?.grade || 'D',
        total_score: stock.totalScore || 0,

        // 기본 정보
        change_rate: stock.changeRate || 0,
        volume: stock.volume || 0,
        market_cap: stock.marketCap || 0,

        // ========================================
        // 거래량 기준 지표 (v3.30)
        // ========================================
        volume_ratio: parseFloat(volumeRatio.toFixed(2)) || 0,
        volume_acceleration_score: stock.momentumScore?.volumeAcceleration?.score || 0,
        volume_acceleration_trend: stock.momentumScore?.volumeAcceleration?.trend || null,
        asymmetric_ratio: stock.advancedAnalysis?.indicators?.asymmetric?.ratio || null,
        asymmetric_signal: stock.advancedAnalysis?.indicators?.asymmetric?.signal || null,
        obv_trend: stock.volumeAnalysis?.signals?.obvTrend || null,
        volume_5d_change_rate: stock.trendAnalysis?.volumeChange5d || null,

        // 고래 감지 상세
        whale_detected: hasBuyWhale,
        whale_confirmed: whaleConfirmed,
        whale_volume_ratio: hasBuyWhale ? parseFloat(whaleInfo.volumeRatio || 0) : null,
        whale_price_change: hasBuyWhale ? parseFloat(whaleInfo.priceChange || 0) : null,

        // ========================================
        // 시세 기준 지표 (v3.30)
        // ========================================
        mfi: stock.volumeAnalysis?.indicators?.mfi || null,
        rsi: stock.overheatingV2?.rsi || null,
        disparity: stock.overheatingV2?.disparity || null,
        vwap_divergence: vwapDivergence ? parseFloat(vwapDivergence.toFixed(2)) : null,
        consecutive_rise_days: stock.momentumScore?.consecutiveRise?.days || 0,
        escape_velocity: stock.advancedAnalysis?.indicators?.escape?.detected || false,
        escape_closing_strength: stock.advancedAnalysis?.indicators?.escape?.closingStrength || null,
        upper_shadow_ratio: upperShadowRatio ? parseFloat(upperShadowRatio.toFixed(2)) : null,

        // ========================================
        // 수급 기준 지표 (v3.30)
        // ========================================
        institution_buy_days: stock.institutionalFlow?.institution?.consecutiveBuyDays || 0,
        foreign_buy_days: stock.institutionalFlow?.foreign?.consecutiveBuyDays || 0,

        // ========================================
        // 복합 지표 (v3.30)
        // ========================================
        accumulation_detected: stock.advancedAnalysis?.indicators?.accumulation?.detected || false,
        vpd_score: stock.volumePriceDivergence?.divergenceScore || null,
        vpd_raw: stock.volumePriceDivergence?.divergence || null,

        // 점수 컴포넌트
        base_score: stock.radarScore?.baseScore || 0,
        whale_bonus: stock.radarScore?.whaleBonus || 0,
        momentum_score: stock.radarScore?.momentumScore?.totalScore || 0,
        trend_score: stock.radarScore?.trendScore?.totalScore || 0,

        is_active: true
      };
    });

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

    // v3.25: save 시점에 텔레그램 알림 (고래 상세 정보 포함)
    let tgSent = false;
    try {
      // 1. 내일 TOP 3 선정
      const saveTop3 = selectSaveTop3(stocks);
      console.log(`📱 TOP 3 후보: ${saveTop3.length}개 - ${saveTop3.map(s => s.stockName + '(' + s.totalScore + ')').join(', ')}`);

      // 2. 어제 추천 종목의 당일 성과 분석 (오늘 종가 기준)
      let morningResults = [];
      try {
        const yesterday = getYesterdayDateKST();
        const { data: yestStocks } = await supabase
          .from('screening_recommendations')
          .select('*')
          .eq('recommendation_date', yesterday)
          .eq('is_active', true);

        if (yestStocks && yestStocks.length > 0) {
          const yestTop3 = selectAlertTop3(yestStocks).slice(0, 3);

          for (const s of yestTop3) {
            let closingPrice = null;

            // 1차: 오늘 스크리닝 결과에서 일봉 종가 찾기
            const todayStock = stocks.find(t => t.stockCode === s.stock_code);
            if (todayStock && todayStock.chartData && todayStock.chartData[0]) {
              closingPrice = todayStock.chartData[0].close;
            }

            // 2차: 일봉 API로 오늘 종가 조회 (시간외가 제외)
            if (!closingPrice) {
              try {
                const chartData = await kisApi.getDailyChart(s.stock_code, 1);
                if (chartData && chartData[0] && chartData[0].close) {
                  closingPrice = chartData[0].close;
                }
              } catch (apiErr) {
                console.warn(`⚠️ 종가 조회 실패 (${s.stock_name}): ${apiErr.message}`);
              }
              await new Promise(r => setTimeout(r, 100)); // Rate limit
            }

            // 조회 실패 시 추천가 유지
            if (!closingPrice) closingPrice = s.recommended_price;

            const returnRate = ((closingPrice - s.recommended_price) / s.recommended_price) * 100;
            morningResults.push({
              stockName: s.stock_name,
              stockCode: s.stock_code,
              recommendPrice: s.recommended_price,
              closingPrice: closingPrice,
              returnRate: returnRate
            });
          }
          console.log(`📊 어제 추천 성과 분석: ${morningResults.length}개 완료 (오늘 종가 기준)`);
        }
      } catch (mErr) {
        console.warn('⚠️ 어제 추천 성과 분석 실패:', mErr.message);
      }

      // 3. 메시지 전송
      if (saveTop3.length > 0 || morningResults.length > 0) {
        const saveMsg = formatSaveAlertMessage(saveTop3, morningResults, today);
        tgSent = await sendTelegramMessage(saveMsg);
        console.log(`📱 텔레그램 알림: ${tgSent ? '성공' : '실패'} (TOP ${saveTop3.length}개)`);
      } else {
        console.log('📱 텔레그램: 전송할 내용 없음');
      }
    } catch (tgErr) {
      console.warn('⚠️ 텔레그램 알림 실패:', tgErr.message, tgErr.stack);
      tgSent = 'error: ' + tgErr.message;
    }

    return res.status(200).json({
      success: true,
      saved: data.length,
      date: today,
      grades: gradeStats,
      telegramSent: tgSent,
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
