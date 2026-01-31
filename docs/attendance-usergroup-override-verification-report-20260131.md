# Attendance UserGroup Overrides + Plugin Nav (Verification Report)

Date: 2026-01-31

## Verification Summary
- Executed **static verification** (source inspection).
- Executed **runtime redirect check** using Playwright (local Vite dev server).
- Backend-dependent UI checks (plugin list, attendance API) not executed.

## Static Checks Performed
- `plugins/plugin-attendance/index.cjs`
  - Confirmed `userIds` override logic present.
  - Confirmed `security/driver` groups match by `role` and `attendance_group`.
- `apps/web/src/main.ts`
  - Confirmed `/p/:plugin/:viewId` route exists.
  - Confirmed `/attendance` redirects to plugin host.

## Runtime Checks Performed (Local)
- Started backend: `pnpm --filter @metasheet/core-backend dev` (listening on `http://localhost:7778`).
- Started frontend: `pnpm dev` (Vite on `http://localhost:8899`).
- Verified plugin list API:
  - `GET http://localhost:7778/api/plugins` includes `plugin-attendance`.
- Playwright verified redirect:
  - Opened `http://localhost:8899/attendance`
  - Final URL: `http://localhost:8899/p/plugin-attendance/attendance`
- Playwright verified navigation link:
  - `Attendance` nav entry exists
  - `href = /p/plugin-attendance/attendance`
- Playwright verified Attendance view loads:
  - Heading `Attendance` present
  - Status shows `Missing Bearer token` (expected without auth token)

### Backend Notes
- Backend started with DB auth error (`password authentication failed for user "metasheet"`), so data-dependent attendance APIs were **not** validated.

## Recommended Runtime Checks (With Backend)
1. **Plugin nav**
   - Start web: `pnpm dev`
   - Confirm top nav shows plugin entries from `/api/plugins`.
   - Open `/p/plugin-attendance/attendance` and verify Attendance renders.
   - Visit `/attendance` and confirm redirect to plugin host.

2. **UserGroup overrides (policy engine)**
   - In rule-set config, set `userGroups[].userIds` for a known test user.
   - Ensure group matches even if `attendance_group`/`role` are missing.
   - Confirm driver/security rules apply based on:
     - `role = 司机/保安`, or
     - `attendance_group` contains 司机/保安, or
     - `userIds` override.

3. **Regression sanity**
   - Import preview still maps `职位 -> role` and `考勤组 -> attendance_group`.
   - Existing policies still apply as before when `userIds` are not set.
