/**
 * 매일 추천 종목 자동 저장 & 알림 Cron (v3.32)
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
 * v3.32: 시장 심리 지수 계산
 * 지수 일봉(30일)에서 이격도, RSI, 추세 위치 분석
 * @param {Array} chartData - 지수 일봉 [{date, close, ...}] 내림차순
 * @returns {Object|null} - {score, grade, emoji, label, disparity, rsi}
 */
function calculateMarketSentiment(chartData) {
  if (!chartData || chartData.length < 20) return null;

  const closes = chartData.map(d => d.close);
  const current = closes[0];

  // 1. 20일 이격도
  const ma20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  const disparity = (current / ma20) * 100;
  let disparityScore = 0;
  if (disparity <= 95) disparityScore = -2;
  else if (disparity <= 98) disparityScore = -1;
  else if (disparity >= 105) disparityScore = 2;
  else if (disparity >= 102) disparityScore = 1;

  // 2. RSI(14)
  let gains = 0, losses = 0;
  for (let i = 0; i < 14 && i < closes.length - 1; i++) {
    const diff = closes[i] - closes[i + 1]; // 내림차순이므로 [i]가 최신
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = losses === 0 ? 100 : gains / losses;
  const rsi = 100 - (100 / (1 + rs));
  let rsiScore = 0;
  if (rsi <= 30) rsiScore = -2;
  else if (rsi <= 40) rsiScore = -1;
  else if (rsi >= 70) rsiScore = 2;
  else if (rsi >= 60) rsiScore = 1;

  // 3. 추세 위치 (가용 일수 기준 이동평균)
  let trendScore = 0;
  if (chartData.length >= 25) {
    const availableDays = Math.min(closes.length, 30);
    const maApprox = closes.slice(0, availableDays).reduce((a, b) => a + b, 0) / availableDays;
    const trendPosition = ((current - maApprox) / maApprox) * 100;
    if (trendPosition <= -10) trendScore = -2;
    else if (trendPosition <= -3) trendScore = -1;
    else if (trendPosition >= 10) trendScore = 2;
    else if (trendPosition >= 3) trendScore = 1;
  }

  const totalScore = disparityScore + rsiScore + trendScore; // -6 ~ +6

  // 등급 판정
  let grade, emoji, label;
  if (totalScore <= -3) { grade = 'fear'; emoji = '😱'; label = '공포'; }
  else if (totalScore <= -1) { grade = 'anxiety'; emoji = '😟'; label = '불안'; }
  else if (totalScore <= 1) { grade = 'neutral'; emoji = '😐'; label = '중립'; }
  else if (totalScore <= 3) { grade = 'optimism'; emoji = '😊'; label = '낙관'; }
  else { grade = 'extreme'; emoji = '🔥'; label = '과열'; }

  return {
    score: totalScore,
    grade, emoji, label,
    disparity: disparity.toFixed(1),
    rsi: rsi.toFixed(0)
  };
}

/**
 * v3.32: 시장 심리 지수 메시지 포맷
 * @param {Object} kospiSentiment - KOSPI 심리 지수
 * @param {Object} kosdaqSentiment - KOSDAQ 심리 지수
 * @returns {string} - 텔레그램 메시지 문자열
 */
function formatSentimentLine(kospiSentiment, kosdaqSentiment) {
  if (!kospiSentiment && !kosdaqSentiment) return '';

  let msg = `📊 <b>시장 심리</b>\n`;

  if (kospiSentiment) {
    msg += `  KOSPI ${kospiSentiment.emoji} ${kospiSentiment.label} (이격도 ${kospiSentiment.disparity} | RSI ${kospiSentiment.rsi})\n`;
  }
  if (kosdaqSentiment) {
    msg += `  KOSDAQ ${kosdaqSentiment.emoji} ${kosdaqSentiment.label} (이격도 ${kosdaqSentiment.disparity} | RSI ${kosdaqSentiment.rsi})\n`;
  }

  // 행동 가이드 (v3.33: 모멘텀 전략에 맞게 수정)
  const kGrade = kospiSentiment?.grade;
  const qGrade = kosdaqSentiment?.grade;

  // 모멘텀 전략: 상승 추세에 편승, 하락 추세에 손절
  if (kGrade === 'extreme' && qGrade === 'extreme') {
    msg += `  🚀 시장 상승 추세 - 추천 종목 적극 매수!\n`;
  } else if (kGrade === 'extreme' || qGrade === 'extreme') {
    msg += `  � 상승 추세 강세 - 추세 편승, 보유 유지\n`;
  } else if (kGrade === 'optimism' || qGrade === 'optimism') {
    msg += `  📈 상승 추세 지속 - 분할 매수 권장\n`;
  } else if (kGrade === 'fear' && qGrade === 'fear') {
    msg += `  � 시장 하락 추세 - 관망 권장, 손절 우선\n`;
  } else if (kGrade === 'fear' || qGrade === 'fear') {
    msg += `  ⚠️ 하락 추세 주의 - 손절 라인 준수\n`;
  } else if (kGrade === 'anxiety' || qGrade === 'anxiety') {
    msg += `  ⚠️ 변동성 확대 - 비중 축소 고려\n`;
  }

  return msg + `\n`;
}

/**
 * v3.32: 시장 태그 포맷 (종목명 옆에 표시)
 * @param {string} market - 'KOSPI' 또는 'KOSDAQ'
 * @returns {string} - '[코스피]' 또는 '[코스닥]' 또는 ''
 */
function formatMarketTag(market) {
  if (market === 'KOSPI') return '[KOSPI]';
  if (market === 'KOSDAQ') return '[KOSDAQ]';
  return '';
}

/**
 * v3.33: 종목명 표시용 유틸리티 (stock_name === stock_code 인 경우 걸러냄)
 * @param {Object} stock - stock_name, stockName, stock_code, stockCode 등 필드 포함
 * @returns {string} - 표시할 종목명
 */
function getDisplayName(stock) {
  const code = stock.stock_code || stock.stockCode || '';
  const candidates = [stock.stock_name, stock.stockName];
  for (const name of candidates) {
    if (name && name.trim() !== '' && name !== code && !name.startsWith('[')) {
      return name;
    }
  }
  return code || '미상장';
}

/**
 * v3.33: 종목 정보(종목명, 시장) 보완 통합 함수
 * 1단계: DB에서 이전 데이터 조회 (market 필터 없이)
 * 2단계: KIS API getCurrentPrice 호출
 * @param {Array} stocks - stock_code, stock_name, market 필드를 가진 배열
 */
async function supplementStockInfo(stocks) {
  if (!stocks || stocks.length === 0) return;

  // 보완이 필요한 종목 확인
  const needsFix = stocks.filter(s => {
    const code = s.stock_code || s.stockCode || '';
    const name = s.stock_name || s.stockName || '';
    return !name || name === code || name.startsWith('[') || !s.market;
  });

  if (needsFix.length === 0) {
    console.log('✅ 모든 종목 정보 정상');
    return;
  }

  console.log(`🔄 ${needsFix.length}개 종목 정보 보완 필요`);

  // 1단계: DB에서 이전 데이터 조회 (market 필터 제거!)
  try {
    const stockCodes = needsFix.map(s => s.stock_code || s.stockCode);
    const { data: prevData } = await supabase
      .from('screening_recommendations')
      .select('stock_code, stock_name, market')
      .in('stock_code', stockCodes)
      .order('recommendation_date', { ascending: false });

    if (prevData && prevData.length > 0) {
      // stock_name과 market을 별도로 추적
      const nameMap = {};   // code → 유효한 종목명
      const marketMap = {}; // code → 시장 구분
      prevData.forEach(d => {
        if (!nameMap[d.stock_code] && d.stock_name && d.stock_name !== d.stock_code && !d.stock_name.startsWith('[')) {
          nameMap[d.stock_code] = d.stock_name;
        }
        if (!marketMap[d.stock_code] && d.market) {
          marketMap[d.stock_code] = d.market;
        }
      });

      needsFix.forEach(s => {
        const code = s.stock_code || s.stockCode;
        // 종목명 보완
        const prevName = nameMap[code];
        const curName = s.stock_name || s.stockName || '';
        if (prevName && (!curName || curName === code || curName.startsWith('['))) {
          s.stock_name = prevName;
          if (s.stockName !== undefined) s.stockName = prevName;
          console.log(`  📦 DB [${code}] name → ${prevName}`);
        }
        // 시장 보완 (별도)
        if (!s.market && marketMap[code]) {
          s.market = marketMap[code];
          console.log(`  📦 DB [${code}] market → ${marketMap[code]}`);
        }
      });
    }
  } catch (e) {
    console.warn('⚠️ DB 보완 실패:', e.message);
  }

  // 2단계: 여전히 부족한 종목은 KIS API 호출
  const stillNeeds = stocks.filter(s => {
    const code = s.stock_code || s.stockCode || '';
    const name = s.stock_name || s.stockName || '';
    return !name || name === code || name.startsWith('[') || !s.market;
  });

  if (stillNeeds.length > 0) {
    console.log(`🔍 ${stillNeeds.length}개 종목 KIS API 조회 중...`);
    for (const s of stillNeeds) {
      const code = s.stock_code || s.stockCode;
      try {
        const info = await kisApi.getCurrentPrice(code);
        if (info) {
          console.log(`  🔍 API [${code}] → stockName=${info.stockName}, market=${info.market}`);
          const currentName = s.stock_name || s.stockName || '';
          if (info.stockName && info.stockName !== code && !info.stockName.startsWith('[')) {
            s.stock_name = info.stockName;
            if (s.stockName !== undefined) s.stockName = info.stockName;
            console.log(`  ✅ API [${code}] → ${info.stockName}`);
          }
          if (info.market && !s.market) {
            s.market = info.market;
            console.log(`  ✅ API [${code}] market → ${info.market}`);
          }
        } else {
          console.warn(`  ❌ API [${code}] → null 반환`);
        }
      } catch (e) {
        console.warn(`  ❌ API [${code}] 실패: ${e.message}`);
      }
    }
  }

  // 3단계: 여전히 이름 없는 종목은 getStockName 전용 API 호출
  const stillNoName = stocks.filter(s => {
    const code = s.stock_code || s.stockCode || '';
    const name = s.stock_name || s.stockName || '';
    return !name || name === code || name.startsWith('[');
  });

  if (stillNoName.length > 0) {
    console.log(`🔎 ${stillNoName.length}개 종목 getStockName 전용 조회 중...`);
    for (const s of stillNoName) {
      const code = s.stock_code || s.stockCode;
      try {
        const name = await kisApi.getStockName(code);
        if (name && name !== code && !name.startsWith('[')) {
          s.stock_name = name;
          if (s.stockName !== undefined) s.stockName = name;
          console.log(`  ✅ getStockName [${code}] → ${name}`);
        } else {
          console.warn(`  ❌ getStockName [${code}] → 유효한 이름 없음 (${name})`);
        }
      } catch (e) {
        console.warn(`  ❌ getStockName [${code}] 실패: ${e.message}`);
      }
    }
  }

  // 최종 결과 로그
  stocks.forEach(s => {
    const code = s.stock_code || s.stockCode;
    const name = s.stock_name || s.stockName;
    console.log(`  📌 최종 [${code}] name=${name} market=${s.market}`);
  });
}

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

  // v3.44: 매수고래 + 비과열 + 이격도/등락률 필터 (고래 임계값 완화로 별도 대안 불필요)
  const eligible = stocks.filter(s =>
    s.whale_detected &&
    s.recommendation_grade !== '과열' &&
    Math.abs(s.change_rate || 0) < 25 &&
    (s.disparity || 100) < 150
  );
  const top3 = [];

  const addFromRange = (lo, hi) => {
    const pool = eligible
      .filter(s => s.total_score >= lo && s.total_score <= hi && !top3.some(t => t.stock_code === s.stock_code))
      .sort((a, b) => b.total_score - a.total_score);
    for (const s of pool) {
      if (top3.length >= 3) break;
      top3.push(s);
    }
  };

  addFromRange(50, 69);   // 1순위: 스윗스팟
  addFromRange(80, 89);   // 2순위
  addFromRange(90, 100);  // 3순위
  addFromRange(70, 79);   // 4순위: 최후 보충

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

  // v3.44: 매수고래 + 비과열 + 이격도/등락률 필터 (고래 임계값 완화로 별도 대안 불필요)
  const eligible = stocks.filter(s => {
    const hasBuyWhale = (s.advancedAnalysis?.indicators?.whale || []).some(w => w.type?.includes('매수'));
    const isOverheated = s.recommendation?.grade === '과열';
    const disparity = s.overheatingV2?.disparity || 100;
    const changeRate = Math.abs(s.changeRate || 0);
    return hasBuyWhale && !isOverheated && changeRate < 25 && disparity < 150;
  });
  const top3 = [];

  const addFromRange = (lo, hi) => {
    const pool = eligible
      .filter(s => s.totalScore >= lo && s.totalScore <= hi && !top3.some(t => t.stockCode === s.stockCode))
      .sort((a, b) => b.totalScore - a.totalScore);
    for (const s of pool) {
      if (top3.length >= 3) break;
      top3.push(s);
    }
  };

  addFromRange(50, 69);   // 1순위: 스윗스팟
  addFromRange(80, 89);   // 2순위
  addFromRange(90, 100);  // 3순위
  addFromRange(70, 79);   // 4순위: 최후 보충

  return top3;
}

/**
 * v3.34: 방어 전략 TOP 3 선별 (SAVE용 - 스크리닝 결과 camelCase)
 * 기관/외국인 수급 기반, 과매도 반등 종목
 */
function selectDefenseSaveTop3(stocks) {
  if (!stocks || stocks.length === 0) return [];

  const isEligible = (s) => {
    // 기관 연속 매수일 계산
    let instDays = 0, foreignDays = 0;
    const flow = s.institutionalFlow;
    if (flow) {
      instDays = flow.institution?.consecutiveBuyDays || flow.institutionDays || 0;
      foreignDays = flow.foreign?.consecutiveBuyDays || flow.foreignDays || 0;
    }
    const hasSmartMoney = instDays >= 3 || foreignDays >= 3;
    const isNotCrashing = !s.crashCheck?.isCrashing;
    const isNotOverheated = s.recommendation?.grade !== '과열';
    const mcBillion = s.marketCap ? s.marketCap / 100000000 : 0;
    const hasMinMarketCap = mcBillion >= 5000; // 5000억+
    return hasSmartMoney && isNotCrashing && isNotOverheated && hasMinMarketCap;
  };

  const getDualBonus = (s) => {
    const flow = s.institutionalFlow;
    const instDays = flow?.institution?.consecutiveBuyDays || flow?.institutionDays || 0;
    const foreignDays = flow?.foreign?.consecutiveBuyDays || flow?.foreignDays || 0;
    if (instDays >= 2 && foreignDays >= 2) return true;
    return false;
  };

  const top3 = [];

  // 1순위: 쌍방수급 + 55-84점
  const p1 = stocks.filter(s => isEligible(s) && s.defenseScore >= 55 && s.defenseScore < 85 && getDualBonus(s))
    .sort((a, b) => b.defenseScore - a.defenseScore);
  top3.push(...p1.slice(0, 3));

  // 2순위: 55점+
  if (top3.length < 3) {
    const p2 = stocks.filter(s => isEligible(s) && s.defenseScore >= 55 && !top3.some(t => t.stockCode === s.stockCode))
      .sort((a, b) => b.defenseScore - a.defenseScore);
    top3.push(...p2.slice(0, 3 - top3.length));
  }

  // 3순위: 40점+
  if (top3.length < 3) {
    const p3 = stocks.filter(s => isEligible(s) && s.defenseScore >= 40 && !top3.some(t => t.stockCode === s.stockCode))
      .sort((a, b) => b.defenseScore - a.defenseScore);
    top3.push(...p3.slice(0, 3 - top3.length));
  }

  return top3;
}

/**
 * v3.34: 방어 전략 TOP 3 선별 (ALERT용 - DB snake_case)
 */
function selectDefenseAlertTop3(stocks) {
  if (!stocks || stocks.length === 0) return [];

  const isEligible = (s) => {
    const instDays = s.institution_buy_days || 0;
    const foreignDays = s.foreign_buy_days || 0;
    const hasSmartMoney = instDays >= 3 || foreignDays >= 3;
    const isNotOverheated = s.recommendation_grade !== '과열';
    const mcBillion = s.market_cap ? s.market_cap / 100000000 : 0;
    const hasMinMarketCap = mcBillion >= 5000;
    return hasSmartMoney && isNotOverheated && hasMinMarketCap;
  };

  const top3 = [];

  // 1순위: 쌍방수급 + 55-84점
  const p1 = stocks.filter(s => {
    const instDays = s.institution_buy_days || 0;
    const foreignDays = s.foreign_buy_days || 0;
    return isEligible(s) && s.defense_score >= 55 && s.defense_score < 85 && instDays >= 2 && foreignDays >= 2;
  }).sort((a, b) => b.defense_score - a.defense_score);
  top3.push(...p1.slice(0, 3));

  if (top3.length < 3) {
    const p2 = stocks.filter(s => isEligible(s) && s.defense_score >= 55 && !top3.some(t => t.stock_code === s.stock_code))
      .sort((a, b) => b.defense_score - a.defense_score);
    top3.push(...p2.slice(0, 3 - top3.length));
  }

  if (top3.length < 3) {
    const p3 = stocks.filter(s => isEligible(s) && s.defense_score >= 40 && !top3.some(t => t.stock_code === s.stock_code))
      .sort((a, b) => b.defense_score - a.defense_score);
    top3.push(...p3.slice(0, 3 - top3.length));
  }

  return top3;
}

/**
 * v3.34: 시장 공포 상태인지 확인 (KOSPI + KOSDAQ 모두 fear)
 */
function isMarketDefensive(sentiment) {
  if (!sentiment) return false;
  const kGrade = sentiment.kospi?.grade;
  const qGrade = sentiment.kosdaq?.grade;
  const bearish = ['fear', 'anxiety']; // 공포 + 불안
  // v3.34.2: 한쪽이라도 불안 이하면 방어 전략 표시 (공포까지 기다리면 너무 늦음)
  return bearish.includes(kGrade) || bearish.includes(qGrade);
}

/**
 * v3.43: DB에 저장된 is_top3/is_defense_top3 플래그 기반 TOP3 조회
 * 결산(save) 시점에 저장된 TOP3를 그대로 사용하여 불일치 방지
 * fallback: is_top3 미저장 시 기존 선별 로직 사용
 */
function getTop3FromDb(stocks, field = 'is_top3') {
  const dbTop3 = (stocks || [])
    .filter(s => s[field])
    .sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
  if (dbTop3.length > 0) return dbTop3.slice(0, 3);
  // fallback: is_top3 미저장 시 기존 로직
  return field === 'is_defense_top3'
    ? selectDefenseAlertTop3(stocks || [])
    : selectAlertTop3(stocks || []).slice(0, 3);
}

/**
 * v3.34: 방어 TOP 3 텔레그램 메시지 포맷 (공통)
 */
function formatDefenseTop3Section(defenseTop3, mode = 'save') {
  if (!defenseTop3 || defenseTop3.length === 0) return '';

  let msg = `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `🛡️ <b>방어 전략 TOP 3</b> (기관 수급 기반)\n\n`;

  defenseTop3.forEach((stock, i) => {
    const medal = ['🥇', '🥈', '🥉'][i];
    const isSave = mode === 'save';
    const price = isSave ? (stock.currentPrice || 0) : (stock.recommended_price || 0);
    const score = isSave ? (stock.defenseScore || 0) : (stock.defense_score || 0);
    const grade = isSave ? (stock.defenseGrade || 'D-D') : (stock.defense_grade || 'D-D');
    const mc = isSave ? (stock.marketCap || 0) : (stock.market_cap || 0);
    const mcBillion = mc / 100000000;

    // 손절 계산 (시총별 차등)
    const slWarning = mcBillion >= 50000 ? Math.floor(price * 0.96) : Math.floor(price * 0.97);
    const slExit = mcBillion >= 50000 ? Math.floor(price * 0.94) : Math.floor(price * 0.95);
    const slWarningPct = mcBillion >= 50000 ? '-4%' : '-3%';
    const slExitPct = mcBillion >= 50000 ? '-6%' : '-5%';

    const instDays = isSave
      ? (stock.institutionalFlow?.institutionDays || 0)
      : (stock.institution_buy_days || 0);
    const foreignDays = isSave
      ? (stock.institutionalFlow?.foreignDays || 0)
      : (stock.foreign_buy_days || 0);

    const marketTag = formatMarketTag(stock.market);
    const displayName = getDisplayName(stock);
    msg += `${medal} <b>${displayName}</b> ${marketTag} (${grade}, ${score.toFixed ? score.toFixed(0) : score}점)\n`;
    msg += `   💰 현재가: ${price.toLocaleString()}원\n`;
    msg += `   🛡️ 손절: ${slWarning.toLocaleString()}원(${slWarningPct}) / ${slExit.toLocaleString()}원(${slExitPct})\n`;
    msg += `   📊 기관 ${instDays}일 연속매수 | 외국인 ${foreignDays}일\n\n`;
  });

  return msg;
}

/**
 * v3.27: SAVE 메시지 (오후 16:10)
 * 🌆 오늘의 결산 (오전 추천 성과 + 내일 TOP 3)
 */
function formatSaveAlertMessage(nextTop3, morningResults, date, options = {}, defenseTop3 = []) {
  // 날짜 포맷: 2026-02-05 → 02/05
  const dateShort = date.slice(5).replace('-', '/');
  let msg = `🌆 <b>오늘의 결산</b> (${dateShort})\n`;

  // 장중 수동 결산 경고
  if (options.skipDbSave) {
    msg += `⚠️ <i>장중 데이터 (종가 미확정, DB 미저장)</i>\n`;
  }
  msg += `\n`;

  // v3.32: 시장 심리 지수
  if (options.sentiment) {
    msg += formatSentimentLine(options.sentiment.kospi, options.sentiment.kosdaq);
  }

  // ── 1. D-1 추천 종목의 오늘 성과 ──
  if (morningResults && morningResults.length > 0) {
    msg += `📊 <b>D-1 추천 종목의 오늘 성과</b>\n`;
    let winCount = 0;
    let totalReturn = 0;

    morningResults.forEach((stock, i) => {
      const medal = ['🥇', '🥈', '🥉'][i];
      const startPrice = stock.recommendedPrice || stock.recommendPrice || 0;
      const endPrice = stock.currentPrice || stock.closingPrice || 0;
      const r = stock.returnRate || 0;
      const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
      const emoji = r >= 0 ? '✅' : '❌';
      if (r >= 0) winCount++;
      totalReturn += r;

      const marketTag = formatMarketTag(stock.market);
      const displayName = getDisplayName(stock);
      msg += `  ${medal} ${displayName} ${marketTag}: ${startPrice.toLocaleString()} → ${endPrice.toLocaleString()}원 (${returnStr}) ${emoji}\n`;
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

      const marketTag = formatMarketTag(stock.market);
      const displayName = getDisplayName(stock);
      msg += `${medal} <b>${displayName}</b> ${marketTag} (${stock.totalScore || 0}점, ${gradeDisplay})\n`;
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
      } else if (stock.changeRate != null) {
        // cached 경로: trendAnalysis 없을 때 당일 등락률 표시
        const chg = stock.changeRate >= 0 ? `+${stock.changeRate.toFixed(1)}%` : `${stock.changeRate.toFixed(1)}%`;
        msg += `   📈 당일 등락: ${chg}\n`;
      }
      msg += `\n`;
    });
  }

  // v3.34: 방어 TOP 3 (시장 공포 시에만)
  if (defenseTop3 && defenseTop3.length > 0 && isMarketDefensive(options.sentiment)) {
    msg += formatDefenseTop3Section(defenseTop3, 'save');
  }

  return msg;
}

/**
 * v3.27: ALERT 메시지 (아침 08:30)
 * 🌅 오늘의 매수 전략 + 과거 추천 성과
 */
function formatAlertMessage(top3, whaleStocks, date, prevDayResults, sentiment = null, defenseTop3 = []) {
  // 날짜 포맷: 2026-02-05 → 02/05
  const dateShort = date.slice(5).replace('-', '/');
  let message = `🌅 <b>오늘의 매수 전략</b> (${dateShort})\n\n`;

  // v3.32: 시장 심리 지수
  if (sentiment) {
    message += formatSentimentLine(sentiment.kospi, sentiment.kosdaq);
  }

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

      const marketTag = formatMarketTag(stock.market);
      const displayName = getDisplayName(stock);
      message += `${medal} <b>${displayName}</b> ${marketTag} (${stock.stock_code})\n`;
      message += `   📊 ${(stock.total_score || 0).toFixed(0)}점 | ${grade}등급\n`;
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

    let totalWinAll = 0;
    let totalReturnAll = 0;
    let totalCountAll = 0;

    prevDayResults.forEach((day, dayIndex) => {
      // 날짜 포맷 (D-1, D-2, ...)
      const dayShort = day.date.slice(5).replace('-', '/');
      const daysAgo = `D-${dayIndex + 1}`;
      message += `📅 ${daysAgo}(${dayShort}) 추천\n`;

      // TOP 3만 표시 (최대 3개)
      const displayStocks = day.stocks.slice(0, 3);

      displayStocks.forEach((stock, i) => {
        const r = stock.latestReturn || 0;
        const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
        const emoji = r >= 0 ? '✅' : '❌';
        if (r >= 0) totalWinAll++;
        totalReturnAll += r;
        totalCountAll++;

        const marketTag = formatMarketTag(stock.market);
        const displayName = getDisplayName(stock);
        message += `  ${i + 1}. ${displayName} ${marketTag} → ${returnStr} ${emoji}\n`;
      });
      message += `\n`;
    });

    // 전체 요약
    if (totalCountAll > 0) {
      const avgReturnAll = totalReturnAll / totalCountAll;
      const winRateAll = (totalWinAll / totalCountAll * 100).toFixed(0);
      message += `📊 전체: 평균 ${avgReturnAll >= 0 ? '+' : ''}${avgReturnAll.toFixed(1)}% | 승률 ${winRateAll}% (${totalWinAll}/${totalCountAll})\n`;
    }
  }

  // v3.34: 방어 TOP 3 (시장 공포 시에만)
  if (defenseTop3 && defenseTop3.length > 0 && isMarketDefensive(sentiment)) {
    message += formatDefenseTop3Section(defenseTop3, 'alert');
  }

  return message;
}


/**
 * v3.30: TRACK 메시지 (장중 10:00/11:30/13:30/15:00)
 * 📊 3일치 주가 추적 + 익절/손절 시그널
 *
 * 시그널 기준:
 *   🎉대박: +20% 이상 (분할 매도 강력 권장)
 *   💰익절고려: +10% 이상 (절반 매도 고려)
 *   ⚠️주의: -3% ~ -5% (손절 임박)
 *   🚨손절: -5% 이하 (즉시 매도 권장)
 */
function getReturnSignal(r) {
  if (r >= 20) return '🎉대박';
  if (r >= 10) return '💰익절고려';
  if (r <= -5) return '🚨손절';
  if (r <= -3) return '⚠️주의';
  return r >= 0 ? '✅' : '❌';
}

function formatTrackMessage(dayResults, timeStr, sentiment = null) {
  let msg = `📊 <b>주가 추적</b> (${timeStr})\n\n`;

  // v3.32: 시장 심리 지수
  if (sentiment) {
    msg += formatSentimentLine(sentiment.kospi, sentiment.kosdaq);
  }

  let totalWin = 0;
  let totalReturn = 0;
  let totalValid = 0;
  let stopLossCount = 0;
  let takeProfitCount = 0;

  dayResults.forEach((day, dayIdx) => {
    const dateShort = day.alertDate.slice(5).replace('-', '/');
    const daysAgo = dayIdx === 0 ? '오늘' : `D-${dayIdx}`;
    msg += `📅 ${daysAgo}(${dateShort}) 추천\n`;

    day.stocks.forEach((stock, i) => {
      const r = stock.return_rate || 0;
      const signal = stock.current_price > 0 ? getReturnSignal(r) : '⚠️조회실패';

      if (stock.current_price > 0) {
        if (r >= 0) totalWin++;
        totalReturn += r;
        totalValid++;
        if (r <= -5) stopLossCount++;
        if (r >= 10) takeProfitCount++;
      }

      if (dayIdx === 0) {
        // 오늘 추천: 상세 표시
        const medal = ['🥇', '🥈', '🥉'][i];
        const gradeDisplay = stock.grade === '과열' ? '과열 ⚠️' : `${stock.grade || '?'}등급`;
        const recPrice = (stock.recommended_price || 0).toLocaleString();

        if (stock.current_price > 0) {
          const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
          const marketTag = formatMarketTag(stock.market);
          const displayName = getDisplayName(stock);
          msg += `${medal} <b>${displayName}</b> ${marketTag} (${gradeDisplay})\n`;
          msg += `   💰 ${recPrice} → ${stock.current_price.toLocaleString()}원 (${returnStr}) ${signal}\n`;
        } else {
          const marketTag = formatMarketTag(stock.market);
          const displayName = getDisplayName(stock);
          msg += `${medal} <b>${displayName}</b> ${marketTag} (${gradeDisplay})\n`;
          msg += `   💰 ${recPrice}원 → ⚠️ 조회실패\n`;
        }
      } else {
        // 이전 추천: 간결 표시
        const marketTag = formatMarketTag(stock.market);
        const displayName = getDisplayName(stock);
        if (stock.current_price > 0) {
          const returnStr = r >= 0 ? `+${r.toFixed(1)}%` : `${r.toFixed(1)}%`;
          msg += `  ${i + 1}. ${displayName} ${marketTag} → ${returnStr} ${signal}\n`;
        } else {
          msg += `  ${i + 1}. ${displayName} ${marketTag} → ⚠️ 조회실패\n`;
        }
      }
    });
    msg += `\n`;
  });

  // 전체 요약
  if (totalValid > 0) {
    const avgReturn = totalReturn / totalValid;
    const winRate = (totalWin / totalValid * 100).toFixed(0);
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📈 전체: 평균 ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(1)}% | 승률 ${winRate}% (${totalWin}/${totalValid})`;
    if (stopLossCount > 0 || takeProfitCount > 0) {
      msg += `\n🛡️`;
      if (stopLossCount > 0) msg += ` 손절(-5%) ${stopLossCount}개`;
      if (takeProfitCount > 0) msg += ` 💰 익절(+10%) ${takeProfitCount}개`;
    }
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
 * KRX 휴장일 목록 (2025-2026)
 * 주말은 vercel.json cron에서 이미 제외 (1-5), 여기서는 공휴일만 관리
 * 매년 초 KRX 휴장일 공지 확인 후 업데이트 필요
 */
const KRX_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', // 신정
  '2025-01-28', '2025-01-29', '2025-01-30', // 설 연휴
  '2025-03-01', // 삼일절
  '2025-03-03', // 삼일절 대체휴일
  '2025-05-01', // 근로자의 날
  '2025-05-05', // 어린이날
  '2025-05-06', // 부처님오신날
  '2025-06-06', // 현충일
  '2025-08-15', // 광복절
  '2025-10-03', // 개천절
  '2025-10-06', '2025-10-07', '2025-10-08', // 추석 연휴
  '2025-10-09', // 한글날
  '2025-12-25', // 크리스마스
  // 2026
  '2026-01-01', // 신정
  '2026-02-16', '2026-02-17', '2026-02-18', // 설 연휴
  '2026-03-02', // 삼일절 대체휴일
  '2026-05-01', // 근로자의 날
  '2026-05-05', // 어린이날
  '2026-05-25', // 부처님오신날
  '2026-08-17', // 광복절 대체휴일
  '2026-09-24', '2026-09-25', // 추석 연휴
  '2026-10-05', // 개천절 대체휴일
  '2026-10-09', // 한글날
  '2026-12-25', // 크리스마스
]);

function isKRXHoliday(dateStr) {
  return KRX_HOLIDAYS.has(dateStr);
}

/**
 * 거래일 여부 판별 (주말 + KRX 공휴일 제외)
 * v3.43: getUTCDay() 사용 — Vercel(UTC 서버)에서 getDay()는 로컬 타임존 기반이라
 *        KST +09:00 날짜가 UTC로 전날로 변환되어 요일이 틀려지는 버그 수정
 */
function isTradingDay(dateStr) {
  // dateStr은 'YYYY-MM-DD' 형태의 KST 날짜
  // UTC 자정으로 파싱하여 요일 판별 (KST 날짜 자체의 요일을 구하기 위함)
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const day = utcDate.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !KRX_HOLIDAYS.has(dateStr);
}

/**
 * 날짜 배열에서 거래일만 필터링
 */
function filterTradingDays(dates) {
  return dates.filter(d => isTradingDay(d));
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
  let mode = req.query.mode || 'save';

  // =============================================
  // 📱 WEBHOOK 모드: 텔레그램 명령어 처리
  // POST 요청이고 body에 텔레그램 메시지가 있으면 웹훅으로 판단
  // =============================================
  const isTelegramWebhook = req.method === 'POST' && req.body?.message?.text;

  if (mode === 'webhook' || isTelegramWebhook) {
    const update = req.body || {};
    const text = (update.message?.text || '').trim();
    const chatId = update.message?.chat?.id;
    console.log(`📱 Webhook 수신: "${text}" (chat: ${chatId})`);

    // 웹훅에서 호출됨을 표시 (save 모드에서 장중 DB 저장 방지용)
    req._fromWebhook = true;

    if (text.startsWith('/추적') || text.startsWith('/track')) {
      mode = 'track';
      await sendTelegramMessage('📤 /추적 명령어 접수! 처리 중...');
    } else if (text.startsWith('/알림') || text.startsWith('/alert')) {
      mode = 'alert';
      await sendTelegramMessage('📤 /알림 명령어 접수! 처리 중...');
    } else if (text.startsWith('/결산') || text.startsWith('/save')) {
      mode = 'save';
      await sendTelegramMessage('📤 /결산 명령어 접수! 처리 중...');
    } else {
      // /도움 또는 미인식 명령어 → 도움말 전송
      const helpMsg = `📱 <b>사용 가능한 명령어</b>\n\n`
        + `/추적 — 장중 주가 추적 (3일치)\n`
        + `/알림 — 오늘의 TOP 3 + 과거 성과\n`
        + `/결산 — 오늘의 결산 (종가 기준)\n`
        + `/도움 — 이 도움말`;
      await sendTelegramMessage(helpMsg);
      return res.status(200).json({ ok: true });
    }
  }

  // KRX 휴장일 체크 (cron 자동 실행만 차단, 웹훅 수동 명령은 허용)
  const todayKST = getTodayDateKST();
  if (!req._fromWebhook && isKRXHoliday(todayKST)) {
    console.log(`🏖️ 오늘(${todayKST})은 KRX 휴장일 — cron 건너뜀`);
    return res.status(200).json({
      success: true,
      message: `KRX holiday (${todayKST}) — skipped`,
      holiday: true
    });
  }

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

      const allSaveDates = filterTradingDays([...new Set((saveDateRows || []).map(r => r.recommendation_date))]);
      const latestSaveDate = allSaveDates[0];

      if (!latestSaveDate) {
        console.log('⚠️ 이전 거래일 SAVE 데이터 없음');
        return res.status(200).json({
          success: false,
          mode: 'alert',
          message: 'No previous save data'
        });
      }
      console.log(`📅 최근 SAVE 날짜 (거래일): ${latestSaveDate}`);

      const { data: savedStocks } = await supabase
        .from('screening_recommendations')
        .select('*')
        .eq('recommendation_date', latestSaveDate)
        .eq('is_active', true)
        .order('total_score', { ascending: false });

      // Step 2: TOP 3 선별 (모멘텀 + 방어) — DB is_top3 플래그 기반 (v3.43)
      const top3 = getTop3FromDb(savedStocks, 'is_top3');
      const defenseAlertTop3 = getTop3FromDb(savedStocks, 'is_defense_top3');
      console.log(`✅ TOP 3 선정: ${top3.length}개, 방어 TOP 3: ${defenseAlertTop3.length}개`);

      // v3.33: 종목 정보 보완 (통합 함수)
      await supplementStockInfo(top3);

      top3.forEach((s, i) => {
        console.log(`  TOP ${i + 1}. ${s.stock_name} (${s.total_score}점, 고래:${s.whale_detected})`);
      });

      // Step 3: 과거 추천 종목 성과 조회 (D-1의 SAVE 데이터부터)
      // SAVE날짜 → ALERT 전달일 매핑: SAVE 2/4 → ALERT 2/5, SAVE 2/3 → ALERT 2/4, ...
      let prevDayResults = []; // [{ date, alertDate, stocks: [...] }, ...]
      try {
        // 최근 추천일 찾기 (latestSaveDate 이전, 가격 업데이트 완료된 것만)
        const { data: prevDateRows } = await supabase
          .from('screening_recommendations')
          .select('recommendation_date')
          .lt('recommendation_date', latestSaveDate)
          .order('recommendation_date', { ascending: false });

        // 중복 날짜 제거 → 거래일만 필터 → 최근 3일
        const uniqueDates = filterTradingDays([...new Set((prevDateRows || []).map(r => r.recommendation_date))]).slice(0, 3);
        // ALERT 전달일 매핑: [latestSaveDate, uniqueDates[0], uniqueDates[1]]
        const alertDates = [latestSaveDate, ...uniqueDates.slice(0, -1)];
        console.log(`📅 이전 추천일(SAVE, 거래일): ${uniqueDates.join(', ') || '없음'}`);
        console.log(`📅 ALERT 전달일: ${alertDates.join(', ') || '없음'}`);

        for (let idx = 0; idx < uniqueDates.length; idx++) {
          const prevDate = uniqueDates[idx];
          // 해당 날짜 종목 조회
          const { data: prevStocks } = await supabase
            .from('screening_recommendations')
            .select('*')
            .eq('recommendation_date', prevDate)
            .eq('is_active', true)
            .order('total_score', { ascending: false });

          // TOP 3: DB is_top3 플래그 기반 (v3.43)
          const prevTop3 = getTop3FromDb(prevStocks, 'is_top3');
          if (prevTop3.length === 0) continue;

          // v3.33: 과거 추천 종목 정보 보완 (종목명 + 시장)
          await supplementStockInfo(prevTop3);

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

            // v3.43: DB 종가가 추천일과 같은 경우(= 다음날 가격 미업데이트) KIS API fallback
            if (priceDate === prevDate) {
              try {
                const priceInfo = await kisApi.getCurrentPrice(stock.stock_code);
                if (priceInfo?.currentPrice) {
                  latestPrice = priceInfo.currentPrice;
                  priceDate = today;
                  console.log(`  📈 ${stock.stock_name} 실시간가: ${latestPrice.toLocaleString()}원`);
                }
              } catch (e) {
                console.warn(`  ⚠️ ${stock.stock_name} 실시간가 조회 실패: ${e.message}`);
              }
            }

            const returnRate = ((latestPrice - stock.recommended_price) / stock.recommended_price) * 100;

            dayStocks.push({
              stock_name: stock.stock_name,
              stock_code: stock.stock_code,
              recommended_price: stock.recommended_price,
              latestPrice: latestPrice,
              latestReturn: returnRate,
              priceDate: priceDate,
              market: stock.market // v3.32 추가
            });
          }

          if (dayStocks.length > 0) {
            prevDayResults.push({ date: alertDates[idx], stocks: dayStocks });
          }
        }
        console.log(`✅ 이전 추천 결과: ${prevDayResults.length}일치 (실시간 현재가 반영)`);
      } catch (prevError) {
        console.warn('⚠️ 이전 추천 결과 조회 실패 (무시):', prevError.message);
      }

      // v3.32: 시장 심리 지수 조회
      let sentiment = null;
      try {
        const [kospiChart, kosdaqChart] = await Promise.all([
          kisApi.getIndexChart('0001', 30),
          kisApi.getIndexChart('1001', 30)
        ]);
        sentiment = {
          kospi: calculateMarketSentiment(kospiChart),
          kosdaq: calculateMarketSentiment(kosdaqChart)
        };
        console.log(`📊 시장 심리: KOSPI ${sentiment.kospi?.label || '?'}, KOSDAQ ${sentiment.kosdaq?.label || '?'}`);
      } catch (sentErr) {
        console.warn('⚠️ 시장 심리 지수 조회 실패:', sentErr.message);
      }

      // Step 5: 텔레그램 알림 전송
      const message = formatAlertMessage(top3, [], today, prevDayResults, sentiment, defenseAlertTop3);
      const sent = await sendTelegramMessage(message);

      return res.status(200).json({
        success: true,
        mode: 'alert',
        date: today,
        latestSaveDate,
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
    // v3.30: 3일치 추적 + 익절/손절 시그널
    // =============================================
    if (mode === 'track') {
      const now = new Date();
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstNow = new Date(now.getTime() + kstOffset);
      const kstTimeStr = `${String(kstNow.getHours()).padStart(2, '0')}:${String(kstNow.getMinutes()).padStart(2, '0')}`;
      console.log(`📊 주가 추적 모드 시작 (${kstTimeStr} KST)...`);

      const today = getTodayDateKST();

      // v3.32: 시장 정보 맵 로딩 로직을 전역 함수(getGlobalMarketMap)로 대체


      // Step 1: 최근 3개 SAVE 날짜 찾기
      const { data: saveDateRows } = await supabase
        .from('screening_recommendations')
        .select('recommendation_date')
        .lt('recommendation_date', today)
        .order('recommendation_date', { ascending: false });

      const saveDates = filterTradingDays([...new Set((saveDateRows || []).map(r => r.recommendation_date))]).slice(0, 3);

      if (saveDates.length === 0) {
        console.log('⚠️ 추적할 거래일 추천 데이터 없음');
        return res.status(200).json({ success: false, mode: 'track', message: 'No data to track' });
      }

      // ALERT 전달일 매핑 (SAVE 2/4 → ALERT 2/5)
      const alertDates = [today, ...saveDates.slice(0, -1)];

      // Step 2: 각 날짜별 TOP 3 선별 + 현재가 조회
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 1000;
      const priceCache = {}; // 중복 종목 API 호출 방지
      const dayResults = []; // [{ alertDate, stocks: [...] }, ...]

      for (let dayIdx = 0; dayIdx < saveDates.length; dayIdx++) {
        const saveDate = saveDates[dayIdx];

        const { data: savedStocks } = await supabase
          .from('screening_recommendations')
          .select('*')
          .eq('recommendation_date', saveDate)
          .eq('is_active', true)
          .order('total_score', { ascending: false });

        const top3 = getTop3FromDb(savedStocks, 'is_top3');
        if (top3.length === 0) continue;

        // v3.33: 종목 정보 보완 (통합 함수)
        await supplementStockInfo(top3);

        const stocks = [];
        for (const stock of top3) {
          let cached = priceCache[stock.stock_code];
          let currentPrice = cached?.price || 0;
          let marketInfo = stock.market || cached?.market;
          let stockName = stock.stock_name;

          // 캐시에 없으면 API 호출 (재시도 포함)
          if (!currentPrice) {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              try {
                const priceData = await kisApi.getCurrentPrice(stock.stock_code);
                if (priceData?.currentPrice) {
                  currentPrice = priceData.currentPrice;
                  marketInfo = marketInfo || priceData.market;
                  // v3.33: API 응답에서 종목명/시장 보완
                  if (priceData.stockName && (!stockName || stockName === stock.stock_code)) {
                    stockName = priceData.stockName;
                  }
                  if (priceData.market && !marketInfo) {
                    marketInfo = priceData.market;
                  }
                  priceCache[stock.stock_code] = { price: currentPrice, market: marketInfo, name: stockName };
                  break;
                }
              } catch (err) {
                console.warn(`⚠️ ${stockName} 조회 실패 (${attempt}/${MAX_RETRIES}): ${err.message}`);
              }
              if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY));
            }
          }

          // v3.33: API 실패 시 recommendation_daily_prices에서 종가 fallback
          if (!currentPrice && stock.id) {
            try {
              const { data: closingData } = await supabase
                .from('recommendation_daily_prices')
                .select('closing_price')
                .eq('recommendation_id', stock.id)
                .order('tracking_date', { ascending: false })
                .limit(1);
              if (closingData?.[0]?.closing_price) {
                currentPrice = closingData[0].closing_price;
                console.log(`📦 [${stockName}] 종가 fallback: ${currentPrice}원`);
              }
            } catch (e) { }
          }

          const returnRate = (stock.recommended_price > 0 && currentPrice > 0)
            ? ((currentPrice - stock.recommended_price) / stock.recommended_price * 100)
            : 0;

          stocks.push({
            stock_name: stockName,
            stock_code: stock.stock_code,
            recommended_price: stock.recommended_price,
            current_price: currentPrice,
            return_rate: returnRate,
            grade: stock.recommendation_grade,
            market: marketInfo // v3.32 수정
          });
        }

        dayResults.push({ alertDate: alertDates[dayIdx], stocks });
      }

      // v3.32: 시장 심리 지수 조회
      let sentiment = null;
      try {
        const [kospiChart, kosdaqChart] = await Promise.all([
          kisApi.getIndexChart('0001', 30),
          kisApi.getIndexChart('1001', 30)
        ]);
        sentiment = {
          kospi: calculateMarketSentiment(kospiChart),
          kosdaq: calculateMarketSentiment(kosdaqChart)
        };
        console.log(`📊 시장 심리: KOSPI ${sentiment.kospi?.label || '?'}, KOSDAQ ${sentiment.kosdaq?.label || '?'}`);
      } catch (sentErr) {
        console.warn('⚠️ 시장 심리 지수 조회 실패:', sentErr.message);
      }

      // Step 3: 메시지 포맷 및 전송
      const trackMsg = formatTrackMessage(dayResults, kstTimeStr, sentiment);
      const sent = await sendTelegramMessage(trackMsg);

      return res.status(200).json({
        success: true,
        mode: 'track',
        time: kstTimeStr,
        telegramSent: sent,
        days: dayResults.map(d => ({
          date: d.alertDate,
          stocks: d.stocks.map(s => ({
            name: s.stock_name,
            return: s.return_rate.toFixed(1) + '%'
          }))
        }))
      });
    }

    // =============================================
    // 💾 SAVE 모드: 저장 (16:10 KST) - 기존 로직
    // =============================================
    // 장중 여부 체크 (KST 15:30 이전 = 장중)
    const saveNow = new Date();
    const saveKstHour = (saveNow.getUTCHours() + 9) % 24;
    const saveKstMin = saveNow.getUTCMinutes();
    const isFromWebhook = req._fromWebhook || false;
    const isMarketOpen = saveKstHour >= 9 && (saveKstHour < 15 || (saveKstHour === 15 && saveKstMin < 30));
    const skipDbSave = isFromWebhook && isMarketOpen;

    if (skipDbSave) {
      console.log('📱 수동 결산 (장중) - DB 저장 건너뜀, 메시지만 전송');
    }
    console.log('💾 저장 모드 시작...');

    // v3.33: 오늘 데이터가 이미 있으면 재스크리닝 없이 빠른 반환
    // 자정~장 시작 전(00:00-09:00)에는 전날 데이터도 허용
    let today = new Date().toISOString().slice(0, 10);
    const isBeforeMarketOpen = saveKstHour < 9; // 09:00 KST 이전

    let existingData = null;
    const { data: todayData } = await supabase
      .from('screening_recommendations')
      .select('*')
      .eq('recommendation_date', today)
      .eq('is_active', true)
      .order('total_score', { ascending: false });

    if (todayData && todayData.length > 0) {
      existingData = todayData;
    } else if (isBeforeMarketOpen) {
      // 장 시작 전이고 오늘 데이터가 없으면 전날 데이터 조회
      console.log('🌙 장 시작 전 - 전날 데이터 조회 시도...');
      const { data: prevDateRows } = await supabase
        .from('screening_recommendations')
        .select('recommendation_date')
        .order('recommendation_date', { ascending: false })
        .limit(1);

      if (prevDateRows && prevDateRows.length > 0) {
        const prevDate = prevDateRows[0].recommendation_date;
        const { data: prevData } = await supabase
          .from('screening_recommendations')
          .select('*')
          .eq('recommendation_date', prevDate)
          .eq('is_active', true)
          .order('total_score', { ascending: false });

        if (prevData && prevData.length > 0) {
          existingData = prevData;
          today = prevDate; // 메시지에 표시할 날짜도 전날로 변경
          console.log(`⚡ 전날 데이터 사용 (${prevDate}, ${prevData.length}개)`);
        }
      }
    }

    if (existingData && existingData.length > 0 && !skipDbSave) {
      console.log(`⚡ 기존 결산 데이터 발견 (${existingData.length}개) - 재스크리닝 건너뜀`);

      // 기존 데이터로 메시지 생성 — DB is_top3 플래그 기반 (v3.43)
      const top3ForAlert = getTop3FromDb(existingData, 'is_top3');

      // v3.33: 종목 정보 보완 (통합 함수)
      await supplementStockInfo(top3ForAlert);

      // D-1 추천 종목의 오늘 성과 (이전 SAVE 데이터에서 조회 — ALERT 모드와 동일 로직)
      let morningResults = [];
      try {
        const { data: prevSaveDateRows } = await supabase
          .from('screening_recommendations')
          .select('recommendation_date')
          .lt('recommendation_date', today)
          .order('recommendation_date', { ascending: false });

        const prevSaveDate = filterTradingDays([...new Set((prevSaveDateRows || []).map(r => r.recommendation_date))])[0];

        if (prevSaveDate) {
          console.log(`📅 D-1 추천일 (거래일): ${prevSaveDate}`);
          const { data: prevStocks } = await supabase
            .from('screening_recommendations')
            .select('*')
            .eq('recommendation_date', prevSaveDate)
            .eq('is_active', true)
            .order('total_score', { ascending: false });

          const prevTop3 = getTop3FromDb(prevStocks, 'is_top3');
          await supplementStockInfo(prevTop3);

          for (const s of prevTop3) {
            let currentPrice = 0;
            let stockName = s.stock_name;
            let marketInfo = s.market;

            // 1차: API 호출
            try {
              const priceData = await kisApi.getCurrentPrice(s.stock_code);
              if (priceData?.currentPrice) {
                currentPrice = priceData.currentPrice;
                if (priceData.stockName && (!stockName || stockName === s.stock_code)) {
                  stockName = priceData.stockName;
                }
                if (priceData.market && !marketInfo) {
                  marketInfo = priceData.market;
                }
              }
            } catch (e) { }

            // 2차: recommendation_daily_prices fallback
            if (!currentPrice && s.id) {
              try {
                const { data: closingData } = await supabase
                  .from('recommendation_daily_prices')
                  .select('closing_price')
                  .eq('recommendation_id', s.id)
                  .order('tracking_date', { ascending: false })
                  .limit(1);
                if (closingData?.[0]?.closing_price) {
                  currentPrice = closingData[0].closing_price;
                }
              } catch (e) { }
            }

            if (currentPrice > 0) {
              const returnRate = ((currentPrice - s.recommended_price) / s.recommended_price) * 100;
              morningResults.push({
                stockName: stockName,
                stockCode: s.stock_code,
                recommendedPrice: s.recommended_price,
                currentPrice: currentPrice,
                returnRate: returnRate,
                market: marketInfo
              });
            }
          }
          console.log(`📊 D-1(${prevSaveDate}) 추천 성과: ${morningResults.length}개`);
        } else {
          console.log('⚠️ 이전 SAVE 데이터 없음 - 성과 섹션 건너뜀');
        }
      } catch (e) {
        console.warn('⚠️ D-1 성과 조회 실패:', e.message);
      }

      // 시장 심리 지수
      let sentiment = null;
      try {
        const [kospiChart, kosdaqChart] = await Promise.all([
          kisApi.getIndexChart('0001', 30),
          kisApi.getIndexChart('1001', 30)
        ]);
        sentiment = {
          kospi: calculateMarketSentiment(kospiChart),
          kosdaq: calculateMarketSentiment(kosdaqChart)
        };
      } catch (e) { }

      // TOP3 종목의 최근 주가 데이터 조회 (KIS 차트 API, 3건)
      const top3DailyPrices = {};
      try {
        for (const s of top3ForAlert) {
          await new Promise(r => setTimeout(r, 200)); // Rate limit
          const chartData = await kisApi.getDailyChart(s.stock_code, 5);
          if (chartData && chartData.length >= 2) {
            top3DailyPrices[s.stock_code] = chartData.slice(0, 3).map((d, i) => {
              const prev = chartData[i + 1];
              const priceChange = prev ? ((d.close - prev.close) / prev.close * 100) : 0;
              return {
                date: d.date,
                close: d.close,
                priceChange: parseFloat(priceChange.toFixed(1))
              };
            });
          }
        }
      } catch (e) {
        console.warn('⚠️ TOP3 최근주가 조회 실패:', e.message);
      }

      // 메시지 생성 (nextTop3 = 기존 top3, DB 필드로 구성)
      const nextTop3 = top3ForAlert.map(s => ({
        stockCode: s.stock_code,
        stockName: s.stock_name,
        market: s.market,
        totalScore: s.total_score,
        currentPrice: s.recommended_price,
        recommendation: { grade: s.recommendation_grade },
        changeRate: s.change_rate,
        trendAnalysis: {
          dailyData: top3DailyPrices[s.stock_code] || []
        },
        // 점수 내역 (DB 필드 기반)
        radarScore: {
          baseScore: s.base_score || 0,
          whaleBonus: s.whale_bonus || 0,
          momentumScore: { totalScore: s.momentum_score || 0 },
          trendScore: { totalScore: s.trend_score || 0 }
        },
        scoreBreakdown: {
          signalAdjustments: {
            escapeVelocityBonus: s.escape_velocity ? 5 : 0,
            upperShadowPenalty: 0,
            sellWhalePenalty: s.signal_adjustment ? s.signal_adjustment - (s.escape_velocity ? 5 : 0) : 0
          }
        }
      }));

      // v3.34: 방어 TOP 3도 cached 경로에서 선별 — DB 플래그 기반 (v3.43)
      const defenseAlertTop3 = getTop3FromDb(existingData, 'is_defense_top3');
      const message = formatSaveAlertMessage(nextTop3, morningResults, today, { sentiment }, defenseAlertTop3);
      const sent = await sendTelegramMessage(message);

      return res.status(200).json({
        success: true,
        mode: 'save',
        cached: true, // 캐시 사용 여부 표시
        date: today,
        existingCount: existingData.length,
        top3Count: top3ForAlert.length,
        telegramSent: sent
      });
    }

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

    // Step 2: 저장 구간(50점+) 필터링 — v3.35: 상한 제거 (90점+ TOP3도 저장)
    const filteredStocks = stocks.filter(stock => {
      return stock.totalScore >= 50;
    });

    console.log(`✅ 스크리닝 완료: ${stocks.length}개 중 ${filteredStocks.length}개 (저장 구간 50점+)`);

    if (filteredStocks.length === 0) {
      return res.status(200).json({
        success: true,
        saved: 0,
        message: 'No B+ grade stocks found'
      });
    }

    // Step 3: Supabase에 저장 (today는 위에서 이미 선언됨)

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
        recommended_price: stock.chartData?.[0]?.close || stock.currentPrice || 0,
        recommendation_grade: stock.recommendation?.grade || 'D',
        total_score: stock.totalScore || 0,
        market: stock.market || null, // v3.32: 시장 구분 (KOSPI/KOSDAQ)

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
        institution_buy_days: stock.institutionalFlow?.institutionDays || 0,
        foreign_buy_days: stock.institutionalFlow?.foreignDays || 0,

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
        signal_adjustment: (stock.scoreBreakdown?.signalAdjustments?.escapeVelocityBonus || 0)
          + (stock.scoreBreakdown?.signalAdjustments?.upperShadowPenalty || 0)
          + (stock.scoreBreakdown?.signalAdjustments?.sellWhalePenalty || 0),

        // v3.34: 방어 전략
        defense_score: stock.defenseScore || 0,
        defense_grade: stock.defenseGrade || 'D-D',

        // v3.36: 스코어링 v2 병렬 비교
        total_score_v2: stock.totalScoreV2 || 0,

        is_active: true,
        is_top3: false,
        is_defense_top3: false,
        is_top3_v2: false
      };
    });

    // v3.35: TOP3 선별 후 DB 저장 전에 마킹
    const saveTop3Codes = selectSaveTop3(stocks).slice(0, 3).map(s => s.stockCode);
    const defSaveTop3Codes = selectDefenseSaveTop3(stocks).slice(0, 3).map(s => s.stockCode);

    // v3.37: v2 TOP3 선별 (Supply 기반 필터 — 기관/외국인 수급 + v2 총점)
    const v2Top3Codes = stocks
      .filter(s => {
        const isOverheated = s.recommendation?.grade === '과열';
        if (isOverheated) return false;
        // v2 핵심: 기관 OR 외국인 1일 이상 매수, 또는 매수고래 존재
        const instDays = s.institutionalFlow?.institutionDays || 0;
        const foreignDays = s.institutionalFlow?.foreignDays || 0;
        const hasBuyWhale = (s.advancedAnalysis?.indicators?.whale || []).some(w => w.type?.includes('매수'));
        return (instDays >= 1 || foreignDays >= 1 || hasBuyWhale);
      })
      .sort((a, b) => (b.totalScoreV2 || 0) - (a.totalScoreV2 || 0))
      .slice(0, 3)
      .map(s => s.stockCode);

    for (const rec of recommendations) {
      if (saveTop3Codes.includes(rec.stock_code)) rec.is_top3 = true;
      if (defSaveTop3Codes.includes(rec.stock_code)) rec.is_defense_top3 = true;
      if (v2Top3Codes.includes(rec.stock_code)) rec.is_top3_v2 = true;
    }

    // 장중 수동 결산 시 DB 저장 건너뜀
    let data = recommendations; // skipDbSave 시 recommendations를 data로 사용
    if (!skipDbSave) {
      const { data: savedData, error } = await supabase
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

      data = savedData;
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
    } else {
      console.log(`⏭️ DB 저장 건너뜀 (장중 수동 결산) - ${recommendations.length}개 종목`);
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
      // 1. 내일 TOP 3 선정 (모멘텀 + 방어)
      const saveTop3 = selectSaveTop3(stocks);
      const defenseTop3 = selectDefenseSaveTop3(stocks);
      console.log(`📱 TOP 3 후보: ${saveTop3.length}개 - ${saveTop3.map(s => s.stockName + '(' + s.totalScore + ')').join(', ')}`);
      console.log(`🛡️ 방어 TOP 3: ${defenseTop3.length}개 - ${defenseTop3.map(s => s.stockName + '(' + s.defenseScore + ')').join(', ')}`);

      // 2. 전 거래일 추천 종목의 당일 성과 분석 (오늘 종가 기준)
      // v3.31: 주말/휴일에도 정상 동작하도록 가장 최근 SAVE 날짜 조회 (ALERT 모드와 동일)
      let morningResults = [];
      try {
        const { data: prevSaveDateRows } = await supabase
          .from('screening_recommendations')
          .select('recommendation_date')
          .lt('recommendation_date', today)
          .order('recommendation_date', { ascending: false });

        const latestSaveDate = filterTradingDays([...new Set((prevSaveDateRows || []).map(r => r.recommendation_date))])[0];

        if (!latestSaveDate) {
          console.log('⚠️ 이전 거래일 SAVE 데이터 없음 - 성과 분석 건너뜀');
        }

        const { data: yestStocks } = latestSaveDate ? await supabase
          .from('screening_recommendations')
          .select('*')
          .eq('recommendation_date', latestSaveDate)
          .eq('is_active', true) : { data: null };

        if (yestStocks && yestStocks.length > 0) {
          const yestTop3 = getTop3FromDb(yestStocks, 'is_top3');

          // v3.33: 종목 정보 보완 (통합 함수)
          await supplementStockInfo(yestTop3);

          for (const s of yestTop3) {
            let closingPrice = null;
            const MAX_RETRIES = 3;
            const RETRY_DELAY = 500;

            // 1차: 오늘 스크리닝 결과에서 일봉 종가 찾기
            const todayStock = stocks.find(t => t.stockCode === s.stock_code);
            if (todayStock && todayStock.chartData && todayStock.chartData[0]) {
              closingPrice = todayStock.chartData[0].close;
            }

            // 2차: 일봉 API로 오늘 종가 조회 (3회 재시도)
            if (!closingPrice) {
              for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                  const chartData = await kisApi.getDailyChart(s.stock_code, 1);
                  if (chartData && chartData[0] && chartData[0].close) {
                    closingPrice = chartData[0].close;
                    console.log(`  ✓ ${s.stock_name} 일봉 종가: ${closingPrice.toLocaleString()}원`);
                    break;
                  }
                } catch (apiErr) {
                  console.warn(`⚠️ 일봉 조회 실패 (${s.stock_name}) ${attempt}/${MAX_RETRIES}: ${apiErr.message}`);
                }
                if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY));
              }
            }

            // 3차: 현재가 API로 종가 조회 (3회 재시도)
            if (!closingPrice) {
              for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                  const priceData = await kisApi.getCurrentPrice(s.stock_code);
                  if (priceData && priceData.currentPrice) {
                    closingPrice = priceData.currentPrice;
                    console.log(`  ✓ ${s.stock_name} 현재가 API: ${closingPrice.toLocaleString()}원`);
                    break;
                  }
                } catch (apiErr2) {
                  console.warn(`⚠️ 현재가 조회 실패 (${s.stock_name}) ${attempt}/${MAX_RETRIES}: ${apiErr2.message}`);
                }
                if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY));
              }
            }

            // 조회 실패 시 추천가 유지 + 경고
            if (!closingPrice) {
              closingPrice = s.recommended_price;
              console.warn(`⚠️ ${s.stock_name} 종가 조회 최종 실패 - 추천가 유지: ${closingPrice.toLocaleString()}원`);
            }

            const returnRate = ((closingPrice - s.recommended_price) / s.recommended_price) * 100;
            morningResults.push({
              stockName: s.stock_name,
              stockCode: s.stock_code,
              recommendPrice: s.recommended_price,
              closingPrice: closingPrice,
              returnRate: returnRate,
              market: s.market  // v3.33: 시장 태그
            });
          }
          console.log(`📊 어제 추천 성과 분석: ${morningResults.length}개 완료 (오늘 종가 기준)`);
        }
      } catch (mErr) {
        console.warn('⚠️ 어제 추천 성과 분석 실패:', mErr.message);
      }

      // v3.32: 시장 심리 지수 조회
      let sentiment = null;
      try {
        const [kospiChart, kosdaqChart] = await Promise.all([
          kisApi.getIndexChart('0001', 30),
          kisApi.getIndexChart('1001', 30)
        ]);
        sentiment = {
          kospi: calculateMarketSentiment(kospiChart),
          kosdaq: calculateMarketSentiment(kosdaqChart)
        };
        console.log(`📊 시장 심리: KOSPI ${sentiment.kospi?.label || '?'}, KOSDAQ ${sentiment.kosdaq?.label || '?'}`);
      } catch (sentErr) {
        console.warn('⚠️ 시장 심리 지수 조회 실패:', sentErr.message);
      }

      // 3. 메시지 전송
      if (saveTop3.length > 0 || morningResults.length > 0) {
        const saveMsg = formatSaveAlertMessage(saveTop3, morningResults, today, { skipDbSave, sentiment }, defenseTop3);
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
      saved: skipDbSave ? 0 : data.length,
      skippedDbSave: skipDbSave,
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

    // v3.33: 에러 발생 시 텔레그램으로 에러 메시지 전송
    try {
      await sendTelegramMessage(`❌ 처리 중 오류 발생\n원인: ${error.message}\n\n다시 시도해주세요.`);
    } catch (e) { }

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
