/**
 * build-kospi-valuation.js — KOSPI 합산 PBR · 이익수익률 월별 시계열 구축 (2026-10-21)
 *
 * 왜: KRX·KIS 모두 지수 PER·PBR 이력을 주지 않는다(2026-10-21 확인). 밸류에이션 신호 검정
 *   (INDEX_SIGNAL_VERDICT.md D절)을 위해 종목 단위에서 직접 합산한다.
 *
 * 구성 (각 단계 캐시, 재실행 시 이어감):
 *   1. DART corpCode.xml → stock_code ↔ corp_code       data/dart-corpcode.json
 *   2. KRX 유가증권 일별매매 월말 스냅샷 → 종목별 시총      data/kospi-monthly-cap.jsonl
 *   3. DART 다중회사 주요계정(fnlttMultiAcnt) 2015~       data/dart-multi/{year}_{reprt}.json
 *   4. 월말 t 마다: 그 시점에 공시됐을 재무만 사용(아래 지연) → 합산
 *        PBR = Σ시총 / Σ자본총계,  EY = Σ직전 사업연도 당기순이익 / Σ시총
 *      커버리지(재무가 붙은 시총 비중)를 같이 남긴다.                  data/kospi-valuation-monthly.json
 *
 * ⚠️ 금융사 제외 (2026-10-21): fnlttMultiAcnt 는 2023 사업연도까지 금융업(은행·지주·보험·증권·카드)을
 *   반환하지 않는다 — 신한·KB·삼성생명 등 시총 ~12%. 2024~ 부터 들어오면서 합산 PBR 수준이 꺾여
 *   백분위 신호가 오염된다. 그래서 **2022 이전 보고서에 한 번도 등장하지 않은 회사는 전 기간 제외**
 *   (= 비금융 KOSPI). 2023 이후 신규 상장도 함께 빠지지만 비중이 작다. 커버리지는 전체 시총 대비로 표시.
 *
 * 공시 지연(보수적): 1분기 5/31, 반기 8/31, 3분기 11/30, 사업보고서 다음 해 4/30 이후부터 사용.
 * 재무: 연결(CFS) 우선, 없으면 별도(OFS). 생존편향: 상폐 기업은 corpCode 에 단축코드가 없어 빠질 수 있다 → 커버리지로 확인.
 *
 * 실행: node scripts/build-kospi-valuation.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');

const DART = process.env.DART_API_KEY, KRX = process.env.KRX_AUTH_KEY;
if (!DART || !KRX) { console.error('❌ .env에 DART_API_KEY / KRX_AUTH_KEY 필요'); process.exit(1); }
const fp = f => path.resolve(__dirname, '../data', f);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : NaN; };

// ── 1. corpCode ──────────────────────────────────────────────────────
async function corpCodes() {
  const out = fp('dart-corpcode.json');
  if (fs.existsSync(out)) return JSON.parse(fs.readFileSync(out, 'utf-8'));
  const r = await axios.get('https://opendart.fss.or.kr/api/corpCode.xml', { params: { crtfc_key: DART }, responseType: 'arraybuffer', timeout: 60000 });
  const zip = fp('dart-corpcode.zip');
  fs.writeFileSync(zip, r.data);
  const xml = execFileSync('unzip', ['-p', zip], { maxBuffer: 1 << 28 }).toString('utf-8');
  fs.unlinkSync(zip);
  const map = {};
  for (const m of xml.matchAll(/<corp_code>(\d+)<\/corp_code>\s*<corp_name>[^<]*<\/corp_name>(?:\s*<corp_eng_name>[^<]*<\/corp_eng_name>)?\s*<stock_code>\s*(\d{6})\s*<\/stock_code>/g)) map[m[2]] = m[1];
  fs.writeFileSync(out, JSON.stringify(map));
  console.log(`1. corpCode: 상장 코드 ${Object.keys(map).length}개`);
  return map;
}

// ── 2. KRX 월말 시총 ─────────────────────────────────────────────────
async function monthlyCaps() {
  const out = fp('kospi-monthly-cap.jsonl');
  const have = new Map();
  if (fs.existsSync(out)) for (const l of fs.readFileSync(out, 'utf-8').split('\n')) if (l.trim()) { const r = JSON.parse(l); have.set(r.m, r); }
  // 월말 거래일 = 지수 파일에서
  const days = [];
  for (const l of fs.readFileSync(fp('kospi-index-long.jsonl'), 'utf-8').split('\n')) if (l.trim()) { const r = JSON.parse(l); if (!r.h) days.push(r.d); }
  for (const l of fs.readFileSync(fp('krx-index.jsonl'), 'utf-8').split('\n')) if (l.trim()) days.push(JSON.parse(l).d);
  const last = new Map(); for (const d of [...new Set(days)].sort()) if (d >= '20150101') last.set(d.slice(0, 6), d);
  const todo = [...last].filter(([m]) => !have.has(m));
  console.log(`2. KRX 월말 시총: ${last.size}개월 중 ${todo.length}개월 수집`);
  for (const [m, d] of todo) {
    const r = await axios.get('http://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd', { headers: { AUTH_KEY: KRX }, params: { basDd: d }, timeout: 30000, validateStatus: () => true });
    const rows = r.data?.OutBlock_1 || [];
    if (r.status !== 200 || !rows.length) { console.warn(`   ⚠️ ${d} ${r.status} — 건너뜀`); continue; }
    const caps = rows.map(x => [x.ISU_CD, num(x.MKTCAP)]).filter(([c, v]) => /^\d{6}$/.test(c) && v > 0);
    const rec = { m, d, caps };
    fs.appendFileSync(out, JSON.stringify(rec) + '\n'); have.set(m, rec);
    await sleep(300);
  }
  return [...have.values()].sort((a, b) => a.m < b.m ? -1 : 1);
}

// ── 3. DART 다중회사 주요계정 ────────────────────────────────────────
// DART 계정명 → 내부 이름. 실제 응답은 '당기순이익(손실)' (2026-10-21 확인 — '당기순이익'만 받다가 이익 커버리지 0%였다)
const ACCOUNTS = { '자본총계': '자본총계', '당기순이익': '당기순이익', '당기순이익(손실)': '당기순이익' };
const REPRTS = { 11013: 'Q1', 11012: 'H1', 11014: 'Q3', 11011: 'FY' };
async function dartMulti(corpList) {
  const dir = fp('dart-multi'); fs.mkdirSync(dir, { recursive: true });
  const thisYear = +new Date().getFullYear();
  const jobs = [];
  for (let y = 2015; y <= thisYear; y++) for (const rc of Object.keys(REPRTS)) jobs.push([y, rc]);
  let calls = 0;
  for (const [y, rc] of jobs) {
    const f = path.join(dir, `${y}_${rc}.json`);
    if (fs.existsSync(f)) continue;
    const acc = [];
    for (let i = 0; i < corpList.length; i += 100) {
      const batch = corpList.slice(i, i + 100).join(',');
      for (let t = 1; t <= 4; t++) {
        try {
          const r = await axios.get('https://opendart.fss.or.kr/api/fnlttMultiAcnt.json', { params: { crtfc_key: DART, corp_code: batch, bsns_year: y, reprt_code: rc }, timeout: 60000 });
          const j = r.data; calls++;
          if (j.status === '000') { for (const x of j.list) { const a = ACCOUNTS[x.account_nm]; if (a) acc.push([x.corp_code, x.fs_div, a, num(x.thstrm_amount)]); } break; }
          if (j.status === '013') break;           // 데이터 없음 (미래 분기 등)
          if (j.status === '020') throw new Error('DART 사용한도 초과 — 내일 재개');
          throw new Error(`DART ${j.status} ${j.message}`);
        } catch (e) { if (t === 4 || /한도/.test(e.message)) throw e; await sleep(2000 * t); }
      }
      await sleep(150);
    }
    fs.writeFileSync(f, JSON.stringify(acc));
    process.stdout.write(`\r3. DART ${y} ${REPRTS[rc]}: ${acc.length}행 (누적 ${calls}콜)        `);
  }
  console.log('');
  const data = {};
  for (const [y, rc] of jobs) { const f = path.join(dir, `${y}_${rc}.json`); if (fs.existsSync(f)) data[`${y}_${rc}`] = JSON.parse(fs.readFileSync(f, 'utf-8')); }
  return data;
}

// ── 4. 합산 ──────────────────────────────────────────────────────────
/** 월말 m(YYYYMM) 에 사용 가능한 가장 최근 보고서들 */
function availableReports(m) {
  const y = +m.slice(0, 4), mo = +m.slice(4, 6);
  const out = [];   // [key, 기준시점 정렬키]
  for (let yy = y - 2; yy <= y; yy++) {
    const pub = { 11013: [yy, 5], 11012: [yy, 8], 11014: [yy, 11], 11011: [yy + 1, 4] };   // 이 달 말부터 사용
    for (const [rc, [py, pm]] of Object.entries(pub)) if (y > py || (y === py && mo >= pm)) out.push([`${yy}_${rc}`, yy * 10 + { 11013: 1, 11012: 2, 11014: 3, 11011: 4 }[rc], rc]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}
function pick(rows, corp, account) {   // 연결 우선
  let ofs = NaN;
  for (const [c, fs_, a, v] of rows) if (c === corp && a === account) { if (fs_ === 'CFS' && Number.isFinite(v)) return v; if (fs_ === 'OFS') ofs = v; }
  return ofs;
}

(async () => {
  const cc = await corpCodes();
  const months = await monthlyCaps();
  const everCodes = new Set(); for (const r of months) for (const [c] of r.caps) everCodes.add(c);
  // 우선주(끝자리 5·7·9 등)는 corpCode 에 없으므로 보통주(끝자리 0) 회사로 묶는다
  const corpOf = c => cc[c] || cc[c.slice(0, 5) + '0'];
  const corpList = [...new Set([...everCodes].map(corpOf).filter(Boolean))];
  console.log(`   KOSPI 등장 종목 ${everCodes.size}개 중 corp_code 매핑 ${corpList.length}개`);
  const fin = await dartMulti(corpList);

  // 보고서별 corp → 값 인덱스
  const idx = {};
  for (const [k, rows] of Object.entries(fin)) {
    const by = new Map();
    for (const row of rows) { if (!by.has(row[0])) by.set(row[0], []); by.get(row[0]).push(row); }
    idx[k] = { eq: c => by.has(c) ? pick(by.get(c), c, '자본총계') : NaN, ni: c => by.has(c) ? pick(by.get(c), c, '당기순이익') : NaN };
  }
  // 2022 이전 보고서에 등장한 회사만 (금융사 일관 제외 — 헤더 참고)
  const OLD = new Set();
  for (const [k, rows] of Object.entries(fin)) if (+k.slice(0, 4) <= 2022) for (const [c] of rows) OLD.add(c);
  const series = [];
  for (const { m, d, caps } of months) {
    const reps = availableReports(m).filter(([k]) => idx[k]);
    const fy = reps.filter(([, , rc]) => rc === '11011');
    let capAll = 0, capB = 0, eq = 0, capE = 0, ni = 0;
    const byCorp = new Map();   // 보통주+우선주 시총 합산, 자본·이익은 회사당 한 번
    for (const [code, cap] of caps) { capAll += cap; const corp = corpOf(code); if (corp) byCorp.set(corp, (byCorp.get(corp) || 0) + cap); }
    for (const [corp, cap] of byCorp) {
      if (!OLD.has(corp)) continue;
      const e = reps.map(([k]) => idx[k].eq(corp)).find(Number.isFinite);
      if (Number.isFinite(e) && e > 0) { capB += cap; eq += e; }
      const nI = fy.map(([k]) => idx[k].ni(corp)).find(Number.isFinite);
      if (Number.isFinite(nI)) { capE += cap; ni += nI; }
    }
    if (!eq) continue;
    series.push({ m, d, pbr: capB / eq, ey: ni / capE, covB: capB / capAll, covE: capE / capAll, n: caps.length });
  }
  fs.writeFileSync(fp('kospi-valuation-monthly.json'), JSON.stringify(series, null, 0));
  console.log(`4. 월별 ${series.length}개 → data/kospi-valuation-monthly.json`);
  for (const s of series.filter((_, i) => i % 12 === 0 || i === series.length - 1))
    console.log(`   ${s.d}  PBR ${s.pbr.toFixed(2)}  PER ${(1 / s.ey).toFixed(1)}  EY ${(s.ey * 100).toFixed(1)}%  커버리지 B ${(s.covB * 100).toFixed(0)}% / E ${(s.covE * 100).toFixed(0)}%  종목 ${s.n}`);
})().catch(e => { console.error('\n❌', e.message); process.exit(1); });
