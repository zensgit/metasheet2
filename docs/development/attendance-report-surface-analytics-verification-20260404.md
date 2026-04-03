# Attendance Report Surface Analytics Verification

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceReportSurface.spec.ts tests/attendance-surface-modes.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Expected Outcomes

- report helper tests pass
- `AttendanceView.vue` type-checks after adding local report filters and summary cards
- production web build succeeds
- no whitespace or patch-format regressions remain
