# Correlation Post-Auth Enrichment Development - 2026-04-25

## Context

The correlation middleware already created an AsyncLocalStorage request context before auth. That guaranteed every request had a `correlationId`, but logs emitted after JWT authentication still could not include `userId` or `tenantId` because the request context was immutable from the middleware's point of view.

This slice adds a post-auth enrichment seam so existing request-scoped logging can carry actor and tenant identity without changing route handlers.

## Changes

- Added `enrichRequestContext()` in `packages/core-backend/src/context/request-context.ts`.
- Added `correlationContextEnrichmentMiddleware()` in `packages/core-backend/src/middleware/correlation.ts`.
- Registered the enrichment middleware immediately after the global JWT middleware in `packages/core-backend/src/index.ts`.
- Updated `packages/core-backend/src/core/logger.ts` to include `user_id` and `tenant_id` when present in the active request context.
- Expanded `packages/core-backend/tests/unit/correlation.test.ts` to cover direct enrichment and the Express middleware ordering.

## Design Notes

- The enrichment function mutates only the active AsyncLocalStorage store. It returns `undefined` when called outside a request context.
- Empty strings are ignored, and string values are trimmed before being stored.
- User id resolution accepts `req.user.id`, `req.user.userId`, or `req.user.sub`; numeric finite ids are stringified.
- Tenant id resolution accepts `req.tenantId`, `req.tenant?.id`, `req.user.tenantId`, or `req.user.tenant_id`.
- The middleware is additive and optional: if auth is disabled or the auth middleware does not populate user data, correlation-only logging remains unchanged.

## Explicit Non-Goals

- No change to JWT verification semantics.
- No route-level logging changes.
- No persistence or response schema changes.
- No attempt to infer tenant from arbitrary headers.

## Files

- `packages/core-backend/src/context/request-context.ts`
- `packages/core-backend/src/core/logger.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/middleware/correlation.ts`
- `packages/core-backend/tests/unit/correlation.test.ts`
