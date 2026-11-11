/**
 * INDEX_REBAL_VERDICT 입력: 정기변경 명단 종목명 → 코드 (A1 일자 KRX ISU_NM).
 * 수익률은 계산하지 않는다. 결과: data/index-rebal-codes.json
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs'), path = require('path');
const D = path.resolve(__dirname, '../data');
const EV = JSON.parse(fs.readFileSync(path.join(D, 'index-rebal-events.json'), 'utf-8')).events;
const days = fs.readFileSync(path.join(D, 'krx-daily.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => l.slice(6, 14)).sort();
const ymd = s => s.replace(/-/g, '');
const nextDay = d => days.find(x => x > ymd(d));
const norm = s => s.replace(/\s+/g, '').toUpperCase().replace(/[()]/g, '');
async function names(bas) {
  const f = path.join(D, 'cache-krx-names', bas + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  const out = {};
  for (const p of ['/sto/stk_bydd_trd', '/sto/ksq_bydd_trd']) {
    const r = await fetch(`http://data-dbg.krx.co.kr/svc/apis${p}?basDd=${bas}`, { headers: { AUTH_KEY: process.env.KRX_AUTH_KEY } });
    const j = await r.json();
    for (const x of j.OutBlock_1 || []) out[norm(x.ISU_NM)] = { code: x.ISU_CD, name: x.ISU_NM, mkt: x.MKT_NM };
  }
  fs.writeFileSync(f, JSON.stringify(out));
  return out;
}
const ALIAS = {};   // 철자 교정만: '기사표기' → 'KRX표기'
(async () => {
  const res = [], miss = [];
  for (const e of EV) {
    const a1 = nextDay(e.ann);
    const m = await names(a1);
    for (const k of ['k200_in', 'k200_out', 'k150_in', 'k150_out']) for (const n of e[k]) {
      const key = norm(ALIAS[n] || n), hit = m[key];
      if (hit) res.push({ ev: e.id, list: k, name: n, code: hit.code, krxName: hit.name, mkt: hit.mkt });
      else miss.push(`${e.id} ${k} ${n}`);
    }
  }
  console.log(`매칭 ${res.length} · 실패 ${miss.length}`); miss.forEach(x => console.log('  ✗', x));
  fs.writeFileSync(path.join(D, 'index-rebal-codes.json'), JSON.stringify(res, null, 1));
})();
