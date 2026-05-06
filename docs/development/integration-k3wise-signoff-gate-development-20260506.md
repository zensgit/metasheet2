# K3 WISE Signoff Gate Development

Date: 2026-05-06

## Context

The K3 WISE postdeploy smoke already writes diagnostic evidence and the summary
renderer can display `Internal trial signoff: PASS` or `BLOCKED`. The remaining
gap was a machine-readable gate that can be run against a downloaded or
workflow-produced `integration-k3wise-postdeploy-smoke.json` file.

The gate is deliberately separate from the renderer:

- `integration-k3wise-postdeploy-summary.mjs` stays presentation-oriented.
- `integration-k3wise-signoff-gate.mjs` exits non-zero when evidence is not
  sufficient for internal-trial signoff.

## Implementation

Added `scripts/ops/integration-k3wise-signoff-gate.mjs`.

The script accepts:

```bash
node scripts/ops/integration-k3wise-signoff-gate.mjs --input <evidence.json>
```

It requires all of the following:

- `ok === true`
- `authenticated === true`
- `signoff.internalTrial === "pass"`
- `summary.fail === 0`
- required checks are present and passing:
  - `auth-me`
  - `integration-route-contract`
  - `integration-list-external-systems`
  - `integration-list-pipelines`
  - `integration-list-runs`
  - `integration-list-dead-letters`
  - `staging-descriptor-contract`

The script prints a small JSON result and returns:

- exit `0` for `PASS`
- exit `1` for `BLOCKED` or invalid/missing evidence

The manual `K3 WISE Postdeploy Smoke` workflow now invokes this gate in the
final step when `require_auth=true`. Public diagnostic runs with
`require_auth=false` still skip the signoff gate and remain useful for basic
deployment smoke.

## Scope Control

This slice does not change:

- the K3 WISE setup UI
- live PoC preflight behavior
- live PoC evidence fixtures
- `package.json`
- customer GATE requirements

That keeps it independent from the currently open K3 WISE PRs.
