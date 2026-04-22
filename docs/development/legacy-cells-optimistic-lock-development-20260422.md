# Legacy Cells API — Optimistic Lock

- **Branch**: `codex/legacy-cells-expected-version-20260422`
- **Date**: 2026-04-22
- **Closes**: #526

## Context

The legacy `PUT /api/spreadsheets/:id/sheets/:sheetId/cells` endpoint
has silently done last-write-wins since Pilot R1. Despite the
multitable stack adopting `expectedVersion` throughout, this older
cells endpoint remained LWW and is still reachable via App.vue's
navbar (`/grid` → `GridView.vue`) and `/spreadsheets/:id` →
`SpreadsheetDetailView.vue`.

The enabling migration already landed in March:

- `zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions.ts`
  added `cells.version integer NOT NULL DEFAULT 1`.

The PUT handler never read or wrote that column, so every concurrent
edit silently overwrote the other.

## Scope

Backend-only defense in depth. Frontend retrofit (GridView /
SpreadsheetDetailView sending `expectedVersion` on save) is a separate
follow-up — the server now accepts and enforces the counter, so future
client changes are additive.

Not changed:
- `cell_versions` history table write — `version_number` is now the
  PREVIOUS version (instead of hard-coded `1`), which is an incidental
  improvement but the history table's design is untouched.
- Legacy LWW behavior when `expectedVersion` is omitted, to avoid
  breaking existing callers that never sent one.

## Behavior

Request schema additions (per-cell):

```ts
{
  row: number,
  col: number,
  value?: unknown,
  formula?: string,
  dataType?: string | null,
  expectedVersion?: number  // NEW, optional
}
```

Server rules:

| Scenario | Result |
|---|---|
| `expectedVersion` absent, cell exists | Update + bump version. LWW back-compat. |
| `expectedVersion` absent, cell missing | Insert at version 1. |
| `expectedVersion` matches stored row | Update + bump version. |
| `expectedVersion` mismatches stored row | **409 VERSION_CONFLICT**, transaction rolls back. |
| `expectedVersion` provided, cell missing | **409 VERSION_CONFLICT** (`serverVersion: 0`). |

409 payload:

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Cell version conflict for <sheetId> row=<r> col=<c>: expected <e>, server has <s>",
    "sheetId": "...",
    "row": 0,
    "col": 0,
    "serverVersion": 5,
    "expectedVersion": 2
  }
}
```

## Atomicity

The existing transaction wraps the whole batch. The new
`CellVersionConflictError` is thrown inside the transaction and caught
outside; the `db.transaction().execute()` Kysely call rolls back every
cell that was already updated in the same batch when any cell in the
batch conflicts. See `test: 409 on a batch aborts ALL cells`.

## Changes

- `packages/core-backend/src/routes/spreadsheets.ts`
  - New `CellVersionConflictError` class (file-local).
  - Schema: optional `expectedVersion: number` per cell.
  - Update path: read current `version`, validate against
    `expectedVersion`, throw on mismatch, bump `version: currentVersion + 1`
    on write.
  - Insert path: reject with 409 when `expectedVersion` is provided
    (client thought the row existed).
  - Outer handler catches `CellVersionConflictError` and returns a 409
    payload carrying both `expectedVersion` and `serverVersion` so the
    client can reconcile.
  - `cell_versions` history row now records the PREVIOUS version
    (`currentVersion`) instead of the prior hard-coded `1`.
- `packages/core-backend/src/db/types.ts`
  - `CellsTable.version` added as `Generated<number>` to match the DB
    default. Enables the Kysely `.set({ version: nextVersion })` call
    to type-check and forces the TS tooling to recognize the column
    going forward.

## Tests

`packages/core-backend/tests/unit/spreadsheets-cell-version.test.ts` (6 cases):

- Accepts write when `expectedVersion` matches + bumps version
- 409 when `expectedVersion` does not match (rolls back)
- 409 in a batch rolls back the batch atomically
- Omitted `expectedVersion` = LWW back-compat (version still bumps)
- 409 when `expectedVersion` provided for a non-existent cell
- Insert path: new cell creates version=1 without `expectedVersion`

Uses a pure-memory Kysely stand-in keyed off the actual handler call
pattern (`selectFrom → where(eb.and([...]))`, `updateTable → set →
where → returningAll`, `insertInto → values → returningAll`). No DB
needed. Run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/spreadsheets-cell-version.test.ts
```

## Risk

- **Older clients unaffected** — they do not send `expectedVersion`,
  the handler's code path for that case is unchanged except for
  `version` incrementing (previously skipped). Bumping `version` on
  every write is safe: it only matters to clients that opt into the
  check.
- **New 409 path** — only returned when the client opted in and
  mismatched. A bug in the client's `expectedVersion` tracking will
  surface as a 409, not a silent overwrite. That is the desired
  outcome.
- **History row change** — `cell_versions.version_number` now records
  the pre-write version. No existing reader of that table depends on
  the old hard-coded `1` value (it was obviously a bug), but if a
  downstream tool assumed "1 means change event happened" rather than
  "1 means the starting version", its count will shift. Worth a
  follow-up audit but not a blocker.

## Follow-up (not in this PR)

- Frontend: `GridView.vue` + `SpreadsheetDetailView.vue` should track
  per-cell `version` after every read (`GET /cells` already returns
  `version`) and send `expectedVersion` on PUT. Separate small PR.
- Consider deprecating the legacy cells endpoint altogether once the
  last two views migrate to the multitable stack. Out of scope.
