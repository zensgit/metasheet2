# Multitable Pilot Release Gate Direct Smoke Artifacts

## Background

`multitable-pilot-release-gate.sh` had already become the canonical gate report generator for:

- local ready wrappers
- staging ready wrappers
- skipped-smoke reuse flows

But when the gate was run directly through:

- `pnpm verify:multitable-pilot:release-gate`
- `pnpm verify:multitable-pilot:release-gate:staging`

the live-smoke step still behaved like an ad hoc child command:

- smoke artifacts were only deterministic if the caller pre-specified `PILOT_SMOKE_REPORT` and `PILOT_SMOKE_REPORT_MD`
- direct gate runs had no guaranteed `output/playwright/.../report.json`
- the canonical gate report could end up without stable raw smoke artifact paths even though smoke had actually run

That meant the wrapper chain was stronger than the direct gate path.

## Goal

Make `release-gate` itself a first-class artifact producer so direct runs and wrapper-driven runs share the same contract:

- deterministic gate output root
- deterministic smoke output root under the gate root
- canonical `report.json` and `report.md` written by default
- canonical `liveSmoke.report` and `liveSmoke.reportMd` populated for direct smoke execution

## Design

### 1. Deterministic gate output root

`scripts/ops/multitable-pilot-release-gate.sh` now derives:

- `OUTPUT_ROOT`
- `REPORT_JSON`
- `REPORT_MD`
- `LOG_PATH`

in this order:

1. explicit env override
2. derive from existing `REPORT_JSON` / `REPORT_MD` / `LOG_PATH`
3. otherwise default to:
   - `output/playwright/multitable-pilot-release-gate/<timestamp>`
   - `output/playwright/multitable-pilot-release-gate-staging/<timestamp>`

This makes direct gate runs self-contained instead of best-effort.

### 2. Deterministic smoke artifact root

The gate now derives:

- `PILOT_SMOKE_OUTPUT_ROOT=${OUTPUT_ROOT}/smoke`
- `PILOT_SMOKE_REPORT=${PILOT_SMOKE_OUTPUT_ROOT}/report.json`
- `PILOT_SMOKE_REPORT_MD=${PILOT_SMOKE_OUTPUT_ROOT}/report.md`

unless the caller explicitly overrides them.

### 3. Actually apply step envs at execution time

The release gate already stored per-step env metadata, but execution still ignored it.

`run_release_gate_step()` now parses the serialized env map and executes steps with:

- `env KEY=VALUE ... bash -c "$command"`

This lets the smoke step receive:

- `OUTPUT_ROOT`
- `REPORT_MD`
- `SMOKE_REPORT_MD`
- `RUN_MODE`
- `API_BASE`
- `WEB_BASE`
- `HEADLESS`
- `TIMEOUT_MS`

without polluting the command string shown in the gate report.

### 4. Keep report contract stable

The visible command remains:

- `pnpm verify:multitable-pilot`
- `pnpm verify:multitable-pilot:staging`

So report consumers still see the canonical step command, while the runtime gets deterministic artifact locations.

## Validation

Executed:

```bash
bash -n scripts/ops/multitable-pilot-release-gate.sh scripts/ops/multitable-pilot-ready-local.sh scripts/ops/multitable-pilot-ready-staging.sh scripts/ops/multitable-pilot-local.sh scripts/ops/multitable-pilot-release-bound.sh
```

```bash
node --test scripts/verify-multitable-live-smoke.test.mjs scripts/ops/multitable-pilot-readiness.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs scripts/ops/multitable-pilot-release-gate.test.mjs
```

```bash
pnpm --filter @metasheet/web build
```

Key assertions added:

- direct local gate run writes:
  - `OUTPUT_ROOT/report.json`
  - `OUTPUT_ROOT/report.md`
  - `OUTPUT_ROOT/smoke/report.json`
  - `OUTPUT_ROOT/smoke/report.md`
- direct staging gate run writes the same deterministic smoke paths
- canonical gate `report.liveSmoke.report` / `report.liveSmoke.reportMd` point to those artifacts
- step command stays canonical while the env is injected at execution time

## Result

The direct pilot release gate path now matches the wrapper path:

- direct local gate is artifact-complete
- direct staging gate is artifact-complete
- wrapper reuse still works
- canonical reports always know where the raw smoke evidence lives
