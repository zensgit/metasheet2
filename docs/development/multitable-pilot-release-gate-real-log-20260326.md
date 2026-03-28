# Multitable Pilot Release-Gate Real Log

Date: 2026-03-26

## Problem

The multitable pilot `release-gate` already published:

- `report.json`
- `report.md`
- `release-gate.log`
- `operator-commands.sh`

but direct gate runs did not actually guarantee a usable gate log.

The path existed in the report contract, yet:

- the script did not initialize the log
- step execution did not append output into the log
- `show-log-tail` in the operator helper could point to an empty or missing artifact

That left two practical gaps:

- the direct gate log could still be empty or missing
- downstream `readiness -> handoff -> release-bound` summaries did not yet promote the gate-side operator helper

## Design

### 1. Treat gate log as a real artifact, not just metadata

`scripts/ops/multitable-pilot-release-gate.sh` now initializes `release-gate.log` at the start of each run and writes:

- gate header
- run mode
- report and smoke artifact paths
- per-step start markers
- per-step pass/fail/skip markers
- final completion status

### 2. Capture real command output

Every executed release-gate step now appends stdout/stderr into `release-gate.log`.

This means direct gate runs now leave a stable diagnostic trail for:

- passed steps
- skipped smoke
- failed steps

### 3. Align operator helper with a real log

The gate-side `operator-commands.sh` already exposed:

- `show-artifacts`
- `rerun-gate`
- `rerun-live-smoke`
- `show-log-tail`

After this change, `show-log-tail` is backed by a real canonical gate log rather than a report-only placeholder path.

### 4. Promote the operator helper through the pilot chain

The canonical gate now records `operatorCommandsPath`, and downstream pilot artifacts carry it forward:

- `readiness` surfaces `gates.operatorCommands`
- `handoff` copies `gates/operator-commands.sh`
- `release-bound` includes `readinessGateOperatorCommands`

This makes the helper discoverable from every operator-facing artifact layer, not only from the direct gate output root.

## Files

Implementation:

- `scripts/ops/multitable-pilot-release-gate.sh`
- `scripts/ops/multitable-pilot-readiness.mjs`
- `scripts/ops/multitable-pilot-handoff.mjs`
- `scripts/ops/multitable-pilot-release-bound.sh`

Focused regression:

- `scripts/ops/multitable-pilot-release-gate.test.mjs`
- `scripts/ops/multitable-pilot-readiness.test.mjs`
- `scripts/ops/multitable-pilot-handoff.test.mjs`
- `scripts/ops/multitable-pilot-release-bound.test.mjs`

## Verification

Executed:

```bash
bash -n scripts/ops/multitable-pilot-release-gate.sh scripts/ops/multitable-pilot-release-bound.sh
```

```bash
node --test scripts/ops/multitable-pilot-release-gate.test.mjs scripts/ops/multitable-pilot-readiness.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs
```

```bash
node --check scripts/ops/multitable-pilot-readiness.mjs scripts/ops/multitable-pilot-handoff.mjs
```

```bash
pnpm --filter @metasheet/web build
```

Results:

- gate / release-bound shell syntax passed
- focused ops tests passed
- `web build` passed

## Explicitly Not Run

Not run in this slice:

- real staging live smoke
- `pnpm verify:multitable-pilot:staging`
- `pnpm verify:multitable-pilot:release-gate:staging`
- `pnpm verify:multitable-pilot:ready:staging`
- real deployment

## Outcome

The multitable pilot direct `release-gate` is now materially more operational:

- the canonical gate log is real
- the helper can tail a real artifact
- the helper itself is now promoted through readiness, handoff, and release-bound
- direct runs, skipped-smoke runs, and failed-step runs all leave reproducible diagnostics

This closes a contract gap that previously existed between the reported gate artifact set and the artifacts actually produced on disk.
