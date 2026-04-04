# Attendance Reports Time Slice Verification

Date: 2026-04-04

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/attendance-reports-analytics.spec.ts tests/attendance-experience-entrypoints.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/attendance-experience-mobile-zh.spec.ts tests/attendance-surface-modes.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Result

All commands passed.

## Verified behavior

1. Reports mode renders period presets for `this week / this month / last month / this quarter`.
2. Applying a preset updates the visible date range and refreshes the reports surface.
3. Reports mode renders summary-driven `Attendance Trend` and `Management Metrics` cards.
4. Existing local request and record filters still work after the time-slice changes.
5. Date-input formatting no longer shifts preset ranges backward by one day in the test environment.

## Notes

- The frontend build still emits the existing chunk-size warning.
- This slice remains frontend-only and does not touch approval-center files.
