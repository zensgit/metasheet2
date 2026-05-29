# Attendance Group Fixed-Schedule Preview Verification — 2026-05-28

## Scope

FS-B implements the fixed-schedule preview slice from `attendance-group-admin-ux-fixed-schedule-design-20260528.md`.

The slice is intentionally preview-only:

- Adds `POST /api/attendance/groups/:id/fixed-schedule/preview`.
- Enumerates all target members server-side from `attendance_group_members`.
- Classifies targets as `wouldCreate[]`, `skipped[]`, or `blockingConflicts[]`.
- Adds an Attendance groups UI preview panel that can submit the preview and render counts.
- Does not write `attendance_shift_assignments`, `attendance_rotation_assignments`, `attendance_schedule_groups`, or any other table.
- Does not add an apply button, migration, permission, route outside the preview endpoint, or schema change.

## Verification

Commands run from `/tmp/metasheet2-attendance-group-fixed-schedule-preview-20260528`:

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-scheduling-assignment-conflict.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-uuid-validation-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendance-admin-regressions.spec.ts
git diff --check
```

Results:

- `node --check plugins/plugin-attendance/index.cjs`: PASS.
- Backend conflict/preview targeted suite: PASS, `7/7`.
- Backend route UUID validation targeted suite: PASS, `3/3`.
- Frontend targeted suite: PASS, `29/29`.
- `git diff --check`: PASS.

Additional attempted check:

```bash
pnpm --filter @metasheet/web type-check
```

Result: blocked by missing local `echarts` install in the borrowed main worktree dependencies:

```text
Cannot find module 'echarts/core'
Cannot find module 'echarts/charts'
Cannot find module 'echarts/components'
Cannot find module 'echarts/renderers'
Cannot find module 'echarts'
```

`apps/web/package.json` declares `echarts: ^5.5.0`; the local dependency tree used for this isolated worktree does not currently contain `apps/web/node_modules/echarts`. This is a local dependency-install gap, not introduced by this slice.

## Test Coverage Added

Backend:

- `buildAttendanceGroupFixedSchedulePreview` classifies one `wouldCreate`, one exact-match `skipped`, one shift blocking conflict, and one rotation blocking conflict.
- The helper reads the full member set via `attendance_group_members` and queries assignment tables read-only.
- The helper rejects empty groups before previewing.
- The SQL source assertion rejects accidental `INSERT`, `UPDATE`, or `DELETE` in the preview helper test path.
- The route rejects malformed group UUIDs before hitting the database.

Frontend:

- The Attendance groups panel can submit the preview to `/api/attendance/groups/:id/fixed-schedule/preview`.
- The request body contains only `shiftId`, `startDate`, and `endDate` for the preview.
- The preview result renders target/create/skip/conflict counts.
- The preview panel has no "Apply" action and does not POST to `/api/attendance/assignments`.

## Deferred

FS-C remains a separate explicit opt-in:

- Apply/write route.
- Transactional per-user locks and revalidation.
- Zero writes when `blockingConflicts[]` is non-empty.
- Creation of missing exact assignments when skips are present.
- Post-apply reload and production/staging acceptance.
