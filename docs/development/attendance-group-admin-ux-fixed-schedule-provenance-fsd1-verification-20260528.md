# Attendance Group Fixed-Schedule Provenance FS-D1 Verification

Date: 2026-05-28
Branch: `codex/attendance-group-fsd1-provenance-20260528`
Status: runtime slice verification

## 1. Scope

FS-D1 implements only the migration and mapper exposure from `attendance-group-admin-ux-fixed-schedule-managed-provenance-design-20260528.md`.

This slice adds nullable producer metadata to `attendance_shift_assignments`:

- `producer_type`
- `producer_ref_id`
- `producer_key`
- `producer_run_id`

It also exposes the fields through `mapAssignmentRow` in both camelCase and snake_case forms.

## 2. Boundaries

- No route changes.
- No frontend changes.
- No FS-C apply tagging.
- No rebuild or clear operation.
- No `attendance_schedule_groups` reuse.
- No new schedule fact table.
- Existing/manual/legacy rows remain all-null and unmanaged.

FS-D2 remains the first slice that may tag newly created group fixed-schedule rows. FS-D3 remains the rebuild/clear slice.

## 3. Migration Shape

Migration: `packages/core-backend/src/db/migrations/zzzz20260528200000_add_attendance_shift_assignment_provenance.ts`

Locked choices:

- Adds columns only to `attendance_shift_assignments`.
- Adds all-null-or-all-non-null check constraint `chk_attendance_shift_assignments_producer_metadata`.
- Adds lookup indexes:
  - `idx_attendance_shift_assignments_producer_key` on `(org_id, producer_type, producer_key)`.
  - `idx_attendance_shift_assignments_producer_ref` on `(org_id, producer_type, producer_ref_id)`.
- Down migration drops the check, indexes, and columns.
- Does not create a second schedule table.

Deployment note:

- The migration uses the repo's existing plain `ADD CONSTRAINT ... CHECK` style rather than `NOT VALID` + later `VALIDATE CONSTRAINT`.
- PostgreSQL validates existing rows when the constraint is added. Here the four columns were just added as nullable, so existing rows are all-null and satisfy the check, but the validation still scans `attendance_shift_assignments` while the DDL lock is held.
- For unusually large production attendance-assignment tables, schedule this migration with the normal migration window; a future migration SOP could split large-table checks into `NOT VALID` plus a separate validation step.

## 4. Verification

Commands run from `/tmp/metasheet2-attendance-group-fsd1-provenance-20260528`:

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-scheduling-assignment-conflict.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migration-provider.test.ts tests/unit/migrations.rollback.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
git diff --check
```

Results:

- `node --check plugins/plugin-attendance/index.cjs` — PASS.
- `attendance-scheduling-assignment-conflict.test.ts` — PASS, 11/11.
- `migration-provider.test.ts` + `migrations.rollback.test.ts` — PASS, 16/16.
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit` — PASS.
- `git diff --check` — PASS.

## 5. Tests Added

`attendance-scheduling-assignment-conflict.test.ts` now locks:

- legacy rows with no producer columns map to `producerType/producerRefId/producerKey/producerRunId = null`;
- managed rows map producer metadata in both camelCase and snake_case forms;
- migration source adds the four nullable producer columns, the all-null-or-all-non-null check, and both producer indexes;
- migration source does not create a second attendance group or schedule fact table.

## 6. Deferred

- FS-D2: populate producer metadata for newly created group fixed-schedule rows.
- FS-D3: managed rebuild/clear with soft-deactivation by `producer_key`.
- Any UI for clear/rebuild.
- Weekly matrix, daily multi-shift modeling, group punch configuration, owner/sub-owner, export/copy, or comprehensive-hours writes.
