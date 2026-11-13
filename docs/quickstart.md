# New Contributors Quickstart

This quickstart gets you from zero to a working Kanban MVP in minutes.

## Prereqs
- Node 20+, pnpm 8+
- PostgreSQL 14+

## Setup
```bash
# 1) Install deps
pnpm install

# 2) Start backend (core server)
pnpm -F @metasheet/core-backend dev:core &
export API=${VITE_API_URL:-http://localhost:8900}

# 3) Initialize DB (migrations + default Kanban view)
export DATABASE_URL=postgres://user:pass@localhost:5432/metasheet
pnpm -F @metasheet/core-backend db:migrate
pnpm -F @metasheet/core-backend db:init:views

# 4) Smoke test API (health → plugins → Kanban GET/POST)
API=$API bash scripts/smoke-kanban.sh

# 5) Start frontend
export VITE_API_URL=$API
pnpm -F @metasheet/web dev

Notes
- Auth: Kanban endpoints always require a JWT — `/api/kanban` sits behind the global session gate and is not in its exception list (`packages/core-backend/src/auth/api-path-policy.ts`). The `KANBAN_AUTH_REQUIRED` env var is parsed into config but no route reads it, so it has no effect. For local dev, mint a token with `GET /api/auth/dev-token` (non-production only, `packages/core-backend/src/routes/auth.ts:63`) and send it as `Authorization: Bearer <token>`; the `x-user-id` header is only a dead fallback in `routes/kanban.ts` and is never actually used.
- WebSocket: `WS_REDIS_ENABLED=true` only toggles visibility in `/health` for now (no Redis wiring yet).
```

## Verify
- Open the web app, navigate to a route with `:viewId` (default `board1`).
- Drag a card, refresh, state persists.

## Troubleshooting
- `/api/plugins` 404: Ensure backend uses `dev:core` (MetaSheetServer), not a simple demo server.
- Kanban 404: Run `db:init:views` to create the default `board1` view.
- CI lockfile errors: lockfile is strict in CI; update `pnpm-lock.yaml` via a small PR when adding packages.
