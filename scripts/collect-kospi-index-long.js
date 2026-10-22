/**
 * collect-kospi-index-long.js — KOSPI·KOSPI 200 지수 OHLC 장기 소급 (2026-10-21)
 *
 * 왜: 박스권(역추세) 지수 매매 검정(scripts/index-box-backtest.js)에 박스 장과 추세 장이 둘 다 필요하다.
 *   data/krx-index.jsonl 은 2022-01~ 이라 "박스피"(2011~2016) 구간이 없다.
 *   KRX OpenAPI /idx/kospi_dd_trd 는 2010-01-04 부터 제공(2009 이전은 빈 배열, 2026-10-21 실측).
 *
 * 산출: data/kospi-index-long.jsonl — {"d":"YYYYMMDD","k":[c,o,h,l],"k200":[c,o,h,l]}
 *       휴장일은 {"d":"...","h":1} 로 남겨 재개 시 다시 묻지 않는다.
 * 재개 가능. 2022-01 이후는 krx-index.jsonl 에 있으므로 기본 범위를 거기서 끊는다.
 * 실행: node scripts/collect-kospi-index-long.js [--from=20100101] [--to=20211231] [--delay=300]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const FROM = arg('from', '20100101');
const TO = arg('to', '20211231');
const DELAY = +arg('delay', 300);
const KEY = process.env.KRX_AUTH_KEY;
if (!KEY) { console.error('❌ .env에 KRX_AUTH_KEY 없음'); process.exit(1); }

const URL = 'http://data-dbg.krx.co.kr/svc/apis/idx/kospi_dd_trd';
const OUT = path.resolve(__dirname, '../data/kospi-index-long.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const n = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };

async function fetchDay(basDd, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await axios.get(URL, { headers: { AUTH_KEY: KEY }, params: { basDd }, timeout: 20000, validateStatus: () => true });
      if (r.status === 200) return r.data?.OutBlock_1 || [];
      if (r.status === 401) { console.error('\n❌ 401 — 인증키/서비스 승인 확인 필요'); process.exit(1); }
    } catch { /* 재시도 */ }
    await sleep(1500 * t);
  }
  console.warn(`\n⚠️ ${basDd} 실패 — 건너뜀(재실행 시 다시 시도)`);
  return null;
}

function weekdays(from, to) {
  const out = [];
  const d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`);
  const end = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`);
  while (d <= end) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

(async () => {
  const done = new Set();
  if (fs.existsSync(OUT)) for (const line of fs.readFileSync(OUT, 'utf-8').split('\n')) {
    if (line.trim()) try { done.add(JSON.parse(line).d); } catch { /* 손상 행 무시 */ }
  }
  const days = weekdays(FROM, TO).filter(d => !done.has(d));
  console.log(`📥 KOSPI 지수 ${FROM}~${TO} | 남은 평일 ${days.length}일 (이미 ${done.size})`);
  const ohlc = x => [n(x.CLSPRC_IDX), n(x.OPNPRC_IDX), n(x.HGPRC_IDX), n(x.LWPRC_IDX)];
  // KRX OpenAPI 는 D 일자를 D+1 아침에 올린다 → 어제·오늘의 빈 응답은 휴장이 아니라 미게시.
  // 휴장으로 남기면 재개 시 영영 건너뛰므로 기록하지 않는다 (2026-10-22, 10/22 당일 실행 시 h:1 오기록).
  const ydayKst = new Date(Date.now() + 9 * 3600e3 - 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  let i = 0, nTrade = 0;
  for (const d of days) {
    const rows = await fetchDay(d);
    if (rows) {
      const k = rows.find(x => x.IDX_NM === '코스피');
      const k200 = rows.find(x => x.IDX_NM === '코스피 200');
      const rec = k && k200 ? { d, k: ohlc(k), k200: ohlc(k200) } : { d, h: 1 };
      if (rec.h && d >= ydayKst) { console.log(`\n  ⏳ ${d} 미게시 — 기록 안 함 (나중에 다시 실행)`); continue; }
      if (!rec.h) nTrade++;
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    }
    if (++i % 100 === 0) process.stdout.write(`\r  ${i}/${days.length} (${d}, 거래일 ${nTrade})`);
    await sleep(DELAY);
  }
  console.log(`\n✅ 완료 — 거래일 ${nTrade}일 추가 → ${OUT}`);
})();
