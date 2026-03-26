# Multitable Gate Log Artifact Promotion

## Background

The multitable pilot chain already promoted:

- raw smoke JSON
- raw smoke Markdown
- wrapper runner JSON/Markdown
- canonical gate JSON/Markdown

But one practical operator gap remained:

- `readiness`
- `handoff`
- `release-bound`

did not treat the pilot `release-gate` Markdown report and gate log as first-class artifacts.

That meant when a staging gate failed, operators still had to rediscover:

- where `gates/report.md` lived
- where `gates/release-gate.log` lived

instead of seeing those files carried through the canonical handoff chain.

## Goal

Promote gate-side diagnostics to the same level as smoke-side diagnostics:

- gate JSON
- gate Markdown
- gate log

should all be threaded through:

- `ready-local`
- `ready-staging`
- `readiness`
- `handoff`
- `release-bound`

## Design

### 1. Readiness now accepts gate Markdown and gate log

`scripts/ops/multitable-pilot-readiness.mjs` now reads:

- `GATE_REPORT_MD`
- `GATE_LOG_PATH`

and stores them under `payload.gates`:

- `reportMd`
- `log`

The readiness Markdown summary also surfaces both paths in `## Build & Test Gates`.

### 2. Ready wrappers now pass gate-side diagnostics explicitly

Both:

- `scripts/ops/multitable-pilot-ready-local.sh`
- `scripts/ops/multitable-pilot-ready-staging.sh`

now pass:

- `GATE_REPORT_MD=${GATE_ROOT}/report.md`
- `GATE_LOG_PATH=${GATE_ROOT}/release-gate.log`

into readiness generation.

### 3. Handoff now copies gate Markdown and gate log

`scripts/ops/multitable-pilot-handoff.mjs` now copies:

- `gates/report.md`
- `gates/release-gate.log`

from readiness root into the handoff bundle and lists both in:

- `artifactChecks.readinessGate`
- `Included Files`

### 4. Release-bound now points at the same gate diagnostics

`scripts/ops/multitable-pilot-release-bound.sh` now exposes:

- `readinessGateReportMd`
- `readinessGateLog`

in `report.json`, and surfaces both in:

- top summary
- operator checklist
- outputs list

This makes operator-side diagnosis consistent with the rest of the artifact chain.

## Validation

Executed:

```bash
bash -n scripts/ops/multitable-pilot-release-gate.sh scripts/ops/multitable-pilot-ready-local.sh scripts/ops/multitable-pilot-ready-staging.sh scripts/ops/multitable-pilot-local.sh scripts/ops/multitable-pilot-release-bound.sh
```

```bash
node --test scripts/ops/multitable-pilot-readiness.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs scripts/ops/multitable-pilot-ready-local.test.mjs scripts/ops/multitable-pilot-ready-staging.test.mjs
```

```bash
pnpm --filter @metasheet/web build
```

Focused assertions added:

- readiness stores `gates.reportMd` and `gates.log`
- ready-local/ready-staging pass `REPORT_MD` and `LOG_PATH` into the gate layer
- handoff copies `gates/report.md` and `gates/release-gate.log`
- release-bound markdown references both readiness gate Markdown and readiness gate log

## Result

The pilot artifact chain now treats gate diagnostics as first-class evidence:

- smoke evidence is promoted
- gate evidence is promoted
- operator replay no longer depends on manually rediscovering the gate log root
