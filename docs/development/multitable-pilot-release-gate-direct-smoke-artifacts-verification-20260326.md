# Multitable Pilot Release Gate Direct Smoke Artifacts Verification

Date: 2026-03-26

## Goal

Verify that direct `release-gate` runs now write deterministic gate and smoke artifacts instead of relying on wrapper-provided paths.

## Commands

```bash
bash -n scripts/ops/multitable-pilot-release-gate.sh
node --test scripts/ops/multitable-pilot-release-gate.test.mjs
```

## Results

- shell syntax passed
- `scripts/ops/multitable-pilot-release-gate.test.mjs`: `6 passed`

## Verified Behavior

- direct local gate runs write:
  - `OUTPUT_ROOT/report.json`
  - `OUTPUT_ROOT/report.md`
  - `OUTPUT_ROOT/smoke/report.json`
  - `OUTPUT_ROOT/smoke/report.md`
- direct staging gate runs write the same deterministic smoke artifact set
- step env metadata is actually applied at execution time
- canonical gate report still shows the stable human-facing command:
  - `pnpm verify:multitable-pilot`
  - `pnpm verify:multitable-pilot:staging`
- skipped-smoke reuse still fails if required embed-host evidence is missing

## Conclusion

Direct `release-gate` execution is now artifact-complete and behaviorally aligned with the wrapper flows used by `ready-local` and `ready-staging`.
