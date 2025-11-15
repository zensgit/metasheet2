# Release v2.1.3 (Draft)

## Highlights
- Backend Kanban hardening: strict auth gate (`KANBAN_AUTH_REQUIRED`), zod validation, ETag/304.
- Frontend Kanban UX: Authorization/x-user-id headers, ETag caching (`If-None-Match`), 400ms debounced POST.
- Docs unification: Kanban API spec and UI guide; README notes.

## Changes
### Backend / Plugin
- Enforce JWT when `KANBAN_AUTH_REQUIRED=true`; dev/test fallback via `x-user-id`.
- `GET /api/kanban/:viewId`: returns `ETag`; 304 on cache hit.
- `POST /api/kanban/:viewId/state`: zod schema validation; 400 on invalid payload, 413 on oversized body; broadcasts `kanban:stateUpdated`.

### Frontend
- KanbanView adds ETag caching, auth headers, and 400ms debounced state save with small banners.
- New `useAuth` composable for building headers.
- Tests: `useAuth` header behavior, debounce coalescing.

### Docs
- `docs/api/kanban.md` consolidated.
- `apps/web/docs/KANBAN_UI.md` and `README.md` updated with strict auth + ETag.

## Verification
- CI: lockfile synced on affected branches; admin merged despite non-required check flakiness.
- Manual: `pnpm -F @metasheet/core-backend dev:core` + `pnpm -F @metasheet/web dev`; verify GET with `If-None-Match`, POST debounce, and auth headers.

## Rollback
- Changes are additive and guarded by flag; disable `KANBAN_AUTH_REQUIRED` to relax auth.

## Links
- PR #122, PR #127
