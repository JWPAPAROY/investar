/**
 * calc-expectations.js — 기대수익 통계 산출 (v3.96)
 *
 * 왜 분리했나 (2026-08-25):
 *   `expected_return_stats`(14행)와 `stock_expected_returns`(1,945행)가 **2026-08-14에
 *   멈춰 있었다**. 이 값은 매일 아침 텔레그램의 "📈 기대수익(N일)" · "⚖️ 손익비 / 승률"에
 *   그대로 표시되므로, 사용자는 11일 지난 숫자를 보고 있었다.
 *
 *   원인은 계산이 아니라 **배치 위치**다. calc-expectations는 post-market 모드의
 *   Step A(패턴) → B(업종전망) → C(업종지수) 뒤에 fall-through로 붙어 있는 **마지막 단계**이고,
 *   Vercel 함수는 `vercel.json`의 maxDuration 60초에 묶여 있다. 앞 단계가 길어지면
 *   조용히 잘리는 쪽은 항상 마지막인 이 단계다 — 실제로 같은 핸들러의 Step B(sector_outlook_stats)는
 *   8/24까지 갱신됐는데 Step D만 8/14에 멈췄다. 계산 자체는 로컬에서 10.7초로 멀쩡하다.
 *
 *   → 60초 벽이 없는 GitHub Actions에서 독립 실행한다(.github/workflows/calc-expectations.yml).
 *     post-market의 fall-through는 그대로 두어 이중 안전망으로 남긴다(멱등 upsert).
 *
 * 실행: node scripts/calc-expectations.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const handler = require('../api/cron/save-daily-recommendations.js');

// 핸들러가 유일한 출처다. 로직을 복사하지 않고 mode만 지정해 호출한다
// (사본 드리프트로 이미 여러 번 사고가 났다 — backend/top3Ranking.js 헤더 참고).
const t0 = Date.now();
const req = { method: 'GET', query: { mode: 'calc-expectations' } };
const res = {
  setHeader: () => {},
  status: (code) => ({
    json: (d) => {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      if (code >= 400 || d?.success === false) {
        console.error('❌ 실패 (' + el + 's, HTTP ' + code + '): ' + JSON.stringify(d).slice(0, 400));
        process.exit(1);
      }
      console.log('✅ 완료 (' + el + 's): 등급조합 ' + (d.stats ?? '?')
        + '건 / 종목별 ' + (d.stockExpected ?? '?') + '건 / 추천 ' + (d.totalRecs ?? '?')
        + ' / 가격 ' + (d.totalPrices ?? '?'));
      process.exit(0);
    },
    end: () => { console.log('완료 (HTTP ' + code + ')'); process.exit(code >= 400 ? 1 : 0); },
  }),
};

handler(req, res).catch(e => { console.error('❌', e.message); process.exit(1); });
