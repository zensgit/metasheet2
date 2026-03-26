# Multitable On-Prem Operator Contract Promotion

## Goal

Promote the on-prem release gate operator contract into the pilot handoff and release-bound artifacts, instead of forcing operators to reopen `release-gate/report.json` just to recover the canonical replay commands and checklist.

## Design

- Keep `scripts/ops/multitable-onprem-release-gate.sh` as the source of truth for:
  - `operatorCommands`
  - `operatorChecklist`
- When `multitable-pilot-handoff.mjs` binds an on-prem gate report, lift those arrays into:
  - top-level `onPremReleaseGateOperatorContract`
  - `artifactChecks.onPremReleaseGate.operatorCommandEntries`
  - `artifactChecks.onPremReleaseGate.operatorChecklist`
- Add a dedicated markdown section in `handoff.md` so the operator contract is visible without opening nested JSON.
- Teach `multitable-pilot-release-bound.sh` to read the propagated handoff contract and emit it again in:
  - canonical `report.json`
  - canonical `report.md`
- Preserve graceful fallback behavior:
  - prefer `handoff.onPremReleaseGateOperatorContract`
  - fall back to `handoff.artifactChecks.onPremReleaseGate`
  - degrade to empty arrays for older handoff bundles

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-handoff.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-bound.sh`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-handoff.test.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-bound.test.mjs`

## Verification

Executed:

```bash
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-pilot-release-bound.sh
node --test scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs
node --test scripts/verify-multitable-live-smoke.test.mjs scripts/ops/multitable-pilot-release-gate.test.mjs scripts/ops/multitable-pilot-readiness.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs scripts/ops/multitable-pilot-ready-local.test.mjs scripts/ops/multitable-pilot-ready-staging.test.mjs
pnpm --filter @metasheet/web build
```

Observed:

- Focused handoff/release-bound tests passed.
- Full focused ops suite passed.
- `@metasheet/web build` passed.

Not run:

- Real staging live smoke
- Real deployment
- Real on-prem release execution
