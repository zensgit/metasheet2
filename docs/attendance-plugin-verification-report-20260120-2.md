# Attendance Plugin Verification Report (2026-01-20, Extension)

## Environment
- Branch: `codex-plm-ui-db-autostart-20260120`
- Backend: `http://localhost:8900` (`RBAC_BYPASS=true`, `RBAC_TOKEN_TRUST=true`, `SKIP_PLUGINS=false`)
- Frontend: `http://localhost:8899`
- Database: `postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2`

## Commands Executed
```sh
pnpm --filter @metasheet/core-backend migrate
pnpm --filter @metasheet/core-backend test:integration:attendance
RBAC_BYPASS=true RBAC_TOKEN_TRUST=true SKIP_PLUGINS=false PORT=8900 pnpm --filter @metasheet/core-backend dev
VITE_API_URL=http://localhost:8900 pnpm dev
curl "http://localhost:8900/api/auth/dev-token?userId=attn-ui-verify-<ts>&roles=admin&perms=attendance:read,attendance:write,attendance:approve,attendance:admin"
AUTH_TOKEN=<token> WEB_URL=http://localhost:8899/attendance node scripts/verify-attendance-ui.mjs
```

## Results
- Migration: succeeded (new attendance leave/overtime/approval/rotation migrations applied).
- Integration test: `test:integration:attendance` passed.
- UI smoke: `verify-attendance-ui.mjs` passed (leave/overtime flows + request cancel + export).
- Dev servers: started for verification and stopped after completion.

## Notes
- Backend/dev servers emitted expected `JWT_SECRET not set` warnings in dev mode.
