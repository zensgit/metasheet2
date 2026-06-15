# 调度 D5 staging smoke runbook

**Date:** 2026-06-13

**Script:** `scripts/ops/staging-attendance-dispatch-d5-smoke.mjs`

**Scope:** D5 closeout prep only. This runbook and script do **not** flip the
tracker to ✅; the tracker flips only after a real staging PASS stamp.

## What This Proves

The smoke runs the daily schedule-dispatch chain against staging through the
same APIs used by the D4 admin UI and the existing approval resolver:

- admin DB-seeds a synthetic target user identity, then creates the target
  shift, target schedule group, and active `schedule_dispatch` approval flow
  through HTTP APIs;
- admin creates a dispatch request through the dedicated
  `POST /api/attendance/schedule-dispatch-requests` route;
- before approval, no assignment or membership side effect exists;
- admin final-approves through `POST /api/attendance/requests/:id/approve`;
- final approval writes exactly one published direct assignment with
  `producer_type='schedule_dispatch'`, deterministic `producer_ref_id`,
  `producer_key`, and `producer_run_id`;
- final approval writes the target schedule-group membership window with
  `source='schedule_dispatch'`;
- effective-calendar follows the new dispatch assignment and shows the target
  shift for the target user/date;
- replay approval is rejected and does not create duplicate assignments or
  memberships;
- no generic adjustment event is written;
- cleanup restores settings and removes the smoke rows with residue `0`.

This is the final D5 staging gate for the `调度` line. It does not exercise a
browser; D4 already locks the frontend request bodies and read-only employee
surface in web tests.

## Prerequisites

1. Deploy a main build that includes:
   - D1 schema/envelope and request type support;
   - D2 dedicated create/list/read/cancel API;
   - D3 final approval writer plus #2570 generated-row hardening
     (`d85cfbf7` or later);
   - D4 admin/employee UI `#2571` (`31850251c`).
2. Staging migrations are current through the schedule-dispatch detail table
   migration and the `schedule_dispatch` request-type constraint.
3. Run from the repo root on the staging host, or from a tunnel where both API
   and DB are reachable.
4. `pg` must be resolvable from Node.
5. `DEPLOY_SHA` is required and must name the staging build being smoked. The
   script refuses to print a PASS stamp without it.
6. Authentication:
   - default path: staging allows `/api/auth/dev-token`, and the script mints
     one admin token;
   - fallback path: provide `ADMIN_TOKEN`, `SMOKE_TOKEN`, or `TOKEN` with
     `attendance:read`, `attendance:write`, `attendance:admin`, and
     `attendance:approve`.

The target user defaults to a fresh synthetic `dispatch-d5-*` subject and the
script inserts that subject into `users` for staging identity hygiene before the
dispatch flow. The script refuses non-synthetic target users. This is
intentional: the smoke never points destructive cleanup at real employee
history.

Before any business API mutation, the script runs a read-only DB preflight that
verifies the cleanup/assertion channel is reachable and the schedule-dispatch
tables exist. It then creates and immediately deletes a stamped probe shift
through the API while checking that the same row is visible through
`DATABASE_URL`. If the API and DB do not point at the same staging instance, the
smoke aborts before the dispatch business flow starts.

## Run

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
DEPLOY_SHA=<staging-main-sha> \
node scripts/ops/staging-attendance-dispatch-d5-smoke.mjs
```

Fallback when dev-token is disabled:

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
DEPLOY_SHA=<staging-main-sha> \
ADMIN_TOKEN='<admin bearer>' \
node scripts/ops/staging-attendance-dispatch-d5-smoke.mjs
```

Optional:

```bash
ORG_ID=default
WORK_DATE=2026-07-06
SMOKE_USER_ID=dispatch-d5-...
```

The target subject must remain disposable `dispatch-d5-*` for fallback runs.

## Expected Output

```text
D5 schedule-dispatch staging smoke @ http://127.0.0.1:8082 (org default, target dispatch-d5-..., workDate ..., stamp dispatch-d5-...)
  PASS  DB cleanup/assertion channel reachable and schedule-dispatch tables exist
  PASS  auth: GET settings 200
  PASS  synthetic target user has no pre-existing attendance residue
  PASS  API/DB coherence probe created shift via API
  PASS  API/DB coherence probe is visible through DATABASE_URL
  PASS  API/DB coherence probe deleted via API
  PASS  save settings shiftEditPolicy,shiftCompliance,multiShiftDay
  PASS  synthetic target user identity exists for staging smoke
  PASS  create target shift
  PASS  create target schedule group
  PASS  create schedule_dispatch approval flow
  PASS  before approval, effective-calendar does not yet show the dispatch target shift
  PASS  create schedule-dispatch request
  PASS  create response maps parent/detail fields to dispatched user and date window
  PASS  pending request has no assignment or membership side effects
  PASS  admin final approval succeeds
  PASS  detail row finalized with assignment id, membership id, and deterministic source key
  PASS  attendance_requests metadata records the dispatch finalization ids
  PASS  published schedule-dispatch assignment has exact target, date, and provenance
  PASS  schedule-dispatch membership window is present with exact target group/user/date
  PASS  effective-calendar shows the dispatched target shift after approval
  PASS  replay approval is rejected without duplicate materialization
  PASS  replay leaves one assignment, one membership, and no generic adjustment event
--- restore + cleanup ---
  PASS  restore original settings
  PASS  cleanup residue = 0 (...)

=== PASS - ... passed, 0 failed ===  stamp dispatch-d5-...
SCHEDULE_DISPATCH_D5_STAGING_SMOKE_PASS deploy=<sha> stamp=dispatch-d5-... workDate=... targetUser=dispatch-d5-... residue=0
```

## On PASS

Flip the tracker row `调度 / 换班 / 小组织` so `调度` becomes ✅, and add a
dated backfill like:

> **回填（YYYY-MM-DD 调度 D5 staging closeout）**：staging smoke
> `SCHEDULE_DISPATCH_D5_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp
> `<stamp>`，workDate `<date>`，targetUser `<dispatch-d5-...>`）：DB-seeded
> synthetic target user identity、HTTP-created target schedule group/shift/active
> `schedule_dispatch` flow; dedicated create route produced pending
> envelope/detail with no side effects; final approval
> wrote exactly one published `producer_type='schedule_dispatch'` assignment
> with deterministic provenance and one `source='schedule_dispatch'`
> membership window; effective-calendar showed the target shift; replay did not
> duplicate; no generic adjustment event; settings restored; cleanup residue=0.
> D1–D4 + D5 staging closed `调度` ✅.

## On FAIL

- DB preflight fails: staging is missing the D1 migrations or `DATABASE_URL`
  points at the wrong database. Do not continue until the DB channel is
  reachable.
- API/DB coherence probe fails: `BASE_URL` and `DATABASE_URL` are not pointed at
  the same staging instance, or the API-created probe shift could not be
  deleted. Inspect the stamped probe shift before re-running.
- token/auth failure: verify `BASE_URL`, token, staging JWT secret, and the
  token permissions.
- create request fails with `SCHEDULE_DISPATCH_APPROVAL_FLOW_REQUIRED`: the
  active `schedule_dispatch` approval flow did not persist, or staging predates
  D1/D2 request-type support.
- final approval fails before assignment write: inspect the response error. A
  conflict, edit-window, compliance, or scope error means the guarded
  transaction is blocking the staging data; do not flip ✅.
- assignment provenance mismatch: D3 finalizer is not writing the locked
  `schedule_dispatch:{requestId/user/date/slot}` facts; do not flip ✅.
- membership missing or wrong date window: D3 membership side fact regressed.
- effective-calendar does not show the target shift: the assignment resolver is
  not seeing the published dispatch row, or staging is not running the deployed
  SHA.
- residue nonzero: inspect rows with the printed `dispatch-d5-*` stamp, target
  user id, created request id, and approval instance business key before
  rerunning.

## Safety

- Creates only stamped shifts, schedule groups, approval flows, and a synthetic
  `dispatch-d5-*` target user identity.
- Direct SQL cleanup targets created request ids, approval instance business
  keys, created assignment ids, created membership ids, created group/shift/flow
  ids, and the synthetic user identity row if this script created it. It does
  not provide a real-user override.
- The final residue check includes schedule-dispatch rows, approval artifacts,
  attendance events, attendance records, stamped groups/shifts/flows, and the
  synthetic user identity. A stray event/record fails the smoke instead of being
  hidden by cleanup.
- Runs a DB/table preflight and API/DB coherence probe before business writes,
  so a bad `DATABASE_URL` cannot leave API-created residue without a cleanup
  channel.
- Restores original attendance settings before deleting smoke rows.
- Does not deploy, restart services, mutate scheduler/background settings, or
  exercise browser visuals.
