const supabase = require('../../backend/supabaseClient');
const axios = require('axios');

let iconv;
try { iconv = require('iconv-lite'); } catch (e) { }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    console.log('📋 종목 마스터 업데이트 시작...');

    async function fetchAndParse(marketType, market) {
      const response = await axios.post('https://kind.krx.co.kr/corpgeneral/corpList.do',
        new URLSearchParams({ method: 'download', marketType }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, timeout: 30000, responseType: 'arraybuffer' }
      );
      const html = iconv
        ? iconv.decode(Buffer.from(response.data), 'euc-kr')
        : new TextDecoder('euc-kr').decode(response.data);
      const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      const stocks = [];
      for (const tr of trs) {
        const tds = tr.match(/<td[\s\S]*?<\/td>/gi);
        if (!tds || tds.length < 3) continue;
        const name = tds[0].replace(/<[^>]*>/g, '').trim();
        const code = tds[2].replace(/<[^>]*>/g, '').trim();
        if (/^\d{6}$/.test(code) && name) {
          stocks.push({ stock_code: code, stock_name: name, market, updated_at: new Date().toISOString() });
        }
      }
      return stocks;
    }

    const [kospi, kosdaq] = await Promise.all([
      fetchAndParse('stockMkt', 'KOSPI'),
      fetchAndParse('kosdaqMkt', 'KOSDAQ')
    ]);

    const all = [...kospi, ...kosdaq];
    console.log(`📊 KOSPI: ${kospi.length}, KOSDAQ: ${kosdaq.length}, 합계: ${all.length}`);

    let upserted = 0;
    for (let i = 0; i < all.length; i += 100) {
      const { error } = await supabase
        .from('stock_master')
        .upsert(all.slice(i, i + 100), { onConflict: 'stock_code' });
      if (error) console.error(`❌ 배치 upsert 실패:`, error.message);
      else upserted += Math.min(100, all.length - i);
    }

    console.log(`✅ ${upserted}/${all.length}개 upsert 완료`);
    return res.status(200).json({ success: true, kospi: kospi.length, kosdaq: kosdaq.length, total: all.length, upserted });
  } catch (err) {
    console.error('❌ 종목 마스터 업데이트 실패:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
