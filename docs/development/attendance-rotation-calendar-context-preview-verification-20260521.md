# Attendance Rotation Calendar Context Preview Verification 2026-05-21

## Local Verification

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendanceRotationSequencePreview.spec.ts \
  tests/AttendanceSchedulingAdminSection.spec.ts \
  --watch=false
```

Result: PASS, 2 files / 15 tests.

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendanceRotationSequencePreview.spec.ts \
  tests/AttendanceSchedulingAdminSection.spec.ts \
  tests/useAttendanceAdminScheduling.spec.ts \
  tests/effectiveCalendar.spec.ts \
  tests/calendarChipDisplay.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false
```

Result: PASS, 6 files / 76 tests.

## Coverage

- Rotation assignment preview still projects rule sequences by date.
- Calendar context attaches by exact preview date without changing row order.
- Invalid calendar dates are ignored by the map helper.
- Extracted scheduling UI renders effective-calendar chip label, source, working/rest state, override marker, and tooltip.
- Existing effective-calendar client and chip display tests remain green.
- Existing attendance admin regression suite remains green, including `AttendanceView.vue` setup.

## Build And Static Verification

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS (`vue-tsc -b`).

```bash
pnpm --filter @metasheet/web build
```

Result: PASS (`vue-tsc -b && vite build`, with existing Vite chunk-size / mixed static+dynamic import warnings).

```bash
git diff --check
```

Result: PASS.

## Boundary Check

- No backend route changes.
- No database migrations.
- No `attendance_*` fact-source changes.
- No direct `meta_*` reads or writes.
- No save-blocking client validator.
- Effective-calendar fetch failure only clears calendar chips; preview/save behavior remains unchanged.
