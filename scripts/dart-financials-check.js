/**
 * dart-financials-check.js — DART 로 만든 재무(backend/dartFinancials.js)가 KIS 값과 같은지 대조 (2026-11-26)
 *
 * 왜: KIS 재무비율 API 가 막혀 수집처를 DART 로 바꾼다. 저PBR·E/P 포트폴리오가 관측 중이라
 *   입력의 뜻이 바뀌면 판정이 오염된다. 바꾸기 전에 KIS 값이 있는 분기(2026-03·06)에서 맞춰 본다.
 *
 * 합격 기준 (결과 보기 전에 정함):
 *   ① 두 쪽 다 있는 종목 비율 ≥ 90%
 *   ② BPS: 순위 상관 ≥ 0.98, 차이 5% 이내 종목 ≥ 85%
 *   ③ ROE: 순위 상관 ≥ 0.90
 *   ④ 실제 선택: PBR 하위 20% 집합 겹침(Jaccard) ≥ 0.85
 *   주식수 정의(보통주만 / 보통+우선주) 중 KIS 와 더 맞는 쪽을 쓴다.
 *
 * 입력: data/financials.json (KIS, 2026-10-06 수집), data/krx-daily.jsonl (시총·종가 → 주식수), data/dart-corpcode.json
 * 캐시: data/dart-multi-full/{year}_{reprt}.json (재실행 시 DART 재호출 안 함)
 * 실행: node scripts/dart-financials-check.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const DF = require('../backend/dartFinancials');

const KEY = process.env.DART_API_KEY;
const D = f => path.resolve(__dirname, '../data', f);
const CACHE = D('dart-multi-full');
fs.mkdirSync(CACHE, { recursive: true });

async function report(codes, year, reprt) {
  const f = path.join(CACHE, `${year}_${reprt}.json`);
  if (fs.existsSync(f)) return new Map(JSON.parse(fs.readFileSync(f, 'utf-8')));
  const r = await DF.fetchReport(KEY, codes, year, reprt, { log: console.log });
  console.log(`  DART ${year}/${reprt}: ${r.byCode.size}종목, 호출 ${r.calls}, 실패 묶음 ${r.errors}`);
  fs.writeFileSync(f, JSON.stringify([...r.byCode]));
  return r.byCode;
}

// 연결 회사의 지배주주 몫 (회사당 1호출, 캐시)
async function controlling(pairs, year, reprt) {
  const f = path.join(CACHE, `ctrl_${year}_${reprt}.json`);
  if (fs.existsSync(f)) return new Map(JSON.parse(fs.readFileSync(f, 'utf-8')));
  const t0 = Date.now();
  const r = await DF.fetchControlling(KEY, pairs, year, reprt, { log: console.log });
  console.log(`  DART 연결 ${year}/${reprt}: ${r.byCode.size}/${pairs.length}종목, 호출 ${r.calls}, 빈 응답 ${r.empty}, 실패 ${r.errors} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (r.errors > pairs.length * 0.01) throw new Error(`실패 ${r.errors}건 — 네트워크 확인 후 다시 실행 (캐시 안 함)`);
  fs.writeFileSync(f, JSON.stringify([...r.byCode]));
  return r.byCode;
}

// 보통주 발행·유통(자기주식 제외) 주식수 (회사당 1호출, 캐시)
async function shareCounts(pairs, year, reprt) {
  const f = path.join(CACHE, `shares_${year}_${reprt}.json`);
  if (fs.existsSync(f)) return new Map(JSON.parse(fs.readFileSync(f, 'utf-8')));
  const t0 = Date.now();
  const r = await DF.fetchShareCounts(KEY, pairs, year, reprt, { log: console.log });
  console.log(`  DART 주식수 ${year}/${reprt}: ${r.byCode.size}/${pairs.length}, 호출 ${r.calls}, 빈 응답 ${r.empty}, 실패 ${r.errors} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (r.errors > pairs.length * 0.01) throw new Error(`실패 ${r.errors}건 — 캐시 안 함`);
  fs.writeFileSync(f, JSON.stringify([...r.byCode]));
  return r.byCode;
}

// 분기말(이하) 마지막 거래일의 주식수 = 시총 ÷ 종가
function sharesAt(ym, end = ym + '31') {
  let best = null, bestD = '';
  // krx-daily.jsonl 은 날짜순이 아니다(이어 붙임) → 끝까지 본다. 없으면 2010~ 장기 파일.
  for (const f of ['krx-daily.jsonl', 'krx-daily-2010.jsonl']) {
    for (const l of fs.readFileSync(D(f), 'utf-8').split('\n')) {
      const d = l.slice(6, 14);
      if (d.slice(0, 6) === ym && d <= end && d > bestD) { best = l; bestD = d; }
    }
    if (best) break;
  }
  if (!best) throw new Error(`${ym} KRX 일별 없음`);
  const j = JSON.parse(best), common = new Map(), withPref = new Map();
  for (const [code, , , , close, , , cap] of j.s) if (close > 0 && cap > 0) common.set(code, cap / close);
  for (const [code, sh] of common) {
    if (code.endsWith('0')) {
      let t = sh;
      for (const [c2, s2] of common) if (c2 !== code && c2.slice(0, 5) === code.slice(0, 5)) t += s2;
      withPref.set(code, t);
    }
  }
  return { date: j.d, common, withPref };
}

function spearman(a, b) {
  const rk = v => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = Array(v.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const ra = rk(a), rb = rk(b), n = a.length, m = (n - 1) / 2;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { s += (ra[i] - m) * (rb[i] - m); sa += (ra[i] - m) ** 2; sb += (rb[i] - m) ** 2; }
  return s / Math.sqrt(sa * sb);
}

(async () => {
  if (!KEY) throw new Error('.env 에 DART_API_KEY 필요');
  const kis = JSON.parse(fs.readFileSync(D('financials.json'), 'utf-8')).rows;
  const cc = JSON.parse(fs.readFileSync(D('dart-corpcode.json'), 'utf-8'));
  const kisCodes = [...new Set(kis.map(r => r.code))];
  const corp = kisCodes.map(c => cc[c]).filter(Boolean);
  console.log(`KIS ${kisCodes.length}종목 중 corp_code 있음 ${corp.length}`);

  // 판정 기록용 — 제일 가까운 KRX 일자의 종가 (PBR 하위 20% 비교)
  const lastPx = sharesAt('202606');
  const px = new Map();
  for (const l of fs.readFileSync(D('krx-daily.jsonl'), 'utf-8').split('\n')) {
    if (l.slice(6, 14) === lastPx.date) { for (const [c, , , , close] of JSON.parse(l).s) px.set(c, close); break; }
  }

  let allPass = true;
  const YMS = (process.argv.find(a => a.startsWith('--ym=')) || '--ym=202606').slice(5).split(',');
  for (const ym of YMS) {
    const y = +ym.slice(0, 4), rp = DF.REPRT[ym.slice(4, 6)];
    const cur = await report(corp, y, rp), ago = await report(corp, y - 1, rp), fy = await report(corp, y - 1, '11011');
    const cfsPairs = codes => [...codes].filter(c => { const o = cur.get(c); return o && o.CFS && o.CFS.eq != null; }).map(c => [c, cc[c]]).filter(p => p[1]);
    const pairs = cfsPairs(cur.keys());
    console.log(`  연결 회사 ${pairs.length}곳 — 지배주주 몫 조회`);
    const ctrl = { cur: await controlling(pairs, y, rp), yearAgo: await controlling(pairs, y - 1, rp), prevFY: await controlling(pairs, y - 1, '11011') };
    // KIS 는 과거 분기 BPS 도 수집일(2026-10-06) 주식수로 다시 나눈다(분할·무상증자 반영) → 같은 날 주식수로 대조
    const sh = sharesAt('202610', '20261006');
    const shc = await shareCounts([...cur.keys()].map(c => [c, cc[c]]).filter(p => p[1]), y, rp);
    const fx = await DF.fxToKrw(ym);
    console.log(`  환율(${ym} 말): ${JSON.stringify(fx.rates)}`);
    const sharesBy = {
      common: c => sh.common.get(c),
      treasury: c => { const b = sh.common.get(c), t = shc.get(c); return b && t ? b * t.distb / t.istc : b; },
    };
    const kisAt = new Map(kis.filter(r => r.ym === ym).map(r => [r.code, r]));
    console.log(`\n━━ ${ym} (주식수 기준일 ${sh.date}) — KIS ${kisAt.size}종목`);

    const results = {};
    for (const def of ['common', 'treasury']) {
      const { rows, skipped } = DF.buildRows(ym, cur, ago, fy, sharesBy[def], ctrl, fx);
      const dm = new Map(rows.map(r => [r.code, r]));
      const both = [...kisAt.keys()].filter(c => dm.has(c) && kisAt.get(c).bps > 0 && dm.get(c).bps > 0);
      const kb = both.map(c => kisAt.get(c).bps), db = both.map(c => dm.get(c).bps);
      const within = both.filter(c => Math.abs(dm.get(c).bps / kisAt.get(c).bps - 1) <= 0.05).length;
      const rb = both.filter(c => kisAt.get(c).roe != null && dm.get(c).roe != null);
      const roeS = spearman(rb.map(c => kisAt.get(c).roe), rb.map(c => dm.get(c).roe));
      const roeWithin = rb.filter(c => Math.abs(dm.get(c).roe - kisAt.get(c).roe) <= 1).length;
      // PBR 하위 20%
      const withPx = both.filter(c => px.get(c) > 0);
      const low = (get) => { const s = withPx.map(c => [c, px.get(c) / get(c)]).sort((a, b) => a[1] - b[1]); return new Set(s.slice(0, Math.round(s.length * 0.2)).map(x => x[0])); };
      const A = low(c => kisAt.get(c).bps), B = low(c => dm.get(c).bps);
      const inter = [...A].filter(c => B.has(c)).length, jac = inter / (A.size + B.size - inter);
      results[def] = { both: both.length, cover: both.length / kisAt.size, bpsS: spearman(kb, db), within: within / both.length, roeS, roeWithin: roeWithin / rb.length, jac, skipped, dm, both_: both };
      console.log(`  [${def}] 대조 ${both.length} (${(results[def].cover * 100).toFixed(1)}%) | BPS 순위상관 ${results[def].bpsS.toFixed(4)}, ±5% 이내 ${(results[def].within * 100).toFixed(1)}% | ROE 순위상관 ${roeS.toFixed(3)}, ±1%p 이내 ${(results[def].roeWithin * 100).toFixed(1)}% | PBR 하위20% Jaccard ${jac.toFixed(3)} | 제외 ${JSON.stringify(skipped)}`);
    }
    const def = results.treasury.within > results.common.within ? 'treasury' : 'common';
    const r = results[def];
    const pass = r.cover >= 0.9 && r.bpsS >= 0.98 && r.within >= 0.85 && r.roeS >= 0.90 && r.jac >= 0.85;
    allPass = allPass && pass;
    console.log(`  → 주식수 정의 ${def}: ${pass ? '✅ 합격' : '❌ 불합격'}`);
    // 차이 큰 종목
    const big = r.both_.map(c => [c, kisAt.get(c).bps, r.dm.get(c).bps, r.dm.get(c).fs]).filter(x => Math.abs(x[2] / x[1] - 1) > 0.05)
      .sort((a, b) => Math.abs(b[2] / b[1] - 1) - Math.abs(a[2] / a[1] - 1)).slice(0, 12);
    console.log('  BPS 차이 큰 종목 (코드 KIS DART 구분):', big.map(x => x.join(' ')).join(' | '));
    const s = ['005930', '000660', '035720'].map(c => kisAt.get(c) && r.dm.get(c) ? `${c} KIS bps ${kisAt.get(c).bps} roe ${kisAt.get(c).roe} eps ${kisAt.get(c).eps} / DART bps ${r.dm.get(c).bps} roe ${r.dm.get(c).roe} eps ${r.dm.get(c).eps}` : c).join('\n    ');
    console.log('  표본:\n    ' + s);
  }
  console.log(`\n종합: ${allPass ? '✅ 두 분기 모두 합격' : '❌ 불합격 — 교체하지 말 것'}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
