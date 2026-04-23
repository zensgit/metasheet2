# Legacy Cells UI Version Wiring Tests Verification - 2026-04-23

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/spreadsheet-detail-cell-version-wiring.spec.ts \
  tests/grid-view-cell-version-wiring.spec.ts \
  --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       5 passed (5)
```

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/spreadsheet-cell-versioning.spec.ts \
  --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result:

```text
EXIT 0
```

```bash
git diff --check
```

Result:

```text
EXIT 0
```

## Verified Behaviors

- `SpreadsheetDetailView` sends `expectedVersion` from loaded cell metadata.
- `SpreadsheetDetailView` displays a 409 conflict and does not display success copy.
- `SpreadsheetDetailView` does not send a stale version after switching sheets before the new sheet load finishes.
- `GridView` sends `expectedVersion` from loaded cell metadata when saving through the formula input.
- `GridView` displays conflict copy and alert on 409, without marking the save as successful.

## Residual Risk

- These are frontend unit/component tests with mocked API responses; the live API conflict path is covered separately by the PR #1096 smoke script.
- Browser-level interaction across the deployed UI remains an optional staging click check, not a blocker for this test-only follow-up.
