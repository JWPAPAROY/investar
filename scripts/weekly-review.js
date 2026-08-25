// 최근 주간 성과 점검 — 임시 분석 스크립트 (2026-08-07)
//
// perf-final.js 와 다른 점 (의도적):
//  - KOSPI 벤치마크를 kospi_close 시계열로 산출한다. kospi_close_change 는 yahooQuote
//    last-two-bars 오정렬 이력이 있어 사용 금지(메모리 제약).
//  - TOP1 을 total_score 내림차순이 아니라 top3_rank 컬럼(v3.94~)으로 잡는다.
//    정렬 로직이 버전마다 달라 점수 기준 TOP1 은 실제 🥇와 다르다(과거는 NULL).
//  - 주 단위로 잘라 최근 구간의 변화를 본다.

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const DAYS = parseInt(process.argv[2] || '90', 10);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fmt = x => (x == null ? '  N/A' : (x >= 0 ? '+' : '') + x.toFixed(2));
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) + '%' : ' - ');

// 월요일 시작 주 키
function weekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);

  const recs = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from('screening_recommendations')
      .select('id,recommendation_date,stock_name,is_top3,top3_rank,total_score,sector_name,market_cap,market_regime')
      .gte('recommendation_date', since).order('recommendation_date', { ascending: true }).range(f, f + 999);
    recs.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const ids = recs.map(r => r.id), pm = {};
  for (let i = 0; i < ids.length; i += 200) {
    const c = ids.slice(i, i + 200);
    for (let f = 0; ; f += 1000) {
      const { data: dp } = await sb.from('recommendation_daily_prices')
        .select('recommendation_id,days_since_recommendation,cumulative_return').in('recommendation_id', c).range(f, f + 999);
      (dp || []).forEach(p => { (pm[p.recommendation_id] ??= {})[p.days_since_recommendation] = p.cumulative_return; });
      if (!dp || dp.length < 1000) break;
    }
  }
  // strict: 목표일 이하의 가장 가까운 관측만. 미래 데이터를 끌어오지 않는다.
  const retAt = (id, t) => {
    const m = pm[id]; if (!m) return null;
    let b = null, bd = -1;
    for (const d of Object.keys(m).map(Number)) if (d <= t && d > bd) { bd = d; b = m[d]; }
    return b;
  };
  // 완성 여부: 목표일 이상 관측이 실제로 존재하는가
  const isComplete = (id, t) => Object.keys(pm[id] || {}).some(d => Number(d) >= t);

  const top3 = recs.filter(r => r.is_top3);

  // ── KOSPI: 종가 시계열로 직접 산출
  const { data: op } = await sb.from('overnight_predictions')
    .select('prediction_date,kospi_close').gte('prediction_date', since).lt('prediction_date', '2027-01-01')
    .order('prediction_date', { ascending: true });
  const kseries = (op || []).filter(r => r.kospi_close != null);
  const kByDate = new Map(kseries.map(r => [r.prediction_date, r.kospi_close]));
  const kDates = kseries.map(r => r.prediction_date);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`주간 성과 점검 — ${since} ~ ${new Date().toISOString().slice(0, 10)} (${DAYS}일)`);
  console.log('='.repeat(72));

  // ── 1. 주별 TOP3 성과 + KOSPI
  console.log(`\n[1] 주별 TOP3 (추천일 기준 주, D+1 매수 → D+N 매도)\n`);
  console.log('주(월)         픽   D+1완성  D+1평균  승률 |  D+10완성 D+10평균  승률 | KOSPI주간');
  console.log('-'.repeat(88));
  const weeks = [...new Set(top3.map(r => weekKey(r.recommendation_date)))].sort();
  for (const w of weeks) {
    const set = top3.filter(r => weekKey(r.recommendation_date) === w);
    const r1 = set.filter(r => isComplete(r.id, 1)).map(r => retAt(r.id, 1)).filter(v => v != null);
    const r10 = set.filter(r => isComplete(r.id, 10)).map(r => retAt(r.id, 10)).filter(v => v != null);
    const wd = kDates.filter(d => weekKey(d) === w);
    let kw = null;
    if (wd.length >= 2) kw = (kByDate.get(wd[wd.length - 1]) / kByDate.get(wd[0]) - 1) * 100;
    console.log(
      `${w}  ${String(set.length).padStart(3)}  ${String(r1.length).padStart(6)}  ${fmt(mean(r1)).padStart(7)}%  ${pct(r1.filter(v => v > 0).length, r1.length).padStart(4)} | ` +
      `${String(r10.length).padStart(7)}  ${fmt(mean(r10)).padStart(7)}%  ${pct(r10.filter(v => v > 0).length, r10.length).padStart(4)} | ${fmt(kw).padStart(7)}%`,
    );
  }

  // ── 2. 최근 7일 / 이전 구간 비교
  const cut = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  console.log(`\n[2] 최근 7일(${cut}~) vs 이전 구간 — 지평별\n`);
  console.log('구간         지평   n   평균     중앙     승률');
  console.log('-'.repeat(50));
  for (const [label, set] of [
    ['최근7일', top3.filter(r => r.recommendation_date >= cut)],
    ['이전   ', top3.filter(r => r.recommendation_date < cut)],
  ]) {
    for (const h of [1, 3, 5, 10]) {
      const r = set.filter(x => isComplete(x.id, h)).map(x => retAt(x.id, h)).filter(v => v != null);
      if (!r.length) { console.log(`${label}     D+${String(h).padEnd(2)}   0     -        -        -`); continue; }
      console.log(`${label}     D+${String(h).padEnd(2)} ${String(r.length).padStart(3)} ${fmt(mean(r)).padStart(7)}% ${fmt(med(r)).padStart(7)}% ${pct(r.filter(v => v > 0).length, r.length).padStart(6)}`);
    }
    console.log('-'.repeat(50));
  }

  // ── 3. KOSPI 최근 흐름
  console.log(`\n[3] KOSPI 종가 (최근 12거래일)\n`);
  const tail = kseries.slice(-12);
  for (const r of tail) {
    const i = kseries.indexOf(r);
    const ch = i > 0 ? (r.kospi_close / kseries[i - 1].kospi_close - 1) * 100 : null;
    console.log(`  ${r.prediction_date}  ${String(Math.round(r.kospi_close)).padStart(6)}  ${fmt(ch).padStart(6)}%`);
  }
  if (kseries.length >= 2) {
    const last = kseries[kseries.length - 1].kospi_close;
    const d5 = kseries.length >= 6 ? (last / kseries[kseries.length - 6].kospi_close - 1) * 100 : null;
    const d10 = kseries.length >= 11 ? (last / kseries[kseries.length - 11].kospi_close - 1) * 100 : null;
    const d20 = kseries.length >= 21 ? (last / kseries[kseries.length - 21].kospi_close - 1) * 100 : null;
    console.log(`\n  5거래일 ${fmt(d5)}% / 10거래일 ${fmt(d10)}% / 20거래일 ${fmt(d20)}%`);
  }

  // ── 4. 알파: 동일 보유구간 KOSPI 대비
  console.log(`\n[4] 매칭 알파 (각 픽의 D+1~D+10 실제 보유구간과 같은 날짜의 KOSPI 수익 차감)\n`);
  const alphaRows = [];
  for (const r of top3) {
    if (!isComplete(r.id, 10)) continue;
    const ret = retAt(r.id, 10);
    if (ret == null) continue;
    const di = kDates.indexOf(r.recommendation_date);
    if (di < 0 || di + 10 >= kDates.length) continue;
    const kRet = (kByDate.get(kDates[di + 10]) / kByDate.get(kDates[di + 1]) - 1) * 100;
    alphaRows.push({ w: weekKey(r.recommendation_date), a: ret - kRet, ret, kRet });
  }
  console.log('주(월)          n   TOP3평균   KOSPI동구간   알파');
  console.log('-'.repeat(56));
  for (const w of [...new Set(alphaRows.map(x => x.w))].sort()) {
    const g = alphaRows.filter(x => x.w === w);
    console.log(`${w}  ${String(g.length).padStart(3)}  ${fmt(mean(g.map(x => x.ret))).padStart(7)}%  ${fmt(mean(g.map(x => x.kRet))).padStart(9)}%  ${fmt(mean(g.map(x => x.a))).padStart(7)}%p`);
  }
  if (alphaRows.length) {
    const a = alphaRows.map(x => x.a);
    console.log('-'.repeat(56));
    console.log(`전체        ${String(a.length).padStart(3)}  ${fmt(mean(alphaRows.map(x => x.ret))).padStart(7)}%  ${fmt(mean(alphaRows.map(x => x.kRet))).padStart(9)}%  ${fmt(mean(a)).padStart(7)}%p  (알파승률 ${pct(a.filter(v => v > 0).length, a.length)})`);
  }

  // ── 5. 업종 · 시총 · 레짐
  console.log(`\n[5] 최근 30일 픽 구성\n`);
  const r30 = top3.filter(r => r.recommendation_date >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
  const bySector = {};
  for (const r of r30) (bySector[r.sector_name || '미상'] ??= []).push(r);
  for (const [s, g] of Object.entries(bySector).sort((a, b) => b[1].length - a[1].length)) {
    const v = g.filter(x => isComplete(x.id, 10)).map(x => retAt(x.id, 10)).filter(x => x != null);
    console.log(`  ${s.padEnd(12)} 픽 ${String(g.length).padStart(2)}  D+10완성 ${String(v.length).padStart(2)}  평균 ${fmt(mean(v)).padStart(7)}%`);
  }
  const caps = r30.map(r => r.market_cap).filter(v => v != null);
  if (caps.length) {
    const t = caps.map(c => c / 1e12);
    console.log(`\n  시총(조원): 중앙 ${med(t).toFixed(1)} / 최소 ${Math.min(...t).toFixed(2)} / 1조 미만 ${caps.filter(c => c < 1e12).length}건`);
  }
  const regimes = {};
  for (const r of r30) regimes[r.market_regime || 'null'] = (regimes[r.market_regime || 'null'] || 0) + 1;
  console.log(`  레짐 분포(최근30일 픽): ${JSON.stringify(regimes)}`);
  const ranked = top3.filter(r => r.top3_rank != null).length;
  console.log(`  top3_rank 기록된 픽: ${ranked}/${top3.length}건`);

  // ── 6. 무픽일
  const recDates = [...new Set(top3.map(r => r.recommendation_date))];
  const recent = kDates.filter(d => d >= cut);
  console.log(`\n[6] 최근 7거래일 추천 유무`);
  for (const d of recent) console.log(`  ${d}  ${recDates.includes(d) ? `픽 ${top3.filter(r => r.recommendation_date === d).length}건` : '무픽'}`);
})();
