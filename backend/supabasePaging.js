/**
 * supabasePaging.js — 페이지네이션 정렬키 단일 출처 (2026-09-07)
 *
 * 왜: PostgREST/Postgres는 ORDER BY가 없으면 .range() 페이지 간 행 순서를 보장하지 않는다.
 *   실측(2026-09-07, market_flow_daily 184,425행): order 없는 첫 호출에서
 *   18,688행(10.1%) 중복 + 동수 누락, 거래일 3일이 통째로 사라졌다(135일 → 132일).
 *   2·3회차는 멀쩡했다 = **콜드 상태의 첫 호출에서만 터진다.**
 *   하루 한 번 도는 cron이 정확히 그 조건이라, 운영에서만 재현되는 버그였다.
 *
 * 정렬키는 각 테이블의 PRIMARY KEY다(supabase-schema-full.sql 기준).
 *   PK는 유일성이 보장되므로 페이지 경계가 흔들리지 않는다.
 *
 * ⚠️ 새 테이블을 페이징으로 읽으려면 **여기에 먼저 등록할 것.**
 *   미등록 테이블은 조용히 넘어가지 않고 throw 한다 — 빠뜨린 것을 알 수 있어야 한다.
 */

const TABLE_ORDER = {
  active_policy: ['id'],
  active_policy_history: ['id'],
  bonus_issue_signals: ['rcept_no'],
  buyback_details: ['rcept_no'],
  disclosures: ['rcept_no'],
  expected_return_stats: ['id'],
  market_flow_daily: ['trade_date', 'stock_code'],
  overnight_predictions: ['id'],
  portfolio_rebalances: ['rebalance_date'],
  recommendation_daily_prices: ['id'],
  screening_recommendations: ['id'],
  sector_outlook_stats: ['sector_name'],
  source_reconciliation: ['trade_date'],
  stock_expected_returns: ['id'],
  stock_financials: ['stock_code', 'stac_yymm'],
  stock_master: ['stock_code'],
  success_patterns: ['id'],
  weekly_diagnostics: ['id'],
};

/** 페이징 쿼리에 PK 정렬을 건다. 미등록 테이블이면 throw. */
function orderByPk(query, table) {
  const cols = TABLE_ORDER[table];
  if (!cols) {
    throw new Error(
      `orderByPk: '${table}'의 정렬키가 등록되지 않았습니다. ` +
      `backend/supabasePaging.js의 TABLE_ORDER에 PK를 추가하세요. ` +
      `(정렬 없이 .range()로 페이징하면 행이 유실됩니다)`
    );
  }
  let q = query;
  for (const c of cols) q = q.order(c);
  return q;
}

module.exports = { TABLE_ORDER, orderByPk };
