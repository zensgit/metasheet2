# Multitable Pilot Contract Gate Hardening

Date: 2026-03-26  
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Make the multitable pilot readiness chain stricter and more auditable than the previous reference state by ensuring:

- the canonical `gates/report.json` is written even when the gate fails
- readiness treats that gate report as a required artifact by default
- OpenAPI parity and route-contract coverage are included in the canonical pilot gate
- release-bound and handoff artifacts carry the same local gate evidence that operators actually use

## Problems Fixed

- `scripts/ops/multitable-pilot-release-gate.sh` only wrote `gates/report.json` after success, so a failed step could leave no canonical gate artifact.
- The gate script duplicated command metadata and executed commands, which made drift possible.
- The canonical gate still referenced a retired backend spec and did not include:
  - `pnpm verify:multitable-openapi:parity`
  - the direct-route/client contract specs
- `scripts/ops/multitable-pilot-readiness.mjs` treated a missing multitable gate report as green.
- Pilot operator templates and copied handoff docs did not consistently carry `gates/report.json`.
- Several operator-facing docs still pointed at the retired `metasheet2-multitable` worktree path.

## Design

### 1. Canonical release-gate step model

`scripts/ops/multitable-pilot-release-gate.sh` now defines one ordered step list that drives both execution and report generation. Each step carries:

- `name`
- `command`
- `log`
- optional `env`
- optional `note`
- runtime `status`

That same metadata is emitted into `gates/report.json`, so the report can no longer silently drift away from the actual gate commands.

### 2. Failure-safe gate artifact

The gate now traps `EXIT` and always writes `REPORT_JSON` when configured, even if a step fails. The report now records:

- `ok`
- `exitCode`
- `failedStep`
- per-step `status`
- per-step `command`
- per-step `log`
- per-step `env` for the live smoke command

This makes a failed gate inspectable instead of disappearing with the shell exit.

### 3. Contract checks are now part of the canonical gate

The gate now includes clean contract slices that do not depend on the current dirty multitable UI workbench WIP:

- `web.vitest.multitable.contracts`
  - `tests/multitable-embed-route.spec.ts`
  - `tests/multitable-client.spec.ts`
- `core-backend.integration.multitable`
  - `tests/integration/multitable-context.api.test.ts`
  - `tests/integration/multitable-record-form.api.test.ts`
  - `tests/integration/multitable-attachments.api.test.ts`
  - `tests/integration/multitable-view-config.api.test.ts`
- `openapi.multitable.parity`
  - `pnpm verify:multitable-openapi:parity`

This makes the pilot gate better aligned with the current runtime and published contract surface.

### 4. Readiness requires gate evidence

`scripts/ops/multitable-pilot-readiness.mjs` now treats the multitable gate report as required by default:

- missing gate report -> readiness fails
- failed gate report -> readiness fails
- readiness still writes `readiness.md` / `readiness.json`, so operators can inspect the failed state

Ad hoc analysis can still opt out with `REQUIRE_GATE_REPORT=false`.

### 5. Operator artifact chain is now consistent

`scripts/ops/multitable-pilot-handoff.mjs` and `scripts/ops/multitable-pilot-release-bound.sh` now surface the local readiness gate report alongside readiness and on-prem gate artifacts.

Deployment docs were aligned so pilot owners and triage leads explicitly record:

- release-gate result
- `gates/report.json` path
- `failedStep` when present

## Scope Guard

This slice intentionally avoids the current dirty multitable UI WIP under:

- `apps/web/src/multitable/components/*`
- `apps/web/src/multitable/views/MultitableEmbedHost.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- their currently dirty specs

Only clean `scripts/ops`, deployment docs, package scripts, and new development MD were changed.
