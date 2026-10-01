# Verification — attendance admin write honesty (#5965, #5968)

Date: 2026-09-23. Branch `cursor/attendance-write-honesty-5965-5968-3163`. Not merged.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendanceGeoFenceSave.spec.ts \
  tests/attendanceFixedScheduleWrites.spec.ts \
  tests/useAttendanceAdminConfig.spec.ts

pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendanceEmployeeQuickActionIcons.spec.ts

pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-admin-regressions.spec.ts \
  -t "partial geofence|applies a fixed schedule preview|preview-only|scheduler dispatch|rebuilds and clears managed"

pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-geofence-settings-save.test.ts \
  tests/unit/attendance-advanced-scheduling-scope.test.ts \
  tests/unit/attendance-uuid-validation-routes.test.ts \
  -t "geofence|owner preview|scheduler dispatch|guards the new scheduling|keeps group CRUD|keeps fixed-schedule preview closed|admits attendance admins through every R0"
```

Results: geofence helper 5, write-grant helper 3, admin config 8, quick-action icons 5, filtered admin regressions 6 passed (partial fence, admin apply, preview-only owner, dispatch-then-403, rebuild/clear, and the existing preview-only limits case that shares the filter). Backend geofence save 4, scheduling-scope guard 1, owner preview, dispatch preview, owner apply still forbidden, non-manager preview still 403 before group SQL, admin routes still skip scheduler-scope SQL.

Backend: geofence save 4, scheduling scope guard 1, owner preview writes `apply: false`, dispatch preview writes `apply: true` / `rebuild: false`, owner apply still `SCHEDULER_SCOPE_FORBIDDEN`, non-manager preview still 403 before group SQL, admin routes still skip `attendance_scheduler_scopes`.

## What was checked

- Partial lat/lng/radius does not PUT. The punch card keeps the previous radius. All-blank still sends `null` and the success text says the fence was turned off.
- Incomplete `{ lat }` and `radiusMeters: 0` are HTTP 400 and do not replace the stored row. Omitting `geoFence` keeps it. Explicit `null` clears it.
- `scope: managed` with `fixedScheduleWrites.apply: false` leaves Apply, rebuild, and clear disabled. Clicking the disabled Apply does not POST.
- The same scope with `apply: true` enables Apply. A following 403 `SCHEDULER_SCOPE_FORBIDDEN` shows preview-only copy and the code, and does not say admin permission is required. Apply is then disabled.
- Admin apply/rebuild/clear behavior in the existing regression stays enabled.
- O3 action set is unchanged. Apply still uses `assertAttendanceGroupFixedScheduleDispatchAllowed`.

## Mutation the tests catch

- Mapping an incomplete fence to `null` fails `attendanceGeoFenceSave.spec.ts` and the partial-save regression.
- Enabling Apply for a managed catalog without an exact `true` grant fails the preview-only regression.
- Returning apply permission for an owner with no scheduler scope fails the owner preview route test.

## Not covered

No browser pass. The attendance admin surface was exercised in jsdom (click preview, click apply, edit the radius, click save). A full `pnpm --filter @metasheet/core-backend test:unit` was not run; only the suites above.
