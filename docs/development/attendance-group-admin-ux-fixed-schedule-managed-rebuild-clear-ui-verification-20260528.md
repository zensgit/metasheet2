# Attendance Group Fixed-Schedule Managed Rebuild/Clear UI Verification - 2026-05-28

## Scope

This slice wires the existing FS-D3 backend operations into the production attendance group admin surface.

It follows:

- `attendance-group-admin-ux-fixed-schedule-managed-provenance-design-20260528.md`
- `attendance-group-admin-ux-fixed-schedule-managed-rebuild-clear-verification-20260528.md`

## Delivered Behavior

The fixed-schedule panel now exposes two explicit managed-row controls for a saved attendance group, selected shift, and date window:

- `Rebuild managed rows` posts to `POST /api/attendance/groups/:id/fixed-schedule/rebuild`.
- `Clear managed rows` asks for confirmation, then posts to `POST /api/attendance/groups/:id/fixed-schedule/clear`.

Both controls reuse the same request body as preview/apply:

- `shiftId`
- `startDate`
- `endDate`
- optional `orgId`

The UI shows rebuild created/deactivated counts from the backend result. A successful clear removes the stale preview result and reports the number of soft-deactivated managed rows.

## Clear-First Hint

When backend preview/rebuild classification reports:

```json
{
  "managedScheduleAction": "clear_existing_managed_schedule_first"
}
```

the panel shows a clear-first hint. This keeps the F1 operator path explicit: if an older managed schedule with a different producer key blocks the selected window, the operator should clear those managed rows first, then preview/rebuild again.

## Boundaries Held

- Frontend-only.
- No backend, schema, migration, route, permission, or OpenAPI change.
- No direct `/api/attendance/assignments` fallback.
- No weekly matrix, daily multi-shift modeling, rotation generation, punch-method config, owner/sub-owner, export/copy, or comprehensive-hours write surface.
- The retired `AttendanceRulesAndGroupsSection.vue` component stays retired.

## Verification

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check
```

Results:

- frontend regression suite: PASS, 32/32
- `vue-tsc --noEmit`: PASS
- `git diff --check`: PASS

New coverage:

- rebuild posts once to the group rebuild route with the selected shift/date body;
- clear asks for confirmation, does not post when cancelled, and posts once when confirmed;
- rebuild/clear never fall back to `POST /api/attendance/assignments`;
- clear removes the preview result and reports the deactivated count;
- managed different-key conflicts render the clear-first hint and keep apply disabled.

## Deferred

The following remain separate opt-ins:

- weekly matrix;
- daily multi-shift modeling;
- group-owned rotation generation;
- group-specific punch method configuration;
- owner/sub-owner roles;
- export/copy controls;
- comprehensive-hours writes from group detail.
