/**
 * krx-probe.js — KRX OpenAPI 탐침 (2026-08-24)
 *
 * 목적: 발급받은 인증키로 **어떤 서비스가 열리는지**, 특히 투자자별 거래실적(수급)이
 *   소급 조회 가능한지 확인한다. 수급은 이 프로젝트 TOP3 정렬의 1차 키인데
 *   KIS가 30일치만 줘서 62거래일(블록 2.5)로 판정 불가 상태다.
 *
 * 인증: 헤더 AUTH_KEY. 파라미터는 대체로 basDd=YYYYMMDD (일자별 조회).
 * 실행: node scripts/krx-probe.js [--date=20260821]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const DATE = arg('date', '20260821');
const KEY = process.env.KRX_AUTH_KEY;
if (!KEY) { console.error('❌ .env에 KRX_AUTH_KEY 없음'); process.exit(1); }
console.log(`🔑 KRX_AUTH_KEY = ${KEY.slice(0, 6)}…${KEY.slice(-4)} (${KEY.length}자)`);
console.log(`📅 조회일자: ${DATE}\n`);

// 후보 엔드포인트 (KRX 정보데이터시스템 OpenAPI 서비스군)
const BASES = [
  'http://data-dbg.krx.co.kr/svc/apis',
  'https://data-dbg.krx.co.kr/svc/apis',
  'http://openapi.krx.co.kr/svc/apis',
];
const PATHS = [
  ['/sto/stk_bydd_trd', '유가증권 일별매매정보'],
  ['/sto/ksq_bydd_trd', '코스닥 일별매매정보'],
  ['/sto/stk_isu_base_info', '유가증권 종목기본정보'],
  ['/idx/krx_dd_trd', 'KRX 지수 일별시세'],
  ['/sto/stk_invsr_trd', '(추정) 투자자별 거래실적'],
  ['/sto/stk_isu_invsr_trd', '(추정) 종목별 투자자 거래실적'],
  ['/sto/stk_shrt_sale', '(추정) 공매도'],
];

(async () => {
  let liveBase = null;
  for (const base of BASES) {
    try {
      const r = await axios.get(`${base}/sto/stk_bydd_trd`, {
        headers: { AUTH_KEY: KEY }, params: { basDd: DATE }, timeout: 15000, validateStatus: () => true,
      });
      const body = typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 200);
      console.log(`[BASE] ${base} → HTTP ${r.status} | ${body.replace(/\s+/g, ' ')}`);
      if (r.status === 200 && r.data && !String(body).includes('error')) { liveBase = base; break; }
    } catch (e) {
      console.log(`[BASE] ${base} → 실패: ${e.code || e.message}`);
    }
  }
  if (!liveBase) { console.log('\n❌ 접속 가능한 베이스 URL 없음 — 키 종류나 서비스 신청 상태 확인 필요'); return; }

  console.log(`\n✅ 사용 가능 베이스: ${liveBase}\n`);
  for (const [p, label] of PATHS) {
    try {
      const r = await axios.get(`${liveBase}${p}`, {
        headers: { AUTH_KEY: KEY }, params: { basDd: DATE }, timeout: 15000, validateStatus: () => true,
      });
      const d = r.data;
      const rows = d && (d.OutBlock_1 || d.output || d.data);
      if (r.status === 200 && Array.isArray(rows)) {
        console.log(`✅ ${p.padEnd(26)} ${label}`);
        console.log(`   행수 ${rows.length} | 필드: ${Object.keys(rows[0] || {}).join(', ')}`);
        if (rows[0]) console.log(`   샘플: ${JSON.stringify(rows[0]).slice(0, 240)}`);
      } else {
        const body = typeof d === 'string' ? d.slice(0, 160) : JSON.stringify(d).slice(0, 160);
        console.log(`❌ ${p.padEnd(26)} ${label} → HTTP ${r.status} | ${body.replace(/\s+/g, ' ')}`);
      }
    } catch (e) {
      console.log(`❌ ${p.padEnd(26)} ${label} → ${e.code || e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
})();
