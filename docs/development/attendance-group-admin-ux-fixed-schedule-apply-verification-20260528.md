# Attendance Group Fixed-Schedule Apply Verification — 2026-05-28

## Scope

FS-C extends the fixed-schedule preview chain with an apply path.

The slice deliberately stays narrow:

- Reuses the FS-B fixed-schedule plan/classifier for both preview and apply.
- Adds `POST /api/attendance/groups/:id/fixed-schedule/apply`.
- Runs apply inside a transaction.
- Acquires the existing per-org/user attendance schedule advisory lock for every target user.
- Re-runs the shared plan/classifier inside the transaction.
- Inserts only `wouldCreate[]` rows into `attendance_shift_assignments`.
- Leaves `skipped[]` as no-op exact matches.
- Returns `409 ATTENDANCE_GROUP_FIXED_SCHEDULE_BLOCKING_CONFLICT` and writes nothing when `blockingConflicts[]` is non-empty.

## Boundaries

- No migration.
- No schema change.
- No new permission.
- No `attendance_schedule_groups` reuse.
- No group schedule fact table.
- No fixed/shift/free schedule type modeling.
- No weekly matrix.
- No punch method configuration.

## Verification

Commands run from `/tmp/metasheet2-attendance-group-fixed-schedule-apply-20260528`:

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-scheduling-assignment-conflict.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-uuid-validation-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendance-admin-regressions.spec.ts
pnpm --filter @metasheet/web type-check
git diff --check
```

Results:

- `node --check plugins/plugin-attendance/index.cjs` — PASS.
- `attendance-scheduling-assignment-conflict.test.ts` — PASS, 9/9.
- `attendance-uuid-validation-routes.test.ts` — PASS, 3/3.
- `attendance-admin-regressions.spec.ts` — PASS, 30/30.
- `git diff --check` — PASS.
- `pnpm --filter @metasheet/web type-check` — BLOCKED by the borrowed worktree dependency tree missing existing `echarts/*` modules (`echarts/core`, `echarts/charts`, `echarts/components`, `echarts/renderers`, `echarts`). The failure is outside this attendance slice; the focused frontend regression suite above ran cleanly.

Locked behaviors:

- Preview and apply both use `buildAttendanceGroupFixedSchedulePlan`.
- Apply locks every target user before the transaction-time overlap query.
- Apply creates only missing exact assignments.
- Apply skips exact matches without treating them as conflicts.
- Apply performs no insert when a blocking conflict exists.
- The frontend calls the group apply route, not `/api/attendance/assignments`.
- Apply stays disabled when preview has blocking conflicts.
- Apply is disabled after a successful apply, so a second click requires a fresh preview and does not re-submit.
- The apply route emits the existing `attendance.assignment.created` event for created assignments; this slice does not introduce a new event type.

## Deferred

These remain separate explicit opt-ins:

- Fixed-schedule producer/source metadata and managed-row rebuild/delete semantics.
- Group-owned weekly schedule matrix.
- Group-specific punch method configuration.
- Owner/sub-owner roles.
- Export/copy controls.
