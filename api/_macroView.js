// 시장 흐름 탭 데이터 (2026-11-15, 2026-11-16 개정)
//   GET /api/screening/prediction?view=macro              — 연준·국면·업종·민감도·일정·정책·월가 시각·월가 흐름
//   GET /api/screening/prediction?view=sens&codes=005930,012450 — 보유 종목 민감도(market_flow_daily 주간 종가)
// 언더스코어 접두 = Vercel 이 별도 함수로 잡지 않는다(함수 12개 한도). 수집은 scripts/collect-macro.js.
// 프론트가 Supabase 를 직접 부르지 않는다(anon 정책이 FOR ALL 이라 키 노출 시 쓰기 가능).
const supabase = require('./../backend/supabaseClient');
const { newsPasses, dedupeNews, sensitivity, rCrit, round } = require('./../backend/macroShared');

let rebalLive = { events: [] };
try { rebalLive = require('../data/index-rebal-live.json'); } catch { /* 없으면 빈 명단 */ }

const PUBLIC_IDS = ['fed', 'regime', 'sectors', 'sensitivity', 'calendar', 'flows', 'street_flow'];   // krx_weekly·ipo_cache·street_flow_cache 는 수집기 내부 캐시
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function macroView(res) {
  if (!supabase) return res.status(500).json({ success: false, error: 'Supabase 미설정' });
  try {
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const [snap, news, events, street] = await Promise.all([
      supabase.from('macro_snapshot').select('id, data, updated_at').in('id', PUBLIC_IDS),
      supabase.from('policy_news').select('title, link, source, published_at, tag').gte('published_at', since).order('published_at', { ascending: false }).order('link').limit(400),
      supabase.from('policy_events').select('*').order('event_date', { ascending: false }).order('id'),
      // 월가 시각: 최근 60일 사건(기관·대상·방향·수치). 테이블이 없거나 실패해도 나머지 칸은 보여준다.
      supabase.from('street_views').select('id, first_seen, first_pub, inst, target, dir, value, prev, pct, horizon, method, title, link, source, n_sources, sources, ref_date, ref_level, implied_pct')
        .gte('first_seen', new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10)).order('first_seen', { ascending: false }).limit(200),
    ]);
    for (const r of [snap, news, events]) if (r.error) throw new Error(r.error.message);
    const streetRows = street.error ? [] : (street.data || []).map(r => ({ ...r, sources: (r.sources || []).map(x => ({ title: x.title, link: x.link, source: x.source, published_at: x.published_at })) }));
    const by = Object.fromEntries((snap.data || []).map(r => [r.id, { ...r.data, updatedAt: r.updated_at }]));
    // 민감도의 요인 계열은 보유 종목 계산용(서버 내부) — 화면에는 안 보낸다
    if (by.sensitivity) { const { factors, ...rest } = by.sensitivity; by.sensitivity = rest; }
    // 월가 흐름: 일별 원집계(days, 최대 182일)는 수집기가 다시 세는 데 쓰는 것 — 화면은 daily·weekly 로 충분
    if (by.street_flow) { const { days, ...rest } = by.street_flow; by.street_flow = rest; }
    // 정기변경 실시간 관측 명단(data/index-rebal-live.json, 사람이 기사로 확인해 넣는다)
    if (by.calendar) {
      const today = kstToday();
      const extra = (rebalLive.events || []).filter(e => (e.eff || e.ann) >= today).map(e => ({ date: e.eff || e.ann, kind: 'rebal', title: '지수 정기변경 명단 확정', detail: [e.k200_in?.length ? `코스피200 편입 ${e.k200_in.length}` : '', e.k150_in?.length ? `코스닥150 편입 ${e.k150_in.length}` : ''].filter(Boolean).join(' · ') }));
      by.calendar.items = [...(by.calendar.items || []).filter(x => x.date >= today), ...extra].sort((a, b) => (a.kst || a.date).localeCompare(b.kst || b.date));
    }
    // 뉴스: 수집 때와 같은 기준으로 다시 거르고(기준이 바뀌기 전에 쌓인 행 정리), 비슷한 제목은 묶고,
    //   한 사안이 하루를 덮지 않게 태그·날짜(KST)마다 4건까지(나머지는 첫 기사에 dayMore 로 센다), 태그마다 최대 12건
    const kept = dedupeNews((news.data || []).filter(n => newsPasses(n.tag, n.title)));
    const perTag = {}, perDay = {}, firstOfDay = {}; const newsOut = [];
    for (const n of kept) {
      const k = n.tag + '|' + new Date(Date.parse(n.published_at) + 9 * 3600e3).toISOString().slice(0, 10);
      perDay[k] = (perDay[k] || 0) + 1;
      if (perDay[k] > 4) { if (firstOfDay[k]) firstOfDay[k].dayMore = (firstOfDay[k].dayMore || 0) + 1 + (n.similar || 0); continue; }
      perTag[n.tag] = (perTag[n.tag] || 0) + 1; if (perTag[n.tag] > 12) continue;
      newsOut.push(n); if (!firstOfDay[k]) firstOfDay[k] = n;
    }
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ success: true, fed: by.fed || null, regime: by.regime || null, sectors: by.sectors || null,
      sensitivity: by.sensitivity || null, calendar: by.calendar || null, news: newsOut, events: events.data || [], street: streetRows, flows: by.flows || null, streetFlow: by.street_flow || null });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// 보유 종목 민감도 — 같은 주 단위(수집기의 KR 주말 날짜)로 market_flow_daily 종가를 맞춘다.
// market_flow_daily 의 전 종목 수집은 2026-05-22 부터라 표본은 그 이후 주만큼이다(응답에 weeks 로 나간다).
async function sensView(req, res) {
  if (!supabase) return res.status(500).json({ success: false, error: 'Supabase 미설정' });
  const codes = [...new Set(String(req.query.codes || '').toUpperCase().split(/[^0-9A-Z]+/).filter(c => /^[0-9A-Z]{6}$/.test(c)))].slice(0, 10);
  if (!codes.length) return res.status(400).json({ success: false, error: '종목코드(6자리)를 넣어 주세요' });
  try {
    const { data: s, error } = await supabase.from('macro_snapshot').select('data').eq('id', 'sensitivity').maybeSingle();
    if (error) throw new Error(error.message);
    const factors = s?.data?.factors || [];
    if (factors.length < 10) throw new Error('요인 계열 준비 전');
    const from = factors[0].d;
    const [px, names] = await Promise.all([
      supabase.from('market_flow_daily').select('stock_code, trade_date, krx_close, close').in('stock_code', codes).gte('trade_date', from).in('trade_date', factors.map(f => f.d)).limit(5000),
      supabase.from('stock_master').select('stock_code, stock_name').in('stock_code', codes),
    ]);
    if (px.error) throw new Error(px.error.message);
    const nm = Object.fromEntries((names.data || []).map(r => [r.stock_code, r.stock_name]));
    const rows = codes.map(code => {
      // krx_close(무수정 종가, KRX)가 기본. 당일분은 KRX 미공표라 close(KIS)로 채운다. 주간 ±40% 초과는 sensitivity() 가 이음매로 뺀다.
      const closes = new Map((px.data || []).filter(r => r.stock_code === code).map(r => [r.trade_date, +(r.krx_close ?? r.close)]).filter(([, v]) => v > 0));
      const out = sensitivity(factors, closes);
      return { code, name: nm[code] || null, ...out, rCrit: round(rCrit(out.weeks)) };
    });
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ success: true, from, rows });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = { macroView, sensView };
