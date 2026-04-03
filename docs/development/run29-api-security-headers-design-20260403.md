# Run29 API Security Headers Design

## Context

Run 29 deployment feedback reported that API responses were missing `X-Content-Type-Options: nosniff`.

The same feedback also mentioned `400 vs 404` semantics for attendance item lookups. That behavior was re-checked before changing code:

- malformed IDs should stay `400 / VALIDATION_ERROR`
- valid-but-missing UUIDs already return `404 / NOT_FOUND` in the attendance plugin

This slice therefore only hardens API response headers.

## Decision

Add a small `/api`-scoped middleware in `MetaSheetServer.setupMiddleware()` that always sets:

- `X-Content-Type-Options: nosniff`

Place it before attendance import auth/body parsing so the header is present even on early `401` and parser-driven `400` responses.

## Scope

Changed files:

- `packages/core-backend/src/index.ts`
- `packages/core-backend/tests/unit/server-lifecycle.test.ts`

No route contract changes.
No attendance item lookup behavior changes.
