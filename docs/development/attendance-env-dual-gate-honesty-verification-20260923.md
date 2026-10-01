# Attendance env dual-gate honesty — verification — 2026-09-23

Design: `docs/development/attendance-env-dual-gate-honesty-design-20260923.md`.
Issues: #5976, #5981. Env defaults were not flipped.

## What was checked

- Default env: both `runtimeGates` snapshots are `live: false` and list every required env var in `offEnv`.
- Digest `live` is true only when the producer accepts `parseBoolean` and both `ATTENDANCE_SCHEDULER_ENABLED` and `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED` are the exact string `true`. `1` and `TRUE` do not open the scheduler or worker.
- Monthly accrual `live` is true only when `ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED` parses on and the scheduler env is exact `true`.
- `mergeSettings` drops a `runtimeGates` key, so the snapshot is not part of persisted settings.
- Admin UI, digest enabled + gates off: hint names the three env vars, status is `producer off`, warning says the subscription stays dormant, PUT still sends `enabled: true`, and the save status says dormant rather than live.
- Admin UI, digest enabled + gates on: warning is absent; save status says the digest gates are on and that the channel still needs its own configuration.
- Admin UI, digest disabled: no warning. Enabling it with no `runtimeGates` on the response shows “did not report” and stays dormant.
- Empty delivery list names `ATTENDANCE_REPORT_DIGEST_ENABLED` when the subscription is enabled and the producer gate is off, and omits that line when the subscription is off.
- Admin UI, monthly accrual switch on + gates off: the old “no admin click required” sentence is gone, the hint names both env vars, the warning says accrual stays dormant, PUT still sends `scheduledTrigger.enabled: true`.
- Admin UI, switch on + gates on: warning is absent. Switch off + gates off: hint remains, warning is absent.

## Commands

```text
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-env-dual-gate-honesty.test.ts tests/unit/attendance-annual-leave-accrual-scheduled-trigger.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts --watch=false -t "report digest:|annual-leave policy: scheduled trigger|notification deliveries: empty history|loads attendanceReportDigestPolicy|scheduledTrigger.enabled hydrates"
```

Result: backend 24 passed; frontend 8 passed, 142 skipped by the name filter. The filtered frontend set includes the new disclosure cases and the previous digest / scheduled-trigger round-trip cases.

## Not run

- `attendance-plugin.test.ts` integration cases that assert `runtimeGates` on GET/PUT. They need a database (`ATTENDANCE_TEST_DATABASE_URL` or `DATABASE_URL`) and were not executed in this workspace.
- A logged-in browser session against the admin cards. The Vue specs mount `AttendanceView` in admin mode, open the cards, and click save. That does not exercise a real backend process or a mobile viewport.

## Honesty check

Removing the digest warning (`v-if="reportDigestDormant"`) fails `report digest: enabled while env gates are off...`. Making `buildAttendanceDualGateRuntimeStatus` report `live: true` with the env unset fails `defaults both features to dormant...`.

A gap these tests do not catch: digest `live` ignores channel env. The card says the selected channel still needs its own server configuration, and a missing channel fails in a delivery row rather than suppressing the producer.
