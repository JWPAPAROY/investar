/**
 * 해외 예측 백필 스크립트
 * 최근 30 거래일치 해외 지수 히스토리 → overnight_predictions 테이블 채우기
 * Yahoo Finance chart API (무료)를 사용하여 과거 데이터 수집
 *
 * Usage: node scripts/backfill-overnight-predictions.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const DEFAULT_WEIGHTS = {
  '^GSPC':     { name: 'S&P 500',    weight: +0.25 },
  '^IXIC':     { name: 'NASDAQ',     weight: +0.20 },
  '^SOX':      { name: 'SOX 반도체',  weight: +0.12 },
  '^VIX':      { name: 'VIX 공포',    weight: -0.10 },
  '^DJI':      { name: '다우존스',     weight: +0.08 },
  'USDKRW=X':  { name: '달러/원',     weight: -0.08 },
  '^TNX':      { name: '미국10년물',   weight: -0.07 },
  '^N225':     { name: '닛케이',      weight: +0.05 },
  'CL=F':      { name: 'WTI 원유',    weight: +0.03 },
  'DX-Y.NYB':  { name: '달러인덱스',   weight: -0.02 },
};

const SIGNAL_TABLE = [
  { min:  0.5, signal: 'strong_bullish', emoji: '🟢🟢', label: '강한 상승' },
  { min:  0.2, signal: 'mild_bullish',   emoji: '🟢',   label: '약한 상승' },
  { min: -0.2, signal: 'neutral',        emoji: '⚪',   label: '중립' },
  { min: -0.5, signal: 'mild_bearish',   emoji: '🔴',   label: '약한 하락' },
  { min: -Infinity, signal: 'strong_bearish', emoji: '🔴🔴', label: '강한 하락' },
];

/**
 * Yahoo Finance chart API로 과거 데이터 가져오기
 * @param {string} symbol - 티커 (e.g. '^GSPC')
 * @param {number} days - 과거 일수
 * @returns {Array} [{ date: 'YYYY-MM-DD', close }]
 */
function fetchHistory(symbol, days = 50) {
  return new Promise((resolve, reject) => {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - days * 24 * 60 * 60;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;

    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) { resolve([]); return; }

          const timestamps = result.timestamp || [];
          const closes = result.indicators?.quote?.[0]?.close || [];
          const opens = result.indicators?.quote?.[0]?.open || [];

          const history = [];
          for (let i = 0; i < timestamps.length; i++) {
            if (closes[i] == null) continue;
            const d = new Date(timestamps[i] * 1000);
            const dateStr = d.toISOString().slice(0, 10);
            history.push({ date: dateStr, close: closes[i], open: opens[i] || closes[i] });
          }
          resolve(history);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('📊 해외 예측 백필 시작...\n');

  // 1. 모든 해외 지수 히스토리 가져오기
  const tickers = Object.keys(DEFAULT_WEIGHTS);
  const allHistory = {};

  for (const ticker of tickers) {
    try {
      const data = await fetchHistory(ticker, 50);
      allHistory[ticker] = data;
      console.log(`  ✅ ${ticker} (${DEFAULT_WEIGHTS[ticker].name}): ${data.length}일`);
    } catch (err) {
      console.warn(`  ⚠️ ${ticker}: ${err.message}`);
      allHistory[ticker] = [];
    }
    await sleep(300); // rate limit
  }

  // 2. KOSPI, KOSDAQ 히스토리 (실제 결과용)
  let kospiHistory = [], kosdaqHistory = [];
  try {
    kospiHistory = await fetchHistory('^KS11', 50);
    console.log(`  ✅ KOSPI: ${kospiHistory.length}일`);
  } catch (e) { console.warn('  ⚠️ KOSPI:', e.message); }
  await sleep(300);

  try {
    kosdaqHistory = await fetchHistory('^KQ11', 50);
    console.log(`  ✅ KOSDAQ: ${kosdaqHistory.length}일`);
  } catch (e) { console.warn('  ⚠️ KOSDAQ:', e.message); }

  // 날짜→데이터 맵
  const kospiByDate = {};
  kospiHistory.forEach(d => { kospiByDate[d.date] = d; });
  const kosdaqByDate = {};
  kosdaqHistory.forEach(d => { kosdaqByDate[d.date] = d; });

  const tickerByDate = {};
  for (const ticker of tickers) {
    tickerByDate[ticker] = {};
    allHistory[ticker].forEach(d => { tickerByDate[ticker][d.date] = d; });
  }

  // 3. S&P 500 거래일 기준 날짜 목록
  const spDates = allHistory['^GSPC'].map(d => d.date);

  console.log(`\n📈 ${spDates.length - 1}개 거래일 처리 중...\n`);

  const records = [];

  for (let i = 1; i < spDates.length; i++) {
    const prevDate = spDates[i - 1];
    const currDate = spDates[i];

    // 해외 지수 변동률 계산
    const factors = [];
    let score = 0;

    for (const [ticker, config] of Object.entries(DEFAULT_WEIGHTS)) {
      const curr = tickerByDate[ticker]?.[currDate];
      const prev = tickerByDate[ticker]?.[prevDate];

      if (!curr || !prev || !prev.close) {
        factors.push({
          name: config.name, ticker,
          change: 0, weight: config.weight, contribution: 0,
        });
        continue;
      }

      const change = ((curr.close - prev.close) / prev.close) * 100;
      const contribution = change * config.weight;
      score += contribution;

      factors.push({
        name: config.name, ticker,
        change: +change.toFixed(2),
        weight: config.weight,
        contribution: +contribution.toFixed(4),
      });
    }

    factors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    const sig = SIGNAL_TABLE.find(s => score >= s.min);

    // KOSPI/KOSDAQ 실제 결과
    let kospiOpenChange = null, kospiCloseChange = null;
    let kosdaqOpenChange = null, kosdaqCloseChange = null;
    let actualDirection = null;
    let hit = null;

    const kospi = kospiByDate[currDate];
    if (kospi) {
      const prevKospiDate = Object.keys(kospiByDate)
        .filter(d => d < currDate).sort().pop();
      const prevKospi = prevKospiDate ? kospiByDate[prevKospiDate] : null;

      if (prevKospi && prevKospi.close) {
        kospiOpenChange = +((kospi.open - prevKospi.close) / prevKospi.close * 100).toFixed(3);
        kospiCloseChange = +((kospi.close - prevKospi.close) / prevKospi.close * 100).toFixed(3);
      }
    }

    const kosdaq = kosdaqByDate[currDate];
    if (kosdaq) {
      const prevKosdaqDate = Object.keys(kosdaqByDate)
        .filter(d => d < currDate).sort().pop();
      const prevKosdaq = prevKosdaqDate ? kosdaqByDate[prevKosdaqDate] : null;

      if (prevKosdaq && prevKosdaq.close) {
        kosdaqOpenChange = +((kosdaq.open - prevKosdaq.close) / prevKosdaq.close * 100).toFixed(3);
        kosdaqCloseChange = +((kosdaq.close - prevKosdaq.close) / prevKosdaq.close * 100).toFixed(3);
      }
    }

    if (kospiCloseChange != null) {
      actualDirection = 'flat';
      if (kospiCloseChange > 0.2) actualDirection = 'up';
      else if (kospiCloseChange < -0.2) actualDirection = 'down';

      hit = false;
      if ((sig.signal.includes('bullish') && actualDirection === 'up') ||
          (sig.signal.includes('bearish') && actualDirection === 'down') ||
          (sig.signal === 'neutral' && actualDirection === 'flat')) {
        hit = true;
      }
    }

    records.push({
      prediction_date: currDate,
      score: +score.toFixed(3),
      signal: sig.signal,
      factors,
      weights: DEFAULT_WEIGHTS,
      kospi_open_change: kospiOpenChange,
      kospi_close_change: kospiCloseChange,
      kosdaq_open_change: kosdaqOpenChange,
      kosdaq_close_change: kosdaqCloseChange,
      actual_direction: actualDirection,
      hit,
    });

    const hitStr = hit === true ? '✅' : hit === false ? '❌' : '⬜';
    const scoreStr = (score >= 0 ? '+' : '') + score.toFixed(3);
    const kospiStr = kospiCloseChange != null
      ? (kospiCloseChange >= 0 ? '+' : '') + kospiCloseChange.toFixed(2) + '%'
      : 'N/A   ';
    console.log(`  ${currDate}  score: ${scoreStr.padStart(7)}  ${sig.emoji} ${sig.label.padEnd(5)}  KOSPI: ${kospiStr.padStart(8)}  ${hitStr}`);
  }

  // 4. Supabase에 upsert
  console.log(`\n💾 ${records.length}건 Supabase 저장 중...`);

  const batchSize = 20;
  let saved = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await supabase
      .from('overnight_predictions')
      .upsert(batch, { onConflict: 'prediction_date' });

    if (error) {
      console.error(`  ❌ 배치 ${i}-${i + batch.length} 실패:`, error.message);
    } else {
      saved += batch.length;
    }
  }

  // 5. 적중률 요약
  const withResult = records.filter(r => r.hit != null);
  const hits = withResult.filter(r => r.hit === true).length;
  const total = withResult.length;

  console.log(`\n✅ 백필 완료: ${saved}/${records.length}건 저장`);
  console.log(`📊 적중률: ${hits}/${total} (${total > 0 ? (hits/total*100).toFixed(1) : 0}%)`);
  console.log(`   상승 예측: ${records.filter(r => r.signal.includes('bullish')).length}건`);
  console.log(`   중립 예측: ${records.filter(r => r.signal === 'neutral').length}건`);
  console.log(`   하락 예측: ${records.filter(r => r.signal.includes('bearish')).length}건`);
}

main().catch(err => {
  console.error('❌ 백필 실패:', err);
  process.exit(1);
});
