/**
 * collect-sectors.js — 종목별 업종 수집 (2026-08-24)
 *
 * 왜: KRX 오픈API의 종목기본정보에는 **업종 필드가 없다**(SECT_TP_NM은 소속부).
 *   저PBR ∩ cap300이 4.6년 +213%로 나왔는데 이게 가치 팩터인지 **금융 업종 베팅**인지
 *   가리려면 업종이 필요하다. KIS 현재가 조회의 `bstp_kor_isnm`(업종 한글명)을 쓴다.
 *
 * 재개 가능: 이미 수집된 종목은 건너뛴다. 산출 data/sector-map.json = {code: 업종명}
 * 실행: node scripts/collect-sectors.js [--delay=250]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const kisApi = require('../backend/kisApi');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const DELAY = arg('delay', 250);
const OUT = path.resolve(__dirname, '../data/sector-map.json');
const MASTER = path.resolve(__dirname, '../data/krx-master.json');

(async () => {
  const master = JSON.parse(fs.readFileSync(MASTER, 'utf-8')).rows;
  const codes = master.filter(r => r.stkType === '보통주').map(r => r.code);
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf-8')) : {};
  const todo = codes.filter(c => !out[c]);
  console.log(`업종 수집: 대상 ${codes.length}종목 중 미수집 ${todo.length}종목 (간격 ${DELAY}ms)`);
  if (!todo.length) { console.log('이미 완료'); return; }

  // ⚠️ 직접 axios로 치면 안 된다 — KIS는 포트 :9443과 custtype 헤더가 필요하고,
  //    빠뜨리면 조용히 타임아웃(ECONNABORTED)만 난다. kisApi가 이미 sectorName을 준다.
  let n = 0, fail = 0;
  for (const code of todo) {
    try {
      const d = await kisApi.getCurrentPrice(code);
      const s = d?.sectorName;
      if (s) out[code] = s; else fail++;
    } catch { fail++; }
    if (++n % 100 === 0) {
      fs.writeFileSync(OUT, JSON.stringify(out));
      process.stdout.write(`\r  ${n}/${todo.length} 수집 (실패 ${fail})   `);
    }
    await new Promise(r => setTimeout(r, DELAY));
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\n✅ 완료 — ${Object.keys(out).length}종목 업종 확보 (실패 ${fail})`);
})();
