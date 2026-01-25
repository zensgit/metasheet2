# Attendance Auth Bootstrap Development Report (2026-01-25)

## Summary
- Added token bootstrap for Attendance/API calls when no local token is present.
- Normalized auth token storage to `auth_token` + `jwt` for compatibility.
- Added an opt-in backend gate to allow `/api/auth/dev-token` in production-like envs.
- Documented the frontend env flag for auto dev-token.

## Changes
- `apps/web/src/utils/api.ts`
  - Added shared auth token helpers.
  - Added dev-token bootstrap and gating.
  - Ensured `apiFetch` injects `Authorization` when possible.
- `apps/web/src/composables/useAuth.ts`
  - Switched to shared auth token helpers.
- `packages/core-backend/src/routes/auth.ts`
  - Added `ALLOW_DEV_TOKEN` opt-in gate for `/api/auth/dev-token`.
- `apps/web/.env.development.example`
  - Added `VITE_AUTO_DEV_TOKEN` example.

## Configuration
- Frontend: set `VITE_AUTO_DEV_TOKEN=true` to auto fetch `/api/auth/dev-token` when a local token is missing.
- Backend: set `ALLOW_DEV_TOKEN=true` to allow `/api/auth/dev-token` even if `NODE_ENV=production`.

## Notes
- Bootstrap only runs when no `Authorization` header is present.
- The token is stored in both `auth_token` and `jwt` to keep existing flows consistent.
