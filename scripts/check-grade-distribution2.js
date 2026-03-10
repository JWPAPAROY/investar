const https = require('https');
const url = require('url');

function fetch(apiUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(apiUrl);
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNvemp1bGNyeHFmbWpxbmR4aGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzg0MTAxMDIsImV4cCI6MjA1Mzk4NjEwMn0.GBfGJSQDjKGalRjkMFZNRJOCEVMQ3-1a_GCRWV5-8TM',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNvemp1bGNyeHFmbWpxbmR4aGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzg0MTAxMDIsImV4cCI6MjA1Mzk4NjEwMn0.GBfGJSQDjKGalRjkMFZNRJOCEVMQ3-1a_GCRWV5-8TM'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

(async () => {
  // Supabase anon key로 직접 조회 (RLS public read 설정됨)

  // 1. expected_return_stats 현황
  console.log('=== expected_return_stats 현황 ===');
  const stats = await fetch('https://sozjulcrxqfmjqndxhko.supabase.co/rest/v1/expected_return_stats?select=*&order=grade');
  if (Array.isArray(stats)) {
    stats.forEach(r => {
      console.log('  ' + r.grade + ' | whale=' + r.whale_detected + ' | day=' + r.optimal_days + ' | median=' + r.median + '% | p25=' + r.p25 + '% | p75=' + r.p75 + '% | winRate=' + r.win_rate + '% | N=' + r.sample_count);
    });
  } else {
    console.log('조회 실패:', stats);
  }

  console.log();

  // 2. screening_recommendations 등급별 분포
  console.log('=== screening_recommendations 등급별 분포 ===');
  const recs = await fetch('https://sozjulcrxqfmjqndxhko.supabase.co/rest/v1/screening_recommendations?select=recommendation_grade');
  if (Array.isArray(recs)) {
    const gradeCounts = {};
    recs.forEach(r => {
      const g = r.recommendation_grade || '?';
      gradeCounts[g] = (gradeCounts[g] || 0) + 1;
    });
    console.log('총 추천:', recs.length, '건');
    Object.keys(gradeCounts).sort().forEach(g => {
      console.log('  ' + g + ': ' + gradeCounts[g] + '건');
    });
  }

  console.log();

  // 3. recommendation_daily_prices에서 A등급 종목의 가격 데이터 수
  console.log('=== A등급 종목 일별가격 데이터 확인 ===');
  const aRecs = await fetch('https://sozjulcrxqfmjqndxhko.supabase.co/rest/v1/screening_recommendations?select=id&recommendation_grade=eq.A');
  if (Array.isArray(aRecs)) {
    console.log('A등급 추천 수:', aRecs.length);

    // A등급 ID들의 daily prices 수
    const aIds = aRecs.map(r => r.id);
    if (aIds.length > 0) {
      const idFilter = 'in.(' + aIds.join(',') + ')';
      const aPrices = await fetch('https://sozjulcrxqfmjqndxhko.supabase.co/rest/v1/recommendation_daily_prices?select=recommendation_id,days_since_recommendation&recommendation_id=' + idFilter + '&days_since_recommendation=gte.1&days_since_recommendation=lte.15');
      if (Array.isArray(aPrices)) {
        console.log('A등급 일별가격 데이터:', aPrices.length, '건');

        // day별 분포
        const dayCount = {};
        aPrices.forEach(p => {
          dayCount[p.days_since_recommendation] = (dayCount[p.days_since_recommendation] || 0) + 1;
        });
        console.log('day별 분포:');
        Object.keys(dayCount).sort((a,b) => a-b).forEach(d => {
          console.log('  day ' + d + ': ' + dayCount[d] + '건' + (dayCount[d] >= 30 ? ' ✅' : ' ❌ (<30)'));
        });
      }
    }
  }
})();
