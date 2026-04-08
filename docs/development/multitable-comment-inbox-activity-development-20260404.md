# Multitable Comment Inbox Activity Development

Date: 2026-04-04
Branch: `codex/multitable-comment-inbox-activity-main-20260404`

## Scope

Convert the multitable comment inbox from a mention-only list into a real activity inbox:

- include comments that mention the current user
- include unread comments from other collaborators even without a mention
- expose an explicit `mentioned` flag so the frontend can explain why an item appears

## Changes

### Backend

- Updated `CommentInboxItem` to include `mentioned`.
- Changed `CommentService.getInbox()` to return comments authored by other users when either:
  - the user is mentioned, or
  - the comment is still unread for that user
- Changed `CommentService.getUnreadCount()` to count all unread inbox items, not only unread mentions.

### Frontend

- Extended multitable inbox item types and client normalization with `mentioned`.
- Updated `MultitableCommentInboxView` copy to match the new inbox semantics.
- Added a `Mention` badge for inbox rows that are present because they mention the current user.

### Contract

- Updated OpenAPI `CommentInboxItem` to require `mentioned`.
- Updated `/api/comments/inbox` and `/api/comments/unread-count` descriptions to match the runtime behavior.

## Files

- `packages/core-backend/src/di/identifiers.ts`
- `packages/core-backend/src/services/CommentService.ts`
- `packages/core-backend/tests/integration/comments.api.test.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/views/MultitableCommentInboxView.vue`
- `apps/web/tests/multitable-client.spec.ts`
- `apps/web/tests/multitable-comment-inbox.spec.ts`
- `apps/web/tests/multitable-comment-inbox-view.spec.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/comments.yml`
- `packages/openapi/dist/*`

## Notes

- Plugin `node_modules` link churn came from `pnpm install --ignore-scripts` in the clean worktree. Those files are local noise and must not be staged with this slice.
