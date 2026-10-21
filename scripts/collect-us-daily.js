/**
 * collect-us-daily.js — 해외 지표 일봉 소급 (Yahoo chart v8, 2026-10-21)
 *
 * 왜: 해외 신호 → KOSPI 200 검정(scripts/index-signal-test.js). overnightPredictor 와 같은 출처.
 * 산출: data/us-daily.json — { [ticker]: [[YYYYMMDD(미국 현지 거래일), close], ...] } (매번 전체 덮어씀)
 * 실행: node scripts/collect-us-daily.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TICKERS = ['^GSPC', 'ES=F', '^SOX', '^VIX', 'KRW=X', 'EWY'];
const OUT = path.resolve(__dirname, '../data/us-daily.json');
const P1 = Math.floor(Date.parse('2009-06-01T00:00:00Z') / 1000);
const P2 = Math.floor(Date.now() / 1000);

(async () => {
  const out = {};
  for (const t of TICKERS) {
    const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}`, {
      params: { period1: P1, period2: P2, interval: '1d' }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000,
    });
    const res = r.data.chart.result[0];
    const off = res.meta.gmtoffset;   // 거래소 현지 기준 날짜로 변환 (정규장 시작 타임스탬프 기준)
    const cl = res.indicators.quote[0].close;
    out[t] = res.timestamp.map((ts, i) => [new Date((ts + off) * 1000).toISOString().slice(0, 10).replace(/-/g, ''), cl[i]])
      .filter(([, c]) => c != null && c > 0);
    console.log(`${t.padEnd(6)} ${out[t].length}일 ${out[t][0][0]} ~ ${out[t].at(-1)[0]}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`✅ ${OUT}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
