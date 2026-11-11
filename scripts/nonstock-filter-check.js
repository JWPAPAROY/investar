/**
 * nonstock-filter-check.js — kisApi.isNonStockItem 회귀 검사 (2026-11-11)
 *
 * 두 방향을 모두 본다:
 *   ① 오탐: KRX 상장 주권(data/krx-master.json) 중 제외되는 종목.
 *      스팩·리츠·부동산투자회사는 의도된 제외라 따로 센다. 그 외는 0이어야 한다.
 *   ② 미탐: KRX ETF 전 종목(etf_bydd_trd, 실시간 조회) 중 통과하는 것. 0이어야 한다.
 *
 * 실행: node scripts/nonstock-filter-check.js [--basDd=20261110]
 *   필요: .env 의 KRX_AUTH_KEY, data/krx-master.json (scripts/collect-krx-daily.js 가 생성)
 * 종료 코드: 오탐 또는 미탐이 있으면 1.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const path = require('path');
const axios = require('axios');
const kisApi = require('../backend/kisApi');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };

(async () => {
  const master = require(path.resolve(__dirname, '../data/krx-master.json')).rows;
  const intended = r => r.secuGrp !== '주권' || /스팩|SPAC|리츠|REIT/.test(r.name);
  const flagged = master.filter(r => kisApi.isNonStockItem(r.name));
  const falsePos = flagged.filter(r => !intended(r));
  console.log(`① 상장 주권 ${master.length}개 중 제외 ${flagged.length}개 (의도된 스팩·리츠 등 ${flagged.length - falsePos.length}개)`);
  console.log(`   오탐 ${falsePos.length}개${falsePos.length ? ': ' + falsePos.map(r => r.name).join(', ') : ''}`);

  const basDd = arg('basDd', '20261110');
  const r = await axios.get('http://data-dbg.krx.co.kr/svc/apis/etp/etf_bydd_trd',
    { headers: { AUTH_KEY: process.env.KRX_AUTH_KEY }, params: { basDd }, timeout: 30000, validateStatus: () => true });
  const etf = (r.data?.OutBlock_1 || []).map(x => x.ISU_NM || x.ISU_ABBRV);
  if (etf.length === 0) { console.error(`② KRX ETF 목록 조회 실패 (HTTP ${r.status}, basDd=${basDd}) — 휴장일이면 --basDd 지정`); process.exit(1); }
  const missed = etf.filter(n => !kisApi.isNonStockItem(n));
  console.log(`② ETF ${etf.length}개 중 미탐 ${missed.length}개${missed.length ? ': ' + missed.slice(0, 20).join(', ') : ''}`);

  process.exit(falsePos.length || missed.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
