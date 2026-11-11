/**
 * LOCKUP_VERDICT 입력: 2022~ 신규 상장(IPO) 목록. 수익률은 계산하지 않는다.
 * IPO = krx-daily 에 처음 나타난 종목 중, 첫 등장 0~45일 전에 같은 종목코드의
 *       "[발행조건확정]증권신고서(지분증권)" 접수가 있는 것 (유상증자·분할재상장·이전상장 배제).
 * 입력: 인자1 = disclosures 에서 뽑은 발행조건확정 접수 JSON. 결과: data/lockup-ipos.json
 */
const fs = require('fs'), path = require('path');
const D = path.resolve(__dirname, '../data');
const fil = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const first = new Map(), mkt = new Map(); let d0 = null;
const k2010 = new Set();
for (const l of fs.readFileSync(path.join(D, 'krx-daily.jsonl'), 'utf-8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  if (!d0 || r.d < d0) d0 = r.d;
  for (const s of r.s) if (!first.has(s[0]) || first.get(s[0]) > r.d) first.set(s[0], r.d);
}
const iso = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const out = [];
for (const [code, d] of first) {
  if (d === d0) continue;
  const f = fil.filter(x => x.stock_code === code && x.rcept_dt <= iso(d) && (Date.parse(iso(d)) - Date.parse(x.rcept_dt)) / 864e5 <= 45);
  if (!f.length) continue;
  const name = f[f.length - 1].corp_name;
  if (/스팩|기업인수목적|리츠|REIT/i.test(name)) continue;
  out.push({ code, name, list: iso(d), cls: f[0].corp_cls, filed: f[f.length - 1].rcept_dt });
}
out.sort((a, b) => (a.list < b.list ? -1 : 1));
fs.writeFileSync(path.join(D, 'lockup-ipos.json'), JSON.stringify(out, null, 1));
const by = {}; out.forEach(x => { const y = x.list.slice(0, 4) + x.cls; by[y] = (by[y] || 0) + 1; });
console.log('IPO', out.length, by);
console.log(out.slice(0, 5).map(x => `${x.list} ${x.name}`).join(' | '), ' ... ', out.slice(-3).map(x => `${x.list} ${x.name}`).join(' | '));
