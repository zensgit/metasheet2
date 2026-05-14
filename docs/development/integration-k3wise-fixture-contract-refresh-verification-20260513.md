# K3 WISE Fixture Contract Refresh Verification - 2026-05-13

## Worktree

`/private/tmp/ms2-k3wise-fixture-contract-refresh-20260513`

Branch:

`codex/k3wise-fixture-contract-refresh-20260513`

Baseline:

`origin/main` at `2c7c65d51`.

## Validation Plan

```bash
node --check scripts/ops/integration-k3wise-live-poc-evidence.mjs
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node --test scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs
pnpm run verify:integration-k3wise:poc
git diff --check origin/main..HEAD
```

## Coverage

- Fixture contract keeps customer-facing JSON templates equivalent to exported script samples.
- Passed material dry-run now requires `runId` and `rowsPreviewed` in the PoC sample range.
- Nested secret-like containers are rejected before reports are written.
- Optional SQL `skipped` can pass, but explicit SQL `fail` fails the evidence report.
- `verify:integration-k3wise:poc` keeps the full current chain and adds the fixture contract test.

## Results

All planned commands passed:

- `node --check scripts/ops/integration-k3wise-live-poc-evidence.mjs`
  - passed.
- `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`
  - 50/50 passed.
- `node --test scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs`
  - 2/2 passed.
  - During refresh this first caught real drift: `evidence-sample.json` had two ERP feedback rows while `sampleEvidence()` exported one. The exported sample was updated to match the copy-and-edit fixture.
- `pnpm run verify:integration-k3wise:poc`
  - preflight tests: 21/21 passed.
  - evidence tests: 50/50 passed.
  - fixture contract tests: 2/2 passed.
  - mock K3 WebAPI tests: 4/4 passed.
  - mock SQL executor tests: 12/12 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `git diff --check origin/main..HEAD`
  - passed.

## Not Covered

- Real K3 WISE connectivity.
- Real SQL Server connectivity.
- Customer live evidence collection; this is an offline evidence gate refresh.
