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
// 파이프라인 가동일. 그 전 공시는 소급 기록이다 — 탈락 사유 분포를 흐리지 않도록 따로 센다.
const LIVE_START = '2026-09-07';

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
        + 'buy_price,sell_price,return_pct,matched_excess,notified_buy')
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

    // **실전 = 매수 알림이 실제로 나간 건만.** 소급 기록(가동 전)과 재판정분(달력 버그로 놓친 건)은
    //   그때 따라 할 수 없었던 매매라 "사후 계산"으로 따로 보여준다. 섞으면 실전 성적이 부풀거나 흐려진다.
    const live = closed.filter(r => r.notified_buy);
    const retro = closed.filter(r => !r.notified_buy);
    const statsOf = (xs) => {
      const mx = xs.filter(r => r.matched_excess != null).map(r => r.matched_excess);
      const mxMed = mid(mx);
      return {
        closedCount: xs.length,
        rawMedian: mid(xs.map(r => r.return_pct)),
        matchedMedian: mxMed,
        matchedNet: mxMed == null ? null : mxMed - COST,
        matchedN: mx.length,
        winRate: mx.length ? (100 * mx.filter(v => v > COST).length) / mx.length : null,
      };
    };
    const liveStats = statsOf(live);

    // 탈락 사유 분포 (사유가 여러 개면 중복 집계). 가동 이후 공시만 — 소급분 249건이 분포를 덮던 문제.
    const rejects = {};
    const liveRows = rows.filter(r => r.disclosure_date >= LIVE_START);
    for (const r of liveRows) {
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
        ...liveStats,
        cost: COST,
      },
      retroStats: statsOf(retro),
      liveStart: LIVE_START,
      liveTotal: liveRows.length,
      liveEligible: liveRows.filter(r => r.eligible).length,
      // 프론트가 나란히 보여줄 기준선. 괴리를 눈으로 보게 하는 것이 이 탭의 목적이다.
      baseline: { median: BASE_MEDIAN, net: BASE_NET, n: BASE_N },
      rejects,
      // 표본이 얇을 때 화면이 성급한 결론을 내지 않도록 서버가 직접 문구를 준다.
      caution: liveStats.matchedN < 30
        ? `실전 표본 ${liveStats.matchedN}건(알림 발송분만) — 백테스트는 ${BASE_N}건이다. 이 숫자로 전략을 판단하지 말 것.`
        : null,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = { bonusView };
