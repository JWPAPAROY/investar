/**
 * collect-krx-drv-bond.js — KRX 파생상품지수(VKOSPI 등) · 채권지수 일별 소급 (2026-10-22)
 *
 * 왜: 지수 급락 사전 경보 후보 중 아직 검정 안 한 두 축 — ② VKOSPI(옵션 내재변동성) ③ 신용 스프레드 근사
 *   (KRX 채권지수 평균수익률 − KTB 지수 평균수익률). 둘 다 KRX OpenAPI 별도 이용신청이 필요했다(2026-10-22 승인).
 *   덤으로 KTB 총수익지수가 생겨 주식+국채 고정 배분 검정이 가능하다.
 *
 * 산출: data/krx-drv-index.jsonl — {"d":"YYYYMMDD","i":[[지수명,종가,시가,고가,저가],...]}
 *       data/krx-bond-index.jsonl — {"d":"YYYYMMDD","b":[[그룹명,총수익,순가격,평균듀레이션,평균수익률],...]}
 * 휴장·미게시일은 기록하지 않는다(재개 시 다시 묻는다). 재개 가능.
 * 실행: node scripts/collect-krx-drv-bond.js [--from=20100101] [--to=YYYYMMDD] [--delay=500]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const FROM = arg('from', '20100101');
const TO = arg('to', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''));
const DELAY = +arg('delay', 500);
const KEY = process.env.KRX_AUTH_KEY;
if (!KEY) { console.error('❌ .env에 KRX_AUTH_KEY 없음'); process.exit(1); }

const BASE = 'http://data-dbg.krx.co.kr/svc/apis';
const OUT = { drv: path.resolve(__dirname, '../data/krx-drv-index.jsonl'), bond: path.resolve(__dirname, '../data/krx-bond-index.jsonl') };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const n = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };

async function fetchPath(p, basDd, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await axios.get(BASE + p, { headers: { AUTH_KEY: KEY }, params: { basDd }, timeout: 30000, validateStatus: () => true });
      if (r.status === 200) return r.data?.OutBlock_1 || [];
      if (r.status === 401) { console.error(`\n❌ 401 (${p}) — 서비스 승인 확인`); process.exit(1); }
      if (t === tries) { console.warn(`\n⚠️ ${basDd} ${p} HTTP ${r.status} — 건너뜀`); return null; }
    } catch (e) { if (t === tries) { console.warn(`\n⚠️ ${basDd} ${p} ${e.code || e.message} — 건너뜀`); return null; } }
    await sleep(1500 * t);
  }
  return null;
}
const done = f => { const s = new Set(); if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf-8').split('\n')) if (l.trim()) try { s.add(JSON.parse(l).d); } catch { } return s; };
function weekdays(from, to) {
  const out = [], d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}T00:00:00Z`), end = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  return out;
}

(async () => {
  const dDrv = done(OUT.drv), dBond = done(OUT.bond);
  const days = weekdays(FROM, TO).filter(d => !dDrv.has(d) || !dBond.has(d));
  console.log(`📥 파생·채권지수 ${FROM}~${TO} | 남은 평일 ${days.length}일`);
  let k = 0, nDrv = 0, nBond = 0;
  for (const d of days) {
    if (!dDrv.has(d)) {
      const r = await fetchPath('/idx/drvprod_dd_trd', d);
      if (r && r.length) { fs.appendFileSync(OUT.drv, JSON.stringify({ d, i: r.map(x => [x.IDX_NM, n(x.CLSPRC_IDX), n(x.OPNPRC_IDX), n(x.HGPRC_IDX), n(x.LWPRC_IDX)]) }) + '\n'); nDrv++; }
      await sleep(DELAY);
    }
    if (!dBond.has(d)) {
      const r = await fetchPath('/idx/bon_dd_trd', d);
      if (r && r.length) { fs.appendFileSync(OUT.bond, JSON.stringify({ d, b: r.map(x => [x.BND_IDX_GRP_NM, n(x.TOT_EARNG_IDX), n(x.NETPRC_IDX), n(x.AVG_DURATION), n(x.BND_IDX_AVG_YD)]) }) + '\n'); nBond++; }
      await sleep(DELAY);
    }
    if (++k % 100 === 0) process.stdout.write(`\r  ${k}/${days.length} (${d}) 파생 ${nDrv} · 채권 ${nBond}   `);
  }
  console.log(`\n✅ 완료 — 파생 ${nDrv}일 · 채권 ${nBond}일`);
})();
