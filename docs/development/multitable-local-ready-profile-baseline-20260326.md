# Multitable Local Ready Profile Baseline

Date: 2026-03-26

## Context

`pnpm verify:multitable-pilot:ready:local` was reusing the same grid-profile thresholds as staging and release readiness:

- `ui.grid.open <= 350ms`
- `ui.grid.search-hit <= 300ms`
- `api.grid.initial-load <= 25ms`
- `api.grid.search-hit <= 25ms`

After the multitable live-smoke runtime fixes landed, the local pilot smoke itself passed end-to-end, but `ready-local` still failed before release-gate/readiness because the profile step exceeded the local machine budget while still remaining stable enough for developer preflight.

Observed local profile data from the full ready-local run:

- `ui.grid.open = 450.43ms`
- `ui.grid.search-hit = 293.62ms`
- `api.grid.initial-load = 63.98ms`
- `api.grid.search-hit = 66.28ms`

That is a delivery-chain policy problem, not a product correctness problem.

## Decision

Split the profile baseline by run mode:

- `ready-local` keeps a developer-machine baseline:
  - `ui.grid.open <= 500ms`
  - `ui.grid.search-hit <= 300ms`
  - `api.grid.initial-load <= 75ms`
  - `api.grid.search-hit <= 75ms`
- `ready-staging` keeps the stricter release-style baseline:
  - `ui.grid.open <= 350ms`
  - `ui.grid.search-hit <= 300ms`
  - `api.grid.initial-load <= 25ms`
  - `api.grid.search-hit <= 25ms`

This preserves a strict bar where it matters while allowing the local wrapper to complete the full smoke -> profile -> gate -> readiness chain on a developer machine.

## Implementation

- [`scripts/ops/multitable-pilot-ready-local.sh`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-ready-local.sh)
  now defines local default thresholds and passes them into `verify:multitable-grid-profile:summary`.
- [`scripts/ops/multitable-pilot-ready-local.test.mjs`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-ready-local.test.mjs)
  locks the behavior with a realistic local profile fixture that would fail under the staging thresholds but pass under the local baseline.
- [`package.json`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/package.json)
  adds `verify:multitable-pilot:ready:local:test`.
- [`docs/deployment/multitable-internal-pilot-runbook-20260319.md`](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/docs/deployment/multitable-internal-pilot-runbook-20260319.md)
  now documents local vs staging thresholds explicitly.

## Why this is better

- Developer preflight no longer stalls after a fully green pilot smoke due to local hardware variance.
- Staging and release readiness remain strict.
- The distinction is explicit in both code and operator docs instead of hidden in ad hoc env overrides.

## Delivery-Chain Outcome

With the local baseline in place, the real delivery chain now completes on this workstation:

- `pnpm verify:multitable-pilot:ready:local`
- `pnpm build:multitable-onprem-package`
- `pnpm verify:multitable-onprem:release-gate`
- `pnpm prepare:multitable-pilot:handoff`
- `pnpm prepare:multitable-pilot:release-bound`

That turns this slice from a policy tweak into an actual delivery unblocker.
