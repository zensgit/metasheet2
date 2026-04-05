# Multitable Comment Edit/Delete Development

## Scope
- Added authored comment edit flow in multitable comment threads.
- Added safe delete flow for authored leaf comments.
- Extended comment realtime handling to react to `comment:updated` and `comment:deleted`.
- Extended comment OpenAPI contract with update/delete endpoints.

## Backend
- Extended comment service contract in `packages/core-backend/src/di/identifiers.ts`.
- Added `updateComment()` and `deleteComment()` to `packages/core-backend/src/services/CommentService.ts`.
- Enforced safe semantics:
  - only the author can edit or delete a comment
  - resolved comments cannot be edited
  - comments with replies cannot be deleted
  - delete is hard delete and also clears `meta_comment_reads`
- Added route handlers in `packages/core-backend/src/routes/comments.ts`:
  - `PATCH /api/comments/:commentId`
  - `DELETE /api/comments/:commentId`
- Added `comment:updated`, `comment:deleted`, and widened `comment:activity` broadcasting for inbox/runtime refresh.

## Frontend
- Added client methods in `apps/web/src/multitable/api/client.ts`:
  - `updateComment()`
  - `deleteComment()`
- Extended `useMultitableComments()` with:
  - `updatingIds`
  - `deletingIds`
  - `updateComment()`
  - `deleteComment()`
  - local `applyUpdatedComment()` / `applyDeletedComment()`
- Upgraded `MetaCommentsDrawer.vue` to support:
  - edit/delete affordances for authored comments
  - edit banner
  - seeded mention chips for edit mode
  - disabled states for updating/deleting
- Extended `MetaCommentComposer.vue` with:
  - `initialMentions`
  - `submitLabel`
  - seeded mention state for edit mode
- Wired `MultitableWorkbench.vue` to:
  - load current user id without blocking workbench bootstrap
  - enter/exit edit mode
  - preserve field-scoped comment context while editing
  - submit update vs create based on active comment mode
  - delete comments and clear local edit/reply/highlight state
  - forward `comment:updated` / `comment:deleted` realtime events to summary/presence refresh logic

## Contracts
- Extended `packages/openapi/src/paths/comments.yml` with:
  - `PATCH /api/comments/{commentId}`
  - `DELETE /api/comments/{commentId}`
- Regenerated:
  - `packages/openapi/dist/combined.openapi.yml`
  - `packages/openapi/dist/openapi.json`
  - `packages/openapi/dist/openapi.yaml`

## Tests Added Or Updated
- Frontend:
  - `apps/web/tests/multitable-client.spec.ts`
  - `apps/web/tests/multitable-comments.spec.ts`
  - `apps/web/tests/multitable-comments-drawer.spec.ts`
  - `apps/web/tests/multitable-comment-realtime.spec.ts`
  - workbench mock compatibility:
    - `apps/web/tests/multitable-workbench-view.spec.ts`
    - `apps/web/tests/multitable-workbench-manager-flow.spec.ts`
    - `apps/web/tests/multitable-workbench-import-flow.spec.ts`
- Backend:
  - `packages/core-backend/tests/integration/comments.api.test.ts`

## Notes
- The clean delivery worktree needed `pnpm install --ignore-scripts` before local verification.
- Plugin `node_modules` symlink churn from that install is intentionally excluded from the slice.
