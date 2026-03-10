const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

(async () => {
  // calc-expectations의 로그를 직접 볼 수 없으니,
  // Supabase REST API를 통해 직접 확인
  // recommend API의 metadata에서는 안 보이니까
  // save-daily-recommendations에서 간접적으로 확인

  // 방법: calc-expectations가 방금 실행되었으니 결과를 보자
  // expected_return_stats를 recommend API 응답에서 간접 확인은 불가

  // 직접 Supabase를 호출하자
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL) {
    console.log('로컬 환경변수 없음 - Vercel 함수로 우회 확인');
    console.log();

    // performance API에서 등급별 통계 확인
    console.log('=== 성과 API에서 등급별 분포 확인 ===');
    const perf = await fetch('https://investar-xi.vercel.app/api/recommendations/performance?days=90');

    if (perf.gradeStats) {
      console.log('등급별 통계:');
      Object.entries(perf.gradeStats).forEach(([grade, stats]) => {
        console.log('  ' + grade + ': ' + JSON.stringify(stats));
      });
    }

    console.log();
    console.log('총 추천 수:', perf.totalRecommendations);
    console.log('추적 기간:', perf.period);

    if (perf.recommendations) {
      const gradeCounts = {};
      const gradeWithPrices = {};
      perf.recommendations.forEach(r => {
        const g = r.grade || '?';
        gradeCounts[g] = (gradeCounts[g] || 0) + 1;
        if (r.latestReturn !== undefined && r.latestReturn !== null) {
          gradeWithPrices[g] = (gradeWithPrices[g] || 0) + 1;
        }
      });
      console.log();
      console.log('등급별 추천 종목 수 (90일):');
      Object.keys(gradeCounts).sort().forEach(g => {
        console.log('  ' + g + ': ' + gradeCounts[g] + '개 (가격추적: ' + (gradeWithPrices[g] || 0) + '개)');
      });
    }
  }
})();
