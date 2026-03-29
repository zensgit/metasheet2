# Attendance Admin Quick Jump Verification

Date: 2026-03-29

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  tests/useAttendanceAdminRail.spec.ts \
  tests/useAttendanceAdminRailNavigation.spec.ts \
  --watch=false
pnpm --filter @metasheet/web build
```

## What This Verifies

- sticky current-section bar still renders correctly
- quick-jump select is present in the current-section bar
- selecting a deep section updates the hash and current-section label
- earlier pager / focus-mode / keyboard shortcut flows remain green

## Claude Code Note

Claude Code was actually invoked during this continuation, but it did not return a timely actionable result for this slice. Final verification relies on local tests, typecheck, and build output.
