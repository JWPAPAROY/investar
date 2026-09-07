/**
 * _bonusView.js — GET /api/portfolio?view=bonus 의 본체 (v3.98)
 *   언더스코어 접두는 Vercel 이 서버리스 함수로 잡지 않게 하기 위함이다(12함수 한도).
 */
const supabase = require('./../backend/supabaseClient');

// ── 📢 무상증자 실전 신호 (v3.98) ──────────────────────────────────────
// ⚠️ **별도 함수로 두지 못한다.** Vercel Hobby 는 서버리스 함수 12개가 한도이고
//    api/bonus/index.js 를 추가한 배포(d218abf)가 그 한도로 실패했다.
//    CLAUDE.md 가 기록한 기존 해법(mode 통합)을 따라 여기에 얹는다 — GET /api/portfolio?view=bonus
// ⚠️ 프론트에서 Supabase 를 직접 부르지 않기 위한 래퍼이기도 하다.
//    anon 정책이 FOR ALL(쓰기 포함)이라 키가 노출되면 판정 기록이 삭제될 수 있다.
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

async function bonusView(res) {
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
}

module.exports = { bonusView };
