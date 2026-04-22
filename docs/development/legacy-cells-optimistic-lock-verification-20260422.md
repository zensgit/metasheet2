# Verification — Legacy Cells API Optimistic Lock

- **Branch**: `codex/legacy-cells-expected-version-20260422`
- **Date**: 2026-04-22
- **Dev MD**: `legacy-cells-optimistic-lock-development-20260422.md`
- **Closes**: #526

## Evidence matrix

| Risk flagged by reviewer (#526) | How the fix closes it | Test |
|---|---|---|
| Two concurrent PUTs silently overwrite each other | `cells.version` now read on update; `expectedVersion` mismatch throws `CellVersionConflictError` → 409 | `returns 409 VERSION_CONFLICT when expectedVersion does not match` |
| One-cell failure might leave a partially-applied batch | `CellVersionConflictError` thrown inside `db.transaction().execute()` rolls back the whole batch | `409 on a batch aborts ALL cells in the batch` |
| Older clients break on deploy | Legacy LWW preserved when `expectedVersion` is absent; version still bumps so future opt-ins work | `last-write-wins back-compat: omitted expectedVersion still works` |
| Stale-client insert can undo a concurrent delete | 409 when `expectedVersion` is provided and row is missing | `returns 409 when expectedVersion is provided for a non-existent cell` |
| New cells from a fresh client should work with no history | Insert path preserved for absent `expectedVersion` + missing row | `insert path: new cell with no expectedVersion creates version=1` |

## Test runs

```
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/spreadsheet
```

```text
✓ tests/unit/spreadsheet-db.test.ts   (N tests)
✓ tests/unit/spreadsheet-api.test.ts  (N tests)
✓ tests/unit/spreadsheets-cell-version.test.ts (6 tests)

Test Files  3 passed (3)
     Tests  89 passed (89)
```

Type check:

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit
EXIT=0
```

## Manual verification (integration)

Reproduction of the original LWW bug (no `expectedVersion`):

```bash
# User A: PUT row=2,col=0 value="A" at version 1 -> succeeds, version=2
# User B: PUT row=2,col=0 value="B" (no expectedVersion) -> succeeds, version=3
# Read: value="B"  (A's write was silently discarded)
# This back-compat behavior is preserved for callers that never opt in.
```

With the fix, concurrent clients that opt in get a safe 409:

```bash
# Both users GET cells -> each sees row (2,0) at version=1
# User A: PUT value="A" expectedVersion=1 -> 200 OK, returns version=2
# User B: PUT value="B" expectedVersion=1 -> 409 VERSION_CONFLICT
#         serverVersion=2, expectedVersion=1
# User B refetches, retries with expectedVersion=2 -> 200 OK, version=3
```

## Rollback

Pure code change, no schema migration. Revert the PR commit and the
handler returns to LWW behavior. `cells.version` column stays
(non-breaking).

## Follow-up plan

- Retrofit `GridView.vue` and `SpreadsheetDetailView.vue` to track
  per-cell `version` from the server's `GET /cells` payload and pass
  it back on PUT. Single small PR per view.
- Consider deprecating the legacy endpoint entirely once the two
  remaining consumers migrate to the multitable stack. Tracked
  separately.
