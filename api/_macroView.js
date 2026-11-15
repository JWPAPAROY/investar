// 시장 흐름 탭 데이터 (2026-11-15) — GET /api/screening/prediction?view=macro
// 언더스코어 접두 = Vercel 이 별도 함수로 잡지 않는다(함수 12개 한도). 수집은 scripts/collect-macro.js.
// 프론트가 Supabase 를 직접 부르지 않는다(anon 정책이 FOR ALL 이라 키 노출 시 쓰기 가능).
const supabase = require('./../backend/supabaseClient');

async function macroView(res) {
  if (!supabase) return res.status(500).json({ success: false, error: 'Supabase 미설정' });
  try {
    const [snap, news, events] = await Promise.all([
      supabase.from('macro_snapshot').select('id, data, updated_at'),
      supabase.from('policy_news').select('title, link, source, published_at, tag').order('published_at', { ascending: false }).order('link').limit(40),
      supabase.from('policy_events').select('*').order('event_date', { ascending: false }).order('id'),
    ]);
    for (const r of [snap, news, events]) if (r.error) throw new Error(r.error.message);
    const by = Object.fromEntries((snap.data || []).map(r => [r.id, { ...r.data, updatedAt: r.updated_at }]));
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ success: true, fed: by.fed || null, regime: by.regime || null, sectors: by.sectors || null, news: news.data || [], events: events.data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = { macroView };
