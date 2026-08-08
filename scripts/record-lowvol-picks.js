/**
 * record-lowvol-picks.js — 저변동성 후보 실시간 관측 기록 (관측 전용, 실운영 무관)
 *
 * 배경(2026-08-08): 대안 깔때기 검증에서 유일하게 살아남은 후보가 저변동성이었다.
 *   규칙 = 시총 상위 UNIV 유니버스 → 직전 LOOK거래일 일간수익 표준편차 하위 K종목.
 *   15개 경우(5설정 × 3지평) 전부 유니버스 기준선을 이겼고 14개는 절대수익도 플러스.
 *   단 D+10 독립블록 2.2로 **판정 요건 미달** → 백테스트가 아닌 실시간 기록을 쌓는다.
 *
 * ⚠️ 이 스크립트는 추천/알림/정책에 **전혀 관여하지 않는다.** screening_recommendations,
 *    active_policy, weekly_diagnostics 어디에도 쓰지 않는다. 읽기 + 자체 기록만 한다.
 *
 * 사용:
 *   node scripts/record-lowvol-picks.js              # 오늘 픽 계산 + 기록
 *   node scripts/record-lowvol-picks.js --telegram   # 기록 + 텔레그램 발송
 *   node scripts/record-lowvol-picks.js --review     # 지금까지 기록된 픽의 실적 집계
 *   node scripts/record-lowvol-picks.js --dry        # 계산만, 기록 안 함
 *
 * 저장: Supabase `lowvol_observations` (있으면) + 로컬 `data/lowvol-picks.jsonl` (항상)
 *       테이블이 없어도 로컬 기록은 되므로 오늘부터 바로 축적된다.
 *       테이블 생성 SQL: supabase-lowvol-observation.sql
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAGE = 1000, MIN_UNIVERSE = 2000;
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const has = k => process.argv.includes(`--${k}`);

// 백테스트에서 가장 강했던 설정. 바꾸면 기록의 연속성이 깨지므로 함부로 바꾸지 말 것.
const UNIV = arg('univ', 300);
const LOOK = arg('look', 20);
const K = arg('k', 20);

const OUT = path.resolve(__dirname, '../data/lowvol-picks.jsonl');
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const winR = a => (a.length ? (a.filter(v => v > 0).length / a.length) * 100 : null);
const sign = v => (v == null ? '-' : (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)));

async function fetchAll(table, cols, apply) {
  const out = [];
  for (let f = 0; ; f += PAGE) {
    let q = sb.from(table).select(cols).range(f, f + PAGE - 1);
    if (apply) q = apply(q);
    const { data, error } = await q; if (error) throw error;
    out.push(...data); if (data.length < PAGE) break;
  }
  return out;
}

async function loadMarket() {
  const flow = await fetchAll('market_flow_daily', 'stock_code,trade_date,close,volume,market_cap,sector_name');
  const byDate = new Map();
  for (const r of flow) { if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []); byDate.get(r.trade_date).push(r); }
  const days = [...byDate.keys()].filter(d => byDate.get(d).length >= MIN_UNIVERSE).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const px = new Map();
  for (const r of flow) {
    if (!dayIdx.has(r.trade_date)) continue;
    if (!px.has(r.stock_code)) px.set(r.stock_code, new Map());
    px.get(r.stock_code).set(r.trade_date, r);
  }
  return { byDate, days, dayIdx, px };
}

function computePicks({ byDate, days, px }, i) {
  const at = (c, k) => (k >= 0 && k < days.length ? px.get(c)?.get(days[k]) : null);
  const univ = byDate.get(days[i]).filter(r => r.market_cap > 0)
    .sort((a, b) => b.market_cap - a.market_cap).slice(0, UNIV);
  const scored = [];
  for (const r of univ) {
    const rets = [];
    for (let k = 1; k < LOOK; k++) {
      const a = at(r.stock_code, i - k - 1), b = at(r.stock_code, i - k);
      if (a?.close && b?.close) rets.push((b.close - a.close) / a.close);
    }
    if (rets.length < LOOK - 3) continue;
    const m = avg(rets);
    const sd = Math.sqrt(avg(rets.map(x => (x - m) ** 2))) * 100;
    scored.push({
      stock_code: r.stock_code, sector: r.sector_name, close: r.close,
      market_cap: r.market_cap, vol20_pct: Number(sd.toFixed(3)),
    });
  }
  return scored.sort((a, b) => a.vol20_pct - b.vol20_pct).slice(0, K);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return console.log('  (텔레그램 미설정 — 발송 생략)');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
  });
  const j = await res.json();
  console.log(j.ok ? '  ✅ 텔레그램 발송' : `  ⚠️ 텔레그램 실패: ${j.description}`);
}

(async () => {
  const mkt = await loadMarket();
  const { days, dayIdx, px, byDate } = mkt;
  const at = (c, k) => (k >= 0 && k < days.length ? px.get(c)?.get(days[k]) : null);

  // ── --review: 기록된 픽의 실적 집계 ────────────────────────────
  if (has('review')) {
    if (!fs.existsSync(OUT)) return console.log('기록 없음 — 먼저 기록을 쌓아야 합니다.');
    const recs = fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    console.log(`📊 저변동성 관측 실적 (기록 ${recs.length}일)\n`);
    const last = days[days.length - 1];
    for (const H of [2, 5, 10]) {
      const rows = [], base = [];
      for (const rec of recs) {
        const i = dayIdx.get(rec.signal_date);
        if (i == null || i + H >= days.length) continue;
        for (const p of rec.picks) {
          const b = at(p.stock_code, i + 1), s = at(p.stock_code, i + H);
          if (b?.close && s?.close) rows.push(((s.close - b.close) / b.close) * 100);
        }
        const u = byDate.get(days[i]).filter(r => r.market_cap > 0)
          .sort((a, b) => b.market_cap - a.market_cap).slice(0, UNIV);
        for (const r of u) {
          const b = at(r.stock_code, i + 1), s = at(r.stock_code, i + H);
          if (b?.close && s?.close) base.push(((s.close - b.close) / b.close) * 100);
        }
      }
      if (!rows.length) { console.log(`D+${H}: 아직 평가 가능한 기록 없음`); continue; }
      console.log(`D+1→D+${H}: 저변동성 ${sign(avg(rows))}% (승률 ${winR(rows).toFixed(0)}%, 중앙 ${sign(med(rows))}%, n=${rows.length})` +
        `  vs 유니버스 기준선 ${sign(avg(base))}%  → ${sign(avg(rows) - avg(base))}%p`);
    }
    const evalDays = recs.filter(r => { const i = dayIdx.get(r.signal_date); return i != null && i + 10 < days.length; }).length;
    console.log(`\n독립블록(D+10 기준): ${(evalDays / 10).toFixed(1)}` + (evalDays / 10 < 3 ? '  ⚠️ 판정 불가 — 계속 축적 필요' : '  ✅ 판정 요건 충족'));
    console.log(`최종 시장 데이터: ${last}`);
    return;
  }

  // ── 오늘 픽 계산 ──────────────────────────────────────────────
  const i = days.length - 1;
  const signalDate = days[i];
  const picks = computePicks(mkt, i);
  console.log(`📌 저변동성 관측 픽 — 신호일 ${signalDate} (시총상위${UNIV} / ${LOOK}일 변동성 하위 ${K})\n`);
  console.log('순위 종목코드  업종            변동성   종가       시총');
  picks.forEach((p, n) => console.log(
    `${String(n + 1).padStart(3)}  ${p.stock_code}  ${(p.sector || '').padEnd(14)}${p.vol20_pct.toFixed(2)}%  ${String(p.close).padStart(9)}  ${(p.market_cap / 1e8).toFixed(0)}억`));

  if (has('dry')) return console.log('\n(--dry: 기록하지 않음)');

  const record = {
    signal_date: signalDate, recorded_at: new Date().toISOString(),
    params: { univ: UNIV, look: LOOK, k: K },
    picks,
  };

  // 로컬 기록 (항상) — 같은 신호일 중복이면 교체
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let lines = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean) : [];
  lines = lines.filter(l => JSON.parse(l).signal_date !== signalDate);
  lines.push(JSON.stringify(record));
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`\n✅ 로컬 기록: ${OUT} (총 ${lines.length}일)`);

  // Supabase 기록 (테이블 있을 때만)
  const { error } = await sb.from('lowvol_observations').upsert({
    signal_date: signalDate, params: record.params, picks, recorded_at: record.recorded_at,
  }, { onConflict: 'signal_date' });
  console.log(error ? `  (Supabase 미기록: ${error.message} — supabase-lowvol-observation.sql 실행 필요)`
    : '  ✅ Supabase lowvol_observations 기록');

  if (has('telegram')) {
    const top = picks.slice(0, 5).map((p, n) =>
      `${n + 1}. ${p.stock_code} ${p.sector ?? ''} (변동성 ${p.vol20_pct.toFixed(2)}%)`).join('\n');
    await sendTelegram(
      `🔬 <b>저변동성 관측 픽</b> (${signalDate})\n` +
      `<i>검증용 기록 — 매매 추천 아님</i>\n\n${top}\n` +
      `…외 ${Math.max(0, picks.length - 5)}종목\n\n` +
      `규칙: 시총상위${UNIV} 중 ${LOOK}일 변동성 하위 ${K}\n` +
      `판정 예정: 2026-09-16 (독립블록 3+ 확보 시)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
