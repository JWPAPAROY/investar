/**
 * 시장 레짐 판정 공용 모듈 (v3.94)
 *
 * save-daily-recommendations.js 안에만 있어서 웹 경로(screening.js selectTop3)가
 * 레짐/시총 플로어를 전혀 적용받지 못했다. 그 결과 텔레그램이 무픽인 날에도 웹은
 * 마이크로캡을 추천했다(2026-07-17 확인: 삼성공조 1,104억 / 파세코 1,606억).
 *
 * KOSPI 종가 시계열은 overnight_predictions.kospi_close 를 쓴다.
 * (kospi_close_change 는 신뢰하지 말 것 — CLAUDE.md 벤치마크 주의 참고)
 */

const supabase = require('./supabaseClient');

/**
 * 'momentum' | 'broad'
 *   broad   : 직전 10거래일 (KOSPI−KOSDAQ) 스프레드 < 0 AND KOSPI 누적 > 0 → 소형주 참여장 → 플로어 OFF
 *   momentum: 그 외 → 플로어 ON
 * v3.92: 하락장(kp≤0)의 spread<0은 위험회피이지 소형주 랠리가 아니므로 broad로 보지 않는다.
 * 데이터 부족/실패 시 'momentum'(보수적으로 플로어 ON).
 */
async function detectMarketRegime() {
  try {
    if (!supabase) return 'momentum';
    const { data } = await supabase
      .from('overnight_predictions')
      .select('prediction_date,kospi_close,kosdaq_close')
      .lt('prediction_date', '2027-01-01')
      .not('kospi_close', 'is', null)
      .not('kosdaq_close', 'is', null)
      .order('prediction_date', { ascending: false })
      .limit(11); // 최신 + 직전 10거래일
    if (!data || data.length < 6) return 'momentum';
    const latest = data[0], base = data[data.length - 1];
    const kp = (latest.kospi_close / base.kospi_close - 1) * 100;
    const kq = (latest.kosdaq_close / base.kosdaq_close - 1) * 100;
    const spread = kp - kq;
    const regime = (spread < 0 && kp > 0) ? 'broad' : 'momentum';
    console.log(`📐 레짐 탐지: KOSPI−KOSDAQ ${data.length - 1}일 스프레드 ${spread >= 0 ? '+' : ''}${spread.toFixed(1)}%p, KOSPI 누적 ${kp >= 0 ? '+' : ''}${kp.toFixed(1)}% → ${regime}${regime === 'momentum' && spread < 0 ? '(하락장 spread<0, broad 억제)' : ''}`);
    return regime;
  } catch (e) {
    console.warn('detectMarketRegime 실패, momentum fallback:', e.message);
    return 'momentum';
  }
}

module.exports = { detectMarketRegime };
