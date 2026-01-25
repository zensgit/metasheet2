# Attendance Auth Bootstrap Verification (2026-01-25)

## Environment
- Branch: `feat/plm-updates`
- Workspace: `/Users/huazhou/Downloads/Github/metasheet2`
- Preprod: `http://142.171.239.56:8081`
- Preprod worktree: `/home/mainuser/metasheet2-feat` (branch `origin/feat-plm-updates`)
- Preprod commit: `637c7c185ee26d49190c93377727f49941419197`

## Automated Tests
- Command: `pnpm --filter @metasheet/web exec vitest run --watch=false`
- Result: PASS (2026-01-25)

## Preprod Config Verification (2026-01-25)
- `/home/mainuser/metasheet2/docker/app.env`: `ALLOW_DEV_TOKEN=false`.
- `/home/mainuser/metasheet2-feat/apps/web/.env.production`: `VITE_AUTO_DEV_TOKEN=false`.
- `GET http://127.0.0.1:8900/api/auth/dev-token` returned `404`.

## Manual Verification (Preprod UI - 2026-01-25)
- Opened `/attendance` with no token; auth-required card displayed.
- Navigated to `/login?redirect=/attendance`, logged in with admin account.
- Redirected back to `/attendance`; auth-required card dismissed and summary UI loaded.

## Manual Verification (Preprod - Production Lock)
- Backend dev-token endpoint: `GET /api/auth/dev-token` returned `404` after `ALLOW_DEV_TOKEN=false`.
- Frontend: `VITE_AUTO_DEV_TOKEN=false` baked into web build.
- `/attendance` shows an "Authentication required" banner with token input, save/clear, and retry actions when no token is present.
- `/login` page is available to obtain a token via `/api/auth/login`, then redirects back to `/attendance`.

## Notes
- `/api/auth/dev-token` remains disabled by default in production unless explicitly enabled.
