# Attendance Mode Directory Admin Access Design

Date: 2026-03-26

## Background

The live environment runs in `attendance` product mode. In that mode the frontend route guard only allowed:

- `/attendance`
- `/p/plugin-attendance/attendance`
- `/settings`

This blocked `/admin/directory` even for platform administrators, so the DingTalk pending-review flow was deployed but not directly operable from the UI.

## Goals

- Keep the attendance-focused shell for regular users.
- Allow platform administrators to access `/admin/directory` in attendance mode.
- Avoid granting directory access to attendance-only admins who are not platform admins.

## Implementation

### 1. Add an explicit `platformAdmin` feature

The backend auth feature payload now includes `platformAdmin`, derived from `user.role === 'admin'`.

This keeps the frontend from inferring directory privileges from `attendance:admin`, which would be too broad for `/api/admin/directory`.

### 2. Gate the directory route with platform admin

`/admin/directory` now declares `requiredFeature: 'platformAdmin'`.

This means:

- platform admins can enter the route
- non-admin users are redirected to the attendance home path

### 3. Replace the hard-coded attendance allowlist with a feature-aware helper

The attendance-focused route restriction now calls `isPathAllowedInAttendanceFocus(path)`.

Allowed paths remain:

- `/attendance`
- `/p/plugin-attendance/attendance`
- `/settings`

And `/admin/directory` is additionally allowed only when `platformAdmin === true`.

### 4. Expose a visible admin entry

The top navigation now shows a `Directory` / `目录同步` entry for platform admins:

- in attendance mode
- in platform mode

This avoids relying on manual URL entry.

## Files

- `packages/core-backend/src/routes/auth.ts`
- `apps/web/src/composables/useAuth.ts`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/main.ts`
- `apps/web/src/App.vue`
- `apps/web/src/router/types.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `apps/web/tests/featureFlags.spec.ts`
- `apps/web/tests/app.spec.ts`
