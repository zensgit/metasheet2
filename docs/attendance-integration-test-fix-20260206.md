# Attendance Integration Test Fix (2026-02-06)

## Summary

`pnpm --filter @metasheet/core-backend test:integration:attendance` was failing at:

- `packages/core-backend/tests/integration/attendance-plugin.test.ts` expecting `200`
- got `503 { code: 'DB_NOT_READY' }` from `POST /api/attendance/requests/:id/approve`

## Root Cause

The core backend database pool is initialized during module import.

In the integration test, `MetaSheetServer` was imported at the top-level:

- `import { MetaSheetServer } from '../../src/index'`

But the test only set:

- `process.env.DATABASE_URL = dbUrl`

inside `beforeAll()`.

So the DB pool was created using the *original* `DATABASE_URL` from the environment (in our local case pointing at an older database schema).

That older schema was missing at least:

- `attendance_records.source_batch_id`

causing a Postgres schema error (`42703`) during approval resolution, which the plugin intentionally maps to `503 DB_NOT_READY`.

## Fix

1. **Load `MetaSheetServer` after setting `DATABASE_URL`**

Changed the integration test to do a dynamic import after env setup:

- `packages/core-backend/tests/integration/attendance-plugin.test.ts`

2. **Add debug logging for schema errors during request approval**

When `resolveRequest()` hits a schema error, log the underlying Postgres error (response remains generic):

- `plugins/plugin-attendance/index.cjs`

## Verification

Ran (local dev DB on `metasheet-dev-postgres`):

```bash
ATTENDANCE_TEST_DATABASE_URL=postgres://... pnpm --filter @metasheet/core-backend test:integration:attendance
```

Result: ✅ pass.

