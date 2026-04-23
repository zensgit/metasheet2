# Legacy Cells Expected Version Frontend - Test And Verification

Date: 2026-04-23

## Result

PASS

## Delivered

- `GridView.vue` now sends `expectedVersion` for changed legacy spreadsheet cells when the frontend has a known server version.
- `SpreadsheetDetailView.vue` now preloads selected-sheet cell versions and sends `expectedVersion` from the manual cell update form.
- Shared pure helper added for version-map creation, payload enrichment, response version merging, and conflict message formatting.
- Conflict responses preserve local edits and tell the user to refresh/retry instead of snapshotting stale state.

## Verified Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/spreadsheet-cell-versioning.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/spreadsheets-cell-version.test.ts --reporter=dot
git diff --check
```

## Verified Results

- Frontend focused unit test: 1 file / 4 tests passed.
- Frontend type check: passed.
- Backend PR #1042 contract regression: 1 file / 7 tests passed.
- Whitespace check: passed.

## Staging Manual Check

Use two browser sessions against one legacy spreadsheet:

1. Session A and B load the same sheet.
2. Session A updates `A1` and saves.
3. Session B updates stale `A1` and saves without refresh.
4. Expected: Session B gets `VERSION_CONFLICT`; local stale edit is not marked synced.
5. Refresh Session B and save again.
6. Expected: save succeeds with the latest returned cell version.
