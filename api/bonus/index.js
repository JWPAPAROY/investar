/**
 * GET /api/bonus — 무상증자 실전 신호 현황 + 성과 (v3.98)
 *
 * 근거: DISCLOSURE_VERDICT.md 2회차 판정에서 A1_무상증자가 ①②를 모두 통과한 **유일한** 유형.
 *   D+1 종가 매수 → D+5 종가 매도. 백테스트 매칭초과 중앙 +1.25% / 비용차감 +0.87%p (n=248).
 *
 * ⚠️ **Supabase anon 키를 프론트에 노출하지 않기 위해 이 엔드포인트를 둔다.**
 *    anon 정책이 `FOR ALL USING (true)` 라 읽기뿐 아니라 **쓰기도 열려 있다** —
 *    키가 공개되면 disclosures 54.9만 건과 판정 기록이 삭제·수정될 수 있다.
 *    프론트에서 Supabase를 직접 부르지 말 것.
 *
 * 성과는 저장값을 그대로 읽는다(scripts/bonus-issue-signals.js 가 채운다).
 *   여기서 재계산하면 두 출처가 갈라진다 — 이 저장소가 반복해서 당한 사고다.
 */
const supabase = require('../../backend/supabaseClient');

const COST = 0.35;              // 수수료 무료 계정: 매도세 0.15 + 슬리피지 0.10x2
const BASE_MEDIAN = 1.25;       // 백테스트 매칭초과 중앙
const BASE_NET = 0.87;          // 백테스트 비용차감
const BASE_N = 248;

const mid = (a) => {
  if (!a.length) return null;
  const x = [...a].sort((u, v) => u - v);
  const h = x.length >> 1;
  return x.length % 2 ? x[h] : (x[h - 1] + x[h]) / 2;
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return res.status(503).json({ success: false, error: 'Supabase 미설정' });

  try {
    // 신호는 연 56건 규모라 전건을 읽어도 부담이 없다.
    const { data, error } = await supabase
      .from('bonus_issue_signals')
      .select('rcept_no,stock_code,corp_name,disclosure_date,ratio,record_date,ex_rights_date,'
        + 'buy_date,sell_date,market_cap,cap_quintile,avg_value_20d,eligible,reject_reason,'
        + 'buy_price,sell_price,return_pct,matched_excess')
      .order('disclosure_date', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const rows = data || [];
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // KST
    const ok = rows.filter(r => r.eligible);

    // 대기: 아직 매수 전 / 진행: 매수했고 매도 전 / 청산: 수익률 확정
    const pending = ok.filter(r => r.buy_date && r.buy_date > today);
    const holding = ok.filter(r => r.buy_date && r.buy_date <= today && r.return_pct == null);
    const closed = ok.filter(r => r.return_pct != null);

    const mx = closed.filter(r => r.matched_excess != null).map(r => r.matched_excess);
    const raw = closed.map(r => r.return_pct);
    const mxMed = mid(mx);

    // 탈락 사유 분포 (사유가 여러 개면 중복 집계)
    const rejects = {};
    for (const r of rows) {
      if (r.eligible) continue;
      for (const part of String(r.reject_reason || '기타').split(' / ')) {
        const k = part.replace(/\(.*/, '').trim();
        rejects[k] = (rejects[k] || 0) + 1;
      }
    }

    res.status(200).json({
      success: true,
      today,
      pending, holding,
      closed: closed.slice(0, 30),
      stats: {
        total: rows.length,
        eligible: ok.length,
        closedCount: closed.length,
        rawMedian: mid(raw),
        matchedMedian: mxMed,
        matchedNet: mxMed == null ? null : mxMed - COST,
        matchedN: mx.length,
        winRate: mx.length ? (100 * mx.filter(v => v > COST).length) / mx.length : null,
        cost: COST,
      },
      // 프론트가 나란히 보여줄 기준선. 괴리를 눈으로 보게 하는 것이 이 탭의 목적이다.
      baseline: { median: BASE_MEDIAN, net: BASE_NET, n: BASE_N },
      rejects,
      // 표본이 얇을 때 화면이 성급한 결론을 내지 않도록 서버가 직접 문구를 준다.
      caution: mx.length < 30
        ? `표본 ${mx.length}건 — 백테스트는 ${BASE_N}건이다. 이 숫자로 전략을 판단하지 말 것.`
        : null,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
};
