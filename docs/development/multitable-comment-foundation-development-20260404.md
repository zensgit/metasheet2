# Multitable Comment Foundation Development

Date: 2026-04-04
Branch: `codex/multitable-comment-collab-main-20260404`

## Scope

Backend-first multitable comment collaboration foundation ported from the active `metasheet2-multitable-next` worktree onto latest `main`.

Included:

- Comment mention summary endpoint and service aggregation
- Comment presence summary enrichment
- Comment room helpers and sheet/record WebSocket room delivery
- Integration coverage for comments API and room-scoped delivery
- OpenAPI source and generated contract refresh

## Changed Files

- `packages/core-backend/src/routes/comments.ts`
- `packages/core-backend/src/services/CollabService.ts`
- `packages/core-backend/src/services/CommentService.ts`
- `packages/core-backend/src/services/commentRooms.ts`
- `packages/core-backend/tests/integration/comments.api.test.ts`
- `packages/core-backend/tests/integration/rooms.basic.test.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/comments.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`

## Notes

- This slice intentionally excludes the larger frontend comment affordance / mention popover / presence badge work still in `metasheet2-multitable-next`.
- Plugin `node_modules` link noise exists in the worktree after `pnpm install`, but it is not part of this slice.
