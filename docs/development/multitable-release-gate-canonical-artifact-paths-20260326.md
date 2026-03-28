# Multitable Release Gate Canonical Artifact Paths

## Background

The multitable pilot gate already wrote:

- `report.json`
- `report.md`
- raw smoke artifacts

But one robustness gap remained:

- the canonical gate report did not describe its own artifact paths
- readiness still depended on `GATE_REPORT_MD` / `GATE_LOG_PATH` envs for markdown and log discovery
- direct gate runs and wrapper-driven runs were operationally aligned, but not fully self-describing

That left a brittle edge:

- if only `GATE_REPORT_JSON` was preserved
- or a downstream tool re-opened the canonical gate report later

it still had to guess where gate markdown and the gate log lived.

## Goal

Make the canonical gate report self-describing and let downstream summaries recover from it:

- `report.outputRoot`
- `report.reportPath`
- `report.reportMdPath`
- `report.logPath`
- `report.liveSmoke.outputRoot`

Then allow readiness to fall back to those canonical fields when explicit env paths are omitted.

## Design

### 1. Release gate now records canonical artifact paths

`scripts/ops/multitable-pilot-release-gate.sh` now writes these top-level fields into `report.json`:

- `outputRoot`
- `reportPath`
- `reportMdPath`
- `logPath`

and into `liveSmoke`:

- `outputRoot`

The gate markdown summary now also surfaces:

- gate output root
- gate log path
- smoke output root

### 2. Deterministic paths remain explicit

The gate still honors explicit env overrides, but it now records the resolved canonical values. That keeps both modes aligned:

- direct gate execution
- ready-local / ready-staging wrapper execution

### 3. Readiness can recover gate markdown/log from gate JSON

`scripts/ops/multitable-pilot-readiness.mjs` now falls back to:

- `report.reportMdPath`
- `report.logPath`

when `GATE_REPORT_MD` / `GATE_LOG_PATH` are not explicitly provided.

This means the canonical gate JSON is now sufficient to reconstruct the full gate diagnostic surface.

### 4. Downstream artifact promotion remains stable

Because readiness already promotes gate markdown and log forward, handoff and release-bound automatically benefit once the canonical gate JSON becomes self-describing.

## Validation

Executed:

```bash
bash -n scripts/ops/multitable-pilot-release-gate.sh scripts/ops/multitable-pilot-ready-local.sh scripts/ops/multitable-pilot-ready-staging.sh scripts/ops/multitable-pilot-local.sh scripts/ops/multitable-pilot-release-bound.sh
```

```bash
node --check scripts/ops/multitable-pilot-readiness.mjs scripts/ops/multitable-pilot-handoff.mjs
```

```bash
node --test scripts/ops/multitable-pilot-release-gate.test.mjs scripts/ops/multitable-pilot-readiness.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs scripts/ops/multitable-pilot-ready-local.test.mjs scripts/ops/multitable-pilot-ready-staging.test.mjs
```

```bash
pnpm --filter @metasheet/web build
```

Focused assertions added:

- direct local gate run writes `outputRoot`, `reportPath`, `reportMdPath`, `logPath`, `liveSmoke.outputRoot`
- direct staging gate run writes the same canonical fields
- readiness can resolve gate markdown and gate log from the gate JSON alone
- handoff and release-bound continue to surface the promoted gate diagnostics

## Result

The multitable pilot gate is now fully self-describing:

- direct gate runs are deterministic
- wrapper runs are deterministic
- canonical gate JSON is enough to recover markdown/log diagnostics
- downstream artifact promotion no longer depends solely on wrapper-side env wiring
