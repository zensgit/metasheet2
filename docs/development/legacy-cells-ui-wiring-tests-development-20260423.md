# Legacy Cells UI Version Wiring Tests Development - 2026-04-23

## Context

PR #1042 added backend optimistic locking for the legacy spreadsheet cells PUT API.
PR #1092 wired the frontend helper and two legacy cell editors to send `expectedVersion`.
PR #1096 added a live/staging API conflict smoke test.

This follow-up closes the remaining test gap: view-level UI interactions must prove that the saved payload includes the server-loaded cell version and that a 409 conflict is not presented as a successful save.

## Scope

Added two focused frontend specs:

- `apps/web/tests/spreadsheet-detail-cell-version-wiring.spec.ts`
- `apps/web/tests/grid-view-cell-version-wiring.spec.ts`

No runtime code was changed.

## SpreadsheetDetailView Coverage

The new spec mounts `SpreadsheetDetailView` with mocked `apiFetch` and `vue-router`.

Covered behavior:

- Initial cell load records `version` from `/cells`.
- Updating A1 sends `{ row, col, value, expectedVersion }` to the legacy cells PUT endpoint.
- A backend `VERSION_CONFLICT` response renders the conflict copy and does not render the success copy.
- Switching sheets while the new sheet's cells are still loading does not reuse the previous sheet's cached `expectedVersion`.

The sheet-switch case is load-bearing because it protects the stale-cache failure mode where sheet A's version could accidentally be sent with sheet B's first write.

## GridView Coverage

The new spec mounts `GridView` with mocked `apiFetch` and local storage sheet selection.

Covered behavior:

- Loading a server-backed cell stores its version.
- Editing through the formula input and clicking `保存` sends `expectedVersion`.
- A backend `VERSION_CONFLICT` response shows conflict copy, triggers the conflict alert, and does not mark the grid as saved.

## Design Notes

- Tests use real component event flow instead of calling helper functions directly.
- API is mocked at the boundary so assertions stay focused on frontend contract shape.
- The tests intentionally assert the PUT request body rather than implementation internals.
- This is test-only; it does not alter the optimistic-locking behavior already shipped by PR #1092.
