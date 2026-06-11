# 自动对班 A2 staging smoke runbook

**Date:** 2026-06-11
**Script:** `scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs`
**Scope:** A2-4 closeout prep only. This runbook and script do **not** flip the tracker to ✅; the tracker flips only after a real staging PASS stamp.

## What This Proves

The smoke drives one deterministic A2 tick against the staging DB and then repeats the tick:

- Runtime gates are explicitly present in the smoke runner environment: `ATTENDANCE_SCHEDULER_ENABLED=true`, `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true`, `ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true`, plus org settings `autoShiftMatching.enabled=true`, `mode='auto'`, and `autoWrite.enabled=true`.
- The high-confidence scheduled-shift user is auto-written exactly once.
- A medium-confidence candidate is skipped by `autoWrite.minConfidence='high'`.
- A user with an existing assignment is skipped as `already_scheduled`.
- Users in fixed/free groups are skipped by the scheduled-shift applicability guard.
- The recent-runs API returns the smoke run and skip-reason aggregation.
- A repeat tick writes zero duplicates and records the high user as `already_scheduled`.
- Cleanup removes the smoke users' events/records/assignments, groups, shifts, scheduler-scope, and run ledger rows with residue 0.

The script calls the exported one-shot A2 runner instead of waiting for the background interval. This makes the smoke deterministic while still exercising the same guarded write path and run ledger. It does **not** introspect the already-running backend process env; run it from the deployed backend/container environment or export the same scheduler/A2 flags, and record the deploy env evidence separately before declaring the closeout.

## Prerequisites

1. Deploy a main build that includes A2-3 admin operations UI (`#2471`, squash `052c3f72f4c53fbf5cc6df3d1ee55c0d1b62f969`) and the A2 runtime slices.
2. Set backend runtime flags for the staging deploy and for the smoke runner process:

```bash
ATTENDANCE_SCHEDULER_ENABLED=true
ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true
ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true
```

3. Confirm the A2 migrations are applied on staging, especially:
   - `attendance_auto_shift_auto_write_runs`
   - `attendance_auto_shift_auto_write_run_items`
   - `attendance_scheduler_scopes`
4. Confirm there is no pre-existing active `system:attendance-auto-shift` scheduler-scope with `dispatch`. The smoke creates its own narrow synthetic-user scope. If an older broad scope exists while org auto-write is enabled, a live scheduler could write non-smoke users. The script refuses this by default; use `ALLOW_EXISTING_A2_SYSTEM_SCOPE=1` only when that risk is intentional.
5. Run from the repo root on the staging host or through a tunnel where both API and DB are reachable.
6. `pg` must be resolvable from Node.

## Run

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
ATTENDANCE_SCHEDULER_ENABLED=true \
ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true \
ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true \
node scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs
```

Optional:

```bash
SMOKE_TOKEN='<admin bearer token>' \
ORG_ID=default \
RUN_DATE=2026-06-10 \
WORK_DATE=2026-06-11
```

`RUN_DATE` controls the synthetic scheduler clock. If `WORK_DATE` is omitted, the script uses `RUN_DATE + 1 day`, matching A2's `lookaheadDays=1` window.

## Expected Output

```text
A2-4 auto-shift auto-write staging smoke @ http://127.0.0.1:8082
  org default, workDate 2026-06-11, runNow 2026-06-10T12:00:00.000Z, stamp autoshift-a2-smoke-...
  PASS  auth/settings reachable (200)
  PASS  create shift autoshift-a2-smoke-...-high (201)
  PASS  create shift autoshift-a2-smoke-...-medium (201)
  PASS  create shift autoshift-a2-smoke-...-existing (201)
  PASS  create scheduled_shift group ...
  PASS  create fixed_shift group ...
  PASS  create free_time group ...
  PASS  enable A2 auto-write settings (200)
  PASS  first tick ran
  PASS  first tick applied exactly one high-confidence assignment
  PASS  high-confidence scheduled-shift user applied
  PASS  medium-confidence candidate skipped by high-only auto-write
  PASS  already-scheduled user skipped
  PASS  fixed-shift member skipped by applicability guard
  PASS  free-time member skipped by applicability guard
  PASS  recent run API returns the smoke run
  PASS  recent run API aggregates skip reasons
  PASS  repeat tick ran
  PASS  repeat tick writes zero duplicate assignments
  PASS  repeat tick sees the applied high user as already scheduled
  PASS  cleanup residue = 0 ...

=== PASS — ... passed, 0 failed ===  A2_AUTO_SHIFT_STAGING_SMOKE_PASS deploy=<sha> stamp=autoshift-a2-smoke-... workDate=... residue=0
```

## On PASS

Flip the tracker row `自动对班` to A2 ✅ and add a dated backfill like:

> **回填（YYYY-MM-DD 自动对班 A2 staging closeout）**：staging smoke `A2_AUTO_SHIFT_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp `<stamp>`，workDate `<date>`）：deploy/smoke env flags `ATTENDANCE_SCHEDULER_ENABLED=true` + `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true` + `ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true`；org setting `mode='auto'`/`autoWrite.enabled=true`; one high-confidence scheduled-shift user auto-written exactly once; medium-confidence candidate skipped by `candidate_below_confidence`; existing assignment skipped by `already_scheduled`; fixed/free users skipped by `not_scheduled_shift_group`; recent runs API returned run + skip-reason aggregation; repeat tick wrote zero duplicates and marked the high user `already_scheduled`; settings restored and verified; cleanup residue=0. A2 auto-write closed ✅.

## On FAIL

- `auth/settings reachable` fails: token or staging reachability issue.
- settings update fails: staging predates A2 settings schema or required migrations.
- missing env refusal: run from the deployed backend/container environment or export `ATTENDANCE_SCHEDULER_ENABLED=true`, `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true`, and `ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true`.
- first tick returns `ran:false`: one A2 runtime gate is off in the runner process or org settings.
- high user not applied: inspect `attendance_auto_shift_auto_write_run_items` for `scheduler_scope_forbidden`, edit-window, compliance, or confidence reason.
- pre-existing A2 scope refusal: disable or delete the old `system:attendance-auto-shift` dispatch scope, or run with `ALLOW_EXISTING_A2_SYSTEM_SCOPE=1` only if you intentionally accept that staging blast radius.
- medium user applied: `autoWrite.minConfidence='high'` is not being honored.
- fixed/free users not skipped: scheduled-shift applicability guard regressed.
- repeat tick applies again: producer key/idempotence regressed.
- residue nonzero: inspect rows with the printed `autoshift-a2-smoke-...` stamp and the five synthetic user ids.

## Safety

- The script uses synthetic user ids with a unique `autoshift-a2-smoke-...` stamp.
- Cleanup targets only:
  - the five synthetic users' attendance events/records/assignments;
  - shifts/groups created by the stamp;
  - scheduler scopes created by the stamp;
  - run ledger rows discovered from the smoke users/run window, including rows inserted before an exception.
- It never broad-deletes by `producer_type='auto_shift_match'`, so A0/A1 history and other A2 runs are not touched.
