/**
 * collect-market-funds.js — 증시자금 종합(고객예탁금·신용융자잔고·미수금 등) 일별 소급 (2026-10-21)
 *
 * 왜: 개인 과열 지표 검정(INDEX_SIGNAL_VERDICT.md F절). 출처 KIS FHKST649100C0 (원자료 금융투자협회).
 *   호출당 100거래일씩 과거로 — 2026-10-21 실측: 20110103 요청 → 2010-08-11~2011-01-03.
 *   단위: 금액 필드 억원, hts_avls(시가총액) 백만원. 시장 구분 없음(유가+코스닥 합계로 추정).
 *
 * 산출: data/market-funds-daily.jsonl — 응답 행 원본 + d. 날짜 중복은 덮지 않는다.
 * 실행: node scripts/collect-market-funds.js [--to=YYYYMMDD] [--from=20100101]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const kis = require('../backend/kisApi');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TO = arg('to', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''));
const FROM = arg('from', '20100101');
const OUT = path.resolve(__dirname, '../data/market-funds-daily.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const have = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf-8').split('\n')) if (l.trim()) have.add(JSON.parse(l).d);
  const token = await kis.getAccessToken();
  let cursor = TO, added = 0;
  while (cursor >= FROM) {
    const r = await axios.get(`${kis.baseUrl}/uapi/domestic-stock/v1/quotations/mktfunds`, {
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: kis.appKey, appsecret: kis.appSecret, tr_id: 'FHKST649100C0', custtype: 'P' },
      params: { FID_INPUT_DATE_1: cursor }, timeout: 30000, validateStatus: () => true,
    });
    const rows = r.data?.output || [];
    if (r.data?.rt_cd !== '0' || !rows.length) { console.error(`❌ ${cursor}: ${r.status} ${r.data?.msg1}`); process.exit(1); }
    for (const x of rows) {
      if (have.has(x.bsop_date)) continue;
      have.add(x.bsop_date);
      fs.appendFileSync(OUT, JSON.stringify({ d: x.bsop_date, ...x }) + '\n');
      added++;
    }
    const oldest = rows[rows.length - 1].bsop_date;
    process.stdout.write(`\r  ${cursor} → ~${oldest} (누적 ${added}일)   `);
    const dt = new Date(`${oldest.slice(0, 4)}-${oldest.slice(4, 6)}-${oldest.slice(6, 8)}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    cursor = dt.toISOString().slice(0, 10).replace(/-/g, '');
    await sleep(400);
  }
  console.log(`\n✅ ${added}일 추가 → ${OUT}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
