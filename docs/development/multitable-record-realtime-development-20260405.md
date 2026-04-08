# Multitable Record Realtime Development

Date: 2026-04-05
Branch: `codex/multitable-record-realtime-20260405`

## Scope

This slice upgrades multitable sheet realtime from page-level invalidation to local record-aware merge behavior.

Goals:

- keep `record-created` on full page reload
- locally merge remote `record-updated` and `attachment-updated` events when they target the current page or selected record
- locally remove remote `record-deleted` records from the current page and selected-record state
- fall back to full reload when the change touches a structural field used by sort, filter, or group

## Backend changes

Updated [packages/core-backend/src/routes/univer-meta.ts](/private/tmp/metasheet2-record-realtime-20260405/packages/core-backend/src/routes/univer-meta.ts):

- extended `MultitableSheetRealtimePayload` with `fieldIds?: string[]`
- included `fieldIds` in realtime payloads for:
  - form submit update
  - create record
  - bulk patch
  - attachment delete

This lets the frontend distinguish:

- non-structural record updates that can be merged locally
- structural updates that must reload the current page

## Frontend changes

Updated [apps/web/src/multitable/composables/useMultitableGrid.ts](/private/tmp/metasheet2-record-realtime-20260405/apps/web/src/multitable/composables/useMultitableGrid.ts):

- added `mergeRemoteRecord()`
- added `removeRemoteRecord()`
- added whole-record summary replacement helpers for link and attachment maps

Updated [apps/web/src/multitable/composables/useMultitableSheetRealtime.ts](/private/tmp/metasheet2-record-realtime-20260405/apps/web/src/multitable/composables/useMultitableSheetRealtime.ts):

- normalized `fieldIds`
- added `visibleRecordIds` and `structuralFieldIds` inputs
- serializes event handling through an internal promise chain
- handles:
  - `record-created` => reload
  - `record-deleted` => local remove when relevant
  - `record-updated` / `attachment-updated` => merge when safe, reload when structural

Updated [apps/web/src/multitable/views/MultitableWorkbench.vue](/private/tmp/metasheet2-record-realtime-20260405/apps/web/src/multitable/views/MultitableWorkbench.vue):

- computes structural field ids from active sort/filter/group state
- computes visible record ids for targeted local merge decisions
- adds `mergeRemoteRecordContext()` to fetch current record context and merge it into grid / deep-linked state
- adds `removeLocalRealtimeRecord()` to remove deleted records from grid and selected-record UI state
- keeps form view on the existing `loadStandaloneForm()` path instead of downgrading to `getRecord()`

## Behavioral result

The workbench now does local realtime handling for the common non-structural case:

- current-page record edits update locally
- selected record drawer / deep-linked record updates locally
- deleted visible/selected records disappear locally

Full page reload is still used for:

- remote record creation
- changes that hit active sort/filter/group fields
- fallback when local merge cannot safely resolve the target record

## Test coverage

Updated frontend tests:

- [apps/web/tests/multitable-sheet-realtime.spec.ts](/private/tmp/metasheet2-record-realtime-20260405/apps/web/tests/multitable-sheet-realtime.spec.ts)
- [apps/web/tests/multitable-workbench-view.spec.ts](/private/tmp/metasheet2-record-realtime-20260405/apps/web/tests/multitable-workbench-view.spec.ts)

Updated backend tests:

- [packages/core-backend/tests/integration/multitable-sheet-realtime.api.test.ts](/private/tmp/metasheet2-record-realtime-20260405/packages/core-backend/tests/integration/multitable-sheet-realtime.api.test.ts)
- [packages/core-backend/tests/integration/multitable-attachments.api.test.ts](/private/tmp/metasheet2-record-realtime-20260405/packages/core-backend/tests/integration/multitable-attachments.api.test.ts)

Additional regression:

- [apps/web/tests/multitable-record-drawer.spec.ts](/private/tmp/metasheet2-record-realtime-20260405/apps/web/tests/multitable-record-drawer.spec.ts)

## Notes

- No contract regeneration was required because this slice only enriches websocket/event payloads.
- The worktree contains plugin `node_modules` link noise from `pnpm install --ignore-scripts`; those files are not part of the slice and must stay unstaged.
