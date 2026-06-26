# Manual missed-punch reminder design-lock (PROPOSED)

> Status: **PROPOSED**. This is a post-H2 humanization slice, not a runtime change.
> Grounding: `origin/main` after H1 scope-only smoke closeout (#3267). Reuses the
> shipped attendance anomalies read path, scheduler-scope enforcement, and C5
> notification delivery outbox/worker/channel seam.

## 0. Goal

Give an attendance admin a humane, explicit way to remind selected employees who
appear to owe a punch for a day. The action must be understandable to the admin,
safe under delegated scheduler scopes, and durable through the existing C5
delivery outbox. It must not silently mutate attendance facts.

This is a small "operation on top of shipped engines" slice:

- **Read** owed-punch candidates from existing attendance facts.
- **Confirm** a selected set and message.
- **Enqueue** C5 delivery rows to the selected employees.
- **Let the existing delivery worker** send through the configured channel.

## 1. Existing facts to reuse

- `/api/attendance/anomalies` already reads abnormal attendance records for a
  user/date range, computes `suggestedRequestType`, and marks rows with a
  pending request as `state='pending'`.
- `attendance_notification_deliveries` is the C5 delivery outbox. Producers
  insert rows; `AttendanceNotificationDeliveryWorker` leases, sends, retries,
  and records terminal status.
- `resolveAttendanceDefaultDeliveryChannel()` already validates a routable
  delivery-channel name. The producer must stamp a row channel; the worker must
  be the only component that sends.
- `attendance_scheduler_scopes` already gates scoped non-admin actions. H1
  smoke proves a scope-only actor can reach approve/import paths without central
  `attendance:approve` / `attendance:import` / `attendance:admin` grants.

## 2. v1 contract

### 2.1 Candidate definition

v1 is intentionally **records-backed**. It does not invent attendance records
for people with no record row.

A remindable candidate is an attendance record that:

- belongs to the request org;
- has `COALESCE(is_workday, true) = true`;
- is in the requested date range;
- is not one of `normal`, `off`, or `adjusted`;
- has a missing-punch shape:
  - `status='partial'` with either `first_in_at IS NULL` or `last_out_at IS NULL`;
  - or `status='absent'` where the existing workday context proves the employee
    was expected to attend.

Rows with a pending attendance request for the same day remain visible but are
not selected by default. v1 may still allow a forced send after an explicit
confirm, but the default UX should avoid nudging someone who already filed a
fix.

Non-goals for v1:

- no synthetic "missing record" scan;
- no report-only derived rows;
- no manager fan-out;
- no automatic daily job. This is manual/admin-triggered only.

### 2.1a Candidate read API

HMR-2 should add a dedicated read route instead of stretching the existing
single-user `/api/attendance/anomalies` route:

```text
GET /api/attendance/manual-missed-punch-reminders/candidates
```

Query shape:

- `from` / `to`: required date range for v1; the UI may default both to today.
- `userId`: optional narrowing filter. If omitted, the route returns an
  org-scoped candidate pool across users.
- normal pagination (`page` / `pageSize`).

Authority:

- central `attendance:admin` may read the candidate pool;
- scoped actors must have scheduler-scope action `remind`;
- scoped filtering happens **before pagination** and must not reveal
  out-of-scope candidate existence;
- `attendance:read` by itself is not enough for this candidate pool because the
  next step is an external-notification side effect.

Response rows should be explainable and stable enough for HMR-3 stale-candidate
checks:

- `recordId`, `userId`, `workDate`, `status`;
- `missingSide`: `check_in`, `check_out`, or `both`;
- punch timestamps;
- `pendingRequest` / `latestRequest` summary;
- `selectedByDefault`: false when a pending request exists, true otherwise;
- optional `workdayContext` carried from the existing anomalies path.

The route is read-only: it writes no delivery row, sends no message, and must not
invoke the delivery worker. HMR-3 must re-check every submitted `recordId` under
the same candidate predicate so a stale browser result cannot enqueue a reminder
for a record that was fixed meanwhile.

### 2.2 Recipient and channel

- Recipient v1 = the affected employee only.
- Delivery source type = `manual_missed_punch_reminder`.
- Delivery channel = `resolveAttendanceDefaultDeliveryChannel()` unless a later
  product decision adds per-org/per-user routing. This keeps in-app / email
  routing consistent with C5 instead of forking a new channel selector.
- Delivery payload snapshot must include at least:
  - `kind: 'manual_missed_punch_reminder'`;
  - work date;
  - target user id;
  - missing side (`check_in`, `check_out`, or `both`);
  - actor user id;
  - the confirmed message;
  - candidate record id when present.

### 2.3 Idempotency

The enqueue route requires `idempotencyKey`. The source key is deterministic:

```text
manual_missed_punch_reminder:{idempotencyKey}:recipient:{userId}:channel:{channel}
```

Replay with the same key and same normalized payload is a no-op and returns the
existing delivery ids. Replay with the same key but different target/message/date
is a 409 conflict. A double-click must not create a second external send.

### 2.4 Authority

This is an external-notification side effect, so v1 must not treat plain read
permission as enough.

Recommended guard:

- central admin path: `attendance:admin` is allowed;
- scoped path: add a new scheduler-scope action `remind`;
- every selected target user/date must match at least one active `remind` scope
  for the actor, using the same target-fact model as approve/import/export:
  `userIds`, schedule groups, attendance groups, departments, roles, and role
  tags resolve from the target user and work date.

Do **not** silently reuse `approve`, `import`, or `view` for this action. A
reminder sends a message; it is not a read and it is not approval.

Attendance group `owner` / `sub_owner` is a useful candidate source for future
scope provisioning, but v1 should not invent a second implicit authority model
inside the reminder route. If product wants group managers to remind directly,
grant them `remind` scheduler scopes or add an explicit follow-up that maps
group-manager roster to `remind` authority with its own tests.

### 2.5 Failure semantics

- Invalid input: 400.
- No authority for any selected target: 403 `SCHEDULER_SCOPE_FORBIDDEN`.
- Candidate no longer remindable: 409 `MISSED_PUNCH_REMINDER_CANDIDATE_STALE`.
- Idempotency-key conflict: 409 `MISSED_PUNCH_REMINDER_IDEMPOTENCY_CONFLICT`.
- Delivery enqueue success does not mean external delivery success; the response
  returns delivery rows in `pending` / existing status and points admins to the
  C5 delivery log.

## 3. UX shape

Add a compact operation to the anomalies view:

1. A quick filter: **Owed punch only**.
2. Multi-select rows that are remindable.
3. Button: **Remind selected**.
4. In-DOM confirmation panel with:
   - selected employee count;
   - dates;
   - pending-request warnings;
   - message preview;
   - delivery-channel note.
5. Result panel with created/existing delivery counts and a link to the delivery
   log filtered by `sourceType=manual_missed_punch_reminder` when that filter
   exists.

The confirm snapshot is authoritative: if the user edits the selection or
message while the panel is open, the submitted payload remains the snapshot the
admin confirmed. This follows the L5c operations pattern and avoids TOCTOU
surprises.

## 4. Implementation slices

| Slice | Scope | Notes |
|---|---|---|
| HMR-0 | This design-lock + tracker proposal | docs-only |
| HMR-1 | Add scheduler-scope action `remind` | allowlist, mapping, UI labels, regression proving existing actions unchanged |
| HMR-2 | Dedicated candidate read/filter route | records-backed owed-punch pool, pending-request flag, `remind` scope filtering before pagination, central/scoped authority tests |
| HMR-3 | Enqueue route | idempotent outbox producer; no direct send; real-DB tests for replay/conflict/scope/stale candidate |
| HMR-4 | Admin UI | anomalies quick filter + selected remind confirm/result; web regression tests |
| HMR-5 | Staging smoke | seed owed-punch record, scoped actor, enqueue, worker delivery, repeat no duplicate, residue=0 |

HMR-1 and HMR-2 can be built independently only if write sets stay disjoint.
HMR-3 must wait for the authority contract from HMR-1. HMR-4 waits for HMR-2/3.

## 5. Verification plan

- Unit / route tests:
  - candidate read is read-only and does not write `attendance_notification_deliveries`;
  - candidate read filters out-of-scope users before pagination for scoped
    `remind` actors;
  - actor with only `attendance:read` cannot read the cross-user candidate pool;
  - scope-only actor with `remind` can remind an in-scope user;
  - same actor cannot remind an out-of-scope user;
  - actor with only `view` cannot send;
  - replay with identical idempotency key is no-op;
  - reused idempotency key with different message/target returns 409;
  - stale candidate returns 409 and writes no delivery;
  - delivery rows use source type `manual_missed_punch_reminder`;
  - worker is not invoked by the producer path.
- Frontend tests:
  - owed-punch filter hides non-missing anomalies;
  - confirm snapshot, not live form state, is submitted;
  - failed enqueue clears stale result;
  - policy text does not claim external delivery success.
- Staging smoke:
  - create one records-backed missing-punch candidate;
  - scoped actor with only `remind` authority enqueues;
  - delivery worker sends through the configured channel;
  - repeat request does not duplicate;
  - out-of-scope target is 403;
  - cleanup residue for deliveries, records, events, scopes, users is zero.

## 6. Open decisions for owner review

1. Confirm new scheduler-scope action `remind` instead of reusing `approve`.
2. Confirm v1 recipient = affected employee only; manager fan-out is a later
   option.
3. Confirm v1 only uses records-backed candidates; synthetic "no record exists"
   candidate generation is deferred.
4. Confirm default delivery channel follows C5 default routing, without a
   reminder-specific channel selector in v1.
5. Confirm group owner/sub_owner do not receive implicit reminder authority in
   v1; they must be covered by a `remind` scope if they should use this action.
