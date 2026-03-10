const supabase = require('../../backend/supabaseClient');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);

    if (!q || q.length < 1) {
      return res.status(200).json({ success: true, results: [] });
    }

    let query;
    if (/^\d+$/.test(q)) {
      // 숫자만 입력 → 종목코드 prefix 검색
      query = supabase
        .from('stock_master')
        .select('stock_code, stock_name, market')
        .like('stock_code', `${q}%`)
        .limit(limit);
    } else {
      // 한글/영문 → 종목명 검색
      query = supabase
        .from('stock_master')
        .select('stock_code, stock_name, market')
        .ilike('stock_name', `%${q}%`)
        .limit(limit);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      success: true,
      results: (data || []).map(d => ({
        code: d.stock_code,
        name: d.stock_name,
        market: d.market
      }))
    });
  } catch (err) {
    console.error('종목 검색 오류:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
