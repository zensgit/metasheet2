# HMR-5 staging smoke runbook — manual missed-punch reminders

**Date:** 2026-06-26
**Scope:** HMR-5 closeout prep only. This runbook does **not** mark the manual
missed-punch reminder line complete by itself. The tracker flips only after a
real staging PASS stamp with residue `0`.

## What This Proves

The smoke exercises the manual reminder chain added by HMR-1 through HMR-4:

- a scoped actor with scheduler-scope action `remind` can read only in-scope
  records-backed missed-punch candidates;
- pending attendance requests remain visible but are not selected by default;
- the admin UI confirm submits the snapshot the admin confirmed;
- the enqueue route writes `attendance_notification_deliveries` rows with
  `source_type='manual_missed_punch_reminder'` and never calls a sender directly;
- the delivery worker sends the queued row through the configured C5 default
  channel;
- a replay with the same idempotency key returns existing rows and creates no
  duplicate;
- a stale candidate returns 409 and writes no row;
- an out-of-scope target returns 403 and writes no row;
- cleanup removes smoke users, records, requests, scheduler scopes, deliveries,
  and related rows with residue `0`.

The smoke is records-backed by design. It must not synthesize a candidate for a
user/day with no `attendance_records` row.

## Prerequisites

1. Staging runs a build containing:
   - HMR-1 scheduler-scope action `remind`;
   - HMR-2 candidate route;
   - HMR-3 enqueue route;
   - HMR-4 admin UI.
2. Staging migrations are current through C5 outbox:
   - `attendance_records`
   - `attendance_requests`
   - `attendance_scheduler_scopes`
   - `attendance_notification_deliveries`
3. Run from the staging host or through a tunnel where both API and DB are
   reachable:

```bash
BASE_URL=http://127.0.0.1:8082
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet
DEPLOY_SHA=<staging-main-sha>
```

4. Use disposable synthetic subjects only. Suggested stamp:

```bash
STAMP="hmr5-$(date +%s)"
ORG_ID="org-${STAMP}"
ADMIN_ID="${STAMP}-admin"
SCOPED_ID="${STAMP}-scoped"
WORKER_ID="${STAMP}-worker"
OUTSIDE_ID="${STAMP}-outside"
WORK_DATE="$(date -u +%Y-%m-%d)"
```

5. Real-channel run only: make sure the default C5 channel is intentionally
   routable in staging. If the default channel is `dingtalk_work_notification`,
   use a staging DingTalk test recipient. If it is `email_smtp`, use a staging
   SMTP sink. Fake/in-app routing may prove enqueue state flow, but it is not a
   real external-delivery PASS unless product accepts that channel for the run.

## Seed

Run the setup in a transaction or keep the printed ids for cleanup.
The SQL below uses named placeholders such as `:ORG_ID`; replace them with
quoted literals or bind them with the DB client you use. Do not paste it into
`psql` verbatim without variable binding.

```sql
-- Synthetic identities and org membership.
INSERT INTO users (id, email, password_hash, is_active)
VALUES
  (:ADMIN_ID,  :ADMIN_ID  || '@example.test', 'no-login', true),
  (:SCOPED_ID, :SCOPED_ID || '@example.test', 'no-login', true),
  (:WORKER_ID, :WORKER_ID || '@example.test', 'no-login', true),
  (:OUTSIDE_ID,:OUTSIDE_ID|| '@example.test', 'no-login', true)
ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active;

INSERT INTO user_orgs (user_id, org_id, is_active)
VALUES
  (:ADMIN_ID, :ORG_ID, true),
  (:SCOPED_ID, :ORG_ID, true),
  (:WORKER_ID, :ORG_ID, true),
  (:OUTSIDE_ID, :ORG_ID, true)
ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true;

-- Central admin permission for setup/control checks.
INSERT INTO user_roles (user_id, role_id)
VALUES (:ADMIN_ID, 'admin')
ON CONFLICT DO NOTHING;

-- Scheduler-scope remind authority for exactly WORKER_ID.
INSERT INTO attendance_scheduler_scopes
  (org_id, subject_type, subject_ref, actions, scope, is_active, created_at, updated_at)
VALUES
  (
    :ORG_ID,
    'user',
    :SCOPED_ID,
    ARRAY['remind']::text[],
    jsonb_build_object('userIds', jsonb_build_array(:WORKER_ID)),
    true,
    now(),
    now()
  );

-- In-scope missed-punch candidate: records-backed absent workday.
INSERT INTO attendance_records
  (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
   work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
   source_batch_id, created_at, updated_at)
VALUES
  (
    gen_random_uuid(), :WORKER_ID, :ORG_ID, :WORK_DATE, 'UTC', NULL, NULL,
    0, 0, 0, 'absent', true,
    jsonb_build_object('source', 'hmr5-smoke', 'stamp', :STAMP),
    NULL, now(), now()
  );

-- Visible but default-unselected candidate because a pending request exists.
INSERT INTO attendance_records
  (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
   work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
   source_batch_id, created_at, updated_at)
VALUES
  (
    gen_random_uuid(), :WORKER_ID, :ORG_ID, (:WORK_DATE::date + interval '1 day')::date,
    'UTC', NULL, NULL, 0, 0, 0, 'absent', true,
    jsonb_build_object('source', 'hmr5-smoke', 'stamp', :STAMP),
    NULL, now(), now()
  );

INSERT INTO attendance_requests
  (id, user_id, org_id, work_date, request_type, reason, status, created_at, updated_at)
VALUES
  (
    gen_random_uuid(), :WORKER_ID, :ORG_ID, (:WORK_DATE::date + interval '1 day')::date,
    'missed_check_in', 'HMR-5 pending-request control', 'pending', now(), now()
  );

-- Out-of-scope candidate for the 403 assertion.
INSERT INTO attendance_records
  (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
   work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
   source_batch_id, created_at, updated_at)
VALUES
  (
    gen_random_uuid(), :OUTSIDE_ID, :ORG_ID, :WORK_DATE, 'UTC', NULL, NULL,
    0, 0, 0, 'absent', true,
    jsonb_build_object('source', 'hmr5-smoke', 'stamp', :STAMP),
    NULL, now(), now()
  );
```

Mint tokens using the staging-supported auth path. If `/api/auth/dev-token` is
available:

```bash
ADMIN_TOKEN="$(curl -fsS "$BASE_URL/api/auth/dev-token?userId=$ADMIN_ID&roles=admin&perms=attendance:admin,attendance:read,attendance:write" | jq -r '.token')"
SCOPED_TOKEN="$(curl -fsS "$BASE_URL/api/auth/dev-token?userId=$SCOPED_ID&roles=user&perms=attendance:read" | jq -r '.token')"
```

If dev-token is disabled, provide equivalent bearer tokens whose subjects match
the synthetic ids.

## Smoke Steps

### 1. Admin sees all records-backed candidates

```bash
curl -fsS "$BASE_URL/api/attendance/manual-missed-punch-reminders/candidates?orgId=$ORG_ID&from=$WORK_DATE&to=$(date -u -d "$WORK_DATE +1 day" +%Y-%m-%d)&page=1&pageSize=50" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | tee /tmp/hmr5-admin-candidates.json
```

Expected:

- `ok=true`;
- `total=3`;
- in-scope row has `selectedByDefault=true`;
- pending-request row has `selectedByDefault=false` and `pendingRequest.status='pending'`;
- out-of-scope row is visible to central admin.

### 2. Scoped actor sees only in-scope candidates

```bash
curl -fsS "$BASE_URL/api/attendance/manual-missed-punch-reminders/candidates?orgId=$ORG_ID&from=$WORK_DATE&to=$(date -u -d "$WORK_DATE +1 day" +%Y-%m-%d)&page=1&pageSize=50" \
  -H "Authorization: Bearer $SCOPED_TOKEN" | tee /tmp/hmr5-scoped-candidates.json
```

Expected:

- `ok=true`;
- no row for `$OUTSIDE_ID`;
- pagination is applied after scope filtering;
- the pending-request row remains default-unselected.

Capture the in-scope selected record id:

```bash
RECORD_ID="$(jq -r '.data.items[] | select(.selectedByDefault == true) | .recordId' /tmp/hmr5-scoped-candidates.json | head -1)"
```

### 3. UI smoke: central-admin confirm snapshot and enqueue

The manual reminder UI lives in the Attendance admin console. Run this UI smoke
as `$ADMIN_ID` or an equivalent central attendance admin. The scope-only actor is
covered by the API checks in steps 2, 4, and 8; do not use `$SCOPED_ID` for this
admin-console UI step.

In the staging browser:

1. Log in as `$ADMIN_ID` or an equivalent central attendance admin.
2. Open Attendance admin → Notification deliveries.
3. In **Manual missed-punch reminders**, load the candidate range.
4. Verify the pending-request candidate is visible but not selected by default.
5. Select only `$RECORD_ID`.
6. Enter message: `HMR-5 snapshot $STAMP`.
7. Open confirm.
8. Change the textarea to `HMR-5 edited after confirm $STAMP`.
9. Confirm.

Expected:

- success panel reports `created=1`, `existing=0`;
- DB payload body remains `HMR-5 snapshot $STAMP`, proving the confirm snapshot
  was authoritative;
- no attendance record/request/event is mutated by the reminder operation.
- this step proves the admin UI behavior only. Scheduler-scope `remind`
  authority is proven by the scoped API calls, because the scoped actor does not
  have the central admin console surface.

### 4. API enqueue assertion

Use the same idempotency key for the API checks after the UI smoke, or run a
separate API-only key:

```bash
KEY="hmr5-$STAMP-api"
curl -fsS -X POST "$BASE_URL/api/attendance/manual-missed-punch-reminders/enqueue?orgId=$ORG_ID" \
  -H "Authorization: Bearer $SCOPED_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(jq -nc --arg id "$RECORD_ID" --arg key "$KEY" --arg msg "HMR-5 API $STAMP" \
    '{recordIds:[$id], message:$msg, idempotencyKey:$key}')" \
  | tee /tmp/hmr5-enqueue.json
```

Expected:

- HTTP 202;
- `created=1`, `existing=0`;
- one `attendance_notification_deliveries` row for
  `source_type='manual_missed_punch_reminder'`;
- `source_key='manual_missed_punch_reminder:<key>:recipient:<worker-id>'`;
- `payload.actorUserId=$SCOPED_ID`;
- `payload.body='HMR-5 API <stamp>'`;
- row status starts as `pending` unless the worker claims it immediately.

### 5. Replay is idempotent

Repeat the exact request from step 4.

Expected:

- HTTP 202;
- `created=0`;
- `existing=1`;
- delivery row count for the source id remains `1`.

### 6. Payload conflict is rejected

Repeat step 4 with the same key but a different message.

Expected:

- HTTP 409;
- error code `MISSED_PUNCH_REMINDER_IDEMPOTENCY_CONFLICT`;
- delivery row count remains unchanged.

### 7. Stale candidate is rejected before writing

Update the selected record so it is no longer remindable:

```sql
UPDATE attendance_records
SET status = 'normal',
    first_in_at = now(),
    last_out_at = now(),
    updated_at = now()
WHERE id = :RECORD_ID::uuid
  AND org_id = :ORG_ID;
```

Then enqueue with a fresh key.

Expected:

- HTTP 409;
- error code `MISSED_PUNCH_REMINDER_CANDIDATE_STALE`;
- no new delivery row for the stale key.

### 8. Out-of-scope candidate is rejected before writing

Capture the out-of-scope record id as admin:

```bash
OUTSIDE_RECORD_ID="$(jq -r --arg user "$OUTSIDE_ID" '.data.items[] | select(.userId == $user) | .recordId' /tmp/hmr5-admin-candidates.json | head -1)"
```

Enqueue it as the scoped actor with a fresh key.

Expected:

- HTTP 403;
- error code `SCHEDULER_SCOPE_FORBIDDEN`;
- no delivery row for the out-of-scope key.

### 9. Worker delivery

Let the deployed delivery worker process the pending HMR rows, or trigger the
same worker tick used by C5 staging smokes if staging exposes an operator path.

Expected:

- the primary HMR delivery row reaches `sent` for a real configured channel, or
  the expected terminal status for the explicitly accepted staging channel;
- repeat worker tick does not create a second row and does not resend a `sent`
  row;
- admin Notification deliveries view shows the
  `manual_missed_punch_reminder` row and status.

## Residue Check

Before cleanup, record evidence:

```sql
SELECT source_type, status, channel, count(*)
FROM attendance_notification_deliveries
WHERE org_id = :ORG_ID
  AND source_type = 'manual_missed_punch_reminder'
GROUP BY source_type, status, channel
ORDER BY status, channel;
```

Cleanup:

```sql
DELETE FROM attendance_notification_deliveries
WHERE org_id = :ORG_ID
  AND source_type = 'manual_missed_punch_reminder';

DELETE FROM attendance_requests
WHERE org_id = :ORG_ID
  AND (user_id = :WORKER_ID OR user_id = :OUTSIDE_ID);

DELETE FROM attendance_records
WHERE org_id = :ORG_ID
  AND (user_id = :WORKER_ID OR user_id = :OUTSIDE_ID);

DELETE FROM attendance_scheduler_scopes
WHERE org_id = :ORG_ID
  AND subject_ref = :SCOPED_ID;

DELETE FROM user_roles
WHERE user_id IN (:ADMIN_ID, :SCOPED_ID, :WORKER_ID, :OUTSIDE_ID);

DELETE FROM user_orgs
WHERE org_id = :ORG_ID
  AND user_id IN (:ADMIN_ID, :SCOPED_ID, :WORKER_ID, :OUTSIDE_ID);

DELETE FROM users
WHERE id IN (:ADMIN_ID, :SCOPED_ID, :WORKER_ID, :OUTSIDE_ID);
```

Residue must be zero:

```sql
SELECT
  (SELECT count(*) FROM attendance_notification_deliveries WHERE org_id = :ORG_ID AND source_type = 'manual_missed_punch_reminder') AS deliveries,
  (SELECT count(*) FROM attendance_requests WHERE org_id = :ORG_ID AND (user_id = :WORKER_ID OR user_id = :OUTSIDE_ID)) AS requests,
  (SELECT count(*) FROM attendance_records WHERE org_id = :ORG_ID AND (user_id = :WORKER_ID OR user_id = :OUTSIDE_ID)) AS records,
  (SELECT count(*) FROM attendance_scheduler_scopes WHERE org_id = :ORG_ID AND subject_ref = :SCOPED_ID) AS scopes,
  (SELECT count(*) FROM user_orgs WHERE org_id = :ORG_ID AND user_id IN (:ADMIN_ID, :SCOPED_ID, :WORKER_ID, :OUTSIDE_ID)) AS user_orgs,
  (SELECT count(*) FROM users WHERE id IN (:ADMIN_ID, :SCOPED_ID, :WORKER_ID, :OUTSIDE_ID)) AS users;
```

## Expected PASS Stamp

Only after all steps above pass and residue is zero, record:

```text
HMR5_MANUAL_MISSED_PUNCH_REMINDER_STAGING_SMOKE_PASS deploy=<sha> stamp=hmr5-... channel=<channel> residue=0
```

## Tracker Backfill Template

> **回填（YYYY-MM-DD HMR-5 manual missed-punch reminder staging closeout）**：
> HMR-5 staging smoke PASS on deploy `<sha>`（stamp `<stamp>`，channel
> `<channel>`，residue=0）：scoped actor with scheduler-scope `remind` read only
> in-scope records-backed owed-punch candidates; pending-request candidate
> visible but default-unselected; admin UI submitted the confirm snapshot;
> enqueue wrote `manual_missed_punch_reminder` C5 outbox row and did not mutate
> attendance facts; worker delivered through the configured channel; replay
> returned existing without duplicate; payload conflict returned 409; stale
> candidate returned 409 without write; out-of-scope target returned 403 without
> write; cleanup residue=0. After this stamp, manual missed-punch reminder
> HMR-0..HMR-5 may be marked closed.

## Failure Hints

- Candidate route returns 403 for scoped actor: verify the actor has an active
  scheduler scope with action `remind`, not only `view` or `approve`.
- Candidate route shows out-of-scope rows to scoped actor: scope filtering is
  happening after pagination or facts resolution is wrong; do not pass HMR-5.
- Enqueue accepts body `orgId`: strict schema regressed; this is a blocker.
- Enqueue creates a row for a stale candidate: HMR-3 stale re-check regressed.
- Worker does not send: diagnose through the existing C5 delivery runbook; HMR
  does not own channel configuration.
- Residue is non-zero: inspect rows by `org_id`, `source_type`, and the `hmr5-`
  stamp before rerunning.
