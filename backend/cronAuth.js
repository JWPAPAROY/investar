/**
 * cron 엔드포인트 인증 (2026-11-02)
 *
 * 왜: `?mode=save/alert/track` 과 `update-prices` 가 무인증 GET 이었다.
 *   URL만 알면 누구나 텔레그램 발송·DB 저장을 일으킬 수 있었고, update-prices 는
 *   `?stockCode=&price=` 로 임의 가격을 기록할 수도 있었다.
 *
 * 호출자는 셋뿐이고 모두 `Authorization: Bearer <CRON_SECRET>` 를 보낸다:
 *   - Vercel cron  — 환경변수 CRON_SECRET 이 있으면 Vercel 이 자동으로 붙인다
 *   - Cloudflare Worker (investar-cron) — wrangler secret CRON_SECRET
 *   - 텔레그램 웹훅 — 별도 경로(verifyTelegramWebhook)라 여기 오지 않는다
 * 로컬 스크립트(scripts/calc-expectations.js)는 핸들러를 프로세스 안에서 직접 부르므로
 * `req._internal = true` 로 표시한다 (HTTP 요청은 이 속성을 만들 수 없다).
 *
 * CRON_SECRET 미설정 시 전부 거부한다(fail closed).
 */
const crypto = require('crypto');

function verifyCronRequest(req) {
  if (req._internal === true) return { ok: true };
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, reason: 'CRON_SECRET not configured' };
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad authorization' };
  }
  return { ok: true };
}

module.exports = { verifyCronRequest };
