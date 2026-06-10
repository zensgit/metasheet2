# P4 staging smoke runbook — 排班发布/草稿

**Date:** 2026-06-10
**Script:** `scripts/ops/staging-attendance-schedule-publish-p4-smoke.mjs`
**Scope:** prep-only runbook + smoke harness. Running staging and flipping the tracker are separate owner-gated actions.

## What It Proves

This is the final staging gate for the schedule publish/draft SHOULD item:

- draft assignment created through `/api/attendance/schedule-drafts/assignments`;
- draft is invisible to `GET /api/attendance/effective-calendar`;
- `preflightOnly=true` runs the publication path without mutating the draft row;
- publish flips the row to `published`, stamps `published_at` + `locked_at`, and makes it visible to effective-calendar;
- a low `shiftCompliance.dailyMaxMinutes` cap blocks publish with `SHIFT_COMPLIANCE_CAP_EXCEEDED` and leaves the row draft;
- restrictive `shiftEditPolicy` blocks publish with `SHIFT_EDIT_WINDOW_EXCEEDED` and leaves the row draft;
- settings are restored and synthetic rows are removed with residue 0.

The smoke temporarily enables `multiShiftDay` because the published-visibility assertion reads `effective.slots`, which is only emitted when multi-shift output is enabled. The original settings are restored in cleanup.

It does **not** deploy, restart staging, exercise the frontend browser, or mark the tracker ✅ by itself. The frontend P4 UI has its own web guard; this smoke proves the staged runtime path.

## Prerequisites

1. Staging runs a build containing the full publish stack through P4 UI:
   - P0 lifecycle/read-filter foundation;
   - P1 draft CRUD;
   - P2 transactional publish;
   - P3 fixed-apply/auto-shift compatibility tests;
   - P4 admin UI.
2. `DATABASE_URL` points at the staging Postgres. SQL is used for exact status assertions and cleanup.
3. `SMOKE_TOKEN` is an admin token for staging, or staging allows `/api/auth/dev-token`.
4. Run from the repo root so `pg` resolves.

## Run

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
SMOKE_TOKEN='<staging-admin-jwt-if-dev-token-disabled>' \
node scripts/ops/staging-attendance-schedule-publish-p4-smoke.mjs
```

Optional:

```bash
ORG_ID=default
WORK_DATE=2026-06-30
CAP_DATE=2026-07-01
PAST_DATE=2026-06-01
SMOKE_USER_ID=publishp4-custom
```

`SMOKE_USER_ID` must be synthetic and start with `publishp4-` unless `ALLOW_NON_SYNTHETIC_SMOKE_USER=1` is set. The script deletes assignments for the synthetic smoke user ids and shifts named with its unique stamp.

## Expected Output

```text
P4 schedule-publish staging smoke @ http://127.0.0.1:8082 (user publishp4-..., stamp publish-p4-...)
  PASS  auth: GET settings 200
  PASS  reset relevant settings for smoke
  PASS  create shift normal
  PASS  create draft assignment for ...
  PASS  draft assignment is invisible to effective-calendar before preflight/publish
  PASS  preflight succeeds and reports preflightOnly
  PASS  preflight leaves the draft row unmutated
  PASS  publish succeeds with totalPublished=1
  PASS  publish flips draft to a locked published schedule fact
  PASS  published assignment is visible to effective-calendar
  PASS  set low daily shiftCompliance cap
  PASS  publish over shiftCompliance cap returns 422 and the compliance error code
  PASS  compliance-blocked publish rolls back without published residue
  PASS  set restrictive shiftEditPolicy
  PASS  publish outside shiftEditPolicy window returns 422 and the edit-window error code
  PASS  edit-window-blocked publish leaves the row as draft
--- restore + cleanup ---
  PASS  restore original settings
  PASS  cleanup residue = 0 (assignments 0, shifts 0)

=== PASS — ... passed, 0 failed ===  stamp publish-p4-...
```

## On PASS

Add a tracker closeout entry for `排班发布/草稿` and include:

- deploy SHA;
- smoke stamp;
- `preflightOnly=true` left draft unmutated;
- publish made effective-calendar include the shift;
- compliance cap rollback stayed draft;
- edit-window rollback stayed draft;
- cleanup residue `assignments=0, shifts=0`.

Only then can the schedule publish/draft item move to ✅.

## On FAIL

- `effective-calendar` does not show published shift: verify P0 read filters and P2 publish metadata are deployed.
- `preflightOnly` mutates row: stop; P2 transaction rollback/sentinel behavior regressed.
- compliance cap returns 200: verify `shiftCompliance` settings round-trip and that the deployed build includes P2.
- edit-window returns 200: verify `shiftEditPolicy` settings round-trip and publish route guard order.
- cleanup residue non-zero: manually inspect rows with the printed stamp or `publishp4-...` user ids before rerunning.
