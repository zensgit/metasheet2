# Multitable Pilot Release Gate Alignment

Date: 2026-03-26
Branch: `codex/multitable-next`

## Goal

Make `scripts/ops/multitable-pilot-release-gate.sh` the single source of truth for `gates/report.json` so local readiness output and the actual release gate cannot silently drift apart.

## Problem

Before this change:

- `multitable-pilot-release-gate.sh` executed the real gate commands
- `multitable-pilot-ready-local.sh` re-built `gates/report.json` by hand after the gate finished

That duplicated the contract and had already drifted. The hand-built report omitted checks already present in the real gate command list, including the people-import coverage now expected in the pilot line.

## Scope

Included:

- keep canonical report generation in `multitable-pilot-release-gate.sh`
- make `multitable-pilot-ready-local.sh` consume the canonical report instead of hand-writing JSON
- add a script-level test for release-gate report generation
- document `gates/report.json` in pilot runbook and go/no-go evidence

Excluded:

- pilot smoke UI behavior
- readiness scoring logic
- workbench UI changes

## Design

### 1. Canonical report emission stays inside release gate

`multitable-pilot-release-gate.sh` already knows the actual command list and smoke-skip behavior. It should also own `report.json`.

### 2. Ready-local only orchestrates

`multitable-pilot-ready-local.sh` should:

- run smoke
- run profile
- run threshold summary
- run release gate with:
  - `REPORT_JSON`
  - `LOG_PATH`
  - `PILOT_SMOKE_REPORT`
  - `SKIP_MULTITABLE_PILOT_SMOKE=true`

It should not re-encode check names or commands itself.

### 3. Script-level contract test

Add a node test that:

- injects a fake `pnpm`
- runs `multitable-pilot-release-gate.sh`
- asserts the generated report exists
- asserts the canonical check list includes the people-import Vitest coverage
- asserts smoke skip metadata is written consistently

## Expected outcome

After this change:

- local readiness uses the same gate report shape as the real release gate
- future gate changes only need one code path updated
- pilot sign-off evidence becomes more trustworthy
