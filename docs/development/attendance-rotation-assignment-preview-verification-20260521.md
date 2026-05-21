# Attendance Rotation Assignment Preview Verification 2026-05-21

## Local Verification

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendanceRotationSequencePreview.spec.ts \
  tests/AttendanceSchedulingAdminSection.spec.ts \
  --watch=false
```

Result: PASS, 2 files / 14 tests.

## Regression Verification

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendanceRotationSequencePreview.spec.ts \
  tests/AttendanceSchedulingAdminSection.spec.ts \
  tests/useAttendanceAdminScheduling.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false
```

Result: PASS, 4 files / 48 tests.

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS. Vite emitted the existing `WorkflowDesigner.vue` mixed static/dynamic import warning and large chunk warnings; no new build failure.

```bash
git diff --check
```

Result: PASS.

## Coverage

- Parses and reuses rotation rule shift sequences.
- Projects closed date windows into date-by-date preview rows.
- Repeats shift sequences across assignment dates.
- Displays overnight shift metadata.
- Caps open-ended previews to a bounded row count.
- Marks long closed ranges as truncated.
- Reports missing shift references once while keeping rows visible.
- Renders the assignment impact preview in the extracted scheduling admin section.

## Boundary Check

- No backend route changes.
- No database migrations.
- No `attendance_*` fact-source changes.
- No direct `meta_*` reads or writes.
- No save-blocking client validator.
