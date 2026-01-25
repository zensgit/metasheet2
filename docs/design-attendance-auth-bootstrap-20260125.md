# Attendance Auth Bootstrap Design (2026-01-25)

## Goals
- Provide a clear auth-required state for Attendance without silent failures.
- Enable manual token entry and a minimal login flow to obtain a valid token.
- Keep dev-token bootstrap opt-in and disabled by default in production.

## Non-Goals
- Full-featured auth UX or user management.
- Token refresh/rotation or RBAC changes.
- Attendance business rules beyond auth gating.

## Architecture Overview
- Frontend token helpers in `apps/web/src/utils/api.ts`:
  - Read/write `auth_token` + `jwt`.
  - `apiFetch` injects `Authorization` when present.
- `apps/web/src/composables/useAuth.ts` uses the shared helpers.
- `apps/web/src/views/AttendanceView.vue`:
  - Detects missing/invalid auth and shows an auth-required card.
  - Allows manual token entry and retry.
  - Provides a link to `/login`.
- `apps/web/src/views/LoginView.vue`:
  - Posts to `/api/auth/login`.
  - Stores token and redirects to `redirect` query (default `/attendance`).
- `apps/web/src/App.vue`:
  - Shows Login/Logout in top nav based on token presence.

## Backend Gate
- `packages/core-backend/src/routes/auth.ts`:
  - `/api/auth/dev-token` is only available when `ALLOW_DEV_TOKEN=true`.
  - Default production behavior is disabled.

## Configuration
- Frontend:
  - `VITE_AUTO_DEV_TOKEN=true` enables dev-token bootstrap when no token exists.
- Backend:
  - `ALLOW_DEV_TOKEN=true` allows `/api/auth/dev-token` even in production-like envs.

## Data Flow (Happy Path)
1. User visits `/attendance` with no token.
2. Attendance view shows auth-required card.
3. User clicks Login -> `/login?redirect=/attendance`.
4. Login posts credentials to `/api/auth/login`, stores token, redirects.
5. Attendance uses stored token via `apiFetch`.

## Security Notes
- Dev-token is opt-in and disabled by default.
- Manual token input is explicit and stored locally only.
