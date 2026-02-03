// v3.17 재평가: 과거 추천 종목을 현재 로직으로 재분석
const https = require('https');

// 환경변수 로드 (.env)
try { require('dotenv').config(); } catch(e) {}

const screener = require('./backend/screening');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // 1. Supabase 성과 데이터 (구 로직 점수 + 실제 수익률)
  console.log('Supabase 데이터 조회 중...');
  const perf = await fetch('https://investar-xi.vercel.app/api/recommendations/performance?days=7');
  const perfStocks = perf.stocks || [];

  // 중복 제거 (같은 종목 여러 날짜 → 최신 것만)
  const seen = {};
  const unique = [];
  perfStocks.forEach(s => {
    if (!seen[s.stock_code]) {
      seen[s.stock_code] = true;
      unique.push(s);
    }
  });

  console.log('재평가 대상:', unique.length + '개 종목');
  console.log('KIS API로 개별 분석 시작 (종목당 ~1초)...\n');

  const results = [];

  for (const s of unique) {
    try {
      console.log('  분석 중: ' + s.stock_name + ' (' + s.stock_code + ')');
      const analysis = await screener.analyzeStock(s.stock_code);
      await sleep(800); // rate limit

      if (analysis) {
        results.push({
          name: s.stock_name,
          code: s.stock_code,
          oldScore: s.total_score,
          oldGrade: s.recommendation_grade,
          newScore: analysis.totalScore,
          newGrade: analysis.grade,
          ret: s.current_return,
          whale: s.whale_detected,
          accum: s.accumulation_detected,
          date: s.recommendation_date
        });
      } else {
        results.push({
          name: s.stock_name,
          code: s.stock_code,
          oldScore: s.total_score,
          oldGrade: s.recommendation_grade,
          newScore: null,
          newGrade: '분석실패',
          ret: s.current_return,
          date: s.recommendation_date
        });
      }
    } catch(e) {
      console.log('    에러:', e.message);
      results.push({
        name: s.stock_name,
        code: s.stock_code,
        oldScore: s.total_score,
        oldGrade: s.recommendation_grade,
        newScore: null,
        newGrade: '에러',
        ret: s.current_return,
        date: s.recommendation_date
      });
    }
  }

  // === 결과 출력 ===
  console.log('\n=== v3.17 재평가 결과 ===\n');
  console.log(
    '종목명'.padEnd(14) +
    '구점수'.padStart(6) + ' ' +
    '구등급'.padEnd(5) +
    '신점수'.padStart(6) + ' ' +
    '신등급'.padEnd(5) +
    '변동'.padStart(7) +
    '수익률'.padStart(9)
  );
  console.log('-'.repeat(70));

  results.sort((a, b) => (b.newScore || 0) - (a.newScore || 0));
  results.forEach(r => {
    const diff = r.newScore != null ? (r.newScore - r.oldScore).toFixed(1) : 'N/A';
    const diffStr = r.newScore != null ? ((r.newScore - r.oldScore) >= 0 ? '+' + diff : diff) : 'N/A';
    const retStr = r.ret != null ? r.ret.toFixed(2) + '%' : 'N/A';
    console.log(
      (r.name || '?').padEnd(14) +
      String(r.oldScore).padStart(6) + ' ' +
      (r.oldGrade || '?').padEnd(5) +
      (r.newScore != null ? String(r.newScore).padStart(6) : '  N/A ') + ' ' +
      (r.newGrade || '?').padEnd(5) +
      diffStr.padStart(7) +
      retStr.padStart(9)
    );
  });

  // 통계
  const matched = results.filter(r => r.newScore != null);
  if (matched.length > 0) {
    const avgOld = matched.reduce((a, r) => a + r.oldScore, 0) / matched.length;
    const avgNew = matched.reduce((a, r) => a + r.newScore, 0) / matched.length;
    const increased = matched.filter(r => r.newScore > r.oldScore).length;
    const decreased = matched.filter(r => r.newScore < r.oldScore).length;

    console.log('\n=== 점수 변동 통계 ===');
    console.log('분석 성공:', matched.length + '/' + results.length + '개');
    console.log('평균 구점수:', avgOld.toFixed(1) + '점');
    console.log('평균 신점수:', avgNew.toFixed(1) + '점');
    console.log('평균 변동:', (avgNew - avgOld).toFixed(1) + '점');
    console.log('점수 상승:', increased + '개');
    console.log('점수 하락:', decreased + '개');
  }

  // v3.17 점수 기준 수익률 분포
  console.log('\n=== v3.17 신점수 기준 수익률 분포 ===');
  const rangeKeys = ['70+', '60-69', '50-59', '40-49', '30-39', '<30'];
  const rangeMap = {};
  rangeKeys.forEach(k => rangeMap[k] = []);
  matched.forEach(r => {
    if (r.ret == null) return;
    const sc = r.newScore;
    if (sc >= 70) rangeMap['70+'].push(r);
    else if (sc >= 60) rangeMap['60-69'].push(r);
    else if (sc >= 50) rangeMap['50-59'].push(r);
    else if (sc >= 40) rangeMap['40-49'].push(r);
    else if (sc >= 30) rangeMap['30-39'].push(r);
    else rangeMap['<30'].push(r);
  });

  console.log('v3.17구간  개수   승률      평균수익률');
  console.log('-'.repeat(48));
  rangeKeys.forEach(k => {
    const arr = rangeMap[k];
    if (arr.length === 0) { console.log(k.padEnd(10) + '  0개'); return; }
    const wins = arr.filter(r => r.ret > 0).length;
    const wr = (wins / arr.length * 100).toFixed(1);
    const avgRet = (arr.reduce((a, r) => a + r.ret, 0) / arr.length).toFixed(2);
    console.log(k.padEnd(10) + String(arr.length).padStart(3) + '개  ' + wr.padStart(6) + '%   ' + avgRet.padStart(7) + '%');
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
