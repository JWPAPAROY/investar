/**
 * 장중 모멘텀 분석 API (v3.71)
 * GET /api/recommendations/momentum
 *
 * 최근 3거래일 TOP3 추천 종목의 실시간 모멘텀 분석
 * 장중 여러 번 호출 가능 (프론트엔드 성과 검증 탭용)
 */

const supabase = require('../../backend/supabaseClient');
const kisApi = require('../../backend/kisApi');
const { analyzeIntradayMomentum } = require('../../backend/momentumAnalyzer');

// KRX 휴장일 (save-daily-recommendations.js와 동일)
const KRX_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30',
  '2025-03-01', '2025-03-03', '2025-05-01', '2025-05-05', '2025-05-06',
  '2025-06-06', '2025-08-15', '2025-10-03', '2025-10-06', '2025-10-07',
  '2025-10-08', '2025-10-09', '2025-12-25',
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-03-02', '2026-05-01', '2026-05-05', '2026-05-25',
  '2026-08-17', '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25',
]);

function isTradingDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const day = utcDate.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !KRX_HOLIDAYS.has(dateStr);
}

function getTodayDateKST() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kstNow.toISOString().slice(0, 10);
}

function getCheckpointTime() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const kstMinutes = kstNow.getHours() * 60 + kstNow.getMinutes();
  // 10:00=600, 11:30=690, 13:30=810, 15:00=900
  if (kstMinutes >= 900) return 4;
  if (kstMinutes >= 810) return 3;
  if (kstMinutes >= 690) return 2;
  return 1;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const apiStart = Date.now();
    const today = getTodayDateKST();
    const trackTime = getCheckpointTime();
    const volumeColumn = `volume_t${trackTime}`;

    // KST 시간 정보
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const kstTimeStr = `${String(kstNow.getHours()).padStart(2, '0')}:${String(kstNow.getMinutes()).padStart(2, '0')}`;
    const kstHour = kstNow.getHours();
    const isMarketHours = kstHour >= 9 && kstHour < 16;

    // Step 1: 최근 3개 SAVE 날짜
    const { data: saveDateRows } = await supabase
      .from('screening_recommendations')
      .select('recommendation_date')
      .lt('recommendation_date', today)
      .order('recommendation_date', { ascending: false });

    const allDates = [...new Set((saveDateRows || []).map(r => r.recommendation_date))];
    const saveDates = allDates.filter(d => isTradingDay(d)).slice(0, 3);

    if (saveDates.length === 0) {
      return res.status(200).json({ success: false, message: 'No tracked data' });
    }

    // Step 2: 각 날짜별 TOP3 조회 + 현재가
    const MAX_RETRIES = 2;
    const priceCache = {};
    const dayResults = [];

    // KIS 토큰 준비
    try { await kisApi.getAccessToken(); } catch (e) {}

    for (let dayIdx = 0; dayIdx < saveDates.length; dayIdx++) {
      const saveDate = saveDates[dayIdx];

      const { data: savedStocks } = await supabase
        .from('screening_recommendations')
        .select('*')
        .eq('recommendation_date', saveDate)
        .eq('is_active', true)
        .order('total_score', { ascending: false });

      // TOP3 from DB
      const top3 = (savedStocks || [])
        .filter(s => s.is_top3)
        .sort((a, b) => (b.total_score || 0) - (a.total_score || 0))
        .slice(0, 3);

      if (top3.length === 0) continue;

      const stocks = [];
      for (const stock of top3) {
        let cached = priceCache[stock.stock_code];
        let currentPrice = cached?.price || 0;
        let volume = cached?.volume || 0;
        let high = cached?.high || 0;
        let low = cached?.low || 0;

        if (!currentPrice && isMarketHours) {
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const priceData = await kisApi.getCurrentPrice(stock.stock_code);
              if (priceData?.currentPrice) {
                currentPrice = priceData.currentPrice;
                volume = priceData.volume || 0;
                high = priceData.highPrice || 0;
                low = priceData.lowPrice || 0;
                priceCache[stock.stock_code] = { price: currentPrice, volume, high, low };
                break;
              }
            } catch (e) {
              if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500));
            }
          }
        }

        const returnRate = stock.recommended_price > 0 && currentPrice > 0
          ? ((currentPrice - stock.recommended_price) / stock.recommended_price * 100) : 0;

        stocks.push({
          stock_code: stock.stock_code,
          stock_name: stock.stock_name,
          recommendation_id: stock.id,
          recommended_price: stock.recommended_price,
          current_price: currentPrice || stock.recommended_price,
          return_rate: parseFloat(returnRate.toFixed(2)),
          volume,
          high,
          low,
          total_score: stock.total_score,
          recommendation_grade: stock.recommendation_grade,
          whale_detected: stock.whale_detected,
          recommendation_date: saveDate,
          day_label: `D-${dayIdx + 1}`,
        });
      }

      dayResults.push({ saveDate, dayLabel: `D-${dayIdx + 1}`, stocks });
    }

    // Step 3: 모멘텀 분석
    const allStocks = dayResults.flatMap(d => d.stocks);
    const allRecIds = allStocks.map(s => s.recommendation_id).filter(Boolean);

    if (allRecIds.length > 0 && isMarketHours) {
      // 전일 동시간대 거래량
      let prevVolumes = {};
      try {
        const { data: prevData } = await supabase
          .from('recommendation_daily_prices')
          .select(`recommendation_id, tracking_date, ${volumeColumn}, volume`)
          .in('recommendation_id', allRecIds)
          .lt('tracking_date', today)
          .order('tracking_date', { ascending: false });
        if (prevData) {
          for (const row of prevData) {
            if (prevVolumes[row.recommendation_id]) continue;
            prevVolumes[row.recommendation_id] = row[volumeColumn] || row.volume || 0;
          }
        }
      } catch (e) {}

      // 오늘 이전 체크포인트 거래량
      let todayCheckpoints = {};
      if (trackTime >= 2) {
        try {
          const cpColumns = [];
          for (let t = 1; t < trackTime; t++) cpColumns.push(`volume_t${t}`);
          const { data: cpData } = await supabase
            .from('recommendation_daily_prices')
            .select(`recommendation_id, ${cpColumns.join(', ')}`)
            .in('recommendation_id', allRecIds)
            .eq('tracking_date', today);
          if (cpData) {
            for (const row of cpData) {
              const vols = [];
              for (let t = 1; t < trackTime; t++) {
                vols.push(row[`volume_t${t}`] || 0);
              }
              todayCheckpoints[row.recommendation_id] = vols.filter(v => v > 0);
            }
          }
        } catch (e) {}
      }

      // 분봉 + 모멘텀 분석
      const minuteCache = {};
      for (const stock of allStocks) {
        let minuteData = minuteCache[stock.stock_code] || null;
        if (!minuteData && !(stock.stock_code in minuteCache)) {
          try {
            minuteData = await kisApi.getMinuteChart(stock.stock_code, '1');
          } catch (e) {}
          minuteCache[stock.stock_code] = minuteData;
        }

        const prevVol = prevVolumes[stock.recommendation_id] || 0;
        const cpVols = todayCheckpoints[stock.recommendation_id] || [];
        stock.momentum = analyzeIntradayMomentum(stock, prevVol, minuteData, cpVols);
      }
    }

    // 타임아웃 방지 체크
    const elapsed = Date.now() - apiStart;

    res.status(200).json({
      success: true,
      isMarketHours,
      checkpoint: trackTime,
      checkpointLabel: ['10:00', '11:30', '13:30', '15:00'][trackTime - 1],
      kstTime: kstTimeStr,
      days: dayResults,
      elapsed: `${(elapsed / 1000).toFixed(1)}s`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Momentum API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
