/**
 * collect-etf-daily.js — 비교 대상 ETF 일별 시세 수집 (2026-08-25)
 *
 * 왜: 저PBR 20종목 직접 운용이 **상장 ETF 대비 실익이 있는가**를 답하려면
 *   실제 매매 가능한 상품의 수익률이 필요하다. "왜 인덱스를 안 사는가"의 연장.
 *
 * ⚠️ 배당 처리: 대부분 PR(가격지수) 상품이라 분배금이 가격에 없다. 우리 저PBR 시뮬도
 *   KRX 종가 기반이라 배당이 빠져 있어 **PR 상품과는 대칭**이지만, TR 상품(분배금 재투자)과
 *   비교할 때는 TR 쪽이 유리하다. 표에서 PR/TR을 구분해 읽을 것.
 *
 * 실행: node scripts/collect-etf-daily.js [--from=20220101] [--delay=350]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const FROM = arg('from', '20220101');
const TO = arg('to', '20260821');
const DELAY = +arg('delay', 350);
const KEY = process.env.KRX_AUTH_KEY;
const OUT = path.resolve(__dirname, '../data/etf-daily.jsonl');

// 비교 대상: 지수 / 배당·가치 / 밸류업 / 금융집중
const WANT = new Set(['069500', '161510', '315960', '496080', '466940', '484880']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf-8').split('\n')) { if (l.trim()) try { done.add(JSON.parse(l).d); } catch {} }

(async () => {
  // 대상 거래일은 이미 수집한 주식 데이터의 거래일을 그대로 사용 (휴장일 재조회 방지)
  const DAILY = path.resolve(__dirname, '../data/krx-daily.jsonl');
  const days = [...new Set(fs.readFileSync(DAILY, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l).d))].filter(d => d >= FROM && d <= TO).sort();
  const todo = days.filter(d => !done.has(d));
  console.log(`ETF 수집: 거래일 ${days.length}일 중 미수집 ${todo.length}일 (대상 ${WANT.size}종목)`);

  let n = 0;
  for (const d of todo) {
    try {
      const r = await axios.get('http://data-dbg.krx.co.kr/svc/apis/etp/etf_bydd_trd',
        { headers: { AUTH_KEY: KEY }, params: { basDd: d }, timeout: 30000, validateStatus: () => true });
      if (r.status === 200 && Array.isArray(r.data?.OutBlock_1)) {
        const rows = r.data.OutBlock_1.filter(x => WANT.has(x.ISU_CD))
          .map(x => [x.ISU_CD, Number(x.TDD_CLSPRC), Number(x.NAV || 0)]);
        if (rows.length) fs.appendFileSync(OUT, JSON.stringify({ d, e: rows }) + '\n');
      }
    } catch { /* 건너뜀 */ }
    if (++n % 50 === 0) process.stdout.write(`\r  ${n}/${todo.length}일   `);
    await sleep(DELAY);
  }
  console.log(`\n✅ 완료 — ${OUT}`);
})();
