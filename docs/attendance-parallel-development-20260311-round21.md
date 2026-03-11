# Attendance Parallel Development Report (Round21, 2026-03-11)

## Scope

Reduce async import perf gate hang time and enable earlier idempotency recovery when `/attendance/import/jobs/:id` keeps returning transient 5xx/429 errors.

## Problem Evidence

- Perf baseline runs repeatedly entered long poll loops on `GET /attendance/import/jobs/:id` with `HTTP 502`.
- Example artifacts:
  - `output/playwright/ga/22933748342/perf.log`
  - `output/playwright/ga/22934153530/perf.log`
- Before this patch, recovery logic only triggered after full `IMPORT_JOB_POLL_TIMEOUT_MS` (default 45 minutes for large window), making failures slow and hard to close.

## Implementation

Updated file:
- `scripts/ops/attendance-import-perf.mjs`

Changes:
1. Reduced default `IMPORT_JOB_POLL_RECOVERY_GRACE_MS` from `10m` to `3m`.
2. Added transient fail-fast threshold in job polling (`transientRecoveryErrorThreshold=3`):
   - when transient network/HTTP 5xx errors persist past recovery grace window, throw an async-poll-timeout style error immediately.
3. This reuses existing idempotency recovery flow (`recoverAsyncCommitJobWithRetry`) earlier, instead of waiting for the full poll timeout.

## Verification

| Check | Command | Status |
|---|---|---|
| Script syntax | `node --check scripts/ops/attendance-import-perf.mjs` | PASS |
| Recovery threshold grep | `rg -n "importJobPollRecoveryGraceMs|transientRecoveryErrorThreshold|timed out after transient errors" scripts/ops/attendance-import-perf.mjs` | PASS |

## Expected Effect

- For repeated transient `/jobs/:id` failures, workflow no longer stalls for full poll timeout before invoking idempotency recovery.
- Gate runs should fail or recover earlier, making remediation loops materially faster.
