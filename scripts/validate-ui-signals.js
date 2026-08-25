// [성과 검증] 탭의 "공통 추천 종목" · "연속 급등주" 필드가 실제 예측력이 있는지 검정.
// (2026-08-07)
//
// 검정이 필요한 이유 — 화면에 보이는 적중률은 두 필드 모두 **사후 선택**이다:
//
//   연속 급등주: is_rising = (consecutiveRiseDays >= 2 && returnPct > 0)
//     → "지금 2일 이상 오르는 중이고 지금 수익 중"인 종목만 담는 필터다.
//        이 집합의 승률이 높은 건 예측이 아니라 정의다(동어반복).
//
//   공통 추천 종목: 2회 이상 추천된 종목 + 기하평균 current_return
//     → 사후 선택은 아니지만, 어제 오른 종목이 오늘 다시 뽑히는 모멘텀 풀이라
//        재추천 자체가 상승과 상관될 수 있다. 그리고 current_return 은 "오늘 시점"
//        수익률이라, 오래 보유 중인 종목일수록 시장 전체 등락을 더 많이 반영한다.
//
// 그래서 묻는 질문을 바꾼다:
//   "깃발이 꽂힌 그 시점 이후, 앞으로 오르는가?" (forward return)
// 깃발이 꽂힌 날 t 를 기준으로 t+k 수익률을 재고, 같은 날 깃발이 없던 픽과 비교한다.
// 같은 날끼리 비교해야 시장 전체 등락(베타)이 상쇄된다.

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const DAYS = parseInt(process.argv[2] || '90', 10);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fmt = x => (x == null ? '   N/A' : ((x >= 0 ? '+' : '') + x.toFixed(2)).padStart(6));
const pctS = (n, d) => (d ? ((n / d) * 100).toFixed(0) + '%' : '  - ').padStart(4);

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);

  const recs = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from('screening_recommendations')
      .select('id,recommendation_date,stock_code,stock_name,is_top3,total_score,sector_name,market_cap')
      .gte('recommendation_date', since).order('recommendation_date', { ascending: true }).range(f, f + 999);
    recs.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const recById = new Map(recs.map(r => [r.id, r]));

  // 일별 추적가: 종목별 시계열을 tracking_date 순으로
  const series = {};
  const ids = recs.map(r => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const c = ids.slice(i, i + 200);
    for (let f = 0; ; f += 1000) {
      const { data: dp } = await sb.from('recommendation_daily_prices')
        .select('recommendation_id,tracking_date,change_rate,cumulative_return,days_since_recommendation')
        .in('recommendation_id', c).range(f, f + 999);
      (dp || []).forEach(p => { (series[p.recommendation_id] ??= []).push(p); });
      if (!dp || dp.length < 1000) break;
    }
  }
  for (const k of Object.keys(series)) series[k].sort((a, b) => a.tracking_date < b.tracking_date ? -1 : 1);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`[성과 검증] 탭 필드 예측력 검정 — ${since} ~ (${DAYS}일)`);
  console.log('='.repeat(78));

  // ────────────────────────────────────────────────────────────────
  // A. 연속 급등주 — 깃발이 꽂힌 날 이후의 수익
  // ────────────────────────────────────────────────────────────────
  // 화면 로직 그대로 재현: 그 날까지 연속 상승 일수 >= 2 이고 누적수익 > 0
  const flagged = [];   // {recId, date, di, fwd:{k:ret}}
  const unflagged = [];

  for (const [rid, rows] of Object.entries(series)) {
    let streak = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.change_rate > 0) streak++; else streak = 0;
      const isRising = streak >= 2 && r.cumulative_return > 0;

      // 이 시점 이후 k 거래일 전방 수익 (해당 종목 자체의 이후 등락)
      const fwd = {};
      for (const k of [1, 3, 5]) {
        const nxt = rows[i + k];
        if (!nxt) continue;
        // 누적수익 차이가 아니라 실제 보유수익: (1+c2)/(1+c1)-1
        fwd[k] = ((1 + nxt.cumulative_return / 100) / (1 + r.cumulative_return / 100) - 1) * 100;
      }
      const rec = { rid, date: r.tracking_date, streak, cum: r.cumulative_return, fwd };
      (isRising ? flagged : unflagged).push(rec);
    }
  }

  console.log(`\n[A] 🔥 연속 급등주 — 깃발이 꽂힌 그 날 이후의 수익\n`);
  console.log(`화면이 보여주는 것 = 깃발 시점의 누적수익 (정의상 전부 양수)`);
  console.log(`  깃발 관측 ${flagged.length}건 / 평균 누적수익 ${fmt(mean(flagged.map(x => x.cum)))}%  ← 이 숫자가 "적중률"로 보이는 것`);
  console.log(`  비깃발 관측 ${unflagged.length}건 / 평균 누적수익 ${fmt(mean(unflagged.map(x => x.cum)))}%\n`);
  console.log(`실제로 물어야 할 것 = 깃발 이후 수익`);
  console.log(`지평   깃발 n    평균     중앙   승률 | 비깃발 n    평균   승률 |    차이`);
  console.log('-'.repeat(74));
  for (const k of [1, 3, 5]) {
    const F = flagged.map(x => x.fwd[k]).filter(v => v != null);
    const U = unflagged.map(x => x.fwd[k]).filter(v => v != null);
    console.log(`+${k}일 ${String(F.length).padStart(6)} ${fmt(mean(F))}% ${fmt(med(F))}% ${pctS(F.filter(v => v > 0).length, F.length)} | ` +
      `${String(U.length).padStart(6)} ${fmt(mean(U))}% ${pctS(U.filter(v => v > 0).length, U.length)} | ${fmt(mean(F) - mean(U))}%p`);
  }

  // 같은 날끼리 비교 (시장 등락 상쇄)
  console.log(`\n같은 날짜 안에서만 비교 (시장 베타 상쇄)`);
  console.log(`지평   매칭일수   깃발평균   비깃발평균     차이   깃발우세일`);
  console.log('-'.repeat(64));
  for (const k of [1, 3, 5]) {
    const byDate = {};
    for (const x of flagged) if (x.fwd[k] != null) (byDate[x.date] ??= { f: [], u: [] }).f.push(x.fwd[k]);
    for (const x of unflagged) if (x.fwd[k] != null) (byDate[x.date] ??= { f: [], u: [] }).u.push(x.fwd[k]);
    const days = Object.values(byDate).filter(d => d.f.length && d.u.length);
    if (!days.length) { console.log(`+${k}일  매칭 없음`); continue; }
    const diffs = days.map(d => mean(d.f) - mean(d.u));
    console.log(`+${k}일 ${String(days.length).padStart(8)}   ${fmt(mean(days.map(d => mean(d.f))))}%   ${fmt(mean(days.map(d => mean(d.u))))}%  ${fmt(mean(diffs))}%p   ${pctS(diffs.filter(v => v > 0).length, diffs.length)}`);
  }

  // 연속일수별
  console.log(`\n연속 상승일수별 이후 3일 수익 (많이 오를수록 더 오르나?)`);
  console.log(`연속일수    n      +3일평균   승률`);
  console.log('-'.repeat(42));
  for (const s of [2, 3, 4, 5]) {
    const g = flagged.filter(x => (s < 5 ? x.streak === s : x.streak >= 5)).map(x => x.fwd[3]).filter(v => v != null);
    if (!g.length) continue;
    console.log(`${s === 5 ? '5일+' : s + '일 '}     ${String(g.length).padStart(5)}    ${fmt(mean(g))}%  ${pctS(g.filter(v => v > 0).length, g.length)}`);
  }

  // ────────────────────────────────────────────────────────────────
  // B. 공통 추천 종목 — N회차 추천 이후의 수익
  // ────────────────────────────────────────────────────────────────
  console.log(`\n\n[B] 🔄 공통 추천 종목 — 반복 추천이 예측력인가\n`);

  const byCode = {};
  for (const r of recs) (byCode[r.stock_code] ??= []).push(r);
  for (const k of Object.keys(byCode)) byCode[k].sort((a, b) => a.recommendation_date < b.recommendation_date ? -1 : 1);

  // 각 추천건이 그 종목의 몇 번째 추천인지 (그 시점까지 기준 = look-ahead 없음)
  const nth = new Map();
  for (const [code, list] of Object.entries(byCode)) list.forEach((r, i) => nth.set(r.id, i + 1));

  const retAt = (rid, t) => {
    const rows = series[rid]; if (!rows) return null;
    let b = null, bd = -1, has = false;
    for (const p of rows) {
      if (p.days_since_recommendation <= t && p.days_since_recommendation > bd) { bd = p.days_since_recommendation; b = p.cumulative_return; }
      if (p.days_since_recommendation >= t) has = true;
    }
    return has ? b : null;
  };

  console.log(`추천 회차별 그 추천건의 이후 성과 (해당 추천일 기준 D+N)`);
  console.log(`회차       n     D+1     승률    D+3     승률    D+5     승률   D+10    승률`);
  console.log('-'.repeat(78));
  for (const label of ['1회차', '2회차', '3회차+']) {
    const set = recs.filter(r => {
      const n = nth.get(r.id);
      return label === '1회차' ? n === 1 : label === '2회차' ? n === 2 : n >= 3;
    });
    let line = `${label.padEnd(8)} ${String(set.length).padStart(4)}`;
    for (const h of [1, 3, 5, 10]) {
      const v = set.map(r => retAt(r.id, h)).filter(x => x != null);
      line += ` ${fmt(mean(v))}% ${pctS(v.filter(x => x > 0).length, v.length)}`;
    }
    console.log(line);
  }

  console.log(`\n"2회 이상 추천된 종목"의 전체 추천건 vs "1회만 추천된 종목"`);
  console.log(`집단              n     D+1     승률    D+3     승률   D+10    승률`);
  console.log('-'.repeat(66));
  for (const [label, pred] of [
    ['2회+ 종목', r => byCode[r.stock_code].length >= 2],
    ['1회만 종목', r => byCode[r.stock_code].length === 1],
  ]) {
    const set = recs.filter(pred);
    let line = `${label.padEnd(12)} ${String(set.length).padStart(4)}`;
    for (const h of [1, 3, 10]) {
      const v = set.map(r => retAt(r.id, h)).filter(x => x != null);
      line += ` ${fmt(mean(v))}% ${pctS(v.filter(x => x > 0).length, v.length)}`;
    }
    console.log(line);
  }

  // 최다 추천 종목
  console.log(`\n최다 추천 종목 (화면 상단에 뜨는 것들)`);
  console.log(`종목            추천수  단순평균D+3  기하평균(화면값)  최종추천일`);
  console.log('-'.repeat(70));
  const top = Object.values(byCode).filter(l => l.length >= 3).sort((a, b) => b.length - a.length).slice(0, 10);
  for (const list of top) {
    const rs = list.map(r => retAt(r.id, 3)).filter(v => v != null);
    const geo = rs.length ? (Math.pow(rs.reduce((a, b) => a * (1 + b / 100), 1), 1 / rs.length) - 1) * 100 : null;
    console.log(`${list[0].stock_name.padEnd(14).slice(0, 14)} ${String(list.length).padStart(4)}   ${fmt(mean(rs))}%      ${fmt(geo)}%     ${list[list.length - 1].recommendation_date}`);
  }
})();
