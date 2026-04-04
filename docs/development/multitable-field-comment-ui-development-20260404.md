# Multitable Field Comment UI Development

Date: 2026-04-04
Branch: `codex/multitable-field-comment-ui-main-20260404`

## Scope

This slice implements field-scoped comment affordances across multitable views and closes the field-comment interaction gaps left after the earlier comment foundation and comment UI slices.

## Changes

### Shared comment affordance primitives

- Added `comment-affordance.ts` to normalize unresolved count, mention count, and field-scoped affordance state.
- Added `MetaCommentAffordance.vue` for compact field-level comment badges.
- Added `MetaCommentActionChip.vue` for record-level comment chips used in card and timeline surfaces.

### Comments drawer and workbench wiring

- Extended `MetaCommentsDrawer.vue` to support:
  - `targetFieldId`
  - `scopeLabel`
  - `replyToCommentId`
  - local field filtering
  - reply intent and reply cancellation
- Updated `MultitableWorkbench.vue` to:
  - track selected field comment scope
  - track reply target comment id
  - load comment presence for visible records
  - route record-level and field-level comment open events from all supported views
  - submit comments with `targetFieldId` and `parentId`
  - preserve server-provided field-scoped `commentsScope` on deep-linked record comment submissions

### View parity

- Added record-level and field-level comment entry points to:
  - `MetaGridTable.vue`
  - `MetaFormView.vue`
  - `MetaRecordDrawer.vue`
  - `MetaGalleryView.vue`
  - `MetaKanbanView.vue`
  - `MetaCalendarView.vue`
  - `MetaTimelineView.vue`
- All of the above now consume the shared comment affordance helpers instead of duplicating unresolved-count UI logic.

## Correctness fixes found during implementation

- Fixed a setup-time TDZ bug in `MultitableWorkbench.vue` by moving the comment presence watcher below the `deepLinkedRecord` declaration. The new field-comment tests surfaced this as a real runtime initialization defect.
- Fixed deep-linked field-scoped comment submission so that field scope is preserved even when the drawer is opened from server-provided `commentsScope`.

## Tests added or updated

- Added `apps/web/tests/multitable-comment-affordance.spec.ts`
- Added `apps/web/tests/multitable-grid-field-comment.spec.ts`
- Updated `apps/web/tests/multitable-workbench-view.spec.ts`

