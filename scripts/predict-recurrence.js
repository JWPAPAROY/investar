// "첫 등장 종목 중 재등장할 것과 한 번 뜨고 사라질 것을 추천 시점에 구분할 수 있는가"
// (2026-08-07, validate-ui-signals.js 후속)
//
// 배경: [성과 검증] 탭의 "공통 추천 종목"이 좋아 보이는 이유는 반복 추천이 좋아서가 아니라
//   1회뿐인 종목이 재앙(D+10 −19.9%/승률 9%)이기 때문이다. 그런데 "1회뿐"은 기간이 다 지나야
//   붙는 라벨이라 매매에 못 쓴다. 추천 시점 정보만으로 그걸 예측할 수 있으면 쓸 수 있게 된다.
//
// 설계상 지킨 것 (전부 이 시스템이 과거에 밟은 함정):
//  - **좌측 절단**: 기간 시작 부근의 "첫 등장"은 사실 그 전에도 나왔을 수 있다 → burn-in 이후만 사용.
//  - **우측 절단**: 최근 첫 등장은 재등장할 시간이 없어 자동으로 '1회성'이 된다 → 관측창(H거래일)이
//    데이터 끝을 넘어가는 건 제외. 이걸 빼먹으면 "최근일수록 1회성"이라는 가짜 신호가 생긴다.
//  - **시간 분할 검증**: 같은 데이터로 규칙을 만들고 평가하면 안 된다 → 앞 70% 학습 / 뒤 30% 검증.
//  - **금지 컬럼**: institution_buy_days / foreign_buy_days 는 v3.94 이전 방향 버그 산출값이라 미사용.
//
// 최종 판정 기준은 적중률이 아니라 **수익**이다. 재등장을 잘 맞혀도 그 구분이 수익을 가르지
// 못하면 쓸모가 없다.

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const H = parseInt((process.argv.find(a => a.startsWith('--horizon=')) || '').split('=')[1] || '20', 10);
const BURN_IN_DAYS = 30;   // 이 거래일수만큼 지난 뒤의 첫 등장만 '진짜 첫 등장'으로 인정

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = x => (x == null || Number.isNaN(x) ? '   N/A' : ((x >= 0 ? '+' : '') + x.toFixed(2)).padStart(6));
const pctS = (n, d) => (d ? ((n / d) * 100).toFixed(0) + '%' : '  -').padStart(4);

// 순위 기반 AUC — 이 특징 하나로 재등장/1회성을 얼마나 가르는가. 0.5 = 무의미.
function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map(v => [v, 1]), ...neg.map(v => [v, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0;
  for (let i = 0; i < all.length;) {
    let j = i; while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (i + j + 1) / 2;               // 동점은 평균 순위
    for (let k = i; k < j; k++) if (all[k][1] === 1) sumPos += avgRank;
    i = j; rank = j;
  }
  return (sumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

(async () => {
  // ── 데이터
  const recs = [];
  for (let o = 0; ; o += 1000) {
    const { data } = await sb.from('screening_recommendations').select('*')
      .order('recommendation_date', { ascending: true }).range(o, o + 999);
    recs.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const dates = [...new Set(recs.map(r => r.recommendation_date))].sort();
  const dIdx = new Map(dates.map((d, i) => [d, i]));

  // 종목별 등장일
  const appear = {};
  for (const r of recs) (appear[r.stock_code] ??= []).push(r.recommendation_date);
  for (const k of Object.keys(appear)) appear[k] = [...new Set(appear[k])].sort();

  // ── 표본: burn-in 이후 & 관측창이 데이터 안에 들어오는 첫 등장만
  const lastIdx = dates.length - 1;
  const samples = [];
  for (const [code, days] of Object.entries(appear)) {
    const first = days[0];
    const i = dIdx.get(first);
    if (i < BURN_IN_DAYS) continue;          // 좌측 절단
    if (i + H > lastIdx) continue;           // 우측 절단
    const rec = recs.find(r => r.stock_code === code && r.recommendation_date === first);
    if (!rec) continue;
    const recurred = days.some(d => d > first && dIdx.get(d) <= i + H);
    samples.push({ rec, code, date: first, di: i, recurred });
  }
  samples.sort((a, b) => a.di - b.di);

  console.log(`\n${'='.repeat(76)}`);
  console.log(`첫 등장 종목의 재등장 예측 — 관측창 H=${H}거래일, burn-in ${BURN_IN_DAYS}일`);
  console.log('='.repeat(76));
  console.log(`\n전체 추천일 ${dates.length}일 (${dates[0]} ~ ${dates[lastIdx]})`);
  console.log(`유효 표본(첫 등장) ${samples.length}건 — 재등장 ${samples.filter(s => s.recurred).length}건 ` +
    `(기저율 ${(samples.filter(s => s.recurred).length / samples.length * 100).toFixed(1)}%)`);

  // ── 성과 (첫 등장 그 추천건의 이후 수익)
  const ids = samples.map(s => s.rec.id);
  const pm = {};
  for (let i = 0; i < ids.length; i += 200) {
    const c = ids.slice(i, i + 200);
    for (let o = 0; ; o += 1000) {
      const { data: dp } = await sb.from('recommendation_daily_prices')
        .select('recommendation_id,days_since_recommendation,cumulative_return').in('recommendation_id', c).range(o, o + 999);
      (dp || []).forEach(x => { (pm[x.recommendation_id] ??= {})[x.days_since_recommendation] = x.cumulative_return; });
      if (!dp || dp.length < 1000) break;
    }
  }
  const retAt = (id, t) => {
    const m = pm[id]; if (!m) return null;
    let b = null, bd = -1, has = false;
    for (const d of Object.keys(m).map(Number)) { if (d <= t && d > bd) { bd = d; b = m[d]; } if (d >= t) has = true; }
    return has ? b : null;
  };
  const perf = (set, h) => { const v = set.map(s => retAt(s.rec.id, h)).filter(x => x != null); return { n: v.length, avg: mean(v), win: v.filter(x => x > 0).length / (v.length || 1) * 100 }; };

  console.log(`\n[1] 라벨이 실제로 수익을 가르는가 (첫 등장 건 기준)\n`);
  console.log('집단        n     D+1     승률    D+3     승률   D+10    승률');
  console.log('-'.repeat(64));
  for (const [lab, set] of [['재등장', samples.filter(s => s.recurred)], ['1회성', samples.filter(s => !s.recurred)]]) {
    let line = `${lab.padEnd(8)} ${String(set.length).padStart(4)}`;
    for (const h of [1, 3, 10]) { const p = perf(set, h); line += ` ${fmt(p.avg)}% ${pctS(Math.round(p.win * p.n / 100), p.n)}`; }
    console.log(line);
  }

  // ── 특징별 판별력
  const NUM = ['market_cap', 'total_score', 'base_score', 'momentum_score', 'trend_score',
    'volume_acceleration_score', 'volume_ratio', 'volume_5d_change_rate', 'mfi', 'rsi',
    'disparity', 'vwap_divergence', 'asymmetric_ratio', 'vpd_raw', 'consecutive_rise_days',
    'change_rate', 'whale_bonus', 'whale_volume_ratio', 'whale_price_change',
    'escape_closing_strength', 'signal_adjustment', 'volume'];
  const BOOL = ['whale_detected', 'whale_confirmed', 'accumulation_detected', 'escape_velocity', 'is_top3'];

  console.log(`\n[2] 특징별 판별력 (AUC — 0.50이면 무의미, 0.60+면 쓸 만함)\n`);
  console.log('특징                          AUC    재등장평균     1회성평균');
  console.log('-'.repeat(66));
  const rows = [];
  for (const f of NUM) {
    const P = samples.filter(s => s.recurred && s.rec[f] != null).map(s => Number(s.rec[f]));
    const N = samples.filter(s => !s.recurred && s.rec[f] != null).map(s => Number(s.rec[f]));
    const a = auc(P, N);
    if (a == null) continue;
    rows.push({ f, a, mp: mean(P), mn: mean(N), type: 'num' });
  }
  for (const f of BOOL) {
    const P = samples.filter(s => s.recurred).map(s => (s.rec[f] ? 1 : 0));
    const N = samples.filter(s => !s.recurred).map(s => (s.rec[f] ? 1 : 0));
    rows.push({ f, a: auc(P, N), mp: mean(P) * 100, mn: mean(N) * 100, type: 'bool' });
  }
  rows.sort((x, y) => Math.abs(y.a - 0.5) - Math.abs(x.a - 0.5));
  for (const r of rows) {
    const scale = r.f === 'market_cap' ? 1e12 : r.f === 'volume' ? 1e6 : 1;
    const unit = r.f === 'market_cap' ? '조' : r.f === 'volume' ? 'M' : r.type === 'bool' ? '%' : '';
    console.log(`${r.f.padEnd(28)} ${r.a.toFixed(3)}  ${(r.mp / scale).toFixed(2).padStart(9)}${unit}  ${(r.mn / scale).toFixed(2).padStart(9)}${unit}`);
  }

  // 범주형
  console.log(`\n[3] 범주형\n`);
  for (const f of ['market', 'recommendation_grade']) {
    const g = {};
    for (const s of samples) { const k = s.rec[f] ?? '미상'; (g[k] ??= []).push(s.recurred); }
    console.log(`  ${f}:`);
    for (const [k, v] of Object.entries(g).sort((a, b) => b[1].length - a[1].length))
      console.log(`    ${String(k).padEnd(10)} n=${String(v.length).padStart(4)}  재등장률 ${(v.filter(Boolean).length / v.length * 100).toFixed(0)}%`);
  }

  // ── 시간 분할 학습/검증
  const split = Math.floor(samples.length * 0.7);
  const train = samples.slice(0, split), test = samples.slice(split);
  console.log(`\n[4] 시간 분할: 학습 ${train.length}건(${train[0].date}~${train[train.length - 1].date}) / ` +
    `검증 ${test.length}건(${test[0].date}~${test[test.length - 1].date})\n`);

  // 학습 구간에서만 AUC 상위 특징을 뽑아 z-점수 합산(가중치는 방향만) — 과적합 여지를 줄인다
  const trainAuc = [];
  for (const f of NUM) {
    const P = train.filter(s => s.recurred && s.rec[f] != null).map(s => Number(s.rec[f]));
    const N = train.filter(s => !s.recurred && s.rec[f] != null).map(s => Number(s.rec[f]));
    const a = auc(P, N);
    if (a != null && Math.abs(a - 0.5) >= 0.05) trainAuc.push({ f, a });
  }
  trainAuc.sort((x, y) => Math.abs(y.a - 0.5) - Math.abs(x.a - 0.5));
  const chosen = trainAuc.slice(0, 4);
  console.log(`  학습 구간 선택 특징: ${chosen.map(c => `${c.f}(AUC ${c.a.toFixed(2)})`).join(', ') || '없음'}`);
  if (!chosen.length) { console.log('\n  → 학습 구간에서 판별력 있는 특징이 없음. 여기서 종료.'); return; }

  const stats = {};
  for (const c of chosen) {
    const v = train.map(s => Number(s.rec[c.f])).filter(x => x != null && !Number.isNaN(x));
    const m = mean(v), sd = Math.sqrt(mean(v.map(x => (x - m) ** 2))) || 1;
    stats[c.f] = { m, sd, dir: c.a >= 0.5 ? 1 : -1 };
  }
  const score = s => {
    let t = 0, k = 0;
    for (const c of chosen) {
      const raw = Number(s.rec[c.f]);
      if (raw == null || Number.isNaN(raw)) continue;
      t += stats[c.f].dir * (raw - stats[c.f].m) / stats[c.f].sd; k++;
    }
    return k ? t / k : null;
  };

  const testScored = test.map(s => ({ ...s, sc: score(s) })).filter(s => s.sc != null);
  const testAuc = auc(testScored.filter(s => s.recurred).map(s => s.sc), testScored.filter(s => !s.recurred).map(s => s.sc));
  console.log(`  검증 구간 재등장 예측 AUC: ${testAuc == null ? 'N/A' : testAuc.toFixed(3)}  (기저율 ${(testScored.filter(s => s.recurred).length / testScored.length * 100).toFixed(0)}%)`);

  // ── 경제적 가치: 점수 상·하위의 실제 수익 차이
  console.log(`\n[5] 판정 기준 — 이 점수가 수익을 가르는가 (검증 구간)\n`);
  const sorted = [...testScored].sort((a, b) => b.sc - a.sc);
  const half = Math.floor(sorted.length / 2);
  console.log('집단          n     D+1     승률    D+3     승률   D+10    승률   재등장률');
  console.log('-'.repeat(76));
  for (const [lab, set] of [['점수 상위', sorted.slice(0, half)], ['점수 하위', sorted.slice(half)]]) {
    let line = `${lab.padEnd(10)} ${String(set.length).padStart(4)}`;
    for (const h of [1, 3, 10]) { const p = perf(set, h); line += ` ${fmt(p.avg)}% ${pctS(Math.round(p.win * p.n / 100), p.n)}`; }
    line += `   ${pctS(set.filter(s => s.recurred).length, set.length)}`;
    console.log(line);
  }

  console.log(`\n  참고: 같은 검증 구간에서 실제 라벨로 가른 경우(예측이 완벽할 때의 상한)`);
  for (const [lab, set] of [['  재등장(실제)', testScored.filter(s => s.recurred)], ['  1회성(실제)', testScored.filter(s => !s.recurred)]]) {
    let line = `${lab.padEnd(14)} ${String(set.length).padStart(4)}`;
    for (const h of [1, 3, 10]) { const p = perf(set, h); line += ` ${fmt(p.avg)}% ${pctS(Math.round(p.win * p.n / 100), p.n)}`; }
    console.log(line);
  }
})();
