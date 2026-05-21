# Attendance Calendar Policy Preview UI — Verification

Date: 2026-05-21
Branch: `codex/attendance-calendar-policy-preview-ui-20260521`
Base: `origin/main@d611bb6bb`

## Test Matrix

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceCalendarPolicyPreviewPanel.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS — 3 files / 19 tests |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/web build` | PASS |
| `curl -sS -I http://localhost:8899/` after `pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899` | PASS — HTTP 200 |
| `git diff --check` | PASS |

## Coverage Notes

- `AttendanceCalendarPolicyPreviewPanel.spec.ts` covers:
  - organization-mode preview calls `fetchEffectiveCalendar()` with
    `orgOnly=true` and `suppressUnauthorizedRedirect=true`;
  - resolver results render date, effective label, policy id, and overlay
    summary;
  - user mode requires a target user ID before calling the API;
  - backend `EffectiveCalendarFetchError` messages render without producing a
    result table.
- `useAttendanceHolidayRuleSection.spec.ts` remains in the matrix because the
  extracted holiday section now mounts the shared preview panel.
- `attendance-admin-regressions.spec.ts` remains in the matrix because the
  routed monolithic `AttendanceView.vue` also mounts the shared preview panel.

## Boundary Checks

- Backend plugin is syntax-checked only; no backend file is part of the diff.
- The preview component imports the existing shared client from
  `apps/web/src/services/attendance/effectiveCalendar.ts`.
- The panel does not mutate `settingsForm` or call `saveSettings`.
- No `attendance_*` migration, no direct `meta_*` write, and no new persistence
  path are introduced.

## Result Notes

- `pnpm install` was required in the isolated worktree to restore the workspace
  test/build binaries. It rewrote tracked `node_modules` symlink entries under
  plugin/tool folders; those generated changes were restored before validation
  and are not part of the slice.
- `pnpm --filter @metasheet/web build` emitted the existing Vite warnings about
  `WorkflowDesigner.vue` mixed dynamic/static imports and large chunks. The
  command exited successfully.
