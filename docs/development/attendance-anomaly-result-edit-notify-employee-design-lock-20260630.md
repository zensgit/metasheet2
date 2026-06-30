# Attendance AE-2 — notify the corrected employee — design lock (PROPOSED)

> Date: 2026-06-30
> Baseline: `origin/main@c499abe83` (`#3377` merged — AE-1b corrected-fact durability is live)
> Status: 🟡 **PROPOSED**. This document locks the contract for AE-2 only — telling the corrected employee that their attendance result was changed. It does **not** authorize runtime code, an admin UI (that is AE-3), notifying anyone other than the affected employee, a new delivery system, or staging. Those remain separate, owner-gated PRs.

## 1. Why this slice exists

AE-1 lets an attendance admin correct one confirmed anomaly result (`POST /api/attendance/anomaly-result-edits`), writing an immutable `attendance_record_result_edits` audit row and a durable `meta.manual_result_edit` marker (AE-1b, #3377). The accounting side of the loop is now closed: the correction is recorded and survives recompute.

The human side is still open: **the employee whose result was changed is never told.** An admin can turn an employee's `late` into `normal` (or vice-versa) and the affected person has no signal it happened. AE-2 closes that loop with the minimum surface — a single notification to the affected employee — by reusing the attendance notification pipeline that already exists. It adds no UI and no new send system.

## 2. Grounded current code (`origin/main@c499abe83`)

| Anchor | Location | Note |
|---|---|---|
| AE-1 correction txn | `applyAttendanceResultEdit(trx, options)` @ `index.cjs:18351` | runs inside one `db.transaction` (route `:25166`) |
| Replay short-circuit | step (0) idempotency pre-check @ `:18369` | a matching replay `return { alreadyApplied: true }` **before** any audit/marker write — the comment already reads "(and AE-2 will never re-enqueue)" |
| Audit row write | step (7) `INSERT INTO attendance_record_result_edits … RETURNING *` @ `:18496` | `UNIQUE(org_id, idempotency_key)` backstop |
| Marker write | `buildManualResultEditMarker` + `attachManualResultEditMarkerToRecord` @ `:18508` | last writes before `return` — **the AE-2 hook point** |
| Delivery pipeline | `attendance_notification_deliveries` table | columns `org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, payload, attempt_count, next_attempt_at, claimed_at, claim_expires_at, claim_worker_id, delivered_at, last_error` |
| Status machine | `ATTENDANCE_NOTIFICATION_DELIVERY_STATUSES` @ `:7993` | `pending → sending → sent / retrying / failed / skipped` — claim-based worker with retry already exists |
| Dedup | `INSERT … ON CONFLICT (org_id, source_key) DO NOTHING` | `UNIQUE(org_id, source_key)` — used by both existing producers |
| Existing producers | report-digest enqueue @ `:15089`, manual missed-punch reminder @ `:24840` | digest fans out to self/owner/sub_owner; missed-punch uses `recipient_role='subject'`, key grain `…:recipient:{userId}:channel:{channel}` |
| Channel resolver | `resolveAttendanceDefaultDeliveryChannelForProducer()` @ `:60` | env `ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL`, validated against `{dingtalk_work_notification, email_smtp}`, default `dingtalk_work_notification`; **resolved** value is stamped into both `row.channel` and `source_key` (never the raw config word) |
| Observability | `GET /api/attendance/notification-deliveries` (`attendance:admin`) @ `:37453` | status filter + per-status counters — already surfaces any producer's rows |

The pipeline is mature. AE-2 is a **third producer** of one `'pending'` row; the worker, retry, channel gate, and admin observability are all reused unchanged.

## 3. AE-2 decisions (locked)

### 3.1 Trigger point — same-txn enqueue after audit + marker
After `applyAttendanceResultEdit` writes the audit row and attaches the marker, and **before its `return`**, enqueue exactly one `attendance_notification_deliveries` row using the same `trx`. Real delivery stays with the existing worker; AE-2 never sends synchronously.

Because the enqueue shares the correction's transaction, **correction committed ⟺ notification enqueued** — no corrected record can commit without its notification, and no notification is enqueued for a rolled-back correction. Because the replay short-circuit (step 0) returns *before* the audit write, a replayed correction reaches neither the audit insert nor the enqueue: replay-no-duplicate is structural, not merely guarded.

### 3.2 Audience — the affected employee only
The single row targets `recipient_user_id = record.user_id` (the corrected employee) with `recipient_role = 'subject'`. **No** owner / sub_owner / group / admin / actor rows. AE-2 is a private "your result changed" signal, not a broadcast of an anomaly correction — unlike the digest producer's role fan-out, this producer emits one row and never resolves a manager set.

### 3.3 Idempotency — audit-row-bound source_key
- `source_type = 'attendance_result_edit'` (new constant).
- `source_id = auditRow.id`.
- `source_key = attendance_result_edit:{orgId}:{recordId}:{auditId}:employee:{userId}:channel:{channel}`.

Two independent backstops: (a) the AE-1 replay short-circuit means a re-used `idempotencyKey` never reaches the enqueue; (b) `UNIQUE(org_id, source_key)` + `ON CONFLICT DO NOTHING` makes a same-key insert a no-op even if the enqueue path were ever reached twice. The `{auditId}` segment carries the dedup grain: one correction = one audit row = one notification; a genuinely new correction mints a new `auditId` and correctly produces a new notification.

> **Deviation flagged for ratification (D1):** the owner's literal spec is `attendance_result_edit:{org}:{recordId}:{auditId}:employee:{userId}`. The design appends `:channel:{channel}` to match **both** existing producers (which stamp the resolved channel into the key). Since `{auditId}` already fixes the dedup grain, the channel suffix is **consistency-only** — it future-proofs against a later multi-channel fan-out without changing today's one-row-per-correction behavior. Ratify the suffix or drop it.

### 3.4 Content boundary — redacted payload
The `payload` JSON carries only what the employee needs to understand the change:
`{ kind: 'attendance_result_edit', title, body, sourceType, recipientUserId, recipientRole: 'subject', channel, workDate, beforeStatus, afterStatus, reasonSummary }`.

`reasonSummary` is the correction reason, trimmed/length-capped. The payload **must not** include the full `overrideMetrics` (raw late/early/work-minute internals) or evidence blobs — those stay in the admin-only audit row. The message says *what changed* (`workDate`, `before → after` status, why), not the full metric recomputation.

### 3.5 Failure posture — strict in-txn; the worker owns delivery
- **Enqueue is in-txn (strict).** The single `INSERT` runs in the correction's `trx`. The only *expected* in-txn error — a unique-key collision — is absorbed by `ON CONFLICT DO NOTHING` (no throw). There is no best-effort / savepoint isolation: an enqueue that the database refuses for any *unexpected* reason fails the correction closed rather than committing a correction the employee will never hear about (that silent gap is the exact thing AE-2 exists to remove).
- **Send failure never rolls back the correction.** Delivery happens post-commit in the worker; a failed send moves the row to `retrying` / `failed` under the existing retry machinery and is visible via the admin read API. The committed correction is untouched.
- **Channel unavailable / disabled is not an enqueue failure.** When the configured channel is unroutable, the row still enqueues `'pending'`; the worker marks it `skipped` / `failed`. AE-2 itself performs no synchronous send and is never blocked by channel state — `不影响 AE-1`.

> **Deviation flagged for ratification (D2):** strict in-txn means a *missing / drifted* `attendance_notification_deliveries` table would fail the correction closed (a `503`-class outcome), exactly as AE-1 already fails closed when the payroll-cycle table is missing (`DB_NOT_READY`). This couples the correction to the deliveries table's presence. Recommended: accept it (consistent with the payroll-cycle precedent; best-effort enqueue is a deliberate non-goal for v1). Owner may instead request best-effort enqueue as a follow-up.

### 3.6 Switch / gate — reuse, don't rebuild
AE-2 introduces **no new env, no new policy surface, and no new send code**. Channel selection reuses `resolveAttendanceDefaultDeliveryChannelForProducer()`; delivery, retry, and channel-availability handling reuse the existing worker; visibility reuses `GET /api/attendance/notification-deliveries`. If a future per-org "result-edit notifications off" toggle is wanted, that is a separate slice.

## 4. Implementation shape for the AE-2 runtime (next PR, not this one)

1. Add `const ATTENDANCE_RESULT_EDIT_NOTIFICATION_SOURCE_TYPE = 'attendance_result_edit'` alongside the existing source-type constants (`:68`–`:71`).
2. Add one helper, `enqueueAttendanceResultEditNotification(trx, { orgId, record, auditRow, beforeStatus, targetStatus, reason })`, that builds the redacted payload (§3.4), resolves the channel, computes the `source_key` (§3.3), and runs the single `INSERT … ON CONFLICT (org_id, source_key) DO NOTHING`.
3. Call it in `applyAttendanceResultEdit` between `attachManualResultEditMarkerToRecord` and `return` (§3.1), passing the live `trx`. No call on the replay path (it already returned).
4. No schema migration: `attendance_notification_deliveries` already has every needed column.

## 5. Verification matrix (real-DB, route-level — required for the runtime PR)

| # | Case | Assert |
|---|---|---|
| M1 | **Success enqueue** | a correction commits exactly one delivery row: `recipient_user_id = corrected employee`, `recipient_role='subject'`, `status='pending'`, audit-keyed `source_key`, payload has `workDate`/`before`/`after`/`reasonSummary` and **no** `overrideMetrics` |
| M2 | **Replay → no duplicate** | re-POST with the same `idempotencyKey` returns `alreadyApplied` and creates **zero** additional delivery rows |
| M3 | **Disabled / no channel → no direct send** | with the channel unroutable, the correction still succeeds and AE-2 performs no synchronous send; the row is `pending` (worker later `skipped`/`failed`) |
| M4 | **Wrong user → no notify** | only `record.user_id` has a row; **no** owner / sub_owner / group / admin / actor row exists for the correction |
| M5 | **Rejected correction → no outbox** | a correction rejected by a guard (closed-cycle `409` / edit-window `422` / source `422`) commits **neither** an audit row **nor** a delivery row — because the enqueue is the last step, "rolled-back → no outbox" strengthens to "any non-applied correction leaves zero delivery rows" |
| M6 | **Worker failure visible** | a `pending` AE-2 row that fails delivery transitions to `failed`/`retrying` and appears in `GET /api/attendance/notification-deliveries` counters — no new visibility code |

> **Runtime-PR forward note (skip-when-unreachable lesson):** these six cases must *execute* against Postgres, not green-skip on `!baseUrl`. Per the prior attendance "vitest integration early-return on missing baseUrl" / "wire-vs-fixture drift" lessons, the runtime PR must assert the harness actually ran the DB path (e.g. a guard that fails, not skips, when the DB is unreachable), or a missed writer/enqueue passes the suite while the bug ships.

## 6. Out of scope (explicit non-goals for AE-2)

- **No admin UI / modal** — that is AE-3, gated behind AE-2 + audit + durability being stable in practice.
- **No notification to anyone but the affected employee** — no owner/manager/group digest of corrections.
- **No new delivery channel, no new send system, no new env/policy toggle.**
- **No staging smoke** — that is AE-4 (last).
- **No change to AE-1 / AE-1b semantics** — correction, audit, marker, survive-but-flag are untouched.

## 7. Owner-stated locks (ratified by the owner) + items needing explicit sign-off

Owner-stated and encoded as above:
1. Trigger: same-txn outbox enqueue after audit + marker; real send via the existing worker. (§3.1)
2. Audience: corrected employee only; never owner/sub_owner/group/admin. (§3.2)
3. Idempotency: source_key bound to the AE audit row; AE replay never re-notifies. (§3.3)
4. Content: "your attendance result was corrected," with `workDate` + before/after status + reason summary; no full `overrideMetrics`. (§3.4)
5. Failure: correction never rolls back on *send* failure; enqueue succeeds in-txn; worker failure uses existing retry/status. (§3.5)
6. Switch: reuse the existing attendance notification policy/channel gate; channel unavailable → `pending`/`failed`, AE-1 unaffected; no new send system. (§3.6)
7. Verification: the six-row matrix above. (§5)

Needs an explicit owner call before the runtime PR:
- **D1 — `source_key` `:channel:{channel}` suffix** (§3.3): adopt for cross-producer consistency, or keep the literal `…:employee:{userId}` grain.
- **D2 — strict in-txn vs best-effort enqueue** (§3.5): accept fail-closed on a missing deliveries table (recommended, matches the payroll-cycle precedent), or request best-effort enqueue.

Only the design-lock ships in this PR. The AE-2 runtime is a separate cut after this lock is ratified.
