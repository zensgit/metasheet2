# Attendance Plugin Verification Report (2026-01-20)

## Environment
- Branch: `feat/attendance`
- Backend: `http://localhost:8900` (`RBAC_BYPASS=true`, `RBAC_TOKEN_TRUST=true`, `SKIP_PLUGINS=false`)
- Frontend: `http://localhost:8899`
- Database: `postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2`

## Commands Executed
```sh
pnpm --filter @metasheet/core-backend migrate
RBAC_BYPASS=true RBAC_TOKEN_TRUST=true SKIP_PLUGINS=false PORT=8900 pnpm --filter @metasheet/core-backend dev
VITE_API_URL=http://localhost:8900 pnpm dev
pnpm --filter @metasheet/core-backend test:integration:attendance
curl "http://localhost:8900/api/auth/dev-token?userId=attn-ui-verify-<ts>&roles=admin&perms=attendance:read,attendance:write,attendance:approve,attendance:admin"
AUTH_TOKEN=<token> WEB_URL=http://localhost:8899/attendance node scripts/verify-attendance-ui.mjs
curl http://localhost:8900/api/plugins
```

## Results
- Migration: succeeded (`zzzz20260119150000_add_bpmn_user_task_fields` applied).
- Plugin status: `plugin-attendance` reported `active`.
- UI smoke: `verify-attendance-ui.mjs` passed (check-in/out + export).
- Integration test: `test:integration:attendance` passed.
- Dev servers: started for verification and stopped after completion.

## Warnings / Notes
- `JWT_SECRET` not set warning observed (expected in dev).
- Vite re-optimized deps due to lockfile change (non-blocking).
