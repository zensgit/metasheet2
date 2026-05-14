# Attendance Import Role and DingTalk Benchmark Verification

Date: 2026-05-14

## Checks Run

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-import-permission.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminProvisioning.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
git diff --check
```

## Results

- `node --check plugins/plugin-attendance/index.cjs`: passed.
- `attendance-import-permission.test.ts`: 2 tests passed.
- `useAttendanceAdminProvisioning.spec.ts`: 6 tests passed.
- `pnpm --filter @metasheet/core-backend build`: passed.
- `pnpm --filter @metasheet/web type-check`: passed.
- `git diff --check`: passed.

Note: the targeted frontend Vitest run printed the existing
`WebSocket server error: Port is already in use` warning, but exited 0 and all
targeted tests passed.

## Assertions

- `attendance-importer` preset maps to `attendance_importer`.
- Importer permissions are exactly `attendance:read` and `attendance:import`.
- Attendance admin presets include `attendance:import`.
- Import routes use `withAttendanceImportPermission`.
- Integration list, run history, and sync routes use
  `withAttendanceImportPermission`.
- Integration create, update, and delete remain admin-only by omission from the
  route-guard regression list.
- Frontend legacy fallback provisioning grants exactly `attendance:read` and
  `attendance:import` for importer users.
