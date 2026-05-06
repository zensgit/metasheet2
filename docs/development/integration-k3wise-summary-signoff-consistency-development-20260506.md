# K3 WISE Summary Signoff Consistency Development

Date: 2026-05-06

## Context

`integration-k3wise-postdeploy-summary.mjs` renders the GitHub Step Summary for
K3 WISE postdeploy smoke evidence. Before this slice, the renderer trusted
`signoff.internalTrial="pass"` directly. A stale or hand-edited evidence file
could therefore display `Internal trial signoff: PASS` even when the same JSON
also had `ok=false`, `authenticated=false`, or `summary.fail>0`.

The machine gate remains separate, but the human-facing summary should not show
a contradictory PASS.

## Change

Added a consistency check inside `inferInternalTrialSignoff()`:

- explicit `signoff.internalTrial="pass"` still passes only when:
  - `ok === true`
  - `authenticated === true`
  - `summary.fail === 0`
- inferred PASS from old evidence without a `signoff` block also requires
  `summary.fail === 0`
- inconsistent evidence renders `Internal trial signoff: BLOCKED` with a direct
  reason that names the contradictory field

This keeps the renderer non-fatal: it still exits `0` and renders the rest of
the evidence, but the signoff line can no longer mislead an operator.

## Scope

Changed files:

- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`
- this development note
- companion verification note
This does not touch the open K3 setup UI, live preflight, fixture/evidence, or
signoff-gate PR files.
