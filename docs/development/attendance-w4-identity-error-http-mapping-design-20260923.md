# Attendance W4 identity errors must return a typed 4xx (#5992)

- Date: 2026-09-23
- Baseline: `main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- Issue: #5992

## Problem

`POST /api/attendance/punch` and the other writers that call `respondIfW4BoundaryError` can throw `AttendanceW4IdentityError` (`packages/core-backend/src/attendance/w4c0-identity.ts`). That class sets `name = 'AttendanceW4IdentityError'` and `code` to a closed `W4C0_*` string. It has no `httpStatus`.

The plugin name set did not include that class. `respondIfW4BoundaryError` returned false, the punch catch fell through, and the caller received `500` / `error.code = INTERNAL_ERROR` / `Failed to punch attendance`. Codes such as `W4C0_DEFAULT_ORG_POSTURE_REJECTED` and `W4C0_OPERATION_ID_REQUIRED` never left the process.

## Decision

1. Move the name set and `respondIfW4BoundaryError` into `plugins/plugin-attendance/lib/attendance-w4-boundary-error-response.cjs`. The function closes over nothing in the route. The plugin requires that module and calls the same function the unit test calls.
2. Add `'AttendanceW4IdentityError'` to the set. Already-listed classes stay listed, with the same status rule: `Number.isInteger(error.httpStatus) ? error.httpStatus : 422`, body `{ ok: false, error: { code, message: code } }`.
3. Do not add `httpStatus` to `AttendanceW4IdentityError`. Missing status stays 422. The body `error.code` is the thrown code.
4. A plain `Error`, or an object whose `name` is not in the set, still returns false so the existing generic catch remains the fallthrough.

## Out of scope

The browser self-service punch still does not send `operationId`. Making it a W4 client is a product call and is not part of this change. See `docs/development/attendance-self-service-punch-w4-client-gap-20260821.md`. After this mapping fix, a W4-posture punch that fail-closes still writes nothing; the HTTP response says which `W4C0_*` code refused it.

The CLI name list in `scripts/ops/attendance-w4c5-rollout-transition-lib.ts` already includes `AttendanceW4IdentityError`. It is a different exit-code map and is left alone.
