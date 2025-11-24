# Ops Runbook — Sprint 2 Core

Scope: metasheet core backend (port `8900`), DB on `5435`.

## Quick Health
- Check server: `curl -s http://localhost:8900/health | jq`
- Metrics (Prom): `curl -s http://localhost:8900/metrics/prom | head`
- Plugins: `curl -s http://localhost:8900/api/plugins | jq`

## Processes
- Start (dev): `pnpm --filter @metasheet/core-backend dev`
- Port: `PORT=8900` in `packages/core-backend/.env`
- Stop: Ctrl+C; kill by port: `lsof -iTCP:8900 -sTCP:LISTEN -t | xargs kill -9`

## Database
- URL: `postgresql://metasheet:metasheet@localhost:5435/metasheet`
- Migrate: `pnpm --filter @metasheet/core-backend migrate`
- Reset: `pnpm --filter @metasheet/core-backend db:reset`

## Tokens
- Local admin JWT (example): `node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'ops',roles:['admin']},'dev-jwt-secret-local',{expiresIn:'1h'}))"`
- Staging: request short‑lived token via Issue #5; do not commit secrets.

## Common Issues
- Port busy: change `PORT` or free port as above.
- DB missing tables: run migrations; ensure port `5435`.
- Plugins empty: check manifests, or POST `/api/admin/plugins/reload-all` (admin JWT).

## Restart Cheatsheet
1. Stop server; ensure port freed.
2. `pnpm -r build` if code changed.
3. Start dev: `pnpm --filter @metasheet/core-backend dev`.
4. Verify `/health` returns status ok.

## Staging Validation
- One‑shot: `/tmp/execute-staging-validation.sh "$API_TOKEN" "$BASE_URL"`
- Or scripts: `pnpm staging:validate`, `pnpm staging:perf`, `pnpm staging:schema`.

