# Attendance Auth Bootstrap Verification (2026-01-25)

## Environment
- Branch: `feat/plm-updates`
- Workspace: `/Users/huazhou/Downloads/Github/metasheet2`

## Automated Tests
- Command: `pnpm --filter @metasheet/web exec vitest run --watch=false`
- Result: PASS

## Manual Verification (Not Run)
- Clear localStorage keys `auth_token`, `jwt`, `devToken`.
- Set `VITE_AUTO_DEV_TOKEN=true` on the frontend.
- Set `ALLOW_DEV_TOKEN=true` on the backend if `NODE_ENV=production`.
- Open `/attendance` and confirm the summary loads without manual token entry.

## Notes
- `/api/auth/dev-token` remains disabled by default in production unless explicitly enabled.
