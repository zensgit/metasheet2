# Attendance Post-Release Next-Phase Verification

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Published baseline main commit: `f81254d8cb3e88fd1fdfb5118287df044926dacd`
Published runtime release commit: `796be28e7de27bd07efed118e79e1fe25e09953e`

## Purpose

This document defines the verification baseline and gates for the next attendance iteration after the published explainable-admin release.

It is intentionally a forward-looking verification plan, not a claim that the next-phase work has already been implemented.

## Baseline Already Verified

The published attendance baseline has already cleared:

- PR merge into `main`: `#536`
- runtime deployment workflow:
  - `Build and Push Docker Images`
  - run: `#23401465080`
  - result: `success`
- post-release design/verification docs merge into `main`: `#537`

This means the next phase starts from a live baseline rather than an unverified branch.

## Planned Verification Areas

### 1. Leave Policy Builder

Required checks:

- step builder serializes back to current approval-flow payload shape
- edit existing flow -> reorder/remove/add step -> save path remains stable
- advanced JSON fallback stays synchronized with structured builder state
- invalid conditions or malformed fallback JSON surface explicit errors

### 2. Payroll Template Builder

Required checks:

- structured builder serializes back to current payroll template `config`
- editing an existing template preserves untouched config keys
- summary cards reflect builder state without requiring raw JSON inspection
- advanced JSON fallback round-trips without silent field loss

### 3. Workflow Handoff

Required checks:

- attendance-native starter templates open with the expected request type
- leave/overtime/correction flow handoff keeps enough context for the designer entry point
- tenants without workflow capability still degrade cleanly

## Planned Test Gates

### Frontend Unit / Component

Planned targeted suites:

- `tests/AttendanceLeavePoliciesSection.spec.ts`
- `tests/useAttendanceAdminLeavePolicies.spec.ts`
- `tests/AttendancePayrollAdminSection.spec.ts`
- `tests/useAttendanceAdminPayroll.spec.ts`

Expected assertions:

- builder <-> payload synchronization
- structured summaries
- edit state transitions
- fallback JSON validation

### Type And Build Gates

Required commands for this phase:

```bash
pnpm --filter @metasheet/web exec vitest run tests/AttendanceLeavePoliciesSection.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendancePayrollAdminSection.spec.ts tests/useAttendanceAdminPayroll.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

### Regression Safety Net

The published attendance admin shell should continue to pass its high-signal regression set:

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false
```

## Exit Criteria

The next phase should only be considered ready when:

1. leave approval steps no longer require JSON as the primary authoring surface
2. payroll template semantics no longer require JSON as the primary authoring surface
3. the advanced JSON fallback remains available and synchronized
4. targeted builder tests pass
5. `vue-tsc --noEmit` and `apps/web` build pass
6. published rule/import/scheduling/holiday regressions remain green

## Current Status

As of `2026-03-22`, this verification document is a prepared gate for the next round, not a completed validation record.
