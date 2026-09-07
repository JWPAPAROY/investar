/**
 * collect-disclosures.js — DART 공시 목록 수집 (2026-09-07)
 *
 * 왜: 공시 이벤트 축의 판정 입력. 판정 조건은 DISCLOSURE_VERDICT.md에
 *   **데이터를 보기 전에** 사전 등록돼 있다. 이 스크립트는 판정하지 않는다 — 모으기만 한다.
 *
 * ⚠️ 목록(list.json)만 받는다. 본문은 받지 않는다.
 *   B군·C군·통제군 판정은 report_nm만으로 가능하고, 본문이 필요한 것은 A2(자기주식 취득의
 *   목적 구분: 주가안정/이익소각 vs 임직원 인센티브)뿐이다.
 *   A군이 판정을 통과할 때만 본문 수집 비용을 치른다.
 *
 * ⚠️ rcept_dt는 날짜뿐이고 접수 시각이 없다. 이것이 진입을 D+1 종가로 고정하는 근거다.
 *
 * DART 호출 제한: 분당 1,000회 초과 시 제한. 여기서는 200ms 간격(분당 ~300)으로
 *   여유 있게 간다. 3년 소급 ≈ 평일 750일 × 2시장 × 평균 2~3페이지 ≈ 4,000콜 ≈ 15분.
 *
 * 실행:
 *   node scripts/collect-disclosures.js --from=20220101 --to=20260831   # 소급
 *   node scripts/collect-disclosures.js --resume                        # 마지막 저장일 다음날부터
 *   node scripts/collect-disclosures.js                                 # 최근 7일 증분(기본)
 *   node scripts/collect-disclosures.js --reclassify                    # 재수집 없이 분류만 재산출
 *   node scripts/collect-disclosures.js --from=... --dry                # DB 미기록
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { orderByPk } = require('../backend/supabasePaging');
const { classify } = require('../backend/disclosureTypes');

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n) => {
  const a = args.find((x) => x.startsWith('--' + n + '='));
  return a ? a.split('=')[1] : null;
};

const DRY = flag('dry');
const RECLASSIFY = flag('reclassify');
const RESUME = flag('resume');
const KEY = process.env.DART_API_KEY;
const PAGE_COUNT = 100; // DART list.json 페이지당 최대
const GAP_MS = 200; // 호출 간격 (분당 ~300)
const MARKETS = ['Y', 'K']; // 유가증권 / 코스닥. 코넥스·비상장은 유니버스 밖

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const toDate = (s) => new Date(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + 'T00:00:00Z');
const dashed = (s) => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);

/** DART list.json 한 페이지. 일시 오류만 재시도한다. */
async function fetchPage(bgn, end, corpCls, pageNo) {
  const url =
    'https://opendart.fss.or.kr/api/list.json' +
    '?crtfc_key=' + KEY +
    '&bgn_de=' + bgn + '&end_de=' + end + '&corp_cls=' + corpCls +
    '&page_no=' + pageNo + '&page_count=' + PAGE_COUNT;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      const j = await res.json();
      if (j.status === '000') return j;
      if (j.status === '013') return { status: '013', list: [], total_page: 0 }; // 데이터 없음 = 정상
      if (j.status === '020') throw new Error('DART 사용한도 초과 — 간격을 늘리거나 내일 재개할 것');
      if (j.status === '901') throw new Error('DART 인증키 오류 — .env의 DART_API_KEY 확인');
      throw new Error('DART status=' + j.status + ' ' + (j.message || ''));
    } catch (e) {
      if (/한도 초과|인증키 오류/.test(e.message) || attempt === 3) throw e;
      await sleep(1000 * attempt); // 일시 오류만 지수 백오프
    }
  }
}

/** 하루치 × 한 시장. 페이지 전체를 순회한다. */
async function fetchDay(date, corpCls) {
  const rows = [];
  let pageNo = 1;
  let totalPage = 1;
  while (pageNo <= totalPage) {
    const j = await fetchPage(date, date, corpCls, pageNo);
    totalPage = j.total_page || 0;
    for (const d of j.list || []) rows.push(d);
    pageNo++;
    await sleep(GAP_MS);
  }
  return rows;
}

/** DART 응답 → DB 행. 분류는 backend/disclosureTypes.js 단일 출처. */
function toRow(d) {
  const c = classify(d.report_nm, d.rm);
  return {
    rcept_no: d.rcept_no,
    rcept_dt: dashed(d.rcept_dt),
    corp_code: d.corp_code,
    corp_name: d.corp_name || null,
    stock_code: (d.stock_code || '').trim() || null, // 비상장은 빈 문자열로 온다
    corp_cls: d.corp_cls || null,
    report_nm: d.report_nm,
    flr_nm: d.flr_nm || null,
    rm: (d.rm || '').trim() || null,
    report_type: c.type,
    is_amendment: c.amended,
    is_subsidiary: c.subsidiary,
  };
}

async function upsertRows(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb
      .from('disclosures')
      .upsert(rows.slice(i, i + 500), { onConflict: 'rcept_no' });
    if (error) {
      throw new Error('저장 실패: ' + error.message + ' (supabase-disclosures.sql 실행했는지 확인)');
    }
  }
}

async function fetchAll(table, cols, filter) {
  let out = [];
  let from = 0;
  for (;;) {
    let q = orderByPk(sb.from(table).select(cols), table).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(table + ' 조회 실패: ' + error.message);
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

/** 재수집 없이 저장된 report_nm으로 분류만 다시 매긴다. 정규식 수정 후 사용. */
async function reclassify() {
  const rows = await fetchAll('disclosures', 'rcept_no,report_nm,rm,report_type,is_amendment,is_subsidiary');
  console.log('📚 저장분 ' + rows.length.toLocaleString() + '건 재분류');
  const changed = [];
  for (const r of rows) {
    const c = classify(r.report_nm, r.rm);
    if (c.type !== r.report_type || c.amended !== r.is_amendment || c.subsidiary !== r.is_subsidiary) {
      changed.push({
        rcept_no: r.rcept_no, report_type: c.type,
        is_amendment: c.amended, is_subsidiary: c.subsidiary,
      });
    }
  }
  console.log('   변경 ' + changed.length.toLocaleString() + '건');
  if (!changed.length) return;
  if (DRY) {
    console.log('[DRY] DB 미기록');
    return;
  }
  for (let i = 0; i < changed.length; i += 500) {
    const { error } = await sb
      .from('disclosures')
      .upsert(changed.slice(i, i + 500), { onConflict: 'rcept_no' });
    if (error) throw new Error('재분류 저장 실패: ' + error.message);
  }
  console.log('✅ 재분류 완료');
}

(async () => {
  if (!KEY) throw new Error('.env에 DART_API_KEY가 없습니다');
  if (RECLASSIFY) return reclassify();

  let from = opt('from');
  const to = opt('to') || ymd(new Date());

  if (RESUME) {
    const { data, error } = await sb
      .from('disclosures')
      .select('rcept_dt')
      .order('rcept_dt', { ascending: false })
      .limit(1);
    if (error) throw new Error('이어받기 조회 실패: ' + error.message);
    if (!data || !data[0]) throw new Error('저장분이 없습니다 — --from으로 시작 지점을 지정하세요');
    const next = toDate(data[0].rcept_dt.replace(/-/g, ''));
    next.setUTCDate(next.getUTCDate() + 1);
    from = ymd(next);
    console.log('↩️  이어받기: 마지막 저장 ' + data[0].rcept_dt + ' → ' + dashed(from) + '부터');
  }
  if (!from) {
    // 기본: 최근 7일 증분
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    from = ymd(d);
  }
  if (from > to) {
    console.log('⏸ 수집 범위 없음 (' + dashed(from) + ' > ' + dashed(to) + ')');
    return;
  }

  const days = [];
  for (let d = toDate(from); ymd(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue; // 주말은 공시가 없다 (호출 30% 절약)
    days.push(ymd(d));
  }
  console.log('📅 ' + dashed(from) + ' ~ ' + dashed(to) + ' / 평일 ' + days.length + '일 × 시장 ' + MARKETS.length);
  const t0 = Date.now();

  let total = 0;
  let typed = 0;
  let amended = 0;
  let subsid = 0;
  let noStock = 0;
  const byType = new Map();

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const rows = [];
    for (const m of MARKETS) {
      for (const d of await fetchDay(day, m)) rows.push(toRow(d));
    }
    for (const r of rows) {
      total++;
      if (r.is_amendment) amended++;
      if (r.is_subsidiary) subsid++;
      if (!r.stock_code) noStock++;
      if (r.report_type && !r.is_amendment && !r.is_subsidiary) {
        typed++;   // 판정 대상 = 유형 있음 AND 정정 아님 AND 자회사 아님
        byType.set(r.report_type, (byType.get(r.report_type) || 0) + 1);
      }
    }
    if (rows.length && !DRY) await upsertRows(rows);

    if ((i + 1) % 20 === 0 || i === days.length - 1) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / (i + 1)) * (days.length - i - 1);
      console.log(
        '  ' + dashed(day) + '  ' + (i + 1) + '/' + days.length + '일  ' +
        '누적 ' + total.toLocaleString() + '건  분류 ' + typed.toLocaleString() + '  ' +
        '경과 ' + (el / 60).toFixed(1) + '분  ETA ' + (eta / 60).toFixed(1) + '분'
      );
    }
  }

  console.log(
    '\n📊 총 ' + total.toLocaleString() + '건 / 사전등록 유형 ' + typed.toLocaleString() +
    '건 (' + ((100 * typed) / (total || 1)).toFixed(1) + '%) / ' +
    '정정·철회 ' + amended.toLocaleString() + ' / 자회사 ' + subsid.toLocaleString() +
    ' / 종목코드 없음 ' + noStock.toLocaleString()
  );
  console.log('\n유형별 (정정·자회사 제외 = 판정 대상):');
  [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([t, n]) => console.log('  ' + t.padEnd(20) + String(n).padStart(7)));
  if (DRY) console.log('\n[DRY] DB 미기록');
})();
