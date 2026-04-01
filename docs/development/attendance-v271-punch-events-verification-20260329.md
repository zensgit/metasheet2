# Attendance v2.7.1 Punch Events Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "lists raw punch events with stable timeline fields and cross-user guardrails" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm exec tsx packages/openapi/tools/build.ts
```

## Focused Integration Result

The new integration covers:

- creating punch events through `POST /api/attendance/punch`
- reading them back from `GET /api/attendance/punch/events`
- stable response aliases such as `workDate/work_date` and `eventType/event_type`
- admin cross-user lookup through existing guardrails
- oversized `pageSize` inputs clamped to `200`
- invalid `from` date returning `400 VALIDATION_ERROR`

Observed result:

- `1 passed`

## OpenAPI Result

OpenAPI source and generated dist artifacts were rebuilt successfully after adding:

- `GET /api/attendance/punch/events`
- `AttendancePunchEvent` schema

The current repository build only regenerates `packages/openapi/dist/*`. `packages/openapi/dist-sdk/*` is not produced by `packages/openapi/tools/build.ts`, so this slice intentionally leaves SDK packaging out of scope instead of committing a hand-edited type stub.

## Claude Code Review

Claude Code's focused review first called out a possible large `pageSize` risk. Verification confirmed the route already inherits the shared `parsePagination()` cap of `200`, so this slice locked that behavior with a focused assertion and exposed the same upper bound in OpenAPI.

Claude Code then surfaced a real contract mismatch: the first draft documented `orgId` as a query parameter even though the handler always used the authenticated org from `getOrgId(req)`. The final version removed `orgId` from the new route contract so runtime and OpenAPI now match.

## Residual Risk

This slice intentionally stays backend-only. It enables a future records detail UI, but does not add that UI yet.
