# Attendance Permission Hardening Design

## Goal

Fix two real permission gaps reported from Run 32 validation:

1. ordinary attendance users can read `/api/events`
2. attendance-mode self-registered users do not receive attendance self-service access by default

## Current Problems

- `packages/core-backend/src/routes/events.ts` exposes the event bus REST routes without authentication or admin authorization.
- `AuthService.register()` creates generic `user` accounts with spreadsheet permissions only, even when the runtime product mode is attendance-focused.

## Change

### Event Bus Routes

- Apply `authenticate` to `/api/events` and all nested event bus endpoints.
- Require either:
  - legacy admin claims already present on the authenticated request, or
  - RBAC admin membership from `user_roles`

### Attendance Registration Defaults

- When `PRODUCT_MODE` resolves to attendance-focused mode:
  - add `attendance:read` and `attendance:write` to the registered user's direct permissions
  - best-effort assign the `attendance_employee` role in `user_roles`

This keeps the immediate self-service feature payload correct after registration and also aligns long-term RBAC membership for later logins.

## Scope

- `packages/core-backend/src/routes/events.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- focused tests only

## Non-Goals

- This hotfix does not redesign broader product-mode onboarding.
- This hotfix does not introduce fine-grained event bus permissions; it simply closes the current admin-only exposure gap.
