/**
 * collect-krx-daily.js — KRX 오픈API 일별 데이터 소급 수집 (2026-08-24)
 *
 * 왜: 기존 data/price-history.jsonl(KIS 수정주가)은 세 가지 한계가 있었다.
 *   ① **종가만** 있어 갭·일중변동 축을 검정할 수 없다(--set=gap이 62일 표본에 갇힌 이유).
 *   ② 과거 시총을 "수정주가 × **현재** 상장주식수"로 근사 → 실측 대비 2.1% 오차
 *      (2024-01-02 삼성전자 5,969,782,550 vs 현재 5,846,278,608). cap300 구성이 틀어진다.
 *   ③ 유니버스가 stock_master(=오늘 상장 종목)라 **상폐 종목 부재 = 생존편향**.
 *   KRX 일별매매정보는 그날 시점의 전 종목 스냅샷이라 셋 다 해결된다.
 *
 * 범위 판단(2026-08-24): 2010년까지 제공되지만 **2022-01 시작**을 택했다.
 *   실제 지평이 D+2→D+10(8거래일)이라 길이는 이미 충분하고, 부족한 건 레짐 다양성이다.
 *   2022 하락장 / 2023 회복 / 2024-25 강세 / 2026 크래시 = 4개 레짐.
 *   더 멀리 가면 공매도 전면금지·코로나 개인장 등 **구조가 다른 시장**을 평균에 섞게 된다.
 *
 * 산출:
 *   data/krx-daily.jsonl   — 일자별 {"d":"YYYYMMDD","s":[[code,o,h,l,c,vol,val,mktcap],...]}
 *                            (상장주식수는 mktcap/close로 복원 가능해 저장하지 않는다)
 *   data/krx-index.jsonl   — 일자별 {"d":"...","i":[[지수명,종가,시가,고가,저가,거래량,거래대금,시총],...]}
 *   data/krx-master.json   — 종목기본정보(유가+코스닥). 우선주 배제·상장일 확인용.
 *
 * 재개 가능: 이미 수집된 일자는 건너뛴다. 중단 후 같은 명령으로 다시 실행하면 이어간다.
 * 실행: node scripts/collect-krx-daily.js [--from=20220101] [--to=20260821] [--delay=400] [--no-index]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const has = k => process.argv.includes(`--${k}`);
const FROM = arg('from', '20220101');
const TO = arg('to', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''));
const DELAY = +arg('delay', 400);
const SKIP_INDEX = has('no-index');
const KEY = process.env.KRX_AUTH_KEY;
if (!KEY) { console.error('❌ .env에 KRX_AUTH_KEY 없음'); process.exit(1); }

const BASE = 'http://data-dbg.krx.co.kr/svc/apis';
const DAILY = path.resolve(__dirname, '../data/krx-daily.jsonl');
const INDEX = path.resolve(__dirname, '../data/krx-index.jsonl');
const MASTER = path.resolve(__dirname, '../data/krx-master.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const n = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };

/** 재시도 포함 GET. 429/5xx는 백오프, 그 외 실패는 null 반환. */
async function fetchPath(p, basDd, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await axios.get(BASE + p, {
        headers: { AUTH_KEY: KEY }, params: { basDd }, timeout: 30000, validateStatus: () => true,
      });
      if (r.status === 200) return r.data?.OutBlock_1 || [];
      if (r.status === 401) { console.error(`\n❌ 401 (${p}) — 인증키/서비스 승인 확인 필요`); process.exit(1); }
      if (t === tries) { console.warn(`\n⚠️ ${basDd} ${p} HTTP ${r.status} — 건너뜀`); return null; }
      await sleep(1500 * t);
    } catch (e) {
      if (t === tries) { console.warn(`\n⚠️ ${basDd} ${p} ${e.code || e.message} — 건너뜀`); return null; }
      await sleep(1500 * t);
    }
  }
  return null;
}

/** 이미 수집된 일자 집합 (재개용) */
function collectedDates(file) {
  if (!fs.existsSync(file)) return new Set();
  const out = new Set();
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.add(JSON.parse(line).d); } catch { /* 손상 행 무시 */ }
  }
  return out;
}

/** FROM~TO 사이의 평일 목록 (휴장일은 API가 빈 배열을 주므로 여기서 거르지 않는다) */
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
  console.log(`\n📥 KRX 일별 데이터 수집 — ${FROM} ~ ${TO} (간격 ${DELAY}ms)`);

  // ── 종목기본정보 (1회) ──────────────────────────────────────────────
  if (!fs.existsSync(MASTER)) {
    const rows = [];
    for (const [p, mkt] of [['/sto/stk_isu_base_info', 'KOSPI'], ['/sto/ksq_isu_base_info', 'KOSDAQ']]) {
      const r = await fetchPath(p, TO);
      (r || []).forEach(x => rows.push({
        code: x.ISU_SRT_CD, isin: x.ISU_CD, name: x.ISU_ABBRV || x.ISU_NM, market: mkt,
        listDd: x.LIST_DD, secuGrp: x.SECUGRP_NM, sectTp: x.SECT_TP_NM,
        stkType: x.KIND_STKCERT_TP_NM,   // 보통주 / 우선주 — 유니버스 위생에 필수
        parval: n(x.PARVAL), shrs: n(x.LIST_SHRS),
      }));
      await sleep(DELAY);
    }
    fs.writeFileSync(MASTER, JSON.stringify({ asOf: TO, rows }, null, 0));
    const pref = rows.filter(r => r.stkType && r.stkType !== '보통주').length;
    console.log(`✅ 종목기본정보 ${rows.length}종목 저장 (보통주 외 ${pref}종목 — 우선주 등)`);
  } else {
    console.log('↩️  종목기본정보 이미 있음 (data/krx-master.json)');
  }

  // ── 일별매매 + 지수 ────────────────────────────────────────────────
  const doneDaily = collectedDates(DAILY);
  const doneIndex = collectedDates(INDEX);
  const days = weekdays(FROM, TO);
  console.log(`대상 평일 ${days.length}일 | 이미 수집: 매매 ${doneDaily.size}일 / 지수 ${doneIndex.size}일\n`);

  let nDay = 0, nHol = 0, nRow = 0, t0 = Date.now();
  for (const d of days) {
    const needDaily = !doneDaily.has(d);
    const needIndex = !SKIP_INDEX && !doneIndex.has(d);
    if (!needDaily && !needIndex) continue;

    if (needDaily) {
      const [ks, kq] = [await fetchPath('/sto/stk_bydd_trd', d), await (sleep(DELAY).then(() => fetchPath('/sto/ksq_bydd_trd', d)))];
      if (ks === null || kq === null) { await sleep(DELAY); continue; }
      const rows = [...ks, ...kq]
        .filter(x => n(x.TDD_CLSPRC) > 0)
        .map(x => [x.ISU_CD, n(x.TDD_OPNPRC), n(x.TDD_HGPRC), n(x.TDD_LWPRC), n(x.TDD_CLSPRC),
                   n(x.ACC_TRDVOL), n(x.ACC_TRDVAL), n(x.MKTCAP)]);
      if (rows.length === 0) { nHol++; }
      else {
        fs.appendFileSync(DAILY, JSON.stringify({ d, s: rows }) + '\n');
        nDay++; nRow += rows.length;
      }
      await sleep(DELAY);
    }

    if (needIndex) {
      const parts = [];
      for (const p of ['/idx/kospi_dd_trd', '/idx/kosdaq_dd_trd', '/idx/krx_dd_trd']) {
        const r = await fetchPath(p, d);
        if (r) parts.push(...r);
        await sleep(DELAY);
      }
      const irows = parts.map(x => [x.IDX_NM, n(x.CLSPRC_IDX), n(x.OPNPRC_IDX), n(x.HGPRC_IDX),
                                    n(x.LWPRC_IDX), n(x.ACC_TRDVOL), n(x.ACC_TRDVAL), n(x.MKTCAP)]);
      if (irows.length) fs.appendFileSync(INDEX, JSON.stringify({ d, i: irows }) + '\n');
    }

    if ((nDay + nHol) % 20 === 0 && nDay) {
      const el = (Date.now() - t0) / 1000;
      const done = nDay + nHol, left = days.length - done;
      process.stdout.write(`\r  진행 ${done}/${days.length}일 (거래일 ${nDay} / 휴장 ${nHol}) | ${nRow.toLocaleString()}행 | 경과 ${(el / 60).toFixed(1)}분 | 잔여 ~${(left * el / done / 60).toFixed(0)}분   `);
    }
  }
  console.log(`\n\n✅ 완료 — 거래일 ${nDay}일 / 휴장 ${nHol}일 / 총 ${nRow.toLocaleString()}행`);
  console.log(`   ${DAILY}`);
  if (!SKIP_INDEX) console.log(`   ${INDEX}`);
})();
