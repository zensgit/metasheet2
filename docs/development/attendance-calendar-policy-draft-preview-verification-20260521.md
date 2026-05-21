# Attendance Calendar Policy Draft Preview Verification

Date: 2026-05-21
Branch: `codex/attendance-calendar-draft-preview-20260521`

## Test Matrix

| Check | Command | Result |
| --- | --- | --- |
| Plugin syntax | `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Backend draft resolver unit | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-effective-calendar-role-context.test.ts --reporter=dot` | PASS, 3 tests |
| Frontend focused specs | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/effectiveCalendar.spec.ts tests/AttendanceCalendarPolicyPreviewPanel.spec.ts --watch=false` | PASS, 21 tests |
| Backend attendance regression | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts tests/unit/attendance-effective-calendar-role-context.test.ts --reporter=dot` | PASS, 59 tests |
| Frontend admin regression | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/effectiveCalendar.spec.ts tests/AttendanceCalendarPolicyPreviewPanel.spec.ts tests/useAttendanceAdminConfig.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 36 tests |
| Web type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Core backend build | `pnpm --filter @metasheet/core-backend build` | PASS |
| Web build | `pnpm --filter @metasheet/web build` | PASS |
| Whitespace | `git diff --check` | PASS |

## Acceptance Criteria

- Draft preview can resolve a supplied calendar-policy override without reading
  saved `system_configs` settings.
- Existing saved-preview behavior is preserved when no draft overrides are
  provided.
- The frontend POSTs draft overrides to
  `/api/attendance/effective-calendar/preview` only when the draft checkbox is
  enabled.
- The preview panel can exclude draft rows and fall back to the saved GET path.
- Save payload and preview payload use the same editor-to-wire codec.

## Boundary Checks

- No `attendance_*` migration.
- No direct `meta_*` SQL write.
- No persistence through the new preview route.
- No frontend resolver or save-blocking validator.
- Existing GET `/api/attendance/effective-calendar` behavior remains unchanged.

## Notes

`pnpm install` was required in the isolated worktree to restore local test
binaries. The generated tracked `node_modules` symlink noise was restored before
verification and is not part of the slice.

The web build still emits the existing Vite warning about
`WorkflowDesigner.vue` being both dynamically and statically imported, plus
large chunk warnings. The build exits successfully.
