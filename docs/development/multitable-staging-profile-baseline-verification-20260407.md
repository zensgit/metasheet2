# Multitable Staging Profile Baseline Verification

Date: 2026-04-07
Repo: `/Users/huazhou/Downloads/Github/metasheet2`

## Scope

Verify the staging profile-threshold follow-up only:

- `scripts/ops/multitable-pilot-ready-staging.sh`
- `scripts/ops/multitable-pilot-ready-staging.test.mjs`
- `scripts/ops/multitable-pilot-ready-local.test.mjs`
- `docs/development/multitable-staging-profile-baseline-20260407.md`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`

## Commands

```bash
cd /tmp/metasheet2-profile-threshold-followup
bash -n scripts/ops/multitable-pilot-ready-staging.sh
node --test \
  scripts/ops/multitable-pilot-ready-staging.test.mjs \
  scripts/ops/multitable-pilot-ready-local.test.mjs
git diff --check
AUTH_TOKEN='<admin-jwt>' \
API_BASE='http://142.171.239.56:8081' \
WEB_BASE='http://142.171.239.56:8081' \
ONPREM_GATE_REPORT_JSON='/Users/huazhou/Downloads/Github/metasheet2/output/delivery/multitable-pilot-final-20260407/onprem-gate/report.json' \
ENSURE_PLAYWRIGHT=false \
HEADLESS=true \
pnpm verify:multitable-pilot:ready:staging:release-bound
```

## Results

- `bash -n scripts/ops/multitable-pilot-ready-staging.sh` passed
- focused node tests passed
- `git diff --check` passed
- real staging `pnpm verify:multitable-pilot:ready:staging:release-bound` passed

## Real Staging Evidence

- Staging URL: `http://142.171.239.56:8081/multitable`
- Readiness: `/private/tmp/metasheet2-profile-threshold-followup/output/playwright/multitable-pilot-ready-staging/20260407-211056/readiness.md`
- Smoke: `/private/tmp/metasheet2-profile-threshold-followup/output/playwright/multitable-pilot-ready-staging/20260407-211056/smoke/report.md`
- Profile summary: `/private/tmp/metasheet2-profile-threshold-followup/output/playwright/multitable-pilot-ready-staging/20260407-211056/profile/summary.md`
- Gate report: `/private/tmp/metasheet2-profile-threshold-followup/output/playwright/multitable-pilot-ready-staging/20260407-211056/gates/report.md`

Measured metrics on the passing rerun:

- `ui.grid.open = 2670.69 ms`
- `ui.grid.search-hit = 806.03 ms`
- `api.grid.initial-load = 222.95 ms`
- `api.grid.search-hit = 201.63 ms`

Applied staging thresholds:

- `ui.grid.open <= 3500 ms`
- `ui.grid.search-hit <= 1000 ms`
- `api.grid.initial-load <= 300 ms`
- `api.grid.search-hit <= 250 ms`

## Conclusion

This follow-up is verified. Real staging release-bound readiness now passes with a public-remote staging baseline that matches observed network conditions, while local and same-host rehearsals can still override the thresholds explicitly.
