# Attendance W4 identity error HTTP mapping — verification (#5992)

- Date: 2026-09-23
- Branch: `cursor/attendance-w4-identity-error-map-f381`
- Baseline: `main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- PR: https://github.com/zensgit/metasheet2/pull/6007

## What was checked

`AttendanceW4IdentityError` is in the name set that `respondIfW4BoundaryError` consults. A real instance of that class (no `httpStatus`) is answered as HTTP 422 with `error.code` and `error.message` equal to the closed code. `W4C0_DEFAULT_ORG_POSTURE_REJECTED` and `W4C0_OPERATION_ID_REQUIRED` are both covered. `AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')` still uses the class's own integer status (503 in `ATTENDANCE_W4_OPERATION_ERROR_HTTP_STATUS_V1`). A plain `Error`, and an identity error whose `name` was overwritten to `Error`, still return false and write no body.

`plugins/plugin-attendance/index.cjs` requires `./lib/attendance-w4-boundary-error-response.cjs` and no longer declares `const W4_ERROR_NAMES`.

## Commands

```text
node --check plugins/plugin-attendance/index.cjs
node --check plugins/plugin-attendance/lib/attendance-w4-boundary-error-response.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-w4-boundary-error-response.test.ts --reporter=dot
```

Result: `node --check` exit 0. Vitest v1.6.1: **7 passed**.

## Mutation

Removing `'AttendanceW4IdentityError'` from `W4_ERROR_NAMES` in `plugins/plugin-attendance/lib/attendance-w4-boundary-error-response.cjs` and re-running the same file:

- 3 failed: set membership, `W4C0_DEFAULT_ORG_POSTURE_REJECTED` mapping (`respondIfW4BoundaryError` returned false), `W4C0_OPERATION_ID_REQUIRED` mapping (same).
- 4 still passed: explicit `httpStatus`, plain `Error` fallthrough, renamed impostor, plugin source pin.

The string was restored. The same command then reported **7 passed** again. `git diff` on the lib was empty after restore.

## Not exercised

No PostgreSQL punch against a shadow or authoritative org. The route catch already calls this function; this check proves that call's mapping, not the posture gate that throws the identity error. The browser still does not send `operationId`.
