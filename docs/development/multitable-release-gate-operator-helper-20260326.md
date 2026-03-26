# Multitable Release Gate Operator Helper

## Background

The canonical multitable release-gate report already became self-describing for:

- gate output root
- gate JSON/Markdown paths
- gate log path
- smoke output root

One operator gap remained:

- the report still did not point at a stable helper script path
- rerun commands only lived in shell history or wrapper context

That made replay slower when operators only had the gate report in hand.

## Goal

Promote replay hints into the canonical release-gate artifact itself:

- expose `operatorCommandsPath` in `report.json`
- surface operator helper path and replay commands in `report.md`

## Design

### 1. Gate output now reserves an operator helper path

`scripts/ops/multitable-pilot-release-gate.sh` now derives:

- `COMMANDS_SH=${OUTPUT_ROOT}/operator-commands.sh`

and records it in the canonical report as:

- `operatorCommandsPath`

### 2. Gate markdown now becomes operator-facing

`report.md` now includes an `## Operator Commands` section with:

- helper path
- rerun gate command
- rerun live smoke command
- tail-log command

The commands stay run-mode aware:

- local uses `pnpm verify:multitable-pilot`
- staging uses `RUN_MODE=staging` and `pnpm verify:multitable-pilot:staging`

### 3. This stays a gate-only slice

No runtime, UI, readiness, handoff, or release-bound behavior changes.

This slice only improves canonical gate diagnostics and operator replay ergonomics.

## Validation

Executed:

```bash
bash -n scripts/ops/multitable-pilot-release-gate.sh
```

```bash
node --test scripts/ops/multitable-pilot-release-gate.test.mjs
```

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

```bash
pnpm --filter @metasheet/web build
```

## Result

The canonical gate artifact now carries enough information for an operator to:

- identify the right helper location
- rerun the gate
- rerun the smoke
- tail the correct gate log

without reconstructing those commands from surrounding wrapper scripts.
