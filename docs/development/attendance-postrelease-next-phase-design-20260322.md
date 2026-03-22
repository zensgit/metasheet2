# Attendance Post-Release Next-Phase Design

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Published baseline main commit: `f81254d8cb3e88fd1fdfb5118287df044926dacd`
Runtime release commit: `796be28e7de27bd07efed118e79e1fe25e09953e`

## Goal

Start the next attendance iteration from the published explainable-admin baseline and remove the largest remaining low-code gaps that still require raw JSON or disconnected workflow surfaces.

The next-phase claim is:

> Visual leave, payroll, and approval configuration on top of the already-published explainable admin shell.

## Released Baseline

The published baseline already includes:

- explainable rule simulation
- import workflow lane hints and plan summaries
- batch inbox triage, rollback impact estimation, and guided retry
- admin reliability hardening for scheduling, holidays, RBAC, and batch routes

The current gaps are no longer in rule/import operations. They are in higher-level policy authoring.

## Current Code Findings

### 1. Leave And Approval Policies Still Depend On Raw Text And JSON

Current UI:

- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`

Observed gaps:

- approval flow steps are still authored through `Steps (JSON)`
- leave types and overtime rules are form-based, but not composed into reusable policy presets
- workflow design capability exists, but the leave-policy page does not project approval flow editing into a visual flow builder

### 2. Payroll Templates Still Depend On `config` JSON

Current UI and state:

- `apps/web/src/views/attendance/AttendancePayrollAdminSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminPayroll.ts`

Observed gaps:

- payroll template authoring still exposes `Config (JSON)`
- template metadata is editable, but template semantics are not broken into structured builder fields
- cycle generation is operationally useful, but template design is still engineering-oriented

### 3. Workflow Designer Exists But Is Not Attendance-Native

Current workflow surface:

- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- `apps/web/src/views/WorkflowDesigner.vue`

Observed gaps:

- workflow capability is still presented as a separate shell
- leave approval steps and workflow designer do not share a visible authoring model
- attendance-specific nodes, templates, and routing shortcuts are not surfaced from the attendance admin experience

## Next-Phase Scope

This phase should stay frontend-first and reuse existing APIs and payload shapes where possible.

### 1. Visual Approval Flow Builder

Target:

- replace `Steps (JSON)` editing with a structured step builder
- support step cards with:
  - step name
  - approver role ids
  - optional condition summary
  - reordering
  - duplicate/remove actions
- keep a synchronized advanced JSON fallback for power users
- add a read-friendly preview summary for the final flow

Primary touchpoints:

- `AttendanceLeavePoliciesSection.vue`
- `useAttendanceAdminLeavePolicies.ts`

### 2. Leave Policy Presets And Policy Summary

Target:

- lift leave type + overtime rule + approval flow into a more explainable policy surface
- add preset chips or starter patterns for common requests:
  - paid leave with approval
  - unpaid leave with attachment
  - overtime with approval
  - missed punch correction
- expose policy summary cards instead of only tabular rows

### 3. Visual Payroll Template Builder

Target:

- replace `Config (JSON)` editing with structured sections for:
  - summary rules
  - allowance toggles
  - export metadata
  - settlement notes
- keep a synchronized advanced JSON fallback
- show a compact template summary so operators can compare templates without opening raw config

Primary touchpoints:

- `AttendancePayrollAdminSection.vue`
- `useAttendanceAdminPayroll.ts`

### 4. Attendance-Native Workflow Handoff

Target:

- add a clear handoff from approval flow editing to workflow design
- provide attendance-native starter templates:
  - leave approval
  - overtime approval
  - missed punch correction
  - time correction escalation
- do not attempt full workflow-engine redesign in this phase

## Non-Goals

This phase should not:

- redesign published rule simulation or import triage
- add brand-new backend attendance policy APIs unless the current payload shape blocks structured authoring
- attempt full payroll settlement or finance-grade calculation engines
- attempt fine-grained field/data permission controls in the same iteration

## Delivery Strategy

1. Land visual builders on top of current payload contracts.
2. Keep advanced JSON fields as synchronized fallback, not as the primary UX.
3. Add tests around builder-to-payload synchronization and edit flows.
4. Keep workflow integration shallow but explicit in this phase.

## TODO

- [ ] Add approval-flow step builder in `AttendanceLeavePoliciesSection.vue`
- [ ] Add approval-flow summary and advanced JSON fallback
- [ ] Add leave/overtime starter presets and policy summary cards
- [ ] Add payroll-template structured builder sections
- [ ] Add payroll-template summary cards and JSON fallback
- [ ] Add attendance-native workflow handoff entry points
- [ ] Add targeted tests for leave and payroll authoring flows

## Recommendation

The next meaningful low-code win is no longer more diagnostics. It is converting the remaining authoring surfaces from raw JSON into visual builders while preserving the published explainable admin foundation.
