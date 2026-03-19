# Attendance Strict Gates WorkDate Seed Development

Date: 2026-03-19

## Context

- Manual redeploy run `23296803074` succeeded.
- Follow-up strict-gates run `23296937710` no longer failed on provisioning.
- The remaining failure moved to the second strict-gates sub-run:
  - `apiSmoke=FAIL`
  - `apiSmoke=UNKNOWN`
  - `POST /attendance/requests` returned `409 DUPLICATE_REQUEST`
- Both sub-runs used the same `workDate=2029-11-12`, so the second sub-run collided with the first one on the shared long-lived production environment.

## Root Cause

`scripts/ops/attendance-smoke-api.mjs` derived `workDate` only from GitHub run metadata (`GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_RUN_NUMBER`).

That stabilized dates across workflow reruns, but it did not distinguish the two sub-runs inside `attendance-run-strict-gates-twice.sh`, because both sub-runs execute inside the same GitHub Actions run.

## Changes

- Added `scripts/ops/attendance-smoke-workdate.mjs` to centralize `workDate` derivation.
- Added support for `SMOKE_WORK_DATE_SEED`.
- Updated `scripts/ops/attendance-run-gates.sh` to pass `SMOKE_WORK_DATE_SEED="$OUTPUT_ROOT"` into the API smoke script.
- Updated `scripts/ops/attendance-smoke-api.mjs` to consume the shared helper.

## Result

Each strict-gates sub-run now gets a stable but distinct `workDate` because `OUTPUT_ROOT` differs between `...-1` and `...-2`.

This preserves deterministic retries while preventing duplicate request collisions between the two sub-runs of one strict-gates workflow execution.
