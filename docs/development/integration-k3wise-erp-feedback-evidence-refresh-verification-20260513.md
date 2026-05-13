# K3 WISE ERP Feedback Evidence Refresh Verification - 2026-05-13

## Scope

Refresh of PR #1338 on top of current `main` to require ERP feedback writeback
evidence in the K3 WISE live PoC evidence compiler.

## Commands

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
pnpm run verify:integration-k3wise:poc
git diff --check origin/main..HEAD
```

## Expected Coverage

- complete sample evidence returns `PASS`
- missing `erpFeedback` returns `PARTIAL`
- passed feedback with no updated rows returns `FAIL`
- passed feedback missing required field coverage returns `FAIL`
- compact `rowsUpdated + fieldsUpdated` proof can return `PASS`
- mock PoC demo still exercises the SQL channel read/upsert contract from #1508

## Local Results

### Evidence Unit Suite

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

Result: passed.

- 41 tests passed
- 0 failed
- new ERP feedback cases passed:
  - missing `erpFeedback` returns `PARTIAL`
  - passed feedback with no updated rows returns `FAIL`
  - passed feedback missing required field coverage returns `FAIL`
  - compact `rowsUpdated + fieldsUpdated` proof can return `PASS`

### Mock PoC Demo

```bash
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Result: passed.

- K3 Save-only mock upsert wrote 2 records with 0 Submit and 0 Audit
- BOM Save-only mock upsert wrote 1 BOM record
- SQL channel read-only probe returned 1 row
- SQL channel middle-table upsert wrote 1 integration row
- SQL safety guard rejected direct core-table insert
- evidence compiler returned `PASS` with 0 issues

### Full K3 WISE PoC Gate

```bash
pnpm run verify:integration-k3wise:poc
```

Result: passed.

- preflight suite: 20/20 passed
- evidence suite: 41/41 passed
- SQL mock contract suite: 12/12 passed
- mock PoC demo: PASS

### Whitespace Check

```bash
git diff --cached --check
```

Result: passed, no whitespace errors.

## Notes

This verification is local and offline. It validates the evidence compiler,
fixtures, SQL mock channel contract, and mock PoC demo. It does not call a live
K3 WISE instance.
