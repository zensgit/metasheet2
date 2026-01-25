# Attendance Auth Bootstrap Verification (2026-01-25)

## Environment
- Branch: `feat/plm-updates`
- Workspace: `/Users/huazhou/Downloads/Github/metasheet2`
- Preprod: `http://142.171.239.56:8081`

## Automated Tests
- Command: `pnpm --filter @metasheet/web exec vitest run --watch=false`
- Result: PASS

## Manual Verification (Preprod - Production Lock)
- Backend dev-token endpoint: `GET /api/auth/dev-token` returned `404` after `ALLOW_DEV_TOKEN=false`.
- Frontend: `VITE_AUTO_DEV_TOKEN=false` baked into web build.
- `/attendance` shows an "Authentication required" banner with retry action when no token is present.

## Notes
- `/api/auth/dev-token` remains disabled by default in production unless explicitly enabled.
