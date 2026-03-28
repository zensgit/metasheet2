# Multitable Pilot Release Gate Run Mode Verification

Date: 2026-03-26

## Goal

Verify that the canonical multitable pilot release gate is run-mode aware for both:

- direct gate execution
- wrapper-driven skipped-smoke execution

## Commands

```bash
node --test \
  scripts/ops/multitable-pilot-release-gate.test.mjs \
  scripts/ops/multitable-pilot-ready-staging.test.mjs

node --check scripts/ops/multitable-pilot-handoff.mjs

bash -n \
  scripts/ops/multitable-pilot-release-gate.sh \
  scripts/ops/multitable-pilot-ready-local.sh \
  scripts/ops/multitable-pilot-ready-staging.sh \
  scripts/ops/multitable-pilot-release-bound.sh
```

## Results

- focused ops suite passed:
  - `multitable-pilot-release-gate.test.mjs`
  - `multitable-pilot-ready-staging.test.mjs`
- shell syntax checks passed
- `node --check` passed

Combined focused result from the local run:

- `11 passed`

## Verified Behavior

- direct local gate command remains:
  - `pnpm verify:multitable-pilot`
- direct staging gate command is now:
  - `pnpm verify:multitable-pilot:staging`
- skipped smoke note switches by mode:
  - local: `executed earlier by multitable-pilot-ready-local`
  - staging: `executed earlier by multitable-pilot-ready-staging`
- canonical gate report includes top-level `runMode`
- ready-staging forwards `RUN_MODE=staging` into release-gate execution

## Conclusion

`release-gate` is now first-class mode-aware instead of treating staging as a local-flavored replay path.
