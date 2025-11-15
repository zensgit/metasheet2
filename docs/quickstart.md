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
- Auth: by default, Kanban endpoints accept dev tokens or `x-user-id`. Set `KANBAN_AUTH_REQUIRED=true` to enforce JWT.
- WebSocket: `WS_REDIS_ENABLED=true` only toggles visibility in `/health` for now (no Redis wiring yet).
```

## Verify
- Open the web app, navigate to a route with `:viewId` (default `board1`).
- Drag a card, refresh, state persists.

## Troubleshooting
- `/api/plugins` 404: Ensure backend uses `dev:core` (MetaSheetServer), not a simple demo server.
- Kanban 404: Run `db:init:views` to create the default `board1` view.
- CI lockfile errors: lockfile is strict in CI; update `pnpm-lock.yaml` via a small PR when adding packages.
