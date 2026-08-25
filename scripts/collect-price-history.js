/**
 * collect-price-history.js — 전 종목 일별 수정주가 소급 수집 (2026-08-20)
 *
 * 목적: **상승 레짐 표본 확보.** market_flow_daily의 전 종목 수집은 2026-05-22부터라
 *   검증 가능 구간이 60거래일 단일 하락 레짐뿐이다(시총가중 −16.8%). 저변동성 우위가
 *   알파인지 하락장 베타인지는 상승 레짐 표본 없이 판정 불가(lowvol-attribution.js 참고).
 *   KOSPI 월봉 기준 2025-01 2,517 → 2026-05 8,476(+237%) 뒤 2026-07 −22.2%.
 *   이 구간을 통째로 담으면 같은 신호를 두 레짐에서 대조할 수 있다.
 *
 * API: /uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice (FHKST03010100)
 *   - **1콜당 최대 100행**. 날짜 범위를 줘도 그 범위의 "최근 100행"만 온다
 *     → 종료일을 뒤로 밀며 역방향 페이지네이션.
 *   - **FID_ORG_ADJ_PRC='0' = 수정주가.** 액면분할 연속성 확보에 필수
 *     (카카오 2021-04 5:1 분할 검증: 수정 100,759 vs 원주 502,000).
 *   - acml_tr_pbmn(거래대금)이 함께 오므로 close×volume 근사가 불필요하다.
 *
 * 산출: data/price-history.jsonl — 종목당 1행
 *   {"c":"005930","s":<현재 상장주식수>,"r":[["20240102",close,vol,val],...]}  (날짜 오름차순)
 *
 * ⚠️ 알려진 편향 — 결과 해석 시 반드시 같이 읽을 것:
 *   1. **생존편향**: 유니버스가 stock_master(= 오늘 상장된 종목)라 상폐·합병 종목이 없다.
 *      상폐 종목은 대개 고변동성 부실주 → 고변동성 그룹 성과가 실제보다 좋게 보인다
 *      → 저변동성의 상대우위는 **과소**, 상승장에서의 열위는 **과대** 추정된다.
 *      즉 "상승장에서 저변동성이 뒤진다"는 결론은 편향에 의해 부풀 수 있다.
 *   2. **시총 근사**: 과거 시총 = 수정주가 × **현재** 상장주식수. 유상증자·자사주 소각
 *      이력 미반영 → 과거 시점 cap300 구성이 부정확할 수 있다.
 *   3. **수급 소급 불가**: getInvestorData는 최근 30일 한계 → 기관/외인 신호는 이 데이터로
 *      과거 검증할 수 없다. 가격 기반 신호(변동성·베타·모멘텀·이격도)와 재무 신호
 *      (data/financials.json은 2004년까지 있음)만 소급 검증 가능.
 *
 * 실행:
 *   node scripts/collect-price-history.js --limit 3 --dry     # 샘플 확인
 *   node scripts/collect-price-history.js --from=20240101     # 전 종목 (약 17분)
 *   node scripts/collect-price-history.js --resume            # 중단분만 이어서
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const kisApi = require('../backend/kisApi');
const supabase = require('../backend/supabaseClient');

const args = process.argv.slice(2);
const argv = (k, d) => { const a = args.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const DRY = args.includes('--dry');
const RESUME = args.includes('--resume');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
const FROM = argv('from', '20240101');
const TO = argv('to', new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const OUT = path.resolve(__dirname, '../data/price-history.jsonl');

const isExcluded = (name) => /스팩|SPAC/i.test(name || '');

async function loadUniverse() {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('stock_master')
      .select('stock_code,stock_name').order('stock_code').range(f, f + 999);
    if (error) throw new Error(`stock_master 조회 실패: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out.filter(s => !isExcluded(s.stock_name));
}

const minusDay = (yyyymmdd, n) => {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  return new Date(d.getTime() - n * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
};

async function page(code, d1, d2) {
  await kisApi.rateLimiter.acquire();
  const token = await kisApi.getAccessToken();
  const res = await axios.get(`${kisApi.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`, {
    headers: {
      'Content-Type': 'application/json', 'authorization': `Bearer ${token}`,
      'appkey': kisApi.appKey, 'appsecret': kisApi.appSecret,
      'tr_id': 'FHKST03010100', 'custtype': 'P',
    },
    params: {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2,
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0', // 0: 수정주가 (액면분할 연속성)
    },
  });
  if (res.data.rt_cd !== '0') return null;
  return { o1: res.data.output1 || {}, o2: (res.data.output2 || []).filter(r => r.stck_bsop_date) };
}

async function withRetry(fn) {
  try { return await fn(); } catch (e) {
    await new Promise(r => setTimeout(r, 600));
    try { return await fn(); } catch (e2) { return null; }
  }
}

async function collectStock(code) {
  const seen = new Map();
  let shares = null, end = TO, guard = 0;
  while (guard++ < 20) {
    const p = await withRetry(() => page(code, FROM, end));
    if (!p || !p.o2.length) break;
    if (shares == null) shares = parseInt(p.o1.lstn_stcn || 0) || null;
    let oldest = null;
    for (const r of p.o2) {
      const d = r.stck_bsop_date;
      if (d < FROM) continue;
      if (!seen.has(d)) seen.set(d, [d, +r.stck_clpr || 0, +r.acml_vol || 0, +r.acml_tr_pbmn || 0]);
      if (oldest == null || d < oldest) oldest = d;
    }
    if (!oldest || oldest <= FROM) break;
    const next = minusDay(oldest, 1);
    if (next >= end) break; // 진전 없음 → 중단
    end = next;
  }
  const rows = [...seen.values()].sort((a, b) => a[0].localeCompare(b[0]));
  return { c: code, s: shares, r: rows };
}

(async () => {
  const t0 = Date.now();
  let universe = await loadUniverse();
  if (LIMIT) universe = universe.slice(0, LIMIT);

  let done = new Set();
  if (RESUME && fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).c); } catch {}
    }
    console.log(`↻ resume: 이미 수집된 ${done.size}종목 건너뜀`);
  } else if (!DRY && fs.existsSync(OUT)) {
    fs.unlinkSync(OUT);
  }

  const todo = universe.filter(s => !done.has(s.stock_code));
  console.log(`📈 수정주가 소급 수집: ${todo.length}종목 × ${FROM}~${TO} (종목당 최대 100행/콜, 역방향 페이지네이션)`);

  const ws = DRY ? null : fs.createWriteStream(OUT, { flags: 'a' });
  let ok = 0, fail = 0, totalRows = 0;
  for (let i = 0; i < todo.length; i++) {
    const rec = await collectStock(todo[i].stock_code);
    if (!rec.r.length) fail++;
    else { ok++; totalRows += rec.r.length; if (ws) ws.write(JSON.stringify(rec) + '\n'); }
    if ((i + 1) % 100 === 0 || i === todo.length - 1) {
      const el = (Date.now() - t0) / 1000;
      const eta = ((el / (i + 1)) * (todo.length - i - 1) / 60).toFixed(1);
      console.log(`  ${i + 1}/${todo.length} — ok ${ok} / 실패 ${fail} / ${totalRows.toLocaleString()}행 (${el.toFixed(0)}s, ETA ${eta}분)`);
    }
    if (DRY && i === 0) {
      console.log(`  [--dry] ${rec.c}: shares=${rec.s} rows=${rec.r.length} ${rec.r[0]?.[0]}~${rec.r[rec.r.length - 1]?.[0]}`);
      console.log('   앞 3행:', JSON.stringify(rec.r.slice(0, 3)));
      console.log('   뒤 3행:', JSON.stringify(rec.r.slice(-3)));
    }
  }
  if (ws) { ws.end(); await new Promise(r => ws.on('close', r)); console.log(`\n💾 ${OUT} — ${(fs.statSync(OUT).size / 1e6).toFixed(1)}MB / ${totalRows.toLocaleString()}행`); }
  console.log(`소요 ${((Date.now() - t0) / 60000).toFixed(1)}분`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
