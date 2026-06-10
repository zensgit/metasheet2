# O6 staging smoke runbook — 加班三段引擎

**Date:** 2026-06-10
**Script:** `scripts/ops/staging-attendance-overtime-segmentation-o6-smoke.mjs`
**Scope:** staging smoke harness + runbook. The harness was initially prepared
as owner-gated prep, then executed successfully on staging later the same day.

## Actual Closeout

**Status:** PASS, 2026-06-10.

- Deploy SHA: `a55576fa66683719a643d4e7c480da068a214e20`.
- Smoke stamp: `overtime-o6-mq89b8gp`.
- Log: `/tmp/staging-overtime-o6-smoke-20260610T160158Z.log`.
- Result: `47 passed, 0 failed`.
- Final line:
  `OVERTIME_SEGMENTATION_O6_STAGING_SMOKE_PASS deploy=a55576fa66683719a643d4e7c480da068a214e20 stamp=overtime-o6-mq89b8gp residue=0`.

The first attempt correctly failed before execution because staging was still
running an older runtime image (`46b218503c965370fc58db02141220787cb1cf79`)
that did not persist `overtimeSegmentation`. Staging was then redeployed to the
O1-O5 runtime build above and the smoke passed. Cleanup residue was 0 for
requests, records, events, comp-time lots, comp-time lot events, holidays, and
overtime rules; the temporary synthetic identity also cleaned to
`users=0 user_roles=0`.

## What It Proves

This is the final staging gate for the `加班三段引擎` SHOULD item.

The smoke exercises the real staging HTTP API and uses SQL only for exact request
/ ledger assertions and cleanup:

- enables `overtimeSegmentation.enabled=true` and
  `compTimeFromOvertime.enabled=true`;
- creates one overtime rule with no min / rounding / cap distortion;
- seeds three synthetic user-days:
  - workday overtime = 45 minutes;
  - restday overtime = 75 minutes;
  - manually inserted non-working holiday = 105 minutes;
- checks effective-calendar parity before writing requests;
- creates and approves one overtime request per day;
- asserts each request metadata has the versioned
  `attendance_overtime_segmentation_v1` snapshot with the expected day type and
  single active bucket;
- asserts `/api/attendance/records` exposes total overtime, the
  `approvedOvertimeSegmentation` projection, and built-in `report_values`
  (`workday_overtime_duration`, `restday_overtime_duration`,
  `holiday_overtime_duration`) from the engine buckets;
- asserts `/api/attendance/summary` exposes total + workday/restday/holiday +
  `comp_time_grant_minutes`;
- asserts comp-time lots and grant events consume `compTimeGrantMinutes`
  (`45,75,105`) through the existing `source_key=overtime_conversion:<requestId>`
  idempotency path;
- restores settings and removes smoke requests / records / events / holidays /
  comp-time lots / grant events / overtime rule with residue 0.

It does **not** deploy or restart staging. It does not re-run the local formula
field non-authoritative tests or report-sync source-fingerprint tests; those are
already locked by the merged O4 unit / integration suite. This smoke proves the
deployed runtime + read path + comp-time path on staging.

## Prerequisites

1. Staging runs a main build containing the O1–O5 chain:
   - O1 pure helper;
   - O2 request metadata snapshot and final-approval refresh;
   - O3 records / summary projection;
   - O4 report fields + report-sync fingerprint consumption;
   - O5 comp-time consume.
2. Migrations are current through the comp-time ledger tables used by O5.
3. `DATABASE_URL` points at staging Postgres. SQL is used for request metadata,
   comp-time lot/event assertions, and cleanup.
4. `SMOKE_TOKEN` is an admin token for staging, or staging allows
   `/api/auth/dev-token`.
5. Run from the repo root so `pg` resolves.

## Run

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
SMOKE_TOKEN='<staging-admin-jwt-if-dev-token-disabled>' \
EXPECTED_DEPLOY_SHA='<deployed-main-sha>' \
node scripts/ops/staging-attendance-overtime-segmentation-o6-smoke.mjs
```

Optional:

```bash
ORG_ID=default
SMOKE_USER_ID=overtime-o6-custom
# WORK_DATE / HOLIDAY_DATE / REST_DATE are optional; omit them for dynamic far-future dates.
```

`SMOKE_USER_ID` must be synthetic and start with `overtime-o6-` unless
`ALLOW_NON_SYNTHETIC_SMOKE_USER=1` is set. The cleanup deletes attendance
requests / records / events / comp-time ledger rows for the synthetic smoke user
and deletes the one holiday + overtime rule it creates.

If staging disables `/api/auth/dev-token`, mint `SMOKE_TOKEN` for the same
synthetic `SMOKE_USER_ID` and ensure the user has admin / attendance permissions.
The script decodes the JWT and refuses to run if the token subject does not match
`SMOKE_USER_ID`.

## Expected Output

```text
O6 overtime segmentation staging smoke @ http://127.0.0.1:8082 (user overtime-o6-..., stamp overtime-o6-...)
  dates: workday=..., holiday=..., restday=...
  PASS  auth: GET settings 200
  PASS  smoke dates have no pre-existing holiday rows before seeding
  PASS  save settings overtimeSegmentation,compTimeFromOvertime
  PASS  O6 deployed: overtimeSegmentation + compTimeFromOvertime round-trip through settings
  PASS  effective-calendar returns 200
  PASS  <workDate>: effective-calendar parity dayType=workday
  PASS  <restDate>: effective-calendar parity dayType=restday
  PASS  <holidayDate>: effective-calendar parity dayType=holiday
  PASS  create overtime rule
  PASS  create overtime <workDate> (45m)
  PASS  approve overtime <workDate>
  PASS  create overtime <restDate> (75m)
  PASS  approve overtime <restDate>
  PASS  create overtime <holidayDate> (105m)
  PASS  approve overtime <holidayDate>
  PASS  all three overtime requests are approved
  PASS  <date>: request metadata has versioned engine snapshot
  PASS  <date>: snapshot dayType=...
  PASS  <date>: snapshot total + compTimeGrant match
  PASS  <date>: snapshot bucket totals
  PASS  GET /records returns 200
  PASS  <date>: record total overtime minutes
  PASS  <date>: record approvedOvertimeSegmentation projection
  PASS  <date>: report_values use segment buckets
  PASS  GET /summary returns 200
  PASS  summary exposes total + workday/restday/holiday/comp-time buckets
  PASS  comp-time grant wrote one lot per approved overtime request
  PASS  comp-time lots consume compTimeGrantMinutes buckets (45,75,105)
  PASS  comp-time grant events match lot amounts and source ids
--- restore + cleanup ---
  settings restored
  PASS  cleanup residue = 0 (...)

=== PASS — ... passed, 0 failed ===  stamp overtime-o6-...
OVERTIME_SEGMENTATION_O6_STAGING_SMOKE_PASS deploy=<sha> stamp=overtime-o6-... residue=0
```

## On PASS

This happened on 2026-06-10; the concrete evidence is recorded in
**Actual Closeout** above. For future re-runs, use the same evidence shape:

Flip the tracker row `加班三段引擎` from **🟡** to **✅** and include:

- deploy SHA / image tag;
- smoke stamp;
- workday / restday / holiday bucket values;
- request metadata snapshot evidence;
- `/records.report_values` evidence;
- `/summary` bucket evidence;
- comp-time lot/event amounts;
- cleanup residue 0.

Suggested 回填:

> **回填（YYYY-MM-DD 加班三段引擎 O6 staging closeout）**：加班三段引擎 staging smoke PASS（deploy `<sha>`，stamp `overtime-o6-...`）：effective-calendar parity workday/restday/holiday；approved overtime request metadata 写入 versioned `attendance_overtime_segmentation_v1` snapshot；records/meta/report_values 分别输出 total + workday/restday/holiday bucket；summary 输出 `overtime_minutes=225` / workday=45 / restday=75 / holiday=105 / `comp_time_grant_minutes=225`；comp-time lots/events 按 `compTimeGrantMinutes` 产生 45/75/105；settings restored；cleanup residue=0。加班三段引擎（O1→O2→O3→O4→O5→O6 staging）闭环 ✅。

## On FAIL

- settings round-trip fails → deployed build predates O2 / O5 settings support.
- effective-calendar parity is wrong → day-type resolver or holiday layer drifted;
  do not approve closeout.
- request metadata lacks snapshot → O2 create/final-approval wiring not live.
- records/report_values wrong but metadata right → O3/O4 read path drift.
- summary wrong but records right → summary aggregation drift.
- comp-time lots/events wrong → O5 hook is not consuming
  `compTimeGrantMinutes`.
- residue non-zero → inspect rows with the printed `overtime-o6-...` stamp before
  rerunning.

## Safety

- Refuses non-synthetic `SMOKE_USER_ID` unless explicitly overridden.
- Refuses supplied `SMOKE_TOKEN` whose JWT subject does not equal
  `SMOKE_USER_ID`.
- Restores original attendance settings in `finally`.
- Deletes only:
  - the synthetic user's request / record / event rows for the smoke dates;
  - comp-time lots/events whose `source_type='overtime_conversion'` and
    `source_id` is one of the smoke request ids;
  - the one holiday row and one overtime rule created by the smoke.
