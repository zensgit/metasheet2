# Kanban Frontend UI (MVP)

This guide outlines the Vue 3 Kanban view implementation for MVP, integrating with `/api/kanban/:viewId` and dynamic plugin views.

## Components
- `KanbanView.vue` — top-level view; fetches config/state; wires drag-and-drop.
- `KanbanColumn.vue` — renders a column with header and list of cards.
- `KanbanCard.vue` — individual card; inline edit (optional for MVP).

## State & Data Flow
- Fetch on mount: GET `/api/kanban/:viewId` → `{ columns, state }`.
- Local drag updates → optimistic UI → POST `/api/kanban/:viewId/state`.
- Re-fetch or apply diff on success; debounce POST to reduce load.

## Drag & Drop
- Library: `vue-draggable-plus` or `vuedraggable`.
- Emit `change`/`end` → update local state, persist via POST.
- Accept cross-column moves (future: emit `cardMoved`).

## WebSocket (optional MVP)
- Subscribe `kanban:stateUpdated` to reflect updates from other clients.
- Fallback polling if WS unavailable.

## UX Details
- Empty-states and skeleton loading.
- Error banner with Retry; use `VITE_API_URL`.
- Responsive layout; dark mode via CSS variables.

## Performance
- Virtual list for long columns (future).
- Lazy-load components; keep computed/refs minimal.
- Avoid excessive reactivity on deep JSON trees.

## Testing
- Snapshot: empty view, unknown component, mixed active/failed plugins.
- Interaction: drag → POST → refresh → state persists.


## Auth & Caching
- Auth: Kanban endpoints always require a JWT — `/api/kanban` is behind the global session gate and is not in its exception list (`packages/core-backend/src/auth/api-path-policy.ts`). `KANBAN_AUTH_REQUIRED` is parsed into config but no route consumes it, so setting it changes nothing. The `x-user-id` header (`packages/core-backend/src/routes/kanban.ts:23-33`) is a dead fallback that never actually activates. For local dev, get a token from `GET /api/auth/dev-token` (non-production only, `packages/core-backend/src/routes/auth.ts:63`).
- ETag caching: store `ETag` from GET response and send via `If-None-Match` on subsequent GETs to reduce bandwidth and latency.
