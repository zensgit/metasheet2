# Attendance Admin Rail Navigation Extraction Verification 2026-03-24

## Scope Verified

This verification covers the third admin rail extraction step:

- DOM/hash/observer sync moves into `useAttendanceAdminRailNavigation.ts`
- `AttendanceView.vue` keeps business logic only
- deep-link restore and compact navigation behavior remain intact

## Files

- `apps/web/src/views/attendance/useAttendanceAdminRailNavigation.ts`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/useAttendanceAdminRailNavigation.spec.ts`
- `apps/web/tests/useAttendanceAdminRail.spec.ts`
- `apps/web/tests/AttendanceAdminRail.spec.ts`
- `apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- `apps/web/tests/attendance-import-batch-timezone-status.spec.ts`

## Commands

### Focused rail extraction regression set

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminRailNavigation.spec.ts tests/useAttendanceAdminRail.spec.ts tests/AttendanceAdminRail.spec.ts tests/attendance-admin-anchor-nav.spec.ts tests/attendance-import-batch-timezone-status.spec.ts --watch=false
```

Observed result:

- `5 files / 26 tests passed`

Coverage locked by this run:

- hash restore on mount
- compact mode close-on-select
- rail state/persistence contract
- rail render contract
- grouped anchor nav
- `previewSnapshot.context` empty path still does not crash

### Frontend type-check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Observed result:

- passed

### Frontend production build

```bash
pnpm --filter @metasheet/web build
```

Observed result:

- `pnpm --filter @metasheet/web build` passed after the navigation extraction was wired in

## Verification Notes

- `AttendanceView.vue` no longer owns rail-specific hash restore or observer teardown logic.
- The navigation composable now owns the lifecycle and watcher sequencing for:
  - section binding
  - hash restore
  - observer sync
  - active-link visibility
  - compact viewport synchronization
- `AttendanceView.vue` still owns page data loading and plugin bootstrap, which is the correct remaining boundary.

## Claude Code Verification Use

Claude Code CLI was used for a read-only boundary review of the final extraction step. Its suggested focus areas were:

- naming the last layer as a section/navigation sync composable
- passing shared refs in rather than duplicating state
- testing hash restore and compact-mode transitions first

The implementation follows that guidance, even though the final composable name remains `useAttendanceAdminRailNavigation.ts` for consistency with the existing rail naming.
