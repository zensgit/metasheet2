# Attendance Workflow Step Sync Verification

Date: 2026-03-23
Branch: `codex/attendance-postrelease-next-20260322`

## Scope Verified

This verification covers the new `workflow draft -> approval steps` sync preview/apply slice:

- BPMN serialization of attendance-native approver role metadata
- attendance preview API for linked workflow drafts
- leave admin preview/apply UI
- leave admin builder/json synchronization after applying a workflow-derived preview

## Files Verified

- `packages/core-backend/src/workflow/WorkflowDesigner.ts`
- `plugins/plugin-attendance/index.cjs`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/attendance.yml`
- `apps/web/src/views/attendance/useAttendanceAdminLeavePolicies.ts`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/AttendanceView.vue`

## Automated Verification

### Frontend targeted tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts --watch=false
```

Result:

- `2 files / 15 tests passed`

Coverage in this slice:

- preview API loading
- apply preview into builder/json
- warning rendering
- preview/apply/clear UI actions

### Workflow starter unit test

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-templates.test.ts
```

Result:

- `1 file / 2 tests passed`

Coverage in this slice:

- attendance-native starter template presence
- BPMN serialization of `metasheet:candidateGroups`

### Attendance plugin integration

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts
```

Result:

- `1 file / 47 tests passed`

New integration assertion added:

- create approval flow
- instantiate linked attendance workflow starter
- attach `workflow_id`
- call `GET /api/attendance/approval-flows/:id/workflow-sync-preview`
- verify preview returns `Manager Review -> HR Review`
- verify derived role ids are `manager` and `hr`

### Frontend handoff regression set

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendanceWorkflowHandoff.spec.ts tests/WorkflowDesigner.attendanceHandoff.spec.ts tests/attendance-workflow-designer-zh.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts --watch=false
```

Result:

- `6 files / 23 tests passed`

### Type checks

Commands:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

- both passed

### Frontend production build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed
- only existing chunk-size warnings remained

## Validation Notes

1. The first attempted integration command at worktree root failed because this worktree does not contain a root-level `vitest.integration.config.ts`.
2. The correct verified command was the package-scoped one under `@metasheet/core-backend`.
3. `vitest` reported an existing `WebSocket server error: Port is already in use` during one frontend run, but the actual test run completed successfully and all assertions passed.

## Release Readiness For This Slice

This slice is locally ready for PR review:

- feature behavior implemented
- preview/apply admin UX present
- integration path validated
- type checks green
- frontend build green

Remaining release work, if this branch is promoted:

- open PR
- wait for GitHub checks
- merge through the normal post-release next-phase path
