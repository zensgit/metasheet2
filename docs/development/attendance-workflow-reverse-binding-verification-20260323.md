# Attendance Workflow Reverse Binding Verification

Date: 2026-03-23
Branch: `codex/attendance-postrelease-next-20260322`

## Verified Files

Backend:
- `packages/core-backend/src/db/migrations/zzzz20260323123000_add_attendance_approval_flow_workflow_link.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/workflow/WorkflowDesigner.ts`
- `packages/core-backend/src/routes/workflow-designer.ts`
- `plugins/plugin-attendance/index.cjs`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/attendance.yml`

Frontend:
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/WorkflowDesigner.vue`
- `apps/web/src/views/workflowDesignerPersistence.ts`
- `apps/web/src/views/attendance/useAttendanceAdminLeavePolicies.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`

Tests:
- `apps/web/tests/useAttendanceAdminLeavePolicies.spec.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/WorkflowDesigner.attendanceHandoff.spec.ts`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`

## Commands Run

Frontend targeted tests:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/useAttendanceAdminLeavePolicies.spec.ts \
  tests/AttendanceLeavePoliciesSection.spec.ts \
  tests/WorkflowDesigner.attendanceHandoff.spec.ts \
  --watch=false
```

Result:
- `3 files / 14 tests passed`

Type checks:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:
- both passed

Frontend build:

```bash
pnpm --filter @metasheet/web build
```

Result:
- passed

Backend integration:

```bash
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/attendance-plugin.test.ts
```

Result:
- `1 file / 46 tests passed`

## Verification Notes

### Local persistent DB note

The local shared verification database did not initially contain `attendance_approval_flows.workflow_id`.

The committed migration is correct, but the local `migrate` command could not run because this machine already had a corrupted historical migration ledger:

- `previously executed migration zzzz20260318110000_add_multitable_bases_and_permissions is missing`

To complete local verification on this machine, a one-off local schema patch was applied before rerunning integration:

```sql
ALTER TABLE attendance_approval_flows
ADD COLUMN IF NOT EXISTS workflow_id uuid
REFERENCES workflow_definitions(id)
ON DELETE SET NULL;
```

This was only for local verification against the existing persistent DB and is not a substitute for the committed migration file.

### Integration determinism note

The broad attendance integration test already relied on persistent local data. To keep it deterministic after repeated local runs, the leave approval path now creates and uses an explicit per-test leave approval flow instead of implicitly picking whichever leave flow already exists in the DB.

## Functional Outcomes Verified

- approval flows now return `workflowId`
- workflow drafts created from attendance handoff can be bound back to approval flows
- the link can be cleared independently of normal approval-flow saves
- leave admin can display and open the linked draft
- workflow designer keeps draft ownership on creation so later bind/edit checks succeed
- broad attendance integration remains green after the new link path is added
