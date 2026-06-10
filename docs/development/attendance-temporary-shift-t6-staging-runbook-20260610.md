# T6 staging smoke runbook — 临时班次

**Date:** 2026-06-10
**Script:** `scripts/ops/staging-attendance-temporary-shift-t6-smoke.mjs`
**Scope:** prep-only smoke harness + runbook. Running staging and flipping the tracker are separate owner-gated actions.

## What It Proves

This is the final staging gate for the `临时班次` SHOULD item.

The smoke exercises the real staging HTTP API and uses SQL only for exact assertions
and cleanup:

- create a published regular assignment for a synthetic user;
- create a one-day `assignmentKind='temporary'` / `temporaryMode='replace'` draft through
  `/api/attendance/schedule-drafts/assignments`;
- prove the draft is invisible to `GET /api/attendance/effective-calendar`;
- publish the draft through `/api/attendance/schedule-publications`;
- prove the published temp row:
  - keeps the base row stored as `assignment_kind='regular'`;
  - is stored as `assignment_kind='temporary'` with replace metadata;
  - overlays the effective schedule for the target date;
  - exposes `effective.slots[].assignmentKind='temporary'` and `replaces.assignmentId`
    even when `multiShiftDay.enabled=false`;
  - uses the replacement shift's planned minutes;
- cancel the temp row and prove the base schedule returns;
- create a fixed-schedule managed base row, publish a temp replacement over it, run
  fixed-schedule rebuild, and prove the temp overlay remains effective;
- restore settings and delete synthetic rows with residue 0.

It does **not** deploy or restart staging. It also does not re-run the auto-shift
compatibility path; that compatibility is already locked by the merged real-DB
integration suite for #2439. This smoke covers the staging runtime/read-path gate
plus the fixed-rebuild preservation path.

## Prerequisites

1. Staging runs a main build containing the temporary shift chain:
   - T0 schema #2437;
   - T1 runtime #2439 (`743d5ba75`);
   - T5 admin UI #2441 (`5edaf08b`).
2. `DATABASE_URL` points at staging Postgres. SQL is used for row-shape assertions
   and cleanup.
3. `SMOKE_TOKEN` is an admin token for staging, or staging allows
   `/api/auth/dev-token`.
4. Run from the repo root so `pg` resolves.

## Run

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
SMOKE_TOKEN='<staging-admin-jwt-if-dev-token-disabled>' \
node scripts/ops/staging-attendance-temporary-shift-t6-smoke.mjs
```

Optional:

```bash
ORG_ID=default
# WORK_DATE / FIXED_DATE are optional; omit them for dynamic future dates.
SMOKE_USER_ID=tempshift-custom
```

`SMOKE_USER_ID` must be synthetic and start with `tempshift-` unless
`ALLOW_NON_SYNTHETIC_SMOKE_USER=1` is set. The cleanup deletes assignments,
events, records, and requests for the synthetic smoke user ids and deletes shifts
/ groups named with the unique stamp.

## Expected Output

```text
T6 temporary-shift staging smoke @ http://127.0.0.1:8082 (user tempshift-..., stamp temp-shift-t6-...)
  PASS  auth: GET settings 200
  PASS  reset relevant settings for smoke
  PASS  create shift base
  PASS  create shift replacement
  PASS  create published assignment
  PASS  before temp publish, effective-calendar returns the base assignment
  PASS  before temp publish, no temporary slot is visible
  PASS  create temporary draft
  PASS  draft temporary assignment is invisible before publication
  PASS  publish temporary replacement draft
  PASS  base assignment remains a published regular row
  PASS  temporary row is published with replace metadata
  PASS  published temp replacement: effective shift is the replacement shift
  PASS  published temp replacement: effective slots expose the temporary replacement
  PASS  published temp replacement: temporary slot references the replaced assignment
  PASS  published temp replacement: planned minutes use the replacement shift
  PASS  delete/cancel temporary replacement
  PASS  canceling the temporary row restores the base assignment
  PASS  create fixed group
  PASS  add fixed group member
  PASS  fixed-schedule apply
  PASS  fixed-schedule apply created a managed base assignment
  PASS  create temporary draft
  PASS  publish fixed temporary replacement draft
  PASS  fixed temp before rebuild: effective shift is the replacement shift
  PASS  fixed temp before rebuild: effective slots expose the temporary replacement
  PASS  fixed temp after rebuild: effective shift is the replacement shift
  PASS  fixed temp after rebuild: effective slots expose the temporary replacement
--- restore + cleanup ---
  PASS  restore original settings
  PASS  cleanup residue = 0 (assignments 0, shifts 0, groups 0, events 0, records 0, requests 0)

=== PASS — ... passed, 0 failed ===  stamp temp-shift-t6-...
```

## On PASS

Flip the tracker row `临时班次` from **🟡** to **✅** and include:

- deploy SHA;
- smoke stamp;
- temp draft invisible before publish;
- published temp overlay returned replacement shift + `effective.slots` temp metadata
  under `multiShiftDay.enabled=false`;
- planned minutes came from the replacement shift;
- cancel restored the base assignment;
- fixed-schedule rebuild preserved the temp overlay;
- cleanup residue `assignments=0, shifts=0, groups=0, events=0, records=0, requests=0`.

Suggested 回填:

> **回填（YYYY-MM-DD 临时班次 T6 staging closeout）**：临时班次 staging smoke PASS（deploy `<sha>`，stamp `temp-shift-t6-...`）：draft temp invisible before publish；publish 后 default single-shift effective-calendar 返回 replacement shift + `effective.slots[].assignmentKind='temporary'` + `replaces.assignmentId`；planned minutes 使用 replacement shift；cancel 后 base schedule restored；fixed-schedule rebuild preserved temp overlay；settings restored；cleanup residue=0。临时班次（T0 #2437 → runtime #2439 → admin UI #2441 → T6 staging）闭环 ✅。

## On FAIL

- temp draft is visible before publish → schedule publish status filtering regressed.
- no `effective.slots` metadata after publish → staging likely lacks #2439 or the single-shift temp metadata fix.
- planned minutes still match the base shift → resolver overlay is not feeding planned-minute projection.
- cancel does not restore base → delete/soft-deactivate path or resolver precedence regressed.
- fixed rebuild erases temp → fixed-schedule compatibility regressed.
- cleanup residue non-zero → inspect rows with the printed stamp / `tempshift-...` user ids before rerunning.

## Safety

- Acts only on synthetic `tempshift-*` user ids and stamp-named shifts/groups.
- Restores original attendance settings in `finally`.
- Deletes only smoke-user attendance rows plus stamp-named shifts/groups.
- Refuses non-synthetic `SMOKE_USER_ID` unless explicitly overridden.
