# Attendance Group Fixed-Schedule Managed Rebuild/Clear Verification - 2026-05-28

## Scope

FS-D3 completes the managed provenance runtime for attendance-group fixed schedules.

This slice adds backend-only explicit operations:

- `POST /api/attendance/groups/:id/fixed-schedule/rebuild`
- `POST /api/attendance/groups/:id/fixed-schedule/clear`

It follows:

- `attendance-group-admin-ux-fixed-schedule-managed-provenance-design-20260528.md`
- `attendance-group-admin-ux-fixed-schedule-provenance-fsd1-verification-20260528.md`
- `attendance-group-admin-ux-fixed-schedule-provenance-fsd2-verification-20260528.md`

## Delivered Behavior

### Rebuild

Rebuild resolves the current group members for the provided shift/date window, then:

- locks target users and currently active managed-row users for the same `producer_key`;
- reuses the fixed-schedule classifier;
- returns 409 and writes nothing when `blockingConflicts[]` is non-empty;
- inserts missing `wouldCreate[]` rows with producer metadata;
- soft-deactivates active managed rows for the same `producer_key` whose users are no longer in the group;
- never claims or mutates unmanaged exact-match rows.

### Clear

Clear soft-deactivates only active rows matching:

- `org_id`;
- `producer_type = attendance_group_fixed_schedule`;
- `producer_ref_id = groupId`;
- the exact `producer_key`.

It does not hard-delete and does not touch unmanaged rows or rows from another producer key.

## Boundary Notes

- Backend-only: no frontend controls were added.
- No migration: FS-D1 already added the nullable producer columns.
- No `attendance_schedule_groups` read/write.
- No weekly matrix, punch-method config, owner/sub-owner, export/copy, or comprehensive-hours write surface.
- `producer_run_id` remains diagnostic; rebuild/clear ownership is by `producer_key`.

## F1 Handling

If a same-group fixed-schedule managed row from a different producer key blocks the requested window, the conflict now carries:

```json
{
  "managedScheduleAction": "clear_existing_managed_schedule_first"
}
```

This keeps overlap safety fail-closed while giving later UI work a specific affordance for "clear the previous managed schedule first."

## Verification

Commands run:

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-scheduling-assignment-conflict.test.ts tests/unit/attendance-uuid-validation-routes.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
git diff --check
```

Results:

- `node --check`: PASS
- targeted backend unit tests: PASS, 20/20
- `tsc --noEmit`: PASS
- `git diff --check`: PASS

New coverage:

- rebuild creates missing rows, keeps exact managed/unmanaged skips separate, and soft-deactivates stale managed rows only;
- rebuild refuses a different-key same-group managed overlap with zero insert/update writes and the clear-first action hint;
- clear soft-deactivates only rows for the exact producer key;
- new rebuild/clear routes reject malformed group UUIDs before touching DB.

## Deferred

Frontend controls for rebuild/clear remain a separate opt-in. This slice only exposes the safe backend operations and their tests.
