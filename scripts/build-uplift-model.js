// [성과 검증] 탭이 집계하는 모든 정보를 결합한 상승 예측 모델 (2026-08-07)
//
// ── 왜 이 형태인가
// 탭의 항목 대부분(연속상승일·매도신호·상승패턴·거래량추이·당일진단)은 추천 시점이 아니라
// **보유 중 매일 다시 계산되는 상태값**이다. 그러니 단위는 "추천 1건"이 아니라
// **(포지션 × 일자)** 여야 한다. 그래야 탭이 실제로 보여주는 정보를 그대로 쓴다.
//   → 추천 3,482건이 아니라 관측 ~28,000건이 표본이 된다.
//
// ── 목표변수: 매칭 초과수익
// 절대수익으로 학습하면 "그날 시장이 좋았나"를 학습한다(v3.90~92 시총 플로어 saga에서 이미 밟은 함정).
// 같은 날 열려 있는 모든 포지션의 평균을 뺀 **초과수익**을 목표로 둔다. 시장 등락이 상쇄된다.
//
// ── 과적합 방지
//  - 시간 분할(앞 train / 뒤 test). 무작위 분할은 같은 포지션이 양쪽에 걸쳐 누설된다.
//  - 특징 선택도 train 구간에서만. z-점수 단순 합산(가중치 학습 안 함).
//  - 관측이 겹치므로(한 포지션이 여러 날 등장) **일 단위로 집계한 뒤** 평가한다.
//
// ── 금지 사항 준수
//  - screening_recommendations 의 institution_buy_days / foreign_buy_days 미사용(v3.94 방향 버그).
//    수급은 market_flow_daily 에서 그날부터 과거로 재계산.
//  - kospi_close_change 미사용.

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const HOR = parseInt((process.argv.find(a => a.startsWith('--k=')) || '').split('=')[1] || '3', 10);
const TRAIN_FRAC = 0.65;
// market_flow_daily 는 2026-05-22 부터만 전 종목을 담는다. 그 이전을 학습에 넣으면
// 수급 특징이 전부 0(상수)이 되어 순위상관이 계산조차 안 된다 → 수급 검정 시 --since 로 자를 것.
const SINCE = (process.argv.find(a => a.startsWith('--since=')) || '').split('=')[1] || null;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 1; };
const fmt = (x, d = 2) => (x == null || Number.isNaN(x) ? '  N/A' : ((x >= 0 ? '+' : '') + x.toFixed(d)).padStart(d === 2 ? 6 : 7));
const pctS = (n, d) => (d ? ((n / d) * 100).toFixed(0) + '%' : ' -').padStart(4);

// Spearman 순위상관 — 선형성 가정 없이 단조 관계만 본다
function spearman(xs, ys) {
  const n = xs.length; if (n < 20) return null;
  const rank = arr => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
      const avg = (i + j + 1) / 2;
      for (let k = i; k < j; k++) r[idx[k][1]] = avg;
      i = j;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

(async () => {
  // ────────────────────────────── 1. 로드
  console.log('데이터 로드 중...');
  const recs = [];
  for (let o = 0; ; o += 1000) {
    const { data } = await sb.from('screening_recommendations').select('*')
      .order('recommendation_date', { ascending: true }).range(o, o + 999);
    recs.push(...(data || [])); if (!data || data.length < 1000) break;
  }
  const recById = new Map(recs.map(r => [r.id, r]));

  const prices = [];
  for (let o = 0; ; o += 1000) {
    const { data } = await sb.from('recommendation_daily_prices')
      .select('recommendation_id,tracking_date,closing_price,change_rate,volume,cumulative_return,days_since_recommendation')
      .order('tracking_date', { ascending: true }).range(o, o + 999);
    prices.push(...(data || [])); if (!data || data.length < 1000) break;
  }
  const series = {};
  for (const p of prices) if (p.closing_price > 0) (series[p.recommendation_id] ??= []).push(p);
  for (const k of Object.keys(series)) series[k].sort((a, b) => a.tracking_date < b.tracking_date ? -1 : 1);

  // 수급: 추천된 종목만
  const codes = [...new Set(recs.map(r => r.stock_code))];
  const flow = {};
  for (let i = 0; i < codes.length; i += 60) {
    const c = codes.slice(i, i + 60);
    for (let o = 0; ; o += 1000) {
      const { data } = await sb.from('market_flow_daily')
        .select('stock_code,trade_date,inst_net_value,frgn_net_value')
        .in('stock_code', c).order('trade_date', { ascending: true }).range(o, o + 999);
      (data || []).forEach(x => { (flow[x.stock_code] ??= []).push(x); });
      if (!data || data.length < 1000) break;
    }
  }
  for (const k of Object.keys(flow)) flow[k].sort((a, b) => a.trade_date < b.trade_date ? -1 : 1);
  console.log(`  추천 ${recs.length} / 추적가 ${prices.length} / 수급 종목 ${Object.keys(flow).length}`);

  // ────────────────────────────── 2. 패널 구성
  const obs = [];
  for (const [rid, rows] of Object.entries(series)) {
    const rec = recById.get(rid); if (!rec) continue;
    let streak = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      streak = r.change_rate > 0 ? streak + 1 : 0;

      const fwd = {};
      for (const k of [1, 3, 5]) {
        const nx = rows[i + k];
        if (nx) fwd[k] = ((1 + nx.cumulative_return / 100) / (1 + r.cumulative_return / 100) - 1) * 100;
      }
      if (fwd[HOR] == null) continue;   // 목표 지평이 없으면 관측에서 제외

      // ── 탭 계산 항목 재현
      const win = rows.slice(Math.max(0, i - 5), i + 1);          // 최근 6일 창
      const vols = win.map(p => p.volume || 0).filter(v => v > 0);
      let volTrend = 0;
      if (vols.length >= 4) {
        const h = Math.floor(vols.length / 2);
        const a = mean(vols.slice(0, h)), b = mean(vols.slice(h));
        volTrend = a > 0 ? ((b - a) / a) * 100 : 0;
      }
      const prev5 = rows.slice(Math.max(0, i - 5), i).map(p => p.volume || 0).filter(v => v > 0);
      const volRatio5d = prev5.length ? (r.volume || 0) / mean(prev5) : 1;
      const avgDailyRet = mean(win.map(p => p.change_rate || 0));
      const cum = r.cumulative_return;

      // ── 수급 (그날부터 과거로 — 오름차순 배열을 뒤에서 센다)
      let instD = 0, frgnD = 0, inst5 = 0, frgn5 = 0;
      const fs = flow[rec.stock_code];
      if (fs) {
        const upto = fs.filter(x => x.trade_date <= r.tracking_date);
        for (let j = upto.length - 1; j >= 0 && upto.length - j <= 10; j--) {
          if ((upto[j].inst_net_value ?? 0) > 0 && instD === upto.length - 1 - j) instD++;
        }
        for (let j = upto.length - 1; j >= 0 && upto.length - j <= 10; j--) {
          if ((upto[j].frgn_net_value ?? 0) > 0 && frgnD === upto.length - 1 - j) frgnD++;
        }
        const l5 = upto.slice(-5);
        inst5 = l5.reduce((s, x) => s + (x.inst_net_value ?? 0), 0);
        frgn5 = l5.reduce((s, x) => s + (x.frgn_net_value ?? 0), 0);
      }

      obs.push({
        rid, code: rec.stock_code, name: rec.stock_name, date: r.tracking_date,
        y: fwd[HOR], fwd,
        f: {
          cum_return: cum,
          days_held: r.days_since_recommendation,
          streak,
          is_rising: streak >= 2 && cum > 0 ? 1 : 0,
          sig_stoploss: cum <= -5 ? 1 : 0,
          sig_caution: cum > -5 && cum <= -3 ? 1 : 0,
          sig_highprofit: cum >= 20 ? 1 : 0,
          sig_longhold: r.days_since_recommendation >= 25 && cum < 0 ? 1 : 0,
          vol_trend: volTrend,
          vol_ratio_5d: volRatio5d,
          day_return: r.change_rate ?? 0,
          avg_daily_ret: avgDailyRet,
          mfi: rec.mfi ?? null,
          rsi: rec.rsi ?? null,
          disparity: rec.disparity ?? null,
          whale: rec.whale_detected ? 1 : 0,
          accum: rec.accumulation_detected ? 1 : 0,
          total_score: rec.total_score ?? null,
          log_mcap: rec.market_cap ? Math.log10(rec.market_cap) : null,
          is_kospi: rec.market === 'KOSPI' ? 1 : 0,
          inst_days: instD,
          frgn_days: frgnD,
          inst_net5: inst5,
          frgn_net5: frgn5,
        },
      });
    }
  }

  // ── 목표: 같은 날 열린 모든 포지션 평균 대비 초과수익
  const byDate = {};
  for (const o of obs) (byDate[o.date] ??= []).push(o);
  for (const [d, g] of Object.entries(byDate)) {
    if (g.length < 3) { g.forEach(o => o.ex = null); continue; }
    const m = mean(g.map(o => o.y));
    g.forEach(o => { o.ex = o.y - m; });
  }
  const panel = obs.filter(o => o.ex != null && (!SINCE || o.date >= SINCE));
  const dates = [...new Set(panel.map(o => o.date))].sort();

  console.log(`\n${'='.repeat(80)}`);
  console.log(`상승 예측 모델 — 목표: +${HOR}거래일 매칭 초과수익 (같은 날 포지션 평균 대비)`);
  console.log('='.repeat(80));
  console.log(`\n관측 ${panel.length}건 / ${dates.length}일 (${dates[0]} ~ ${dates[dates.length - 1]})`);
  console.log(`포지션 ${new Set(panel.map(o => o.rid)).size}개 / 종목 ${new Set(panel.map(o => o.code)).size}개`);

  // ────────────────────────────── 3. 시간 분할
  const cutIdx = Math.floor(dates.length * TRAIN_FRAC);
  const cutDate = dates[cutIdx];
  const train = panel.filter(o => o.date < cutDate);
  const test = panel.filter(o => o.date >= cutDate);
  console.log(`\n학습 ${train.length}건 (${dates[0]} ~ ${dates[cutIdx - 1]})`);
  console.log(`검증 ${test.length}건 (${cutDate} ~ ${dates[dates.length - 1]})`);

  const FEATS = Object.keys(panel[0].f);

  // ────────────────────────────── 4. 학습 구간 단변량 IC
  console.log(`\n[1] 학습 구간 단변량 예측력 (Spearman IC — 초과수익과의 순위상관)\n`);
  console.log('특징                  IC(학습)   IC(검증)   같은부호');
  console.log('-'.repeat(56));
  const ics = [];
  for (const f of FEATS) {
    const tr = train.filter(o => o.f[f] != null);
    const te = test.filter(o => o.f[f] != null);
    const icTr = spearman(tr.map(o => o.f[f]), tr.map(o => o.ex));
    const icTe = spearman(te.map(o => o.f[f]), te.map(o => o.ex));
    if (icTr == null) continue;
    ics.push({ f, icTr, icTe });
  }
  ics.sort((a, b) => Math.abs(b.icTr) - Math.abs(a.icTr));
  for (const r of ics)
    console.log(`${r.f.padEnd(20)} ${fmt(r.icTr, 3)}   ${fmt(r.icTe, 3)}     ${r.icTe != null && Math.sign(r.icTe) === Math.sign(r.icTr) ? 'O' : 'X'}`);

  // ────────────────────────────── 5. 합성 점수 (학습 구간에서만 선택·표준화)
  const SEL = ics.filter(r => Math.abs(r.icTr) >= 0.03).slice(0, 6);
  console.log(`\n[2] 합성 점수 = 학습 IC |0.03| 이상 상위 ${SEL.length}개의 방향부호 z-점수 평균`);
  console.log(`    선택: ${SEL.map(s => `${s.f}(${s.icTr >= 0 ? '+' : '−'})`).join(', ') || '없음'}`);
  if (!SEL.length) { console.log('\n→ 학습 구간에 예측력 있는 특징이 없음. 종료.'); return; }

  const norm = {};
  for (const s of SEL) {
    const v = train.map(o => o.f[s.f]).filter(x => x != null);
    norm[s.f] = { m: mean(v), s: sd(v), dir: Math.sign(s.icTr) };
  }
  const score = o => {
    let t = 0, k = 0;
    for (const s of SEL) {
      const v = o.f[s.f]; if (v == null) continue;
      t += norm[s.f].dir * (v - norm[s.f].m) / norm[s.f].s; k++;
    }
    return k ? t / k : null;
  };
  test.forEach(o => { o.sc = score(o); });
  const scored = test.filter(o => o.sc != null);
  console.log(`\n    검증 구간 합성점수 IC: ${fmt(spearman(scored.map(o => o.sc), scored.map(o => o.ex)), 3)}`);

  // ────────────────────────────── 6. 5분위 성과 (검증 구간)
  console.log(`\n[3] 검증 구간 5분위 — 점수가 실제로 수익을 가르는가\n`);
  const srt = [...scored].sort((a, b) => b.sc - a.sc);
  const q = Math.floor(srt.length / 5);
  console.log('분위      n     초과수익   절대수익   승률   상위종목');
  console.log('-'.repeat(70));
  for (let i = 0; i < 5; i++) {
    const g = srt.slice(i * q, i === 4 ? srt.length : (i + 1) * q);
    const nm = [...new Set(g.slice(0, 40).map(o => o.name))].slice(0, 3).join(',');
    console.log(`Q${i + 1}   ${String(g.length).padStart(5)}   ${fmt(mean(g.map(o => o.ex)))}%p   ${fmt(mean(g.map(o => o.y)))}%  ${pctS(g.filter(o => o.y > 0).length, g.length)}   ${nm}`);
  }
  const Q1 = srt.slice(0, q), Q5 = srt.slice(-q);
  console.log('-'.repeat(70));
  console.log(`Q1−Q5 스프레드: ${fmt(mean(Q1.map(o => o.ex)) - mean(Q5.map(o => o.ex)))}%p`);

  // ── 일 단위 집계 (관측 중복 보정)
  const dayDiff = [];
  for (const d of [...new Set(scored.map(o => o.date))]) {
    const g = scored.filter(o => o.date === d).sort((a, b) => b.sc - a.sc);
    if (g.length < 6) continue;
    const n = Math.max(1, Math.floor(g.length / 5));
    dayDiff.push(mean(g.slice(0, n).map(o => o.ex)) - mean(g.slice(-n).map(o => o.ex)));
  }
  console.log(`\n[4] 일 단위 집계 (관측 겹침 보정) — 유효 ${dayDiff.length}일`);
  console.log(`    일별 Q1−Q5 평균 ${fmt(mean(dayDiff))}%p / 양수인 날 ${pctS(dayDiff.filter(v => v > 0).length, dayDiff.length)}`);
  const t = mean(dayDiff) / (sd(dayDiff) / Math.sqrt(dayDiff.length));
  console.log(`    t ≈ ${t.toFixed(2)} ${Math.abs(t) >= 2 ? '(|t|≥2 — 통계적으로 의미 있음)' : '(|t|<2 — 노이즈와 구분 안 됨)'}`);

  // ────────────────────────────── 7. 실전 규칙
  console.log(`\n[5] 실전 형태 — 매일 점수 상위 3개만 보유했다면 (검증 구간)\n`);
  const daily = [];
  for (const d of [...new Set(scored.map(o => o.date))].sort()) {
    const g = scored.filter(o => o.date === d).sort((a, b) => b.sc - a.sc);
    if (g.length < 5) continue;
    daily.push({ d, top3: mean(g.slice(0, 3).map(o => o.y)), all: mean(g.map(o => o.y)), ex: mean(g.slice(0, 3).map(o => o.ex)) });
  }
  console.log(`  대상 ${daily.length}일`);
  console.log(`  상위3 평균수익 ${fmt(mean(daily.map(x => x.top3)))}% / 전체 평균 ${fmt(mean(daily.map(x => x.all)))}% / 초과 ${fmt(mean(daily.map(x => x.ex)))}%p`);
  console.log(`  상위3이 전체를 이긴 날 ${pctS(daily.filter(x => x.top3 > x.all).length, daily.length)}`);

  // ────────────────────────────── 8. 선별이 아니라 배제라면?
  // 5분위가 단조가 아니라 "Q5만 나쁜" 모양이면, 이 점수는 고르는 도구가 아니라 거르는 도구다.
  console.log(`\n[6] 배제 규칙 — 하위 20%를 빼고 나머지를 균등 보유했다면 (일 단위)\n`);
  const exRule = [];
  for (const d of [...new Set(scored.map(o => o.date))].sort()) {
    const g = scored.filter(o => o.date === d).sort((a, b) => b.sc - a.sc);
    if (g.length < 5) continue;
    const cut = Math.max(1, Math.floor(g.length / 5));
    const kept = g.slice(0, g.length - cut);
    exRule.push({ kept: mean(kept.map(o => o.y)), all: mean(g.map(o => o.y)) });
  }
  console.log(`  대상 ${exRule.length}일`);
  console.log(`  하위20% 제외 ${fmt(mean(exRule.map(x => x.kept)))}% vs 전체 보유 ${fmt(mean(exRule.map(x => x.all)))}%`);
  console.log(`  개선폭 ${fmt(mean(exRule.map(x => x.kept - x.all)))}%p / 개선된 날 ${pctS(exRule.filter(x => x.kept > x.all).length, exRule.length)}`);
  const dd = exRule.map(x => x.kept - x.all);
  const tEx = mean(dd) / (sd(dd) / Math.sqrt(dd.length));
  console.log(`  t ≈ ${tEx.toFixed(2)} ${Math.abs(tEx) >= 2 ? '(의미 있음)' : '(노이즈)'}`);

  // ────────────────────────────── 9. 기존 시총 플로어 대비 증분 가치
  // 선택된 특징 1위가 log_mcap 이면 이미 운영 중인 v3.90 시총 플로어와 겹친다.
  // 플로어 통과 구간(1조+) 안에서도 점수가 살아있어야 '새로 얻는 것'이 있다.
  console.log(`\n[7] 기존 시총 플로어(1조+) 통과 구간 안에서만 재검정 — 증분 가치\n`);
  const big = scored.filter(o => o.f.log_mcap != null && o.f.log_mcap >= 12);
  console.log(`  대상 ${big.length}건 (검증 구간의 ${(big.length / scored.length * 100).toFixed(0)}%)`);
  if (big.length >= 500) {
    // 시총을 뺀 점수로 다시 계산 — 플로어가 이미 하는 일을 빼고 나머지가 남는지
    const SEL2 = SEL.filter(s => s.f !== 'log_mcap');
    const score2 = o => {
      let t = 0, k = 0;
      for (const s of SEL2) { const v = o.f[s.f]; if (v == null) continue; t += norm[s.f].dir * (v - norm[s.f].m) / norm[s.f].s; k++; }
      return k ? t / k : null;
    };
    const b2 = big.map(o => ({ ...o, sc2: score2(o) })).filter(o => o.sc2 != null);
    console.log(`  시총 제외 점수의 IC (대형주 내): ${fmt(spearman(b2.map(o => o.sc2), b2.map(o => o.ex)), 3)}`);
    const s2 = [...b2].sort((a, b) => b.sc2 - a.sc2);
    const q2 = Math.floor(s2.length / 5);
    console.log('  분위      n     초과수익   절대수익   승률');
    for (let i = 0; i < 5; i++) {
      const g = s2.slice(i * q2, i === 4 ? s2.length : (i + 1) * q2);
      console.log(`  Q${i + 1}   ${String(g.length).padStart(5)}   ${fmt(mean(g.map(o => o.ex)))}%p   ${fmt(mean(g.map(o => o.y)))}%  ${pctS(g.filter(o => o.y > 0).length, g.length)}`);
    }
    const dd2 = [];
    for (const d of [...new Set(b2.map(o => o.date))]) {
      const g = b2.filter(o => o.date === d).sort((a, b) => b.sc2 - a.sc2);
      if (g.length < 6) continue;
      const n = Math.max(1, Math.floor(g.length / 5));
      dd2.push(mean(g.slice(0, n).map(o => o.ex)) - mean(g.slice(-n).map(o => o.ex)));
    }
    if (dd2.length > 5) {
      const t2 = mean(dd2) / (sd(dd2) / Math.sqrt(dd2.length));
      console.log(`  일 단위 Q1−Q5 ${fmt(mean(dd2))}%p / 양수일 ${pctS(dd2.filter(v => v > 0).length, dd2.length)} / t ≈ ${t2.toFixed(2)}`);
    }
  } else console.log('  표본 부족 — 판정 불가');
})();
