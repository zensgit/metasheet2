# Attendance AE-2.1 — honor the result-edit notification toggle — design lock (RATIFIED)

> Status: ✅ **RATIFIED（owner call 2026-06-30）**. This is a narrow amendment to AE-2. It locks the runtime semantics of `attendanceResultEditPolicy.notifyAffectedEmployee` for anomaly-result-edit notifications. It does **not** authorize AE-3 UI work, new recipients, new channels, a new worker, or staging.

## 1. Why this slice exists

AE-2 shipped the affected-employee notification producer as an honest always-enqueue v1: after a successful `POST /api/attendance/anomaly-result-edits`, it writes one `attendance_notification_deliveries` row for the corrected employee.

That was enough to close the human-notification loop, but it left a live product gap: the settings surface already accepts `attendanceResultEditPolicy.notifyAffectedEmployee`, and the default is `true`, yet setting it to `false` does not change runtime behavior. A settable but ignored knob is surprising and can lead to an employee being notified even after an admin explicitly disabled that signal.

AE-2.1 closes only that gap.

## 2. Existing grounded surface

Current `origin/main` already has the pieces AE-2.1 needs:

| Piece | Current surface | AE-2.1 use |
| --- | --- | --- |
| Policy field | `DEFAULT_SETTINGS.attendanceResultEditPolicy.notifyAffectedEmployee` | gate the notification producer |
| Settings wire | normalizer + PUT schema already accept the boolean | no schema change |
| Route plumbing | `POST /api/attendance/anomaly-result-edits` already reads `attendanceResultEditPolicy` | pass the resolved boolean into the write helper |
| Audit columns | `attendance_record_result_edits.notification_delivery_id` / `notification_skipped_reason` | record the delivery link or skipped reason |
| Delivery substrate | `attendance_notification_deliveries` + existing worker/channel resolver | unchanged |

No migration is required.

## 3. Locked behavior

### 3.1 Enabled / omitted / default

When `notifyAffectedEmployee` is omitted or `true`, AE-2.1 preserves AE-2 behavior:

- after the correction audit row and sticky marker are written;
- inside the same correction transaction;
- enqueue exactly one affected-employee delivery;
- `source_type = 'attendance_result_edit'`;
- `source_id = auditRow.id`;
- `source_key = attendance_result_edit:{orgId}:{recordId}:{auditId}:employee:{userId}:channel:{channel}`;
- `recipient_user_id = record.user_id`;
- `recipient_role = 'subject'`;
- payload remains redacted: no `overrideMetrics`, no `evidence`, no raw before/after snapshots;
- back-link the audit row with `notification_delivery_id = delivery.id`;
- keep `notification_skipped_reason = null`.

If `ON CONFLICT DO NOTHING` finds an existing delivery for the same `source_key`, the helper may select that existing row and still back-link it. A same-key idempotency replay must not enqueue a second row because the replay returns before the producer hook.

### 3.2 Disabled

When `notifyAffectedEmployee === false`, AE-2.1 must:

- still apply the correction normally;
- still write the immutable result-edit audit row;
- still attach the `meta.manual_result_edit` sticky marker;
- write **no** `attendance_notification_deliveries` row;
- set `attendance_record_result_edits.notification_delivery_id = null`;
- set `attendance_record_result_edits.notification_skipped_reason = 'policy_disabled'`;
- expose the same values through the route response mapping.

`policy_disabled` is the v1 vocabulary for this one intentional skip. It is not a worker status, not a delivery failure, and not a retryable condition.

### 3.3 Strict transaction posture

The enabled path keeps the AE-2 strict in-transaction posture: enqueue and audit back-link run in the same database transaction as the correction. Do not introduce best-effort `try/catch` or savepoint isolation around the enqueue.

The disabled path is also in the same transaction: the audit skipped reason is part of the correction record, not a best-effort side write.

### 3.4 No scope expansion

AE-2.1 must not change:

- the recipient set: affected employee only;
- channel selection;
- worker/retry semantics;
- visibility endpoint shape except the existing mapped audit fields;
- AE-3 admin modal;
- AE-4 staging smoke.

## 4. Runtime implementation shape

The implementation PR should be a small backend-only slice:

1. Update the policy comment so it no longer says the toggle is reserved or ignored.
2. Thread `policy.notifyAffectedEmployee !== false` from the anomaly-result-edit route into `applyAttendanceResultEdit`.
3. Split the post-marker hook:
   - enabled: enqueue + `notification_delivery_id` back-link;
   - disabled: skip enqueue + `notification_skipped_reason = 'policy_disabled'`.
4. Map both audit fields through the existing route response object.

The implementation should not add a new migration, frontend UI, env flag, delivery channel, or worker.

## 5. Verification matrix

Runtime PR acceptance gates:

| Case | Required proof |
| --- | --- |
| Default enabled | real-DB route test writes one employee-only delivery, back-links `notification_delivery_id`, keeps skipped reason null |
| Disabled | real-DB route test succeeds, writes zero delivery rows, sets `notification_skipped_reason='policy_disabled'`, and returns it in the API response |
| Source key | default enabled row includes `:channel:{channel}` and `source_id = auditRow.id` |
| Payload redaction | payload has no `overrideMetrics`, no `evidence`, and no raw snapshots |
| Replay | exact idempotency replay returns already-applied and does not write a second delivery |
| Worker visibility | a failed delivery remains visible through the existing notification-delivery read endpoint |
| Guard failures | validation / disabled route / non-editable source failures write no delivery |
| Non-vacuous CI | the result-edit integration suite must run against PostgreSQL in required CI; local no-DB skips are not enough |

## 6. Merge order

AE-2.1 should land before AE-3 runtime. AE-3 exposes the result-edit path through a broader admin UI surface; the notification contract should be stable before widening the entry point.

Known runtime PR at the time of this lock: #3419.

## 7. Deferred

- AE-3 admin anomaly-correction modal.
- AE-4 staging smoke.
- Any multi-recipient, manager, or admin notification fan-out.
- Any per-channel notification-toggle matrix beyond the single `notifyAffectedEmployee` boolean.
