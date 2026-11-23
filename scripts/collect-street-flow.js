/**
 * 월가 흐름 수집 (2026-11-23) — backend/streetFlow.js 설명 참고
 *
 *   node scripts/collect-street-flow.js                 # 최근 4일 다시 받아 집계 → macro_snapshot 'street_flow'
 *   node scripts/collect-street-flow.js --backfill=56   # 지난 56일을 날짜별로 받아 채운다(최초 1회, 요청 약 285번·4분)
 *   node scripts/collect-street-flow.js --dry           # 저장 없이 요약 출력 (--out=파일.json 으로 스냅샷 저장)
 *
 * 저장: macro_snapshot
 *   'street_flow'       공개 — 화면용 스냅샷 + 일별 집계(days, 최대 182일. 원문이 지워진 날도 집계는 남는다)
 *   'street_flow_cache' 내부 — 최근 36일 제목 원문(같은 날을 다시 받을 때 합치고, 급증 키워드·대표 제목에 쓴다. 링크는 최근 8일만)
 * 워크플로: .github/workflows/street-flow.yml (07:00 KST — 미국 장 마감 뒤, 한국 장 시작 전)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const F = require('../backend/streetFlow');

const DRY = process.argv.includes('--dry');
const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const BACKFILL = +arg('backfill') || 0;
const UA = { 'User-Agent': 'Mozilla/5.0 (investar-macro/1.1)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEEP_TITLE_DAYS = 36, KEEP_LINK_DAYS = 8, KEEP_AGG_DAYS = 182;   // 급증 키워드가 최근 7일 vs 직전 4주를 비교하므로 제목은 36일, 링크는 대표 제목용 8일만

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; if (i < tries - 1) await sleep(2000 * (i + 1)); }
  }
  throw new Error(`${url.slice(0, 90)}: ${last && last.message}`);
}

async function yahooCloses(sym) {
  const p1 = Math.floor((Date.now() - 200 * 864e5) / 1000), p2 = Math.floor(Date.now() / 1000) + 86400;
  const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`)).chart.result[0];
  const off = j.meta.gmtoffset || 0, c = j.indicators.quote[0].close;
  return j.timestamp.map((ts, i) => [new Date((ts + off) * 1000).toISOString().slice(0, 10), c[i] == null ? null : Math.round(c[i] * 100) / 100]).filter(([, v]) => v != null);
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: rows, error } = await sb.from('macro_snapshot').select('id, data').in('id', ['street_flow', 'street_flow_cache']);
  if (error) throw new Error(error.message);
  const prev = Object.fromEntries((rows || []).map(r => [r.id, r.data]));
  const titles = { ...(prev.street_flow_cache?.titles || {}) };   // { ETdate: [{t,s,l}] }
  const aggs = new Map((prev.street_flow?.days || []).map(r => [r.d, r]));

  // 받을 날짜(UTC 날짜 창). Google 의 after/before 경계가 어느 시간대인지 확실하지 않아 하루 겹쳐 받는다.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const nDays = BACKFILL || 4;
  const touched = new Set();
  let req = 0, fail = 0, got = 0;
  for (let i = nDays; i >= 0; i--) {
    const d = F.addDays(todayUtc, -i);
    for (const q of F.QUERIES) {
      req++;
      let xml;
      try { xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`${q} after:${d} before:${F.addDays(d, 1)}`)}&hl=en-US&gl=US&ceid=US:en`); }
      catch (e) { fail++; console.log(`  RSS 실패 ${d} ${q}: ${e.message}`); continue; }
      for (const x of F.parseRss(xml)) {
        const arr = (titles[x.d] = titles[x.d] || []);
        if (!arr.some(y => y.t === x.t)) { arr.push({ t: x.t, s: x.s, l: x.l }); got++; }
        touched.add(x.d);
      }
      await sleep(700);
    }
    if (BACKFILL && i % 7 === 0) console.log(`  ${d} 까지, 제목 누적 ${got}`);
  }
  if (fail > req / 2) throw new Error(`RSS 요청 ${req}번 중 ${fail}번 실패 — 저장하지 않는다`);

  // 원문이 있는 날은 다시 센다(사전이 바뀌어도 최근 36일은 새 기준으로 맞춰진다)
  for (const d of Object.keys(titles)) aggs.set(d, { d, ...F.dayAgg(titles[d]) });

  const lastDay = F.etDate(Date.now());
  const days = [...aggs.values()].filter(r => r.d <= lastDay).sort((a, b) => a.d.localeCompare(b.d)).slice(-KEEP_AGG_DAYS);
  const cutoff = F.addDays(lastDay, -KEEP_TITLE_DAYS);
  const linkCut = F.addDays(lastDay, -KEEP_LINK_DAYS);
  const keptTitles = Object.fromEntries(Object.entries(titles).filter(([d]) => d > cutoff && d <= lastDay)
    .map(([d, arr]) => [d, d > linkCut ? arr : arr.map(({ t, s }) => ({ t, s }))]));

  let px = null;
  try {
    const [kospi, sox] = await Promise.all([yahooCloses('^KS11'), yahooCloses('^SOX')]);
    px = { kospi: kospi.slice(-90), sox: sox.slice(-90) };
  } catch (e) { console.log('  가격 실패:', e.message); }

  const snap = { ...F.buildSnapshot(days, keptTitles, lastDay, px), days };
  console.log(`요청 ${req}(실패 ${fail}) · 새 제목 ${got} · 다시 센 날 ${touched.size} · 집계 ${days.length}일 (${days[0]?.d}~${lastDay})`);
  console.log(`최근 7일 ${snap.recent.from}~${snap.recent.to} 기사 ${snap.recent.n} · 하락어 ${snap.recent.downShare}% (직전 4주 ${snap.prev.downShare}%, ${snap.prev.days}일)`);
  for (const k of snap.keywords) console.log(`  ★ ${k.g.padEnd(20)} ${String(k.n).padStart(3)}건 ← ${k.prevN}  ${k.ratio}배  | ${k.titles[0]?.title.slice(0, 90) || ''}`);
  for (const t of snap.themes) console.log(`  ${t.label.padEnd(12)} ${String(t.n7).padStart(4)}건  ${t.share7}% ← ${t.sharePrev}%  ${t.shareRatio ?? '-'}배`);

  if (DRY) {
    const out = arg('out');
    if (out) { require('fs').writeFileSync(out, JSON.stringify(snap)); require('fs').writeFileSync(out.replace(/\.json$/, '') + '.titles.json', JSON.stringify(keptTitles)); }
    return;
  }
  const now = new Date().toISOString();
  const { error: e2 } = await sb.from('macro_snapshot').upsert([
    { id: 'street_flow', data: snap, updated_at: now },
    { id: 'street_flow_cache', data: { titles: keptTitles }, updated_at: now },
  ]);
  if (e2) throw new Error('저장 실패: ' + e2.message);
  console.log('저장 완료');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
