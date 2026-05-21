# Attendance Rotation Sequence Preview Verification

Date: 2026-05-21
Branch: `codex/attendance-rotation-sequence-preview-20260521`
Base: `origin/main@663e7646e`

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Frontend focused specs | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceRotationSequencePreview.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts --watch=false` | PASS, 10 tests |
| Frontend type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Frontend scheduling regression | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceRotationSequencePreview.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 44 tests |
| Frontend build | `pnpm --filter @metasheet/web build` | PASS |
| Whitespace | `git diff --check` | PASS |

## Acceptance Criteria

- Comma and newline separated shift sequences parse consistently.
- Known shift references render ordered preview rows with shift name, id,
  schedule, and overnight marker.
- Missing shift references are reported once when the shift catalog is loaded.
- Legacy/unresolved references remain visible instead of being hidden.
- The extracted scheduling component displays the preview.
- The production `AttendanceView.vue` displays the preview and supports quick
  append from loaded shifts.

## Boundary Checks

- No backend file changed.
- No `plugins/plugin-attendance/index.cjs` change.
- No migration file added or changed.
- No direct `meta_*` SQL write.
- No staging/prod write operation.

## Notes

`pnpm install` was required in the isolated worktree to restore local test
binaries. It rewrote tracked `node_modules` symlink entries under plugin/tool
folders; those generated changes were restored before staging.

The frontend build still emits the existing Vite warning about large chunks and
the mixed static/dynamic import of `WorkflowDesigner.vue`; the command exits 0.
