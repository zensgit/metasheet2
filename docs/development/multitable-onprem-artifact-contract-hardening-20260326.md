# Multitable On-Prem Artifact Contract Hardening

Date: 2026-03-26

## Goal

Harden the on-prem and pilot artifact chain in two places:

1. Make the on-prem release gate report self-describing, so downstream consumers do not need to guess report/helper/log paths from directory layout.
2. Make the release-bound top-level JSON status truthful, so machine-readable consumers do not see a false green when pilot/embed acceptance failed.

## Design

### 1. Canonical on-prem gate artifact paths

- `scripts/ops/multitable-onprem-release-gate.sh` now writes first-class path metadata into `report.json`:
  - `outputRoot`
  - `reportPath`
  - `reportMdPath`
  - `logRoot`
  - `operatorCommandsPath`
- The markdown report also surfaces the same paths near the top.
- `scripts/ops/multitable-pilot-handoff.mjs` now prefers those canonical fields when binding an on-prem gate report:
  - use `raw.reportMdPath` before guessing `gateRoot/report.md`
  - use `raw.operatorCommandsPath` or `raw.operatorCommandScript` before guessing `gateRoot/operator-commands.sh`
  - use `raw.logRoot` before guessing `gateRoot/logs`

This removes an implicit directory contract from the handoff path.

### 2. Truthful release-bound top-level status

- `scripts/ops/multitable-pilot-release-bound.sh` no longer hardcodes `report.json.ok = true`.
- `ok` now rolls up:
  - pilot runner status
  - overall embed-host acceptance status

This aligns the machine-readable `report.json` with the markdown summary that was already showing PASS/FAIL per acceptance section.

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-onprem-release-gate.sh`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-onprem-release-gate.test.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-handoff.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-handoff.test.mjs`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-bound.sh`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-bound.test.mjs`

## Verification

Executed:

```bash
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-onprem-release-gate.sh
bash -n scripts/ops/multitable-pilot-release-bound.sh
node --test scripts/ops/multitable-onprem-release-gate.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs
node --test scripts/verify-multitable-live-smoke.test.mjs scripts/ops/multitable-pilot-release-gate.test.mjs scripts/ops/multitable-pilot-readiness.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs scripts/ops/multitable-pilot-ready-local.test.mjs scripts/ops/multitable-pilot-ready-staging.test.mjs
pnpm --filter @metasheet/web build
```

Observed:

- Focused on-prem/handoff/release-bound tests passed.
- Full focused ops suite passed.
- `@metasheet/web build` passed.

Not run:

- Real staging live smoke
- Real deployment
- Real on-prem release execution
