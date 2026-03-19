# Phase 15 Design Verification — Server-Side Search, Attachment Field & Timeline View

**Date**: 2026-03-19
**Branch**: `codex/multitable-fields-views-linkage-automation-20260312`

## Features Delivered

### Feature A: Server-Side Search
- Added `search` query param to `GET /api/multitable/view` OpenAPI contract
- API client `loadView()` accepts `search?: string`
- Composable `useMultitableGrid` adds `searchQuery` ref with 300ms debounce via `setSearchQuery()`
- Pagination resets to offset 0 when search changes
- `MetaGridTable.vue` client-side `filteredRows` now passes through `rows` directly (search handled server-side)
- `MultitableWorkbench.vue` wires toolbar search to `grid.setSearchQuery()`

### Feature B: Attachment Field Type
- `MetaFieldType` union includes `'attachment'`
- `MetaAttachment` interface: id, filename, mimeType, size, url, thumbnailUrl?, uploadedAt
- API client: `uploadAttachment()` (multipart FormData), `deleteAttachment()`
- `MetaCellRenderer.vue`: attachment chips with paperclip icon
- `MetaCellEditor.vue`: file input + drag-drop zone
- `MetaRecordDrawer.vue`: attachment chip display
- `MetaFormView.vue`: file input with existing attachment list
- `MetaFieldManager.vue`: attachment in field type dropdown with 📎 icon
- `MetaGridTable.vue`: attachment type in EDITABLE set

### Feature C: Timeline View
- New `MetaTimelineView.vue` (~190 LOC)
- Field picker: start/end date field selects
- Zoom: day/week/month with axis tick generation
- Bar positioning: percentage-based left/width from date range
- Unscheduled section for records without dates
- Keyboard accessible (tabindex, Enter to select)
- `MultitableWorkbench.vue`: timeline in view type switch
- `MetaViewManager.vue`: timeline in VIEW_TYPES with ─ icon

### Contract (Codex Backend Tasks)
- OpenAPI: search param, attachment endpoints (POST/GET/DELETE)
- `MultitableAttachment` schema in base.yml
- Codex task doc: `docs/development/codex-phase15-backend-task.md`

## Files Modified

| File | Change |
|------|--------|
| `packages/openapi/src/paths/multitable.yml` | search param + attachment endpoints |
| `packages/openapi/src/base.yml` | MultitableAttachment schema |
| `docs/development/codex-phase15-backend-task.md` | NEW — backend task spec |
| `apps/web/src/multitable/types.ts` | attachment type + MetaAttachment + TimelineConfig |
| `apps/web/src/multitable/api/client.ts` | search param + attachment methods |
| `apps/web/src/multitable/composables/useMultitableGrid.ts` | searchQuery + setSearchQuery |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | search wiring + timeline view |
| `apps/web/src/multitable/components/MetaGridTable.vue` | server-side search (removed client filter) |
| `apps/web/src/multitable/components/cells/MetaCellRenderer.vue` | attachment rendering |
| `apps/web/src/multitable/components/cells/MetaCellEditor.vue` | attachment file input |
| `apps/web/src/multitable/components/MetaRecordDrawer.vue` | attachment display |
| `apps/web/src/multitable/components/MetaFormView.vue` | attachment upload |
| `apps/web/src/multitable/components/MetaFieldManager.vue` | attachment field type |
| `apps/web/src/multitable/components/MetaViewManager.vue` | timeline type option |
| `apps/web/src/multitable/components/MetaTimelineView.vue` | NEW — timeline view |
| `apps/web/tests/multitable-phase15.spec.ts` | NEW — 30 tests |

## Test Results

- **Phase 15 tests**: 30 passed
- **All phase tests (phases 3-15)**: 222 passed across 13 files
- **All multitable tests**: 269 passed (4 pre-existing .vue import failures unrelated to this phase)

## Verification Checklist

- [x] OpenAPI contracts updated with search param and attachment endpoints
- [x] MultitableAttachment schema added to base.yml
- [x] Codex task document committed for backend team
- [x] Types updated (MetaFieldType, MetaAttachment, TimelineConfig)
- [x] API client extended (search, uploadAttachment, deleteAttachment)
- [x] Grid composable has debounced server-side search
- [x] Client-side search removed from MetaGridTable
- [x] Attachment rendering/editing in all relevant components
- [x] Timeline view with field picker, bar positioning, zoom
- [x] All 30 phase 15 tests pass
- [x] No regressions in existing tests
