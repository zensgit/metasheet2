# Attendance Strict Gates WorkDate Seed Verification

Date: 2026-03-19

## Production Evidence Before Fix

- Deploy run: `23296803074` passed.
- Strict-gates run: `23296937710` still failed after redeploy.
- Artifact evidence from `/tmp/strict-recovery-4-fHbHgs`:
  - `20260319-132230-1/gate-summary.json`: all gates `PASS`
  - `20260319-132230-2/gate-summary.json`: `apiSmoke=FAIL`, `apiSmoke=UNKNOWN`
  - `20260319-132230-2/gate-api-smoke.log`: `POST /attendance/requests` returned `409 DUPLICATE_REQUEST`

## Local Verification

Commands run in `/private/tmp/metasheet2-attendance-smoke-workdate`:

```bash
node --test scripts/ops/attendance-smoke-workdate.test.mjs
node --check scripts/ops/attendance-smoke-api.mjs
node --check scripts/ops/attendance-smoke-workdate.mjs
bash -n scripts/ops/attendance-run-gates.sh scripts/ops/attendance-run-strict-gates-twice.sh
```

## Results

- `node --test scripts/ops/attendance-smoke-workdate.test.mjs`: passed `3/3`
- `node --check scripts/ops/attendance-smoke-api.mjs`: passed
- `node --check scripts/ops/attendance-smoke-workdate.mjs`: passed
- `bash -n scripts/ops/attendance-run-gates.sh scripts/ops/attendance-run-strict-gates-twice.sh`: passed

## Verification Scope

This verification confirms:

- explicit `SMOKE_WORK_DATE` overrides still win
- identical seeds stay deterministic
- different strict-gates sub-run seeds produce different `workDate` values
- the updated shell wiring is syntactically valid
