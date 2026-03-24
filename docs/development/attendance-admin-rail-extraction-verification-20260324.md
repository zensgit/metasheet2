# Attendance Admin Rail Extraction Verification 2026-03-24

## Scope Verified

This verification covers the first extraction step for the attendance admin rail:

- the rail UI is moved into `AttendanceAdminRail.vue`
- rail behavior still works through `AttendanceView.vue`
- rail-local styles move with the child component
- a component-level contract test exists for the new extraction seam

## Files

- `apps/web/src/views/attendance/AttendanceAdminRail.vue`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/AttendanceAdminRail.spec.ts`
- `apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- `apps/web/tests/attendance-import-batch-timezone-status.spec.ts`

## Commands

### Component and page-level rail tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/AttendanceAdminRail.spec.ts tests/attendance-admin-anchor-nav.spec.ts tests/attendance-import-batch-timezone-status.spec.ts --watch=false
```

Expected coverage:

- extracted rail renders current-section and recent shortcut context
- rail emits compact/filter/group/select/copy/clear actions
- existing page-level anchor behavior remains intact
- `previewSnapshot.context` empty path still does not crash

### Frontend type-check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

## Verification Notes

- This extraction is intentionally render-layer only; the parent still owns persistence and hash logic.
- Because `AttendanceView.vue` uses `scoped` styles, the rail-specific styles had to move into the new child component as part of the extraction.
- The new component test is not a replacement for the existing page-level tests. It only locks the prop/emit contract so later refactors can change internals without losing interaction coverage.
