# Multitable Embed Readiness Evidence

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Goal

Expose embed-host live-smoke evidence inside pilot readiness without binding readiness to unmerged embed-host implementation files.

## Why

The embed-host protocol work now has its own design and smoke plan, but the canonical readiness summary still only understands:

- route entry
- import recovery
- manager recovery
- grid profile
- build/test gates

That creates a blind spot: if a smoke report already contains `ui.embed-host.*` evidence, readiness currently ignores it.

## Design

### Optional-by-default, required-when-present

Add an `embedHostProtocol` summary to `multitable-pilot-readiness.mjs` with this rule:

- if no `ui.embed-host.*` checks exist in `smoke.json`, readiness stays neutral
- if any `ui.embed-host.*` checks exist, the full protocol set becomes required for that run

Required when present:

- `ui.embed-host.ready`
- `ui.embed-host.state-query.initial`
- `ui.embed-host.navigate.generated-request-id`
- `ui.embed-host.navigate.applied`
- `ui.embed-host.navigate.explicit-request-id`
- `ui.embed-host.state-query.final`

This avoids coupling readiness to the current dirty worktree while still making embed evidence first-class as soon as the smoke script starts emitting it in a committed slice.

### Surface it in operator-facing output

Expose the summary in both:

- `readiness.json`
- `readiness.md`

and update the internal pilot runbook so operators know that `Embed Host Protocol Evidence` becomes a real readiness signal once smoke starts reporting it.

## Files

- `scripts/ops/multitable-pilot-readiness.mjs`
- `scripts/ops/multitable-pilot-readiness.test.mjs`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`

## Outcome

Embed-host protocol evidence now has a place in canonical readiness. It is visible immediately when present, but it does not block current runs that still use the older committed smoke script.
