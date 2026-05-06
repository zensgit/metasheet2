# K3 WISE Summary Auth Signoff Guard Development - 2026-05-06

## Context

`integration-k3wise-postdeploy-summary.mjs` renders the GitHub Step Summary for
K3 WISE postdeploy smoke evidence. With `--require-auth-signoff`, operators use
that summary as the internal-trial signoff surface.

The runbook requires all authenticated signoff evidence to satisfy:

- `ok=true`
- `authenticated=true`
- `signoff.internalTrial=pass`

The summary renderer trusted an explicit `signoff.internalTrial=pass` before
checking `ok` and `authenticated`. A stale, hand-edited, or older contradictory
evidence artifact could therefore display internal trial `PASS` even when
authenticated checks did not run or the smoke itself failed.

## Change

`inferInternalTrialSignoff()` now accepts explicit
`signoff.internalTrial=pass` only when the evidence also has:

- `ok === true`
- `authenticated === true`

Contradictory evidence is rendered as blocked:

- `authenticated !== true` -> `authenticated checks did not run`
- `ok !== true` -> `one or more smoke checks failed`

This keeps the summary renderer aligned with the internal trial runbook and the
smoke generator's intended signoff contract.

## Files

- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`

## Non-Goals

- This does not change smoke evidence generation.
- This does not fail the summary renderer process. The renderer still exits
  successfully after displaying a blocked signoff, so deploy summaries remain
  available for diagnosis.
