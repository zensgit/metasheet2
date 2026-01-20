# Attendance Plugin Verification Report (2026-01-20, Extension)

## Environment
- Branch: `feat/attendance`
- Backend: `http://localhost:8900` (`RBAC_BYPASS=true`, `RBAC_TOKEN_TRUST=true`, `SKIP_PLUGINS=false`, `JWT_SECRET=dev-secret-key`)
- Frontend: `http://localhost:8899`
- Database: `postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2`

## Commands Executed
```sh
pnpm --filter @metasheet/core-backend migrate
pnpm --filter @metasheet/core-backend test:integration:attendance
JWT_SECRET=dev-secret-key RBAC_BYPASS=true RBAC_TOKEN_TRUST=true SKIP_PLUGINS=false PORT=8900 pnpm --filter @metasheet/core-backend dev
VITE_API_URL=http://localhost:8900 pnpm dev
JWT_SECRET=dev-secret-key node scripts/gen-dev-token.js
AUTH_TOKEN=<token> WEB_URL=http://localhost:8899/attendance UI_TIMEOUT=60000 UI_DEBUG=true UI_SCREENSHOT_DIR=tmp/attendance-ui node scripts/verify-attendance-ui.mjs
```

## Results
- Migration: succeeded (new attendance leave/overtime/approval/rotation migrations applied).
- Integration test: `test:integration:attendance` previously passed (not rerun after UI smoke fix).
- UI smoke: `verify-attendance-ui.mjs` passed (leave/overtime flows + request cancel + export).
- Dev servers: started for verification and stopped after completion.

## Notes
- UI smoke requires matching `JWT_SECRET` between backend and token generation; mismatch yields `Invalid token` in the UI.
