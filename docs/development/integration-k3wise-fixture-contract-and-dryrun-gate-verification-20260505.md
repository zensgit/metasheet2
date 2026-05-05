# K3 WISE Fixture Contract And Dry-Run Gate Verification - 2026-05-05

## Worktree

`/private/tmp/ms2-k3wise-fixture-contract-20260505`

Branch:

`codex/k3wise-fixture-contract-20260505`

Baseline:

`origin/main` at `3bbfc0504`.

## Verification Plan

Run the focused evidence and fixture tests, then the full offline K3 WISE PoC gate:

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node --test scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs
pnpm run verify:integration-k3wise:poc
git diff --check
```

## Expected Coverage

- Evidence compiler rejects a passed `materialDryRun` without `runId`.
- Evidence compiler rejects passed `materialDryRun.rowsPreviewed` outside `1..3`.
- Numeric-string `rowsPreviewed` stays accepted for spreadsheet-export style input.
- Blocked/non-pass dry-run phases do not produce row-count proof failures.
- `gate-sample.json` and `evidence-sample.json` stay contract-equivalent to exported CLI samples.
- The fixture pair still compiles into a PASS evidence report.

## Results

All planned commands passed:

- `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`
  - 35/35 passed.
  - Added material dry-run proof coverage:
    - missing `runId` fails.
    - `rowsPreviewed` outside `1..3` fails.
    - numeric-string `rowsPreviewed` is accepted.
    - blocked/non-pass dry-run skips proof checks and remains `PARTIAL`.
- `node --test scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs`
  - 2/2 passed.
  - `gate-sample.json` and `evidence-sample.json` match their exported CLI sample contracts after stripping `_comment`.
- `pnpm run verify:integration-k3wise:poc`
  - preflight tests: 16/16 passed.
  - evidence tests: 35/35 passed.
  - fixture contract tests: 2/2 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `git diff --check`
  - passed.
