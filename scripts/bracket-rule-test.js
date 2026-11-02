/**
 * bracket-rule-test.js — 텔레그램 매매 룰의 ±3% 브래킷 검정 (2026-11-02)
 *
 * 사전 등록: BRACKET_RULE_VERDICT.md (규칙 정의·판정 기준은 그 문서가 단일 출처)
 *
 * 실행: node scripts/bracket-rule-test.js [--buy=3] [--sell=8] [--pct=3] [--boot=5000]
 *       node scripts/bracket-rule-test.js --buy=0 --sell=3     # 재현 점검(원래 v3.85 맥락)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const BUY = +arg('buy', 3), SELL = +arg('sell', 8), PCT = +arg('pct', 3) / 100, BOOT = +arg('boot', 5000);
const CHECK = BUY + 1;                                   // 메시지 문구: D+buy+1 에 판정
const SPLIT = '2026-05-01';                              // 전반부 / 후반부 경계 (사전 등록)
const MAX_DAILY = 0.305;                                 // |일간| > 30.5% = 이음매 → 제외

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY);

async function loadTop3() {
  const out = []; const PAGE = 1000;
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from('screening_recommendations')
      .select('id,stock_code,stock_name,recommendation_date')
      .eq('is_top3', true).order('recommendation_date').order('id')
      .range(p * PAGE, (p + 1) * PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function loadPrices(codes, fromYmd) {
  const file = path.resolve(__dirname, '../data/krx-daily.jsonl');
  const days = []; const px = new Map();               // ymd -> Map(code -> [o,h,l,c])
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const dPos = line.indexOf('"d":"'); const d = line.slice(dPos + 5, dPos + 13);
    if (d < fromYmd) continue;
    const j = JSON.parse(line);
    const m = new Map();
    for (const r of j.s) if (codes.has(r[0])) m.set(r[0], [r[1], r[2], r[3], r[4]]);
    days.push(j.d); px.set(j.d, m);
  }
  const uniq = [...new Set(days)].sort();
  return { days: uniq, px };
}

const ymd = iso => iso.replace(/-/g, '');

// 한 거래 평가. 반환: { base, r1, r2, r3, exitR1, exitR2, exitR3 } 또는 { skip: reason }
function evalTrade(code, d0, cal, px) {
  const i0 = cal.indexOf(d0);
  if (i0 < 0) return { skip: 'rec date not trading day' };
  if (i0 + SELL >= cal.length) return { skip: 'incomplete' };
  const bar = k => px.get(cal[i0 + k])?.get(code);
  const bars = [];
  for (let k = 0; k <= SELL; k++) { const b = bar(k); if (!b || !(b[3] > 0)) return { skip: 'missing price' }; bars.push(b); }
  for (let k = 1; k <= SELL; k++) if (Math.abs(bars[k][3] / bars[k - 1][3] - 1) > MAX_DAILY) return { skip: 'seam (>30.5%)' };
  const entry = bars[BUY][3];
  const ret = p => p / entry - 1;
  const base = ret(bars[SELL][3]);

  // R1: D+CHECK 종가 판정
  const c4 = ret(bars[CHECK][3]);
  const r1 = (c4 <= -PCT || c4 >= PCT) ? c4 : base;
  const exitR1 = c4 <= -PCT ? 'stop' : c4 >= PCT ? 'tp' : 'hold';

  // 장중 판정 (하루). 시가 0 = 무거래일 → 종가만으로 판정
  const intraday = (b) => {
    const [o0, h0, l0, c] = b; const o = o0 > 0 ? o0 : c, h = h0 > 0 ? h0 : c, l = l0 > 0 ? l0 : c;
    const lo = entry * (1 - PCT), hi = entry * (1 + PCT);
    if (o <= lo) return { r: ret(o), x: 'stop-gap' };
    if (o >= hi) return { r: ret(o), x: 'tp-gap' };
    if (l <= lo) return { r: -PCT, x: 'stop' };            // 같은 날 둘 다 닿으면 손절 먼저 (보수적)
    if (h >= hi) return { r: PCT, x: 'tp' };
    return null;
  };
  const d4 = intraday(bars[CHECK]);
  const r2 = d4 ? d4.r : base; const exitR2 = d4 ? d4.x : 'hold';
  let r3 = base, exitR3 = 'hold';
  for (let k = CHECK; k <= SELL; k++) { const h = intraday(bars[k]); if (h) { r3 = h.r; exitR3 = h.x; break; } }
  return { base, r1, r2, r3, exitR1, exitR2, exitR3 };
}

function summarize(rows, key) {
  const v = rows.map(r => r[key]); const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sorted = [...v].sort((a, b) => a - b); const med = sorted[Math.floor(n / 2)];
  const win = v.filter(x => x > 0).length / n;
  return { n, mean, med, win };
}

// 추천일 단위 클러스터 부트스트랩: 차이(R - BASE)의 평균 95% CI
function clusterBoot(rows, key, B) {
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r[key] - r.base); }
  const clusters = [...byDate.values()]; const C = clusters.length;
  let seed = 20261102; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let c = 0; c < C; c++) { const cl = clusters[Math.floor(rnd() * C)]; for (const x of cl) { s += x; n++; } }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(B * 0.025)], means[Math.floor(B * 0.975)], C];
}

const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';

(async () => {
  const recs = await loadTop3();
  const codes = new Set(recs.map(r => r.stock_code));
  const { days: cal, px } = await loadPrices(codes, ymd(recs[0].recommendation_date));
  console.log(`TOP3 ${recs.length}건 (${recs[0].recommendation_date} ~ ${recs[recs.length - 1].recommendation_date}) · KRX ${cal[0]}~${cal[cal.length - 1]} ${cal.length}거래일`);
  console.log(`규칙: D+${BUY} 종가 매수 / D+${CHECK} ±${PCT * 100}% / D+${SELL} 종가 매도\n`);

  const rows = []; const skips = {};
  const seen = new Set();
  for (const r of recs) {
    const key = r.stock_code + r.recommendation_date;
    if (seen.has(key)) { skips['duplicate row'] = (skips['duplicate row'] || 0) + 1; continue; }
    seen.add(key);
    const e = evalTrade(r.stock_code, ymd(r.recommendation_date), cal, px);
    if (e.skip) { skips[e.skip] = (skips[e.skip] || 0) + 1; continue; }
    rows.push({ date: r.recommendation_date, code: r.stock_code, name: r.stock_name, ...e });
  }
  console.log(`평가 ${rows.length}건 · 제외`, JSON.stringify(skips), '\n');

  const report = (label, subset) => {
    if (!subset.length) { console.log(label, '표본 없음'); return; }
    console.log(`── ${label} (n=${subset.length}, 추천일 ${new Set(subset.map(r => r.date)).size}일)`);
    for (const k of ['base', 'r1', 'r2', 'r3']) {
      const s = summarize(subset, k);
      let line = `  ${k.toUpperCase().padEnd(5)} 평균 ${pct(s.mean).padStart(8)}  중앙 ${pct(s.med).padStart(8)}  승률 ${(s.win * 100).toFixed(0).padStart(3)}%`;
      if (k !== 'base') {
        const d = subset.reduce((a, r) => a + (r[k] - r.base), 0) / subset.length;
        line += `  │ 차이 ${pct(d).padStart(8)}`;
        if (subset === rows) { const [lo, hi, C] = clusterBoot(subset, k, BOOT); line += `  95%CI [${pct(lo)}, ${pct(hi)}] (클러스터 ${C})`; }
        const ek = 'exit' + k.toUpperCase();
        const ex = {}; for (const r of subset) { const t = r[ek].startsWith('stop') ? '손절' : r[ek].startsWith('tp') ? '익절' : '보유'; ex[t] = (ex[t] || 0) + 1; }
        line += `  손절 ${(100 * (ex['손절'] || 0) / subset.length).toFixed(0)}% 익절 ${(100 * (ex['익절'] || 0) / subset.length).toFixed(0)}%`;
      }
      console.log(line);
    }
  };
  report('전체', rows);
  report(`전반부 (~${SPLIT})`, rows.filter(r => r.date < SPLIT));
  report(`후반부 (${SPLIT}~)`, rows.filter(r => r.date >= SPLIT));
})().catch(e => { console.error('❌', e.message); process.exit(1); });
