# Attendance Admin Nav Shortcuts Verification

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

## Expected Coverage

- current-section bar shows shortcut hint
- focused/show-all mode persists per org-scoped storage bucket
- `Alt+ArrowUp` / `Alt+ArrowDown` moves between sections
- keyboard switching is ignored while an input is focused
- existing admin rail and pager behavior stays green

## Claude Code Note

Claude Code was actually used for this slice. It did not generate the final patch, but it provided one useful implementation boundary:

- keep persistence in `useAttendanceAdminRail.ts`
- keep keyboard switching in `useAttendanceAdminRailNavigation.ts`
- avoid re-expanding left-rail complexity

Verification still relies on local tests, typecheck, and build output.
