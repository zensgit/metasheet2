# Attendance Shift Assignment Preview Verification 2026-05-21

## Local Verification

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendanceRotationSequencePreview.spec.ts \
  tests/AttendanceSchedulingAdminSection.spec.ts \
  --watch=false
```

Result: PASS, 2 files / 19 tests.

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

Result: PASS, 6 files / 80 tests.

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

## Coverage

- Fixed shift assignment preview projects a selected shift across a closed date
  window.
- Open-ended and long closed previews are capped to the visible row limit.
- Missing selected shift IDs remain visible and are reported when the loaded
  shift catalog cannot resolve them.
- Effective-calendar context attaches by exact preview date without changing
  row order.
- Extracted scheduling UI renders fixed assignment preview date, day index,
  shift label, schedule, calendar source, working/rest state, override marker,
  and tooltip metadata.
- Existing rotation preview, effective-calendar client, calendar chip display,
  scheduling composable, and admin regression suites remain green.

## Boundary Check

- No backend route changes.
- No database migrations.
- No `attendance_*` fact-source changes.
- No direct `meta_*` reads or writes.
- No save-blocking client validator.
- Effective-calendar fetch failure only clears fixed assignment calendar chips;
  fixed assignment preview and save behavior remain unchanged.

## Notes

`pnpm install` was required in the isolated worktree to restore local test and
build binaries. It rewrote tracked `node_modules` symlink entries under
plugin/tool folders; those generated changes were restored before validation
and are not part of this slice.
