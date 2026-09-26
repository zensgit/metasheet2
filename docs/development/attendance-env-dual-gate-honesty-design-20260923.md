# Attendance env dual-gate honesty — design — 2026-09-23

Covers #5976 (report digest subscription) and #5981 (annual-leave monthly accrual). Same class of bug, one fix.

## Problem

An admin can save either feature as enabled. The default deployment keeps a second gate off, and the admin UI never says so.

| Feature | Org switch (saved) | Env gate (default) | What actually happens |
| --- | --- | --- | --- |
| Report digest | `attendanceReportDigestPolicy.enabled` | `ATTENDANCE_REPORT_DIGEST_ENABLED` off | Producer writes no outbox. Delivery also needs `ATTENDANCE_SCHEDULER_ENABLED` exactly `true` and `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED` exactly `true`. |
| Monthly accrual | `annualLeavePolicy.scheduledTrigger.enabled` | `ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED` off | `runAnnualLeaveAccrualScheduledTriggerOnce` returns `{ ran:false, reason:'disabled' }`. The job ticks only when `ATTENDANCE_SCHEDULER_ENABLED` is exactly `true`. |

The off-by-default env gates are intentional (report-digest lock 2026-06-26 §4; annual-accrual lock 2026-07-10 G3). This change does not flip those defaults.

The annual-leave card currently says that turning the switch on runs accrual every month with no admin click. That sentence describes only the org half of the double gate.

## Decision

Disclose the runtime gates. Keep the org switch saveable while the env gate is off, so an admin can stage the policy before ops opens the process gate (the RD-4/5 smoke and the S3 double-gate both depend on that order).

Do not return 422 when the org switch is enabled and the env gate is off. A 422 would block that staging order and would still leave a checked box looking “live” if a client ignored the error. Honesty is the response plus the card, not a rejected save.

1. `GET` and `PUT /api/attendance/settings` add a sibling `runtimeGates` object, computed at response time. It is not part of `data` and `normalizeSettings` does not persist it.
2. Each snapshot names the env vars, which ones are off, and a `live` boolean.
3. `live` matches the readers that actually gate the feature:
   - digest producer and annual accrual env: `parseBoolean` (`true` / `1` / `yes`)
   - scheduler and delivery worker: exact `'true'`
4. Channel env is named in the digest hint and is not folded into `live`. A missing channel fails in a delivery row; a missing producer/scheduler/worker produces nothing.
5. The admin cards always show the required env names and a read-only on/off line from `runtimeGates`.
6. When the org switch is on and `live` is not true — including when the server omitted `runtimeGates` — the card shows a warning and the save status says the feature stays dormant and names the gates. The save still returns 200.
7. An empty notification-delivery list adds a digest line when the subscription is enabled and the producer gate is off, so a blank history is not the only signal.

Manual “Run accrual” is unchanged.

## Out of scope

- Flipping any env default to on.
- Refusing the org-switch save.
- Probing SMTP hosts, app secrets, or other channel credentials.
- The same honesty gap on auto-shift or report-sync (those cards already mention a server runtime flag; they are not these two issues).
