# Multitable Comment Inbox Global Realtime Development

## Goal
- Close the remaining inbox realtime gap after sheet-scoped subscriptions.
- Ensure the multitable comment inbox refreshes when new activity appears on sheets that are not already represented in the currently loaded inbox page.

## Scope
- Add a global comment inbox room and activity event on the backend realtime layer.
- Simplify the inbox realtime frontend to subscribe to the global inbox room instead of the current page's sheet set.
- Add frontend and backend regression coverage for the new room and event flow.

## Implementation
- Added `buildCommentInboxRoom()` in `packages/core-backend/src/services/commentRooms.ts`.
- Added `join-comment-inbox` / `leave-comment-inbox` socket handlers in `packages/core-backend/src/services/CollabService.ts`.
- Extended `CommentService.createComment()` and `CommentService.resolveComment()` to broadcast `comment:activity` to the global inbox room in `packages/core-backend/src/services/CommentService.ts`.
- Simplified `apps/web/src/multitable/composables/useMultitableCommentInboxRealtime.ts`:
  - subscribe to the global inbox room
  - refresh on `comment:mention`
  - refresh on `comment:activity`
  - ignore self-authored `created` activity events
- Removed sheet-id wiring from `apps/web/src/views/MultitableCommentInboxView.vue`.
- Added frontend regression updates in `apps/web/tests/multitable-comment-inbox-realtime.spec.ts`.
- Added backend websocket coverage in:
  - `packages/core-backend/tests/integration/comments.api.test.ts`
  - `packages/core-backend/tests/integration/rooms.basic.test.ts`

## Notes
- This slice does not change inbox data semantics. It only fixes realtime discovery of inbox activity.
- The global inbox room intentionally trades precision for correctness: open inbox pages refresh on comment activity anywhere, and the existing inbox query remains the source of truth.
