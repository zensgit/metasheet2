# Attendance AE-4 anomaly-result-edit staging smoke runbook

**Date:** 2026-07-01

**Status:** PREPARED. This runbook does **not** claim a staging PASS. It is the
operator checklist for closing AE-4 after the AE-3 runtime is merged and
deployed.

Do not mark the AE arc complete from this document alone. The closeout happens
only after a real run records the PASS stamp in the section below.

**Scope:** AE-4 closes the anomaly-result-edit arc end to end:

- AE-1 audited correction route;
- AE-1b corrected-fact durability;
- AE-2 / AE-2.1 affected-employee notification and notification-toggle behavior;
- AE-3 admin modal UI;
- cleanup residue `0`.

It does not add runtime code, a new notification channel, manager fan-out, batch
correction, file upload, metric editing, or a new admin section.

## What This Proves

The smoke must prove the real staging deployment can perform a full audited
correction from the UI and that the backend side effects match the ratified
contracts:

1. An admin can see an editable anomaly row, probe admin capability, open the
   AE-3 modal, submit a correction with a reason, and the UI refreshes the
   affected read surfaces.
2. The correction writes exactly one immutable
   `attendance_record_result_edits` row and updates the target
   `attendance_records` row.
3. The target record carries `meta.manual_result_edit` with the real audit id,
   `correctedAgainst`, corrected metrics, and no stale `reviewConflict` for the
   initial same-facts correction.
4. A same-facts recompute preserves the corrected result. A changed-facts
   recompute preserves it but sets `reviewConflict.state='needs_review'`.
5. With `attendanceResultEditPolicy.notifyAffectedEmployee=true`, the correction
   enqueues exactly one affected-employee delivery and back-links
   `notification_delivery_id` on the audit row.
6. With `notifyAffectedEmployee=false`, the correction writes no delivery row and
   records `notification_skipped_reason='policy_disabled'`.
7. Non-admin / failed capability probe cannot open a writable modal or POST.
8. Closed or archived payroll-cycle dates still return the existing fail-closed
   `409` behavior.
9. Cleanup removes synthetic users, memberships, records, result-edit audits,
   notification deliveries, payroll cycles, and any smoke-created request/import
   residue with residue `0`.

## Prerequisites

1. Deploy a main build that includes:
   - AE-1 result-edit route and audit table;
   - AE-1b `meta.manual_result_edit` durability;
   - AE-2 affected-employee notification producer;
   - AE-2.1 `notifyAffectedEmployee` toggle honoring;
   - AE-3 admin modal runtime.
2. Staging migrations are current through:
   - `attendance_record_result_edits`;
   - `attendance_notification_deliveries`;
   - payroll-cycle migrations used by the closed-cycle guard.
3. `BASE_URL` points at the staging API.
4. `DATABASE_URL` points at the same staging database. The operator must run a
   quick API/DB coherence probe before mutating business rows.
5. Authentication:
   - preferred: mint a staging admin token through the environment's approved
     smoke-token path;
   - fallback: provide `ADMIN_TOKEN` with `attendance:read`, `attendance:write`,
     and `attendance:admin`.
6. Browser access to the deployed web app is available for the AE-3 UI step.
7. Use only synthetic ids with an `ae4-smoke-*` prefix. Do not point cleanup at
   real employees.

## Suggested Environment

```bash
BASE_URL=https://<staging-host>
DATABASE_URL=postgresql://<redacted>@<staging-db>/metasheet
DEPLOY_SHA=<deployed-main-sha>
ORG_ID=default
STAMP=ae4-smoke-$(date +%s)
ADMIN_TOKEN='<admin bearer token>'
```

The PASS stamp must include `DEPLOY_SHA`, `STAMP`, and residue `0`. Do not use a
local branch SHA as the deploy SHA.

## Preflight

Run these checks before creating any business rows:

1. API health returns success for the deployed build.
2. Admin token can call `GET /api/attendance/settings`.
3. DB has the required tables:

```sql
SELECT to_regclass('attendance_records') IS NOT NULL AS records_ok,
       to_regclass('attendance_record_result_edits') IS NOT NULL AS edits_ok,
       to_regclass('attendance_notification_deliveries') IS NOT NULL AS deliveries_ok,
       to_regclass('attendance_payroll_cycles') IS NOT NULL AS cycles_ok;
```

4. API/DB coherence probe: create and delete one stamped harmless attendance
   setting or other existing API-visible probe that is also visible through
   `DATABASE_URL`. Abort if API and DB are not the same staging instance.
5. Save current attendance settings so the smoke can restore them:

```bash
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/api/attendance/settings" > /tmp/ae4-settings-before.json
```

## Seed

Seed two disposable users and active org memberships. Keep ids unique per run:

- `ae4-smoke-<stamp>-notify`
- `ae4-smoke-<stamp>-skip`

Insert one editable anomaly record for each user. Use a recent weekday outside
any closed payroll cycle:

- status `late`;
- `work_minutes=480`;
- `late_minutes=20`;
- `early_leave_minutes=0`;
- `is_workday=true`;
- `meta` includes a smoke stamp.

All edit requests in this smoke must also carry stamped business fields:

- `reason` begins with `AE4 smoke <STAMP>`;
- `idempotencyKey` begins with `ae4-smoke:<STAMP>:` and is captured for residue
  and replay checks.

Do not use generic reasons such as `test`, and do not clean audit rows by broad
reason text. The audit table has durable `record_id` and `idempotency_key`
columns; residue and cleanup must use those exact smoke keys.

Example SQL shape:

```sql
INSERT INTO users (id, email, password_hash, name, role, is_active)
VALUES
  (:notify_user, :notify_email, 'no-login', :notify_user, 'user', true),
  (:skip_user, :skip_email, 'no-login', :skip_user, 'user', true)
ON CONFLICT (id) DO UPDATE SET is_active = true;

INSERT INTO user_orgs (user_id, org_id, is_active)
VALUES
  (:notify_user, :org_id, true),
  (:skip_user, :org_id, true)
ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true;

INSERT INTO attendance_records
  (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
   work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
   created_at, updated_at)
VALUES
  (:notify_record_id, :notify_user, :org_id, :work_date, 'Asia/Shanghai',
   :first_in_at, :last_out_at, 480, 20, 0, 'late', true, :meta::jsonb, now(), now()),
  (:skip_record_id, :skip_user, :org_id, :work_date, 'Asia/Shanghai',
   :first_in_at, :last_out_at, 480, 20, 0, 'late', true, :meta::jsonb, now(), now());
```

The smoke may use direct SQL for seed/cleanup, but the correction itself must go
through the deployed API/UI.

## Step 1 — enable notify path and correct from the AE-3 modal

Set the policy on:

```bash
curl -sS -X PUT "$BASE_URL/api/attendance/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "attendanceResultEditPolicy": {
      "enabled": true,
      "editWindowDays": 180,
      "requireReason": true,
      "notifyAffectedEmployee": true
    }
  }'
```

In the browser:

1. Open the attendance overview / request-center anomaly surface as the admin.
2. Filter to the synthetic user or date.
3. Verify the row initially shows the AE-3 capability probe, not an enabled write
   action before capability is checked.
4. Click the probe. It should load admin capability and open the modal.
5. Submit `targetStatus='normal'` with a non-empty reason.
6. Verify the modal closes only after success and the anomalies / records /
   summary surfaces refresh.

Backend assertions:

```sql
SELECT status, late_minutes, early_leave_minutes, meta
FROM attendance_records
WHERE id = :notify_record_id;

SELECT id, before_status, after_status, notification_delivery_id,
       notification_skipped_reason, reason
FROM attendance_record_result_edits
WHERE record_id = :notify_record_id
ORDER BY created_at;

SELECT id, source_type, source_id, source_key, recipient_user_id,
       recipient_role, channel, status, payload
FROM attendance_notification_deliveries
WHERE source_type = 'attendance_result_edit'
  AND org_id = :org_id
  AND source_key LIKE ('attendance_result_edit:' || :org_id || ':' || :notify_record_id || ':%');
```

Expected:

- record status is `normal`;
- `late_minutes=0` and `early_leave_minutes=0`;
- `meta.manual_result_edit.auditId` equals the audit row id;
- exactly one audit row exists for the record;
- `notification_delivery_id` is non-null and references exactly one delivery;
- `notification_skipped_reason` is null;
- delivery `recipient_user_id` is the corrected employee only;
- delivery payload contains work date / before status / after status / reason
  summary and does not include raw `overrideMetrics` or evidence contents beyond
  the allowed summary contract.

## Step 2 — replay and idempotency

Repeat the same API request with the same `idempotencyKey`, or retry from the
same modal instance if the UI exposes the same retry key.

Expected:

- response is successful and indicates the existing edit or unchanged state;
- no second audit row;
- no second delivery row;
- record remains `normal`.

If the UI always creates a new modal key, do this part through API with the
captured body shape from Step 1.

## Step 3 — notify toggle disabled

Set the policy with `notifyAffectedEmployee=false`:

```bash
curl -sS -X PUT "$BASE_URL/api/attendance/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "attendanceResultEditPolicy": {
      "enabled": true,
      "editWindowDays": 180,
      "requireReason": true,
      "notifyAffectedEmployee": false
    }
  }'
```

Correct the second synthetic user's anomaly through the same UI path.

Expected:

- record status becomes `normal`;
- exactly one audit row exists;
- audit `notification_delivery_id` is null;
- audit `notification_skipped_reason='policy_disabled'`;
- no `attendance_notification_deliveries` row exists for that record.

Restore `notifyAffectedEmployee=true` after this step unless cleanup starts
immediately.

## Step 4 — durability across recompute

For the first corrected record:

1. Trigger a same-facts recompute through the deployed import route or another
   no-`statusOverride` recompute path using the same punch facts.
2. Assert the record still has status `normal` and
   `meta.manual_result_edit.reviewConflict` is null.
3. Trigger a changed-facts recompute with materially different punch facts.
4. Assert the record still has status `normal`, but
   `meta.manual_result_edit.reviewConflict.state='needs_review'`.

This step proves AE-1b's durability is active in staging, not just in CI.

If the import route is used for recompute, capture any created
`attendance_import_batches.id` values and any async
`attendance_import_jobs.batch_id` values for cleanup. A green correction with
leftover import artifacts is not an AE-4 pass.

## Step 5 — authorization / capability probe

Use a non-admin or read-only token:

1. Open the same anomaly surface.
2. Verify the UI does not expose an enabled `Edit result` write action.
3. Trigger the capability probe if present.
4. Confirm the modal does not open and no `POST /api/attendance/anomaly-result-edits`
   reaches the backend.

If testing by API, `POST /api/attendance/anomaly-result-edits` must return `403`
and write no audit/delivery rows.

## Step 6 — closed-cycle guard

Create a stamped closed or archived payroll cycle covering a synthetic anomaly
date, then try the same correction.

Expected:

- API returns `409 ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED`;
- UI keeps or closes the modal with clear closed-cycle copy, but does not show
  success;
- no audit row;
- no delivery row;
- record is unchanged.

## Step 7 — residue check

After restoring settings, cleanup all stamped rows. The residue check must
verify every category is zero:

```sql
SELECT
  (SELECT count(*) FROM attendance_records WHERE meta->>'smokeStamp' = :stamp) AS records,
  (SELECT count(*) FROM attendance_record_result_edits
    WHERE org_id = :org_id
      AND (
        record_id = ANY(:smoke_record_ids::uuid[])
        OR idempotency_key LIKE ('ae4-smoke:' || :stamp || ':%')
      )) AS edits,
  (SELECT count(*) FROM attendance_notification_deliveries
    WHERE org_id = :org_id
      AND source_type = 'attendance_result_edit'
      AND (
        source_key LIKE ('attendance_result_edit:' || :org_id || ':' || :notify_record_id || ':%')
        OR source_key LIKE ('attendance_result_edit:' || :org_id || ':' || :skip_record_id || ':%')
      )) AS deliveries,
  (SELECT count(*) FROM attendance_payroll_cycles WHERE org_id = :org_id AND metadata::text LIKE :stamp_like) AS cycles,
  (SELECT count(*) FROM attendance_requests WHERE org_id = :org_id AND metadata::text LIKE :stamp_like) AS requests,
  (SELECT count(*) FROM attendance_events WHERE org_id = :org_id AND meta::text LIKE :stamp_like) AS events,
  (SELECT count(*) FROM attendance_import_batches
    WHERE org_id = :org_id
      AND (meta::text LIKE :stamp_like OR id = ANY(:smoke_import_batch_ids::uuid[]))) AS import_batches,
  (SELECT count(*) FROM attendance_import_items
    WHERE org_id = :org_id
      AND batch_id = ANY(:smoke_import_batch_ids::uuid[])) AS import_items,
  (SELECT count(*) FROM attendance_import_jobs
    WHERE org_id = :org_id
      AND (payload::text LIKE :stamp_like OR batch_id = ANY(:smoke_import_batch_ids::uuid[]))) AS import_jobs,
  (SELECT count(*) FROM user_orgs WHERE user_id LIKE :user_prefix) AS user_orgs,
  (SELECT count(*) FROM users WHERE id LIKE :user_prefix) AS users;
```

Adjust column names only if staging schema differs; do not narrow residue to
only the rows that are easy to delete. A stray event/request/import/delivery is
a failed smoke, not a harmless warning.

## Expected PASS Stamp

Use this exact shape after all steps pass:

```text
AE4_RESULT_EDIT_STAGING_SMOKE_PASS deploy=<sha> stamp=<ae4-smoke-...> org=<org> notifyRecord=<uuid> skipRecord=<uuid> residue=0
```

Backfill text:

> **回填（YYYY-MM-DD AE-4 anomaly-result-edit staging closeout）**：staging
> smoke `AE4_RESULT_EDIT_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp
> `<stamp>`）：AE-3 modal corrected a synthetic late anomaly to normal through
> the real UI; audit row and `meta.manual_result_edit` carried the real audit id;
> affected-employee notification enqueued and audit back-linked when
> `notifyAffectedEmployee=true`; `notifyAffectedEmployee=false` skipped delivery
> with `policy_disabled`; replay did not duplicate audit/delivery; same-facts
> recompute preserved the correction and changed-facts recompute set
> `needs_review`; non-admin probe/POST stayed fail-closed; closed-cycle edit
> returned 409; settings restored; cleanup residue=0. AE-1..AE-4 closed ✅.

## On FAIL

- Capability probe opens a modal after `/settings` fails: AE-3 UI is not
  fail-closed; do not pass.
- POST body contains `overrideMetrics`: AE-3 widened the write surface beyond
  the ratified UI contract; do not pass.
- Audit row exists but no marker, or marker audit id differs from the audit row:
  AE-1b/AE-3 integration regressed; do not pass.
- Notification delivery exists when `notifyAffectedEmployee=false`: AE-2.1
  regressed; do not pass.
- No delivery exists when `notifyAffectedEmployee=true` and the recipient is an
  active org member: AE-2 path regressed; do not pass.
- Same-facts recompute clobbers status: corrected-fact durability regressed; do
  not pass.
- Changed-facts recompute preserves without `needs_review`: stale correction is
  hidden; do not pass.
- Residue is nonzero: inspect the stamped rows before re-running.

## Safety

- Uses only synthetic `ae4-smoke-*` users and records.
- Saves and restores attendance settings.
- Does not change scheduler flags, worker flags, notification channel
  configuration, or payroll production cycles.
- Does not send to managers, owners, or admins.
- Does not delete by broad `source_type` alone; cleanup is stamped and
  record/user scoped.
