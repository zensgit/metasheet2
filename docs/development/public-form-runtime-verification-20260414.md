# Public Form Runtime Verification Checklist

**Date**: 2026-04-14
**Branch**: `codex/public-form-runtime-202604`
**Scope**: Rate limiting, submission audit, integration tests

---

## Rate Limiter Middleware

- [ ] `packages/core-backend/src/middleware/rate-limiter.ts` exists and exports `createRateLimiter`, `publicFormSubmitLimiter`, `publicFormContextLimiter`, `conditionalPublicRateLimiter`
- [ ] In-memory sliding window uses Map (no Redis dependency)
- [ ] Key extraction: `req.ip` for anonymous, `userId` for authenticated
- [ ] Returns 429 with `Retry-After` header when limit exceeded
- [ ] Auto-cleanup via periodic `setInterval` with `unref()`

## Route Wiring

- [ ] `GET /api/multitable/form-context` has `conditionalPublicRateLimiter(publicFormContextLimiter)` middleware
- [ ] `POST /api/multitable/views/:viewId/submit` has `conditionalPublicRateLimiter(publicFormSubmitLimiter)` middleware
- [ ] Rate limiter only triggers when `publicToken` is present (query or body)
- [ ] Authenticated users on same endpoints are NOT rate-limited

## Submission Audit Log

- [ ] After successful public form submission, `console.info('[public-form-submission]', ...)` is called
- [ ] Log includes: viewId, truncated publicToken (first 8 chars + `...`), IP, recordId, timestamp
- [ ] Audit log only fires when `publicAccessAllowed && publicTokenParam` is true

## Unit Tests

- [ ] `tests/unit/rate-limiter.test.ts` passes all assertions:
  - Allows requests within limit
  - Blocks requests exceeding limit with 429
  - Resets after window expires (mocked `Date.now`)
  - Different keys do not interfere
  - Cleanup removes expired entries
  - Uses userId as key when available
  - `conditionalPublicRateLimiter` applies only when publicToken present

## Integration Tests

- [ ] `tests/integration/public-form-flow.test.ts` passes all assertions:
  - Valid token -> form context loads
  - Invalid token -> 401
  - Expired token -> 401
  - Valid token + submit -> record created
  - Rate limit exceeded -> 429 with Retry-After
  - Authenticated user (no publicToken) -> not rate-limited
  - Submit with recordId on public form -> rejected (create-only)
  - Rate limit on form-context endpoint

## Manual Smoke Test

1. Start dev server: `cd packages/core-backend && npm run dev`
2. Create a public form view with a token via the UI or API
3. Open public form URL in incognito browser
4. Submit form 10 times rapidly -> 11th should return 429
5. Wait 15 minutes -> submissions should work again
6. Check server logs for `[public-form-submission]` audit entries
7. Verify authenticated users can submit without rate limits
