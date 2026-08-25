/**
 * collect-financials.js — 전 상장종목 분기 재무비율 수집기 (2026-08-20)
 *
 * 목적: "재무지표를 반영한 선별 로직" 가설 검증용 point-in-time 펀더멘털 확보.
 *   2026-08-08 전 시장 스캔 결론 = "고칠 곳은 지표가 아니라 풀 구성". 방어 대형주가
 *   하락장에도 플러스였는데 현 거래량 깔때기가 구조적으로 못 봤다. 가치·퀄리티 지표가
 *   그 집합을 복원하는지 보려면 전 종목 × 분기 재무가 필요하다.
 *
 * API: /uapi/domestic-stock/v1/finance/financial-ratio (FHKST66430300, FID_DIV_CLS_CODE=1=분기)
 *   → stac_yymm(결산년월) 단위 배열. grs(매출증가율) bsop_prfi_inrt(영업이익증가율)
 *     ntin_inrt(순이익증가율) roe_val eps sps bps rsrv_rate(유보율) lblt_rate(부채비율)
 *
 * ⚠️ 전방참조 방지: stac_yymm은 "결산" 기준이라 그 시점엔 아직 공시 전이다.
 *   사용 시점은 반드시 결산월말 + LAG_DAYS(기본 45일) 이후. 이 스크립트는 원본만
 *   저장하고 lag는 소비 측(direction-signal-battery.js)에서 적용한다.
 *
 * PER/PBR은 저장하지 않는다 — market_flow_daily의 일별 close/market_cap과 조합해
 *   PBR = close/BPS, PER = close/EPS(TTM)로 매일 재계산하는 게 point-in-time이다.
 *   (kisApi.getCurrentPrice()의 per/pbr은 오늘 스냅샷이라 과거 검증에 쓸 수 없다.)
 *
 * 실행:
 *   node scripts/collect-financials.js --limit 5 --dry   # 샘플 확인 (파일 미기록)
 *   node scripts/collect-financials.js                   # 전 종목 → data/financials.json
 *   node scripts/collect-financials.js --push            # 위 + stock_financials 테이블 upsert
 *   node scripts/collect-financials.js --push-file       # 재수집 없이 기존 json만 upsert
 *
 * 산출: data/financials.json  { collectedAt, rows: [{code, ym, roe, eps, sps, bps, ...}] }
 *   ~2,600종목 × 분기 10개 ≈ 26,000행 (~3MB). 분기 1회 재실행이면 충분.
 * 비용: 종목당 1콜, RateLimiter(18/s)로 약 2~3분.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const kisApi = require('../backend/kisApi');
const supabase = require('../backend/supabaseClient');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const PUSH = args.includes('--push');
// v3.96: 재수집 없이 기존 data/financials.json 만 DB로 올린다.
//   --push는 KIS 2,600콜을 다시 부르는데, 이미 수집된 스냅샷을 그대로 올리고 싶을 때가 있다
//   (분석 스크립트가 읽은 것과 **같은 데이터셋**을 DB에 두려면 재수집이 오히려 방해).
const PUSH_ONLY = args.includes('--push-file');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
const OUT = path.resolve(__dirname, '../data/financials.json');

const isExcluded = (name) => /스팩|SPAC/i.test(name || '');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

async function loadUniverse() {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('stock_master')
      .select('stock_code,stock_name,market').order('stock_code').range(f, f + 999);
    if (error) throw new Error(`stock_master 조회 실패: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out.filter(s => !isExcluded(s.stock_name));
}

async function fetchRatios(stockCode) {
  await kisApi.rateLimiter.acquire();
  const token = await kisApi.getAccessToken();
  const res = await axios.get(`${kisApi.baseUrl}/uapi/domestic-stock/v1/finance/financial-ratio`, {
    headers: {
      'Content-Type': 'application/json', 'authorization': `Bearer ${token}`,
      'appkey': kisApi.appKey, 'appsecret': kisApi.appSecret,
      'tr_id': 'FHKST66430300', 'custtype': 'P',
    },
    params: {
      FID_DIV_CLS_CODE: '1',            // 0: 년, 1: 분기
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: stockCode,
    },
  });
  if (res.data.rt_cd !== '0') return null;
  const out = res.data.output;
  if (!Array.isArray(out)) return null;
  return out
    .filter(o => o.stac_yymm && /^\d{6}$/.test(o.stac_yymm))
    .map(o => ({
      code: stockCode,
      ym: o.stac_yymm,           // 결산년월 (공시 시점 아님 — lag 필요)
      grs: num(o.grs),           // 매출액 증가율 %
      opInc: num(o.bsop_prfi_inrt), // 영업이익 증가율 % (적자/흑전/적전은 0)
      niInc: num(o.ntin_inrt),   // 순이익 증가율 %
      roe: num(o.roe_val),       // ROE %
      eps: num(o.eps),           // 주당순이익 (원)
      sps: num(o.sps),           // 주당매출액 (원)
      bps: num(o.bps),           // 주당순자산 (원)
      rsrv: num(o.rsrv_rate),    // 유보율 %
      debt: num(o.lblt_rate),    // 부채비율 %
    }));
}

// KIS는 간헐적 500을 뱉음 → 600ms 후 1회 재시도
async function withRetry(fn) {
  try { return await fn(); } catch (e) {
    await new Promise(r => setTimeout(r, 600));
    try { return await fn(); } catch (e2) { return null; }
  }
}

(async () => {
  if (PUSH_ONLY) {
    const cached = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const rows = cached.rows || [];
    // (stock_code, stac_yymm)은 PK다. 원본에 같은 키가 7건 있는데 한쪽이 전부 0인
    //   빈 레코드다(KIS가 같은 분기를 두 번 주며 하나는 공백). 그대로 upsert하면
    //   'ON CONFLICT DO UPDATE command cannot affect row a second time'로 실패한다.
    //   → 값이 채워진 쪽(0이 아닌 필드가 많은 쪽)을 남긴다.
    const score = (r) => ['grs','opInc','niInc','roe','eps','sps','bps','rsrv','debt']
      .reduce((n, k) => n + (r[k] ? 1 : 0), 0);
    const uniq = new Map();
    for (const r of rows) {
      const k = r.code + '|' + r.ym;
      const prev = uniq.get(k);
      if (!prev || score(r) > score(prev)) uniq.set(k, r);
    }
    if (uniq.size !== rows.length) console.log(`   중복 키 ${rows.length - uniq.size}건 제거 (빈 레코드 쪽 폐기)`);

    console.log(`📤 ${OUT} → stock_financials (${rows.length}행, 수집시각 ${cached.collectedAt})`);
    const batch = [...uniq.values()].map(r => ({
      stock_code: r.code, stac_yymm: r.ym, revenue_growth: r.grs, op_profit_growth: r.opInc,
      net_income_growth: r.niInc, roe: r.roe, eps: r.eps, sps: r.sps, bps: r.bps,
      reserve_rate: r.rsrv, debt_ratio: r.debt,
    }));
    let done = 0;
    for (let i = 0; i < batch.length; i += 1000) {
      const { error } = await supabase.from('stock_financials')
        .upsert(batch.slice(i, i + 1000), { onConflict: 'stock_code,stac_yymm' });
      if (error) throw new Error(`upsert 실패(${i}): ${error.message}`);
      done += Math.min(1000, batch.length - i);
      if (done % 10000 === 0 || done === batch.length) console.log(`   … ${done}/${batch.length}`);
    }
    console.log(`✅ 완료 — ${done}행`);
    return;
  }

  const t0 = Date.now();
  let universe = await loadUniverse();
  if (LIMIT) universe = universe.slice(0, LIMIT);
  console.log(`📊 재무비율 수집: ${universe.length}종목 (분기, 종목당 1콜)`);

  const rows = [];
  let ok = 0, empty = 0, fail = 0;
  for (let i = 0; i < universe.length; i++) {
    const s = universe[i];
    const r = await withRetry(() => fetchRatios(s.stock_code));
    if (r === null) { fail++; }
    else if (!r.length) { empty++; }
    else { ok++; rows.push(...r); }
    if ((i + 1) % 200 === 0 || i === universe.length - 1) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${i + 1}/${universe.length} — ok ${ok} / 빈응답 ${empty} / 실패 ${fail} / ${rows.length}행 (${el}s)`);
    }
  }

  if (DRY) {
    console.log('\n[--dry] 샘플 5행:');
    console.table(rows.slice(0, 5));
    const yms = [...new Set(rows.map(r => r.ym))].sort();
    console.log('결산년월 분포:', yms.join(', '));
    return;
  }

  const payload = { collectedAt: new Date().toISOString(), source: 'FHKST66430300', rows };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`\n💾 ${OUT} — ${rows.length}행 (${(fs.statSync(OUT).size / 1e6).toFixed(1)}MB)`);
  const yms = [...new Set(rows.map(r => r.ym))].sort();
  console.log(`결산년월: ${yms[0]} ~ ${yms[yms.length - 1]} (${yms.length}개 분기)`);

  if (PUSH) {
    const batch = rows.map(r => ({
      stock_code: r.code, stac_yymm: r.ym, revenue_growth: r.grs, op_profit_growth: r.opInc,
      net_income_growth: r.niInc, roe: r.roe, eps: r.eps, sps: r.sps, bps: r.bps,
      reserve_rate: r.rsrv, debt_ratio: r.debt,
    }));
    for (let f = 0; f < batch.length; f += 1000) {
      const { error } = await supabase.from('stock_financials')
        .upsert(batch.slice(f, f + 1000), { onConflict: 'stock_code,stac_yymm' });
      if (error) throw new Error(`upsert 실패: ${error.message} (supabase-stock-financials.sql 실행했는지 확인)`);
    }
    console.log(`☁️  stock_financials upsert 완료 (${batch.length}행)`);
  }
  console.log(`\n소요 ${((Date.now() - t0) / 1000 / 60).toFixed(1)}분`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
