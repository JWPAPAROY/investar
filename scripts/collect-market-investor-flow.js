/**
 * collect-market-investor-flow.js — KOSPI 시장 전체 투자자별 일별 순매수 소급 (2026-10-21)
 *
 * 왜: 지수 수급 신호 검정(scripts/index-signal-test.js). 종목별 수급은 KIS가 30일만 주지만,
 *   **시장 전체**(FHPTJ04040000, 시장별 투자자매매동향 일별)는 호출당 300거래일씩 과거로 내려간다.
 *   2026-10-21 실측: 20110103 요청 → 2009-10-23 ~ 2011-01-03 반환. 17년치가 ~15콜.
 *   (메모리의 "다년 수급은 KRX 웹 로그인 필수"는 **종목별** 이야기다. 시장 합계는 이 경로로 된다.)
 *
 * 산출: data/kospi-investor-daily.jsonl — 응답 행 원본 그대로 + d(=stck_bsop_date). 날짜 중복은 덮지 않는다.
 * 실행: node scripts/collect-market-investor-flow.js [--to=YYYYMMDD] [--from=20100101]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const kis = require('../backend/kisApi');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TO = arg('to', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''));
const FROM = arg('from', '20100101');
const OUT = path.resolve(__dirname, '../data/kospi-investor-daily.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const have = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf-8').split('\n')) if (l.trim()) have.add(JSON.parse(l).d);
  const token = await kis.getAccessToken();
  let cursor = TO, added = 0;
  while (cursor >= FROM) {
    const r = await axios.get(`${kis.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market`, {
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: kis.appKey, appsecret: kis.appSecret, tr_id: 'FHPTJ04040000', custtype: 'P' },
      params: { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001', FID_INPUT_DATE_1: cursor, FID_INPUT_ISCD_1: 'KSP', FID_INPUT_DATE_2: cursor, FID_INPUT_ISCD_2: '0001' },
      timeout: 30000, validateStatus: () => true,
    });
    const rows = r.data?.output || [];
    if (r.data?.rt_cd !== '0' || !rows.length) { console.error(`❌ ${cursor}: ${r.status} ${r.data?.msg1}`); process.exit(1); }
    for (const x of rows) {
      if (have.has(x.stck_bsop_date)) continue;
      have.add(x.stck_bsop_date);
      fs.appendFileSync(OUT, JSON.stringify({ d: x.stck_bsop_date, ...x }) + '\n');
      added++;
    }
    const oldest = rows[rows.length - 1].stck_bsop_date;
    console.log(`  ${cursor} → ${rows[0].stck_bsop_date}~${oldest} (${rows.length}행)`);
    // 가장 오래된 날의 전날부터 다시 (달력일 하루 빼기 — 휴일이면 API가 그 이전 거래일부터 준다)
    const dt = new Date(`${oldest.slice(0, 4)}-${oldest.slice(4, 6)}-${oldest.slice(6, 8)}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    cursor = dt.toISOString().slice(0, 10).replace(/-/g, '');
    await sleep(400);
  }
  console.log(`✅ ${added}일 추가 → ${OUT}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
