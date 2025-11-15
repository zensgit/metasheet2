# Kanban Backend API (MVP)

This document specifies the minimal REST API and runtime behavior for the Kanban view. Scope targets MVP with view-based persistence using `views` + `view_states` tables.

## Endpoints
- GET `/api/kanban/:viewId`
  - Returns board config and user state: `{ columns, cards?, state, version?, etag }`.
  - Caching: responds with `ETag`; supports `If-None-Match` → `304`.
  - Auth: Bearer JWT (dev/test may whitelist).
- POST `/api/kanban/:viewId/state`
  - Body: `{ state: JsonObject, version?: number }`
  - Persists user drag/sort filters to `view_states` (upsert by `(view_id,user_id)`).
  - Returns `204` on success; `409` reserved for future optimistic locking.

Notes
- MVP stores column definitions and basic card mapping in `views.config`.
- Legacy routes temporarily available: `GET /api/kanban/:spreadsheetId`, `POST /api/kanban/:spreadsheetId/move`, `PUT /api/kanban/:spreadsheetId/card/:cardId`. These will be deprecated in favor of `:viewId` + `state` endpoints.
- Future CRUD endpoints (planned): `POST /cards`, `PATCH /cards/:id` for move/update.

## Database (Kysely)
- Tables from initial migration:
  - `views(id uuid pk, type text, name text, config jsonb, created_at, updated_at)`
  - `view_states(id uuid pk, view_id uuid fk, user_id uuid, state jsonb, updated_at)` with unique `(view_id,user_id)`
- Lookups use composite index and GIN for JSONB.

Example (Kysely)
```ts
const view = await db.selectFrom('views')
  .selectAll().where('id', '=', viewId).executeTakeFirst()
const state = await db.selectFrom('view_states')
  .selectAll().where('view_id', '=', viewId).where('user_id', '=', userId)
  .executeTakeFirst()
```

## Real-time (WebSocket)
- Channel: Socket.IO
- Events
  - `kanban:stateUpdated` → `{ viewId, userId, state, updatedAt }`
  - `kanban:cardMoved` (future) → `{ viewId, cardId, from, to }`
- Permissions: `websocket.broadcast` / `websocket.broadcastTo` when emitting from backend.

## Auth, Rate Limit, Cache
- Auth: JWT middleware on `/api/*` with test whitelist.
- Rate limit: per `userId+viewId` (e.g., 60/min) on POST.
- Cache: `GET` emits `ETag`; use strong etags based on hash(view.config + user.state).

## Transactions & Errors
- All writes in a single transaction; upsert `view_states` with `on conflict (view_id,user_id)`.
- Common responses: `200/204`, `304`, `400`, `401`, `404`, `409` (future), `500`.

## Performance Goals
- P99 < 100ms under Observability Strict workflow.
- DB pool: min 0, max 10. Health at `/health` includes `{ db.connected, pool }`.

## References
- docs/frontend/plugin-views-contract.md
- apps/web/docs/KANBAN_UI.md

## Validation (Manual)
- GET: `curl -i -s $API/api/kanban/board1 | jq`
- ETag: `ETAG=\$(curl -sI $API/api/kanban/board1 | awk -F': ' '/^ETag/{print $2}') && curl -i -H "If-None-Match: $ETAG" $API/api/kanban/board1`
- POST state: `curl -s -X POST $API/api/kanban/board1/state -H 'Content-Type: application/json' -H 'x-user-id: dev' -d '{"state":{"columns":[{"id":"todo","cards":["1"]}]}}' -i`

Notes: set `API=${VITE_API_URL:-http://localhost:8900}`
