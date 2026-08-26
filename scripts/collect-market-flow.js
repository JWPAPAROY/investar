/**
 * 전 상장종목 일별 수급+가격 수집기 (v3.93, 2026-07-06)
 *
 * 목적: "풀 밖 수급-우선 신호" 가설 검증용 전 종목 시계열 축적 (→ supabase-market-flow.sql 주석 참고).
 * 실행: GitHub Actions 평일 17:50 KST (.github/workflows/collect-market-flow.yml) 또는 수동.
 *
 *   node scripts/collect-market-flow.js              # 일일 수집 (최근 7일 upsert, 자가복구)
 *   node scripts/collect-market-flow.js --backfill   # 최초 시드 (최근 30일 upsert)
 *   node scripts/collect-market-flow.js --limit 5 --dry  # 테스트 (DB 미기록, 샘플 출력)
 *
 * 설계 노트:
 * - 종목당 KIS 3콜(투자자/일봉/현재가) × ~2,600종목 ≈ 7,800콜, RateLimiter(18/s)로 약 8~10분.
 * - upsert 멱등: (stock_code, trade_date) PK. 매 실행이 최근 N일을 덮어쓰므로 하루 이틀
 *   실행이 빠져도 다음 실행이 메꿈. 당일 투자자 잠정치도 다음 실행에서 확정치로 갱신됨.
 * - 부분 실패 격리: 투자자/일봉 중 한쪽만 성공해도 해당 컬럼만 upsert (PostgREST는
 *   payload에 없는 컬럼을 건드리지 않음). 버퍼를 스키마별로 분리해 키 불일치 방지.
 * - market_cap: 현재가 API의 시총/현재가로 상장주식수를 역산해 각 날짜 종가에 곱한 근사치.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const kisApi = require('../backend/kisApi');
const supabase = require('../backend/supabaseClient');

const args = process.argv.slice(2);
const BACKFILL = args.includes('--backfill');
const DRY = args.includes('--dry');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
const DEPTH = BACKFILL ? 30 : 7;

const toIso = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

// v3.96: 이번 실행이 실제로 기록한 (종목,날짜). 수집 후 KRX 거래대금을 이 조합에만 채운다
//   (없는 조합에 upsert하면 close/volume이 빈 반쪽 행이 생긴다).
const writtenPairs = new Set();

// 상장법인 목록에 섞인 스팩 제외 (ETF/ETN은 KIND 목록에 원래 없음)
const isExcluded = (name) => /스팩|SPAC/i.test(name || '');

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

/**
 * 경량 현재가 조회: 시총(hts_avls, 억원)·업종(bstp_kor_isnm)·현재가만 추출.
 * kisApi.getCurrentPrice()는 종목명 누락 시 CTPF1002R 추가 호출 + 디버그 로그가 있어
 * 전 종목 루프(~2,600회)에는 부적합 → 동일 엔드포인트를 최소 형태로 직접 호출.
 */
async function fetchMeta(stockCode) {
  await kisApi.rateLimiter.acquire();
  try {
    const token = await kisApi.getAccessToken();
    const res = await axios.get(`${kisApi.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`, {
      headers: {
        'Content-Type': 'application/json', 'authorization': `Bearer ${token}`,
        'appkey': kisApi.appKey, 'appsecret': kisApi.appSecret,
        'tr_id': 'FHKST01010100', 'custtype': 'P',
      },
      params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: stockCode },
    });
    const o = res.data.rt_cd === '0' ? res.data.output : null;
    if (!o || !o.stck_prpr) return null;
    return {
      currentPrice: parseInt(o.stck_prpr) || 0,
      marketCap: (parseInt(o.hts_avls) || 0) * 100000000, // 억원 → 원
      sectorName: o.bstp_kor_isnm || null,
    };
  } catch (e) {
    return null;
  }
}

// 스키마별 버퍼 (PostgREST 일괄 upsert는 배치 내 키 일치 필요)
const buffers = { full: [], flowOnly: [], chartOnly: [] };
const stats = { full: 0, flowOnly: 0, chartOnly: 0, stocksOk: 0, stocksFail: 0, flowFail: 0, chartFail: 0 };

async function flush(kind, force = false) {
  const buf = buffers[kind];
  if (!buf.length || (!force && buf.length < 1000)) return;
  const batch = buf.splice(0, buf.length);
  if (DRY) { stats[kind] += batch.length; return; }
  const { error } = await supabase.from('market_flow_daily')
    .upsert(batch, { onConflict: 'stock_code,trade_date' });
  if (error) throw new Error(`upsert 실패(${kind}, n=${batch.length}): ${error.message}`);
  stats[kind] += batch.length;
}

// KIS는 간헐적 500을 뱉음 → 600ms 후 1회 재시도, 그래도 실패면 null (다음 실행이 자가복구)
async function withRetry(fn) {
  try { return await fn(); } catch (e) {
    await new Promise(r => setTimeout(r, 600));
    try { return await fn(); } catch (e2) { return null; }
  }
}

async function collectStock(s) {
  const [inv, chart, cur] = [
    await withRetry(() => kisApi.getInvestorData(s.stock_code, DEPTH)),
    await withRetry(() => kisApi.getDailyChart(s.stock_code, DEPTH)),
    await fetchMeta(s.stock_code), // 실패 시 null (시총/업종만 결측, 수집은 계속)
  ];
  if (!inv && !chart) { stats.stocksFail++; return; }
  if (!inv) stats.flowFail++;
  if (!chart) stats.chartFail++;

  // 상장주식수 역산 → 날짜별 시총 근사
  const shares = (cur && cur.marketCap > 0 && cur.currentPrice > 0)
    ? cur.marketCap / cur.currentPrice : null;
  const sector = (cur && cur.sectorName) || null;
  const capAt = (close) => (shares && close > 0) ? Math.round(shares * close) : null;

  const chartByDate = new Map((chart || []).map(c => [c.date, c]));
  const invByDate = new Map((inv || []).map(v => [v.date, v]));
  const dates = new Set([...chartByDate.keys(), ...invByDate.keys()]);
  // v3.97: getDailyChart가 FHKST03010100으로 바뀌며 거래대금이 실제로 온다.
  //   (기존 FHKST01010400은 acml_tr_pbmn을 안 줘서 NaN → 전 구간 NULL이었다)
  const num = (v) => Number.isFinite(v) ? v : null;

  for (const d of dates) {
    const c = chartByDate.get(d), v = invByDate.get(d);
    const close = (c && c.close) || (v && v.closePrice) || null;
    const base = { stock_code: s.stock_code, trade_date: toIso(d), close, market_cap: capAt(close), sector_name: sector };
    writtenPairs.add(s.stock_code + '|' + toIso(d));
    if (c && v) {
      buffers.full.push({
        ...base, open: num(c.open), high: num(c.high), low: num(c.low), volume: num(c.volume), trading_value: num(c.tradingValue),
        inst_net_qty: num(v.institution.netBuyQty), inst_net_value: num(v.institution.netBuyValue),
        frgn_net_qty: num(v.foreign.netBuyQty), frgn_net_value: num(v.foreign.netBuyValue),
        prsn_net_value: num(v.individual.netBuyValue),
      });
    } else if (v) {
      buffers.flowOnly.push({
        ...base,
        inst_net_qty: num(v.institution.netBuyQty), inst_net_value: num(v.institution.netBuyValue),
        frgn_net_qty: num(v.foreign.netBuyQty), frgn_net_value: num(v.foreign.netBuyValue),
        prsn_net_value: num(v.individual.netBuyValue),
      });
    } else {
      buffers.chartOnly.push({ ...base, open: num(c.open), high: num(c.high), low: num(c.low), volume: num(c.volume), trading_value: num(c.tradingValue) });
    }
  }
  stats.stocksOk++;

  if (DRY && stats.stocksOk <= 3) {
    console.log(`\n[DRY] ${s.stock_name}(${s.stock_code}) dates=${dates.size} sector=${sector}`);
    console.log(JSON.stringify(buffers.full[buffers.full.length - 1] || buffers.flowOnly[buffers.flowOnly.length - 1], null, 2));
  }
  for (const k of Object.keys(buffers)) await flush(k);
}

(async () => {
  const t0 = Date.now();
  if (!supabase) throw new Error('Supabase 환경변수 미설정 (SUPABASE_URL/SUPABASE_ANON_KEY)');
  let universe = await loadUniverse();
  if (LIMIT > 0) universe = universe.slice(0, LIMIT);
  console.log(`📥 수집 시작: ${universe.length}종목, depth=${DEPTH}일${BACKFILL ? ' (백필)' : ''}${DRY ? ' [DRY]' : ''}`);

  for (let i = 0; i < universe.length; i++) {
    try {
      await collectStock(universe[i]);
    } catch (e) {
      // upsert 실패 등 치명 오류는 전파 (조용한 데이터 유실 방지), 그 외는 위에서 격리됨
      throw e;
    }
    if ((i + 1) % 200 === 0) {
      const el = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  … ${i + 1}/${universe.length} (${el}분, ok=${stats.stocksOk} fail=${stats.stocksFail})`);
    }
  }
  for (const k of Object.keys(buffers)) await flush(k, true);

  // v3.97: KRX 거래대금 보충 제거 — **KIS가 직접 준다.**
  //   v3.96에서 "거래대금은 KIS에 없다"고 판단해 KRX를 하루 2콜씩 더 부르고 161,516행을
  //   백필했지만, 그건 TR 하나(FHKST01010400)의 한계였을 뿐이다. FHKST03010100은
  //   acml_tr_pbmn을 준다 — 실측 대조에서 KRX와 **오차 0.000%**(5종목, 2026-08-21).
  //   덤으로 당일치도 즉시 온다(KRX는 다음 날 공표라 하루 늦었다).
  //   KRX 백필 스크립트(scripts/backfill-trading-value.js)는 과거 구멍 메우기용으로 남긴다.

  // v3.97: KRX 실측 시총·상장주식수 채우기.
  //   market_cap 은 KIS 현재가 API에서 역산한 근사치라 어긋난다
  //   (NAVER −3.1%, 018700 +42.7%, 2026-08-21 대조. 3% 초과가 하루 8~17종목).
  //   저PBR·저변동 포트폴리오의 유니버스가 시총 상위 300이고, **백테스트가 KRX MKTCAP으로
  //   검증됐다** — 실운용이 다른 시총을 쓰면 순위가 달라져 성과 비교가 성립하지 않는다.
  //   ⚠️ KRX는 다음 날 공표라 당일치는 비어 있다. 당일 시총은 소비 측에서
  //     krx_listed_shares(최신값) × 당일 종가로 계산한다(build-portfolio.js).
  if (!DRY) {
    try {
      const { fetchKrxTradingValue } = require('./backfill-trading-value');
      const WINDOW = BACKFILL ? 60 : 20;
      const cutoff = new Date(Date.now() + 9 * 3600e3 - WINDOW * 86400e3).toISOString().slice(0, 10);
      const dates = [...new Set([...writtenPairs].map(k => k.split('|')[1]))].sort().filter(d => d >= cutoff);
      let capRows = 0, capDays = 0;
      for (const date of dates) {
        const vals = await fetchKrxTradingValue(date.replace(/-/g, ''));
        if (!vals) continue;
        capDays++;
        const rows = [];
        for (const [code, v] of vals) {
          if (!writtenPairs.has(code + '|' + date)) continue;
          if (v.marketCap == null && v.listedShares == null) continue;
          rows.push({ stock_code: code, trade_date: date, krx_market_cap: v.marketCap, krx_listed_shares: v.listedShares });
        }
        for (let i2 = 0; i2 < rows.length; i2 += 500) {
          const { error } = await supabase.from('market_flow_daily')
            .upsert(rows.slice(i2, i2 + 500), { onConflict: 'stock_code,trade_date' });
          if (error) { console.warn('⚠️ KRX 시총 upsert 실패(' + date + '): ' + error.message); break; }
          capRows += Math.min(500, rows.length - i2);
        }
      }
      console.log('🏛️ KRX 실측 시총: ' + capDays + '일 / ' + capRows + '행');
    } catch (e) {
      console.warn('⚠️ KRX 시총 채우기 실패(수집 자체는 성공):', e.message);
    }
  }

  const el = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n✅ 완료 (${el}분): 종목 ok=${stats.stocksOk} fail=${stats.stocksFail} | rows full=${stats.full} flowOnly=${stats.flowOnly} chartOnly=${stats.chartOnly} | 부분실패 flow=${stats.flowFail} chart=${stats.chartFail}`);
  // 실패율 20% 초과 시 비정상 종료 → Actions 실패 알림으로 감지
  if (stats.stocksFail > universe.length * 0.2) {
    console.error(`❌ 종목 실패율 ${(stats.stocksFail / universe.length * 100).toFixed(0)}% > 20% — 비정상`);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error('❌ 수집 중단:', e.message); process.exit(1); });
