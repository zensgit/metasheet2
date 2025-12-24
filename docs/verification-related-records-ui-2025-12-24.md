# Related Records UI Verification (2025-12-24)

## Scope
- Surface cross-sheet lookup/rollup updates in the Grid/Kanban POC UI.
- Provide a small detail panel with record previews and a one-click open action.
- Keep existing lookup/rollup compute chain unchanged.

## Changes
- Grid: add related updates panel (toggle, clear, open target sheet).
- Kanban: add related updates panel (toggle, clear, open target sheet).
- Add preview formatting for related record data.
- Style updates for the related updates panel.

## Validation
- `pnpm --filter @metasheet/web build`

## Notes
- The panel shows cross-sheet updates returned by `/api/univer-meta/patch` (`relatedRecords`).
- Same-sheet computed updates continue to apply immediately via `onRecords`.
- The open action uses `source=meta` and navigates in a new tab.
