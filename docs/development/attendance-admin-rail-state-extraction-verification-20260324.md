# Attendance Admin Rail State Extraction Verification 2026-03-24

## Scope Verified

This verification covers the second extraction step for the attendance admin rail:

- rail-local state moves into `useAttendanceAdminRail.ts`
- `AttendanceView.vue` still owns observer/hash/DOM sync
- `AttendanceAdminRail.vue` continues to render through the extracted state contract
- org-scoped persistence and action notifications still behave correctly

## Files

- `apps/web/src/views/attendance/useAttendanceAdminRail.ts`
- `apps/web/src/views/attendance/AttendanceAdminRail.vue`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/useAttendanceAdminRail.spec.ts`
- `apps/web/tests/AttendanceAdminRail.spec.ts`
- `apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- `apps/web/tests/attendance-import-batch-timezone-status.spec.ts`

## Commands

### Focused rail regression set

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminRail.spec.ts tests/AttendanceAdminRail.spec.ts tests/attendance-admin-anchor-nav.spec.ts tests/attendance-import-batch-timezone-status.spec.ts --watch=false
```

Observed result:

- `4 files / 24 tests passed`

Coverage locked by this run:

- composable org bucket reload
- composable copy-link / clear-recents notification paths
- rail component prop/emit contract
- grouped anchor nav behavior
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

- passed

Build note:

- Vite still reports the pre-existing large-chunk warning for the main bundle
- this extraction does not worsen that condition and does not introduce a build failure

## Verification Notes

- `AttendanceView.vue` no longer owns duplicated rail storage helpers or rail persistence watchers.
- `useAttendanceAdminRail.ts` now owns storage buckets and rail-local notification paths through an injected `notify` callback.
- The page still owns the high-risk sequencing logic:
  - `restoreAdminSectionFromHash()`
  - `syncAdminSectionNavigationState()`
  - `syncAdminSectionObserver()`
  - `scrollToAdminSection()`
  - active-link visibility sync
- This keeps the extraction focused and avoids changing the long-page observer state machine in the same step.

## Claude Code Verification Use

Claude Code CLI was available and used for a read-only boundary review. Its recommendation aligned with the implemented split:

- move storage/state/computed/watch logic
- keep hash/observer/DOM mechanics in the parent view

The code changes were still implemented and verified locally in this repository.
