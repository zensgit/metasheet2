# Attendance Daily Gate Signal Channel Contract Hardening Verification

Date: 2026-03-28
Branch: `codex/attendance-daily-gate-signal-channels-20260328`

## Files changed

- `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-daily-gate-signal-channels-20260328/scripts/ops/attendance-validate-daily-dashboard-json.sh`
- `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-daily-gate-signal-channels-20260328/scripts/ops/attendance-run-gate-contract-case.sh`
- `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-daily-gate-signal-channels-20260328/docs/development/attendance-daily-gate-signal-channel-contract-hardening-20260328.md`

## Commands run

```bash
git diff --check
./scripts/ops/attendance-run-gate-contract-case.sh dashboard output/playwright/attendance-gate-contract-matrix
GH_TOKEN="$(gh auth token)" OUTPUT_DIR="output/playwright/attendance-daily-gate-dashboard-signal-channels-followup" node ./scripts/ops/attendance-daily-gate-report.mjs
./scripts/ops/attendance-validate-daily-dashboard-json.sh output/playwright/attendance-daily-gate-dashboard-signal-channels-followup/20260328-015115/attendance-daily-gate-dashboard.json
```

## Results

### Dashboard contract case

- passed

Confirmed:

- the positive `dashboard.valid.json` case now accepts the new remote signal channel fields
- the new negative case `dashboard.invalid.remote-channels.json` fails as expected
- the failure is specific and stable:
  - `Remote Preflight contract failed: gateFlat.preflight.manualRecovery=maybe (expected true|false when present)`

### Live GitHub-backed report

Generated report:

- `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-daily-gate-signal-channels-20260328/output/playwright/attendance-daily-gate-dashboard-signal-channels-followup/20260328-015115/attendance-daily-gate-dashboard.json`

Validator result:

- `attendance-validate-daily-dashboard-json.sh` passed on the live generated report

This confirms the hardening works against both:

- synthetic contract fixtures
- real GitHub Actions data

## Notes

While implementing the validator hardening, one concrete bug surfaced and was fixed:

- shell expressions using `// empty` were dropping boolean `false`
- this would have incorrectly treated `manualRecovery=false` as missing
- the validator now reads boolean fields with `has(...)` plus `tostring`
