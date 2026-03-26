# Multitable Pilot Staging Readiness

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Promote the new staging-safe pilot wrapper from a standalone smoke entrypoint into the canonical pilot evidence chain.

Before this slice:

- `multitable-pilot-staging.sh` existed
- but the artifact chain still assumed a local-only wrapper
- readiness/handoff/release-bound still rendered `Local Pilot Runner`
- staging could only reuse that logic awkwardly and still looked like `local-report`

After this slice:

- wrapper artifacts carry an explicit `runMode`
- staging uses its own `staging-report.json` / `staging-report.md`
- readiness can ingest generic runner artifacts through `SMOKE_RUNNER_REPORT_JSON|MD`
- a dedicated `verify:multitable-pilot:ready:staging` wrapper now produces canonical readiness output against already-running services

## Design

### 1. Make the wrapper artifact mode-aware

`scripts/ops/multitable-pilot-local.sh` now accepts:

- `RUN_MODE`
- `RUNNER_REPORT_BASENAME`

This keeps the same wrapper implementation, but stops forcing every execution mode to look like `local-report`.

Default behavior remains unchanged for developer runs:

- `RUN_MODE=local`
- `RUNNER_REPORT_BASENAME=local-report`

The staging wrapper now sets:

- `RUN_MODE=staging`
- `RUNNER_REPORT_BASENAME=staging-report`

### 2. Promote the evidence surface from local-only wording to generic pilot runner wording

`multitable-pilot-readiness.mjs`, `multitable-pilot-handoff.mjs`, and `multitable-pilot-release-bound.sh` now keep backward-compatible `localRunner` data while also exposing the same object as `pilotRunner`.

Rendered summaries now show:

- `## Pilot Runner`
- `Run mode: local|staging`

That removes the naming mismatch when readiness is produced from a pre-deployed staging stack.

### 3. Add a real staging-ready wrapper

New entrypoint:

- `pnpm verify:multitable-pilot:ready:staging`
- `scripts/ops/multitable-pilot-ready-staging.sh`

It mirrors the existing ready-local chain but:

- runs `verify:multitable-pilot:staging`
- runs `profile:multitable-grid:staging`
- requires already-running API/Web services
- binds readiness to `staging-report.json` / `staging-report.md`

So a pre-deployed staging environment can now produce the same canonical readiness artifact shape as local runs, without auto-start side effects.

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
bash -n \
  scripts/ops/multitable-pilot-local.sh \
  scripts/ops/multitable-pilot-staging.sh \
  scripts/ops/multitable-pilot-ready-local.sh \
  scripts/ops/multitable-pilot-ready-staging.sh
node --test \
  scripts/ops/multitable-pilot-local.test.mjs \
  scripts/ops/multitable-pilot-staging.test.mjs \
  scripts/ops/multitable-pilot-ready-staging.test.mjs \
  scripts/ops/multitable-pilot-readiness.test.mjs \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

## Outcome

The pilot chain now has two first-class readiness modes:

- local developer bootstrap mode
- staging running-services-only mode

Both now flow through the same pilot runner evidence model, which is cleaner for future staging deployment rehearsal and avoids local-only artifact semantics leaking into pre-deployed validation.
