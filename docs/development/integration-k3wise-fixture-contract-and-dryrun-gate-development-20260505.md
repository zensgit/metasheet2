# K3 WISE Fixture Contract And Dry-Run Gate Development - 2026-05-05

## Scope

This slice keeps the customer-facing K3 WISE Live PoC handoff templates and evidence compiler aligned before customer GATE answers arrive.

It deliberately avoids the open K3 PR surfaces:

- #1305 K3 WISE setup UI files are untouched.
- #1316 preflight disabled-mode files are untouched.

## Changes

### 1. Fixture contract test

Added `scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs`.

The test validates that:

- `gate-sample.json`, after removing `_comment`, stays equivalent to `sampleGate()`.
- `evidence-sample.json`, after removing `_comment`, stays equivalent to `sampleEvidence()`.
- the gate fixture builds a Save-only preflight packet with three external systems and two pipelines.
- the evidence fixture compiles against that packet with `decision=PASS` and zero issues.
- placeholder credential values from the customer template do not leak into the generated preflight packet.

This catches a common drift class: a developer updates the CLI sample but forgets the copy-and-edit fixture, or vice versa.

### 2. Material dry-run evidence gate

`scripts/ops/integration-k3wise-live-poc-evidence.mjs` now validates `materialDryRun` when its status is `pass`:

- `runId` is required.
- `rowsPreviewed` must be an integer from `1..3`.

The rule mirrors the existing Save-only write row-count gate. A passed dry-run without proof is now a failed evidence package instead of a false green signoff.

If `materialDryRun.status` is not `pass`, the dry-run proof checks are skipped and the phase status continues to drive the overall decision.

### 3. CI entrypoint

`pnpm run verify:integration-k3wise:poc` now includes the fixture contract test between the preflight/evidence unit tests and the mock PoC demo.

## Files

- `package.json`
- `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/README.md`
- `scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs`
