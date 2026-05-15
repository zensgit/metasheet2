# K3 WISE On-Site Evidence Template Development - 2026-05-15

## Purpose

Close the second Stage D live PoC gap: a C4-C9 evidence worksheet that an
operator can copy outside Git and fill during a customer K3 WISE live run.

`evidence-sample.json` remains the complete PASS fixture. The new template is
intentionally incomplete: before the customer run it compiles to `PARTIAL`
with zero issues, then reaches `PASS` only after the live run ids, K3 response
ids, staging writeback rows, replay proof, rollback proof, and customer
confirmation are filled.

## Changes

- Added
  `scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json`.
- Added `sampleOnsiteEvidenceTemplate()` and
  `--print-onsite-evidence-template` to
  `scripts/ops/integration-k3wise-live-poc-evidence.mjs`.
- Extended fixture contract tests so the checked-in worksheet:
  - matches the exported template helper,
  - compiles to `PARTIAL` before completion,
  - has zero issues before completion,
  - reaches `PASS` when completed with the canonical sample evidence values.
- Extended evidence CLI tests so the new print flag emits valid JSON that
  compiles to `PARTIAL` and contains no token-like strings.
- Updated the live GATE execution runbook to point C10 at the worksheet and
  remove the on-site evidence template from the remaining-gap list.
- Updated the on-prem package verifier so future packages must include the
  worksheet and its safety strings.

## Template Contract

The worksheet keeps the evidence compiler's existing top-level shape:

- `gate`
- `connections.plm`
- `connections.k3Wise`
- `connections.sqlServer`
- `materialDryRun`
- `materialSaveOnly`
- `erpFeedback`
- `deadLetterReplay`
- `bomPoC`
- `rollback`
- `customerConfirmation`

It starts all phase statuses at `todo`. This avoids false PASS and avoids hard
FAIL while the customer is still executing the live PoC steps.

## Deployment Impact

No runtime service or DB behavior changed. The deploy-facing effect is package
content verification only: once this lands, future on-prem packages must
include the C4-C9 evidence worksheet.

## Claude Code

Claude Code is not required for this slice. The implementation is repo-local
and deterministic. Claude Code should be reserved for bridge-machine work that
requires actual Windows/K3 connectivity or SQL executor integration.
