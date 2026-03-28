# Multitable Staging Runner Report Fallback Verification

Date: 2026-03-26

## Goal

Verify that staging flows no longer fall back to `local-report.*` names when `pilotRunner/localRunner` omit explicit report paths.

## Commands

```bash
node --test \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs

node --check scripts/ops/multitable-pilot-handoff.mjs

bash -n scripts/ops/multitable-pilot-release-bound.sh
```

## Results

- focused handoff/release-bound tests passed
- handoff script syntax/parse passed
- release-bound shell syntax passed

Combined focused result from the local run:

- `4 passed` on the two staging-fallback assertions plus the surrounding embed evidence assertions

## Verified Behavior

- when staging readiness omits explicit `report` / `reportMd`, handoff falls back to:
  - `smoke/staging-report.json`
  - `smoke/staging-report.md`
- when staging handoff omits explicit `report` / `reportMd`, release-bound falls back to:
  - `staging-report.json`
  - `staging-report.md`
- top-level release-bound markdown and helper output no longer mislabel staging artifacts as local artifacts

## Conclusion

The staging artifact chain is now self-consistent on fallback paths:

- readiness -> handoff
- handoff -> release-bound

without leaking `local-report.*` assumptions into staging summaries.
