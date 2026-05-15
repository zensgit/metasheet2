# K3 WISE GATE Intake Template Development - 2026-05-15

## Purpose

Close the first remaining Stage D gap in
`docs/operations/integration-k3wise-live-gate-execution-package.md`: a
customer-facing GATE intake template that can be sent before the customer
returns live K3 WISE answers.

The existing `gate-sample.json` remains the engineer-facing sample that tracks
`integration-k3wise-live-poc-preflight.mjs --print-sample`. This change adds a
separate operator/customer template with inline A.1-A.6 guidance while keeping
the same accepted JSON shape.

## Changes

- Added
  `scripts/ops/fixtures/integration-k3wise/gate-intake-template.json`.
- Updated fixture contract tests to prove the new template is accepted by the
  live preflight packet builder.
- Updated
  `docs/operations/integration-k3wise-live-gate-execution-package.md` so the
  runbook points operators to the template and marks the previous
  customer-facing intake gap as closed.
- Updated
  `scripts/ops/fixtures/integration-k3wise/README.md` to distinguish
  engineer-facing samples from customer-facing intake.
- Updated `scripts/ops/multitable-onprem-package-verify.sh` so future
  on-prem packages must include the template and must keep its core safety
  strings.

## Template Contract

The checked-in template:

- Uses only safe example non-secret values and `<fill-outside-git>` credential
  placeholders.
- Defaults `k3Wise.autoSubmit=false` and `k3Wise.autoAudit=false`.
- Defaults the advanced SQL Server channel to disabled.
- Carries A.1-A.6 section labels and review notes for implementation
  operators.
- Is accepted by `buildPacket()` as `status=preflight-ready`.
- Does not carry raw token/query secret values, JWT-like strings, or raw
  Postgres userinfo.

Filled customer copies must stay outside Git. The repo template is the shape
and review checklist, not the place to store customer credentials.

## Deployment Impact

No runtime service code changed. The only deploy-facing behavior is package
content verification: once this lands, the on-prem package verifier requires
`scripts/ops/fixtures/integration-k3wise/gate-intake-template.json` and checks
that the live GATE runbook documents it.

## Claude Code

Claude Code is not needed for this slice. It is useful later for bridge-machine
work that requires live Windows/K3 connectivity, but this change is
repo-local: fixture, runbook, package-verifier contract, and tests.
