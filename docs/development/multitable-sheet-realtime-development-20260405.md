# Multitable Sheet Realtime Development

Date: 2026-04-05
Branch: `codex/multitable-next-slice-20260405`

## Scope

This slice adds minimal multitable sheet realtime invalidation on top of the existing backend `spreadsheet.cell.updated` room model.

Goals:

- publish sheet-scoped realtime events from multitable write routes
- subscribe to `sheet:op` in the multitable workbench
- reload the current page for remote edits
- refresh selected-record context when the incoming event targets the currently opened record
- ignore self-authored events

## Backend changes

Updated [packages/core-backend/src/routes/univer-meta.ts](/private/tmp/metasheet2-next-slice-20260405/packages/core-backend/src/routes/univer-meta.ts):

- added `publishMultitableSheetRealtime()` helper backed by `eventBus.publish('spreadsheet.cell.updated', ...)`
- added `getRequestActorId()` to propagate user identity for self-echo suppression
- published realtime events from:
  - `POST /api/multitable/views/:viewId/submit`
  - `POST /api/multitable/records`
  - `DELETE /api/multitable/records/:recordId`
  - `POST /api/multitable/patch`
  - `DELETE /api/multitable/attachments/:attachmentId` when the attachment mutation changes a record payload

Event kinds introduced for this slice:

- `record-created`
- `record-updated`
- `record-deleted`
- `attachment-updated`

## Frontend changes

Added [apps/web/src/multitable/composables/useMultitableSheetRealtime.ts](/private/tmp/metasheet2-next-slice-20260405/apps/web/src/multitable/composables/useMultitableSheetRealtime.ts).

The composable:

- opens the existing collab socket using the authenticated user id
- joins and leaves `sheet:{sheetId}`
- listens for `sheet:op`
- ignores events authored by the current user
- coalesces refreshes to avoid duplicate reload storms
- reloads the current sheet page
- optionally reloads selected-record context when the event targets the opened record

Updated [apps/web/src/multitable/views/MultitableWorkbench.vue](/private/tmp/metasheet2-next-slice-20260405/apps/web/src/multitable/views/MultitableWorkbench.vue):

- wires in `useMultitableSheetRealtime()`
- refreshes form context for standalone form views
- refreshes deep-linked selected-record state when a remote update targets the selected record

## Test coverage

Added [packages/core-backend/tests/integration/multitable-sheet-realtime.api.test.ts](/private/tmp/metasheet2-next-slice-20260405/packages/core-backend/tests/integration/multitable-sheet-realtime.api.test.ts):

- record create publishes realtime
- form submit update publishes realtime
- bulk patch publishes aggregate realtime

Added [apps/web/tests/multitable-sheet-realtime.spec.ts](/private/tmp/metasheet2-next-slice-20260405/apps/web/tests/multitable-sheet-realtime.spec.ts):

- joins and leaves sheet rooms
- reloads page on remote `sheet:op`
- refreshes selected record only when targeted
- ignores self-authored events

Updated supporting frontend tests:

- [apps/web/tests/multitable-workbench-view.spec.ts](/private/tmp/metasheet2-next-slice-20260405/apps/web/tests/multitable-workbench-view.spec.ts)
- [apps/web/tests/multitable-workbench-import-flow.spec.ts](/private/tmp/metasheet2-next-slice-20260405/apps/web/tests/multitable-workbench-import-flow.spec.ts)
- [apps/web/tests/multitable-workbench-manager-flow.spec.ts](/private/tmp/metasheet2-next-slice-20260405/apps/web/tests/multitable-workbench-manager-flow.spec.ts)

Updated backend attachment regression:

- [packages/core-backend/tests/integration/multitable-attachments.api.test.ts](/private/tmp/metasheet2-next-slice-20260405/packages/core-backend/tests/integration/multitable-attachments.api.test.ts)

## Notes

- This slice intentionally does not implement cell-presence, cursor sync, or incremental record patch merge.
- The worktree contains plugin `node_modules` link noise from `pnpm install --ignore-scripts`; those files are not part of the slice and must stay unstaged.
