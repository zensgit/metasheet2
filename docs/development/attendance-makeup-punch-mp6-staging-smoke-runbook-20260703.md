# Attendance makeup-punch MP-6 staging smoke runbook (quota / window / type / anomaly-prefill / approval-adjusted-record)

**Date:** 2026-07-03

**Status:** PREPARED. This runbook does **not** claim a staging PASS. It is the
operator checklist for closing the 补卡规则 (makeup-punch policy) MP arc on
staging after MP-1..MP-5 are deployed. No staging run has been recorded here.

Do not mark MP-6 complete from this document alone. The closeout happens only
after a real run records the PASS stamp in the section below **and** the
operator-decision blocks in this document are resolved.

**Scope:** MP-6 proves the deployed staging build enforces the makeup-punch
policy end to end on the existing self-service request + approval path (per the
design lock `attendance-makeup-punch-policy-design-lock-20260626.md` §7, MP-6:
quota / window / type / anomaly-prefill / approval-adjusted-record / residue=0).
It adds no runtime code, no admin/delegated submit path, and no new record model
— MP-1..MP-3 layer a configurable eligibility check plus an audit snapshot
around the SAME `POST /api/attendance/requests` create and the SAME final
approval that writes the adjusted record and adjustment event.

## What This Proves

The smoke drives the real staging API for every business write (enable the
policy, create makeup requests, approve) and reads server truth via
`DATABASE_URL`. It asserts, on the deployed build:

1. **type / future / window / reason / attachment (fail-closed):** with
   `makeupPunchPolicy` enabled (quota cap 1, `submitWindow.days=30`,
   `requireReason` + `requireAttachment` on), the create path rejects, with the
   ratified `422` codes and no persisted row:
   - a future `workDate` → `MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED`;
   - a `workDate` older than the submit window → `MAKEUP_PUNCH_WINDOW_EXPIRED`;
   - a `missed_check_in` against a server fact of `missing_check_out` →
     `MAKEUP_PUNCH_TYPE_NOT_ALLOWED` (the type gate reads server-derived facts,
     not client prefill);
   - a valid fact with an empty reason → `MAKEUP_PUNCH_REASON_REQUIRED`;
   - a valid fact with no attachment → `MAKEUP_PUNCH_ATTACHMENT_REQUIRED`.
2. **anomaly-prefill (accepted):** a `missed_check_out` request whose SERVER
   facts (`deriveMakeupAnomalyFacts` over a seeded `partial` record: first-in
   present, last-out absent → `missing_check_out`) satisfy the type gate is
   created `status='pending'` and carries a FRESH full
   `metadata.makeupPunchPolicySnapshot` (version / enabled / timezone / cycle /
   quota{maxRequestsPerCycle,countStatuses,principal} / submitWindow /
   allowedAnomalyTypes / requestEvaluatedAt / matchedAnomalyTypes including
   `missing_check_out`).
3. **quota:** a second same-cycle valid makeup for the same subject is rejected
   `MAKEUP_PUNCH_QUOTA_EXCEEDED` — the pending request from (2) already fills the
   cap of 1. Quota is counted per `(org, subject user_id, calendar_month cycle)`,
   anchored on `workDate`, not submit time; `pending` + `approved` count.
4. **approval-adjusted-record:** approving the valid request finalizes it in one
   admin approve — the request row becomes `status='approved'`, the
   `attendance_records` row for the work date becomes `status='adjusted'`
   (`upsertAttendanceRecord({ mode:'override', statusOverride:'adjusted' })`),
   and exactly one `attendance_events` row `event_type='adjustment'` for the
   request carries the REDUCED `meta.makeupPolicySnapshot` (gated on snapshot
   PRESENCE, never the live policy; `quota` reduced to `{ maxRequestsPerCycle }`
   only, `matchedAnomalyTypes` includes `missing_check_out`).
5. **residue=0:** stamped cleanup over every table the smoke dirties
   (`attendance_requests`, `attendance_records`, `attendance_events`, and the
   approval-engine rows `approval_instances` / `approval_assignments` /
   `approval_records`, plus `users` / `user_orgs`) leaves zero; the makeup smoke
   writes NO `attendance_notification_deliveries` and asserts that category is
   zero (coexistence with the AE / report-digest smokes).

### Grounding (all on origin/main, `plugins/plugin-attendance/index.cjs`)

- `DEFAULT_SETTINGS.makeupPunchPolicy` ~L284 (dormant default);
- `MAKEUP_PUNCH_ALLOWED_REQUEST_TYPES` ~L12650 = `missed_check_in` /
  `missed_check_out` / `time_correction`;
- `MAKEUP_REQUEST_TYPE_ANOMALY_TABLE` ~L12727 (static type→anomaly table);
- `deriveMakeupAnomalyFacts` ~L12739 (server-derived facts; `partial` +
  first-in present + last-out absent → `missing_check_out`);
- `buildMakeupPunchPolicySnapshot` ~L12812 (full snapshot);
- `enforceMakeupPunchPolicy` ~L12843, check order future (~L12851) → window
  (~L12857) → type (~L12862) → reason (~L12872) → attachment (~L12875) → quota
  (~L12881); every violation is `HttpError(422, MAKEUP_PUNCH_*)`;
- POST create enforce wiring ~L26736-26782 (settings read gated behind the
  request-type check; enforce in-txn after the lock + duplicate guard; fresh
  snapshot onto `draft.metadata.makeupPunchPolicySnapshot`);
- final-approval adjusted record ~L28441-28459; adjustment event + reduced
  `meta.makeupPolicySnapshot` ~L28546-28600 (snapshot PRESENCE gate ~L28561).

## Operator-Decision Blocks (resolve before the final stamp)

### OQ-1 — token mint path

The staging environment sets a production node-env, under which
`GET /api/auth/dev-token` returns `404`. Two candidate mint paths exist in the
repo (`scripts/gen-staging-token.js` signing with the host's staging JWT secret;
`scripts/ops/resolve-attendance-smoke-token.sh` minting inside the backend
container) but neither is named as the approved smoke-token path by the family
docs. **OPEN QUESTION:** the operator picks the mint path and provides
`ADMIN_TOKEN` (`attendance:read,write,admin,approve`) plus `SUBJECT_TOKEN`
(`attendance:read,write`) whose subject equals the synthetic subject user id —
the makeup request is created AS the token subject, so a mismatched subject would
attribute the row to a user this cleanup does not cover. The helper refuses a
mismatched subject.

Note: on non-staging rehearsal runs where `GET /api/auth/dev-token` IS
available, each mint inserts a `user_sessions` row for the stamped synthetic
users; those rows are expected out-of-ledger (no FK to `users`, not counted in
the residue gate) and do not occur on staging where the route `404`s.

### OQ-2 — `DATABASE_URL` reachability / API↔DB coherence

The staging compose file publishes no host port for the database; the working
`DATABASE_URL` (published port or tunnel endpoint) lives in host-local override
files. **OPEN QUESTION:** verify on the host that `DATABASE_URL` reaches the SAME
staging database as `BASE_URL` before mutating rows. The helper runs an API↔DB
coherence probe (after the enable-PUT it confirms
`makeupPunchPolicy.enabled=true` is visible in `system_configs` under key
`attendance.settings`) and aborts on mismatch, but the reachable endpoint itself
must be confirmed on the host.

### OQ-3 — org scope: single-tenant posture is the real blast radius (population guard N/A)

Unlike the OT-bank v1-8 settlement smoke, MP-6 has **no org-wide enumeration**:
the quota count and the type-gate fact derivation both filter
`user_id = <subject>`, so no non-synthetic user is read or written by the
enforcement path. The v1-8-style settlement-population guard therefore does not
apply here and is intentionally absent.

The real MP-6 exposure is a **behavior blast radius, not data**: enabling
`makeupPunchPolicy` flips a single GLOBAL settings row (the create path reads
org-wide settings ~L26738), so for the duration of the window EVERY real user's
makeup request in the org is subject to this smoke's policy. Per the MP-4 config
lock §5 (RBAC single-tenant posture): `attendance:admin` is a **global**
permission and `org_id` is a **partition key, not an auth boundary** — so this
policy must be enabled only under a single-tenant / per-customer deployment
posture. **OPEN QUESTION:** confirm the window is a single-tenant deployment (run
on `ORG_ID=default` with a short window and a verified settings restore), OR run
on a dedicated disposable org — noting that token issuance and route behavior for
a non-default org id are not verified in this repo; verify on the host before
choosing that path.

### OQ-4 — approval finalization (single approve vs distinct approver / multi-step)

The helper drives ONE admin approve (`POST /api/attendance/requests/:id/approve`)
and asserts the request finalizes (`status='approved'` + adjusted record +
adjustment event). This holds when the makeup request carries no
`approvalFlow.steps` (`isFinalApproval` is true when `flowSteps.length === 0`,
~L28145). **OPEN QUESTION:** confirm the staging host does not configure a
multi-step approval flow (or a distinct-approver requirement) for makeup request
types; if it does, provide the additional approver token(s) and drive the flow
to final before the adjusted-record assertions. The approver is `ADMIN_TOKEN`
(distinct from the subject); a self-approve constraint, if enforced on the host,
is satisfied because subject ≠ admin.

### OQ-5 — SQL-assert channel

The request-metadata `makeupPunchPolicySnapshot` and the adjustment-event
`meta.makeupPolicySnapshot` have no API read surface, and the `attendance_records`
status transition is not exposed as a distinct read. Those assertions go through
`DATABASE_URL` directly, following the attendance staging-smoke family split
(HTTP for business writes, SQL for exact assertions). **OPEN QUESTION:** confirm
SQL-assert is an acceptable channel for the MP-6 stamp.

### OQ-6 — scheduler / expiry interference

Makeup requests and adjusted records are not reaped by any scheduler, and the
seeded `partial` records are synthetic-subject only. Whether staging runs the
attendance scheduler / delivery worker is not knowable from the repo; MP-6 needs
neither. **OPEN QUESTION:** none required, but note the seeded records are real
`attendance_records` rows for the synthetic subject — the residue gate removes
them by user prefix.

## Prerequisites

1. Deploy a main build that includes MP-1 (dormant `makeupPunchPolicy` config),
   MP-2 (create/update enforcement helper), MP-3 (request metadata snapshot +
   final approval audit meta); MP-4 (admin config UI) and MP-5 (Request Center
   UX) are not exercised by this API/DB helper but should be on the same build
   for the arc closeout.
2. Staging migrations are current through the tables this smoke touches:
   `attendance_requests`, `attendance_records`, `attendance_events`, and the
   shared approval-engine tables (`approval_instances`, `approval_assignments`,
   `approval_records`).
3. `BASE_URL` points at the staging API.
4. `DATABASE_URL` points at the same staging database (OQ-2).
5. Authentication per OQ-1: `ADMIN_TOKEN` and a `SUBJECT_TOKEN` whose subject
   equals the synthetic subject user id.
6. Use only synthetic ids with an `mp6-smoke-*` prefix. Do not point cleanup at
   real employees. Business text (reasons, seeded-record meta) carries the stamp;
   the attachment key begins `mp6-smoke:<STAMP>:`.
7. Run standalone, OR as the OPTIONAL 4th smoke on the same deploy SHA in the
   bundled window (`docs/development/attendance-staging-window-bundle-20260702.md`),
   after the previous smoke restored its settings.

## Suggested Environment

```bash
BASE_URL=http://127.0.0.1:8082            # staging root via your tunnel
DATABASE_URL=postgresql://<redacted>@127.0.0.1:5432/metasheet
DEPLOY_SHA=<deployed-main-sha>
ORG_ID=default                            # see OQ-3 (single-tenant posture) before accepting this
STAMP=mp6-smoke-$(date +%s)
ADMIN_TOKEN='<admin bearer token>'
SUBJECT_TOKEN='<bearer, subject = <STAMP>-subject>'
```

The PASS stamp must include `DEPLOY_SHA`, `STAMP`, and residue `0`. Do not use a
local branch SHA as the deploy SHA.

## API/DB Helper

Use the helper to execute the backend portions of this runbook:

```bash
BASE_URL="$BASE_URL" \
DATABASE_URL="$DATABASE_URL" \
DEPLOY_SHA="$DEPLOY_SHA" \
ORG_ID="${ORG_ID:-default}" \
STAMP="$STAMP" \
ADMIN_TOKEN="$ADMIN_TOKEN" \
SUBJECT_TOKEN="$SUBJECT_TOKEN" \
node scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs
```

The helper drives the real staging API for the settings enable, the request
creates, and the approve; it uses SQL only for the synthetic user seed, the
seeded `partial` records (server-fact materialization), the snapshot / record /
event assertions, and stamped cleanup. A successful run prints:

```text
MP6_MAKEUP_PUNCH_API_DB_SMOKE_PASS deploy=<sha> stamp=<mp6-smoke-...> org=<org> quota=1 approvals=1 residue=0
```

This is **not** the final MP-6 PASS stamp. The final closeout requires the
operator to (a) verify the deployed build (`/api/health` `build.commit` equals
`DEPLOY_SHA`), (b) resolve the operator-decision blocks above (OQ-1 and OQ-3 at
minimum), and (c) optionally run the MP-4/MP-5 UI probe — only then record
`MP6_MAKEUP_PUNCH_STAGING_SMOKE_PASS`.

## Preflight

Run these checks before creating any business rows:

1. API health returns success for the deployed build and `build.commit` equals
   `DEPLOY_SHA`.
2. Admin token can call `GET /api/attendance/settings` (a `401` means a
   wrong-realm token — re-mint; a `503 DB_NOT_READY` means staging is not
   migrated — STOP and run the migration-alignment SOP first).
3. DB has the required tables:

```sql
SELECT to_regclass('attendance_requests') IS NOT NULL AS requests_ok,
       to_regclass('attendance_records') IS NOT NULL AS records_ok,
       to_regclass('attendance_events') IS NOT NULL AS events_ok,
       to_regclass('approval_instances') IS NOT NULL AS approvals_ok;
```

4. API/DB coherence probe: after the enable-PUT, confirm
   `makeupPunchPolicy.enabled=true` is visible through `DATABASE_URL` in
   `system_configs` under key `attendance.settings`. Abort if API and DB are not
   the same staging instance.
5. Save current attendance settings so the smoke can restore them:

```bash
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/api/attendance/settings" > /tmp/mp6-settings-before.json
```

6. Verify zero pre-existing residue for this `STAMP` (fresh stamp per run).

## Window and Seed

MP-6 uses RECENT PAST work dates (the opposite of the OT-bank far-future window):
the submit-window check requires `workDate` to be past and within
`submitWindow.days`, and the future-date check rejects tomorrow. Because every
enforcement read is anchored on the synthetic subject's own rows, recent dates do
not collide with real staging data even on a shared org. The date plan (policy-tz
`Asia/Shanghai`) derives from "today":

- **valid** = today−3-ish and **quota** = today−2-ish, chosen so BOTH fall in the
  SAME `calendar_month` cycle (quota is per-cycle) and inside the submit window;
- **type / reason / attachment** = a few more days back (past, inside the window;
  cycle membership is irrelevant — these requests roll back);
- **future** = today+2 (`MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED`);
- **windowExpired** = today−45 (older than the 30-day submit window).

Seed one disposable subject user + active org membership (SQL, upsert):
`mp6-smoke-<stamp>-subject`. Then seed 5 `partial` `attendance_records` (SQL) for
that subject on the valid / quota / type / reason / attachment dates: `status =
'partial'`, `first_in_at` present, `last_out_at` NULL — so
`deriveMakeupAnomalyFacts` yields exactly `['missing_check_out']`. This
materializes SERVER truth; the type gate never trusts client anomaly prefill.

All accrual, rejection, and approval go through the deployed API; only seed and
assert use SQL.

## Step 1 — enable the policy

`PUT /api/attendance/settings` with the makeup policy (only key touched):

```json
{
  "makeupPunchPolicy": {
    "enabled": true,
    "timezone": "Asia/Shanghai",
    "cycle": { "type": "calendar_month", "startDay": 1 },
    "quota": { "maxRequestsPerCycle": 1, "countStatuses": ["pending", "approved"], "principal": "self_service_user" },
    "submitWindow": { "unit": "calendar_day", "days": 30 },
    "allowedAnomalyTypes": ["missing_check_in", "missing_check_out", "late", "severe_late", "absence_late", "early_leave"],
    "allowedRequestTypes": ["missed_check_in", "missed_check_out", "time_correction"],
    "requireReason": true,
    "requireAttachment": true
  }
}
```

`PUT /api/attendance/settings` deep-merges per policy key — this PUT does not
disturb sibling policies, and the restore in Step 5 must therefore re-assert the
whole makeup policy (never PUT an empty snapshot; the #3303 lesson).

## Step 2 — rejection cases (fail-closed)

As the subject, `POST /api/attendance/requests` (each provides the type's
required timestamp: `requestedInAt` for `missed_check_in`, `requestedOutAt`
otherwise):

- `missed_check_out`, `workDate=<future>` → `422 MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED`;
- `missed_check_out`, `workDate=<today-45>` → `422 MAKEUP_PUNCH_WINDOW_EXPIRED`;
- `missed_check_in`, `workDate=<type date>` (fact is `missing_check_out`) →
  `422 MAKEUP_PUNCH_TYPE_NOT_ALLOWED`;
- `missed_check_out`, empty reason → `422 MAKEUP_PUNCH_REASON_REQUIRED`;
- `missed_check_out`, no attachment → `422 MAKEUP_PUNCH_ATTACHMENT_REQUIRED`.

Each throws inside the request transaction, so no `attendance_requests` /
`approval_instances` row is created — confirm each is `422` and rolls back.

## Step 3 — valid request (anomaly-prefill accepted) + snapshot

As the subject, `POST /api/attendance/requests` `missed_check_out` on the valid
date, with a stamped reason and `metadata.attachmentUrl` → `201`, `pending`.

Backend assertion (SQL): `attendance_requests.metadata->>'makeupPunchPolicySnapshot'`
is the full snapshot — `version=1`, `enabled=true`, `quota.maxRequestsPerCycle=1`
with `countStatuses` + `principal`, `submitWindow.days=30`, and
`matchedAnomalyTypes` includes `missing_check_out`.

## Step 4 — quota + approval-adjusted-record

1. As the subject, a second `missed_check_out` on the quota date (same cycle) →
   `422 MAKEUP_PUNCH_QUOTA_EXCEEDED` (the pending valid fills the cap of 1).
   Confirm exactly one subject request row exists (all rejections rolled back).
2. As admin, `POST /api/attendance/requests/:id/approve` the valid request →
   `200`, finalized.

Backend assertions (SQL):

```sql
-- request finalized
SELECT status FROM attendance_requests WHERE id = :valid_request_id AND org_id = :org_id;  -- 'approved'
-- adjusted record
SELECT status FROM attendance_records WHERE org_id = :org_id AND user_id = :subject AND work_date = :valid_date;  -- 'adjusted'
-- adjustment event with the REDUCED policy snapshot (quota = maxRequestsPerCycle only)
SELECT meta FROM attendance_events
WHERE org_id = :org_id AND event_type = 'adjustment' AND meta->>'requestId' = :valid_request_id;
```

Expected: exactly one adjustment event; `meta.makeupPolicySnapshot` present with
`version=1`, `enabled=true`, `quota={ maxRequestsPerCycle: 1 }` (NO
`countStatuses` / `principal` — the event carries the reduced summary), and
`matchedAnomalyTypes` including `missing_check_out`.

## Step 5 — cleanup and EXPLICIT settings restore

Settings restore first, and never by PUT-ing an empty or partial snapshot:
`PUT /api/attendance/settings` deep-merges per policy key, so an empty-body
restore is a NO-OP that leaks the enabled makeup policy (the #3303 lesson).
Restore by re-asserting the whole makeup policy — the pre-smoke `GET` returns a
FULLY-NORMALIZED `makeupPunchPolicy`, so PUT-ing that snapshot back (with an
`enabled:false` floor for the impossible absent-key case) restores every nested
field. Then re-GET and verify the makeup policy compares equal (stable JSON) to
the pre-smoke snapshot; a restore that silently leaves it enabled fails the
smoke.

Cleanup deletes only stamped/captured rows, in FK-safe order: approval records /
assignments → adjustment events (by captured request ids) → records (by user
prefix) → requests (by captured ids OR user prefix) → approval instances (by
captured ids) → `user_orgs` → `users`. Deliveries are never written and never
deleted.

## Step 6 — residue check

After cleanup, every category must be zero. Use the literal `:stamp` matching
`/^mp6-smoke-[A-Za-z0-9-]+$/`, `:user_prefix = :stamp || '-'`, and the captured
`:request_ids` / `:approval_ids`; do not use an unescaped wildcard stamp.

```sql
SELECT
  (SELECT count(*) FROM attendance_requests
    WHERE org_id = :org_id AND (id = ANY(:request_ids::uuid[]) OR left(user_id, length(:user_prefix)) = :user_prefix)) AS requests,
  (SELECT count(*) FROM attendance_records
    WHERE org_id = :org_id AND left(user_id, length(:user_prefix)) = :user_prefix) AS records,
  (SELECT count(*) FROM attendance_events
    WHERE org_id = :org_id AND meta->>'requestId' = ANY(:request_ids::text[])) AS events,
  (SELECT count(*) FROM approval_instances WHERE id = ANY(:approval_ids::text[])) AS approval_instances,
  (SELECT count(*) FROM approval_assignments WHERE instance_id = ANY(:approval_ids::text[])) AS approval_assignments,
  (SELECT count(*) FROM approval_records WHERE instance_id = ANY(:approval_ids::text[])) AS approval_records,
  (SELECT count(*) FROM attendance_notification_deliveries
    WHERE org_id = :org_id AND left(recipient_user_id, length(:user_prefix)) = :user_prefix) AS deliveries,
  (SELECT count(*) FROM user_orgs
    WHERE org_id = :org_id AND left(user_id, length(:user_prefix)) = :user_prefix) AS user_orgs,
  (SELECT count(*) FROM users WHERE left(id, length(:user_prefix)) = :user_prefix) AS users;
```

The approval-engine categories are counted on purpose: the request create /
approve chain writes `approval_instances` / `approval_assignments` /
`approval_records`, and leaving them behind is a failed smoke, not a harmless
warning. The `deliveries` category must be zero because this smoke never writes
notification deliveries — a non-zero count means cross-smoke interference in the
bundled window. Do not narrow residue to only the rows that are easy to delete.

## Expected PASS Stamp

Use this exact shape after all steps pass and the operator-decision blocks are
resolved:

```text
MP6_MAKEUP_PUNCH_STAGING_SMOKE_PASS deploy=<sha> stamp=<mp6-smoke-...> org=<org> quota=1 approvals=1 residue=0
```

Backfill text:

> **回填（YYYY-MM-DD makeup-punch MP-6 staging closeout）**：staging smoke
> `MP6_MAKEUP_PUNCH_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp `<stamp>`）：enabled
> makeupPunchPolicy 拒 future / window-expired / type-mismatch / empty-reason /
> missing-attachment（5 codes fail-closed，均 rollback 无残留）；seeded partial
> record 的 missed_check_out 以服务端 `missing_check_out` 事实通过、pending 且带
> full snapshot；同周期第二条补卡 `MAKEUP_PUNCH_QUOTA_EXCEEDED`（cap 1）；审批通过后
> record=adjusted、adjustment event 带 reduced `makeupPolicySnapshot`
> （matchedAnomalyTypes=missing_check_out）；settings restored and verified；cleanup
> residue=0（zero deliveries）。OQ-1/OQ-3 decisions recorded：`<...>`。MP-6 closed
> ✅（delegated/admin submit + workday window 仍 gated 于 MP-v2）。

## On FAIL

- A future or expired-window `workDate` is accepted: the date guards regressed;
  do not pass.
- `missed_check_in` against a `missing_check_out` fact is accepted: the type gate
  is trusting client prefill or not intersecting server facts; do not pass.
- Empty reason / missing attachment is accepted while the flags are on: the
  reason/attachment gate regressed; do not pass.
- The valid request lands with no `makeupPunchPolicySnapshot`, or the snapshot
  misses `matchedAnomalyTypes`: the MP-3 snapshot write regressed; do not pass.
- The second same-cycle makeup is accepted: quota is mis-scoped (submit-time
  instead of workDate cycle, or actor instead of subject); do not pass.
- After approval the record is not `adjusted`, or the adjustment event lacks
  `meta.makeupPolicySnapshot`, or that snapshot carries the FULL (not reduced)
  quota shape: the finalize audit regressed; do not pass.
- Settings do not compare equal after restore: the deep-merge restore hygiene
  regressed — fix the restore before re-running anything else in the window.
- Residue is nonzero (any category, incl deliveries): inspect the stamped rows
  before re-running.

## Safety

- Uses only synthetic `mp6-smoke-*` users, seeded synthetic records, and recent
  work dates on the subject's own rows (no real data is read or written).
- Every enforcement read is subject-scoped, so there is no org-wide enumeration
  (the OT-bank settlement-population guard does not apply). The single blast
  radius is the GLOBAL settings row while the policy is enabled — mitigated by a
  short window, the single-tenant posture (OQ-3), and a verified settings
  restore.
- Saves and restores attendance settings, re-asserting the whole makeup policy
  and verifying the compare (never PUTs an empty snapshot).
- Does not change scheduler flags, worker flags, or notification channel
  configuration; never writes or deletes notification deliveries.
- Does not delete by broad text/type; cleanup is stamped and keyed by captured
  ids and the user prefix.
