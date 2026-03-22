# Attendance Low-Code Superiority Plan

Date: 2026-03-21
Branch: `codex/attendance-run20-followup-20260320`
PR: `#536`

## Goal

Turn the attendance admin surface from a collection of CRUD sections into a configuration product that is measurably stronger than a typical low-code attendance app in three places:

1. Rule design: not just JSON editing, but explainable simulation.
2. Import operations: not just batch browsing, but anomaly triage and diagnosis.
3. Admin confidence: not just actions, but clear diagnostics, guidance, and verification.
4. Batch discovery: not just a table, but an inbox with explicit scope and filter state.

This plan intentionally defines a release-candidate scope that can be fully landed on the current branch without waiting for new backend APIs.

## Benchmark Framing

Closest benchmark products are low-code platforms with HR/attendance solutions instead of pure attendance SaaS:

- DingTalk Yida official docs: [updates](https://docs.aliwork.com/docs/yida_updates/xkaf5ypaz8chatgg/oktphy8pqlg3p412)
- DingTalk Yida HR/admin scenario docs: [case](https://docs.aliwork.com/docs/yida_qalist/_1/_1/ef8r5r)
- NocoBase workflow integration docs: [workflow http request](https://v2.docs.nocobase.com/cn/integration/workflow-http-request/)
- Airtable automations docs: [automations](https://support.airtable.com/docs/managing-airtable-automations)

## Current Codebase Findings

The codebase already had strong low-code primitives before this phase:

- Configurable attendance rule sets and template versions:
  - `apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue`
  - `apps/web/src/views/attendance/useAttendanceAdminRulesAndGroups.ts`
- Import preview, mapping, execution lane planning, and batch operations:
  - `apps/web/src/views/attendance/AttendanceImportWorkflowSection.vue`
  - `apps/web/src/views/attendance/useAttendanceAdminImportWorkflow.ts`
  - `apps/web/src/views/attendance/AttendanceImportBatchesSection.vue`
  - `apps/web/src/views/attendance/useAttendanceAdminImportBatches.ts`
- Platform-style attendance admin shell:
  - `apps/web/src/views/AttendanceView.vue`

The largest pre-phase gaps were:

1. Rule simulation could preview rows, but could not clearly explain why a row failed.
2. Preview config normalization came back from the API, but the UI did not expose the resolved config.
3. Import batches could summarize anomalies, but snapshot diagnostics and mapping visibility were weak.
4. Existing controls were useful for engineers, but still too implicit for operations users.

## Phase 1 Scope

Phase 1 is the release-candidate scope fully landed in this branch.

### 1. Rule-Set Scenario Lab

Delivered:

- Structured rule builder stays synchronized with JSON config.
- One-click scenario presets:
  - on-time day
  - late arrival
  - early leave
  - missing check-out
  - rest-day overtime
- Preview scorecards:
  - flagged rows
  - clean rows
  - late/early row counts
  - missing punches
  - non-working-day rows
  - average work minutes
- Preview recommendations generated from current builder state and preview result.
- Recommended grace values now represent suggested total grace, not just raw overage.

### 2. Explainable Rule Preview

Delivered:

- Resolved config panel showing the normalized config returned by preview API.
- Config change summary between draft and resolved config:
  - changed leaf fields
  - added defaults
  - removed draft-only values
- Row-level preview diagnosis:
  - selectable preview row
  - severity badge
  - row metrics
  - row-specific guidance
  - source payload viewer

This changes rule preview from a passive result table into a usable simulation/debugging surface.

### 3. Import Batch Triage Console

Delivered:

- Batch inbox filter bar for search, status, engine, source, creator, and created-date window.
- Batch-list time slicing presets on top of manual date-window filters.
- Issue chips and search-based batch item triage.
- Selected batch meta summary.
- Rollback impact estimate based on loaded batch items, with coverage, committed-row estimate, and risk notes.
- Exact full-batch impact refresh that pages through the whole batch before rollback decisions.
- Targeted retry guidance derived from mapping gaps, warnings, policy-sensitive rows, source type, and engine profile.
- Operator notes generated from batch-level anomaly summary.
- Mapping viewer that exposes batch mapping payload instead of only counting fields.
- Selected row detail panel with severity, metrics, warnings, and recommended next steps.
- Structured snapshot diagnostics:
  - metrics
  - policy diagnostics
  - engine diagnostics
- Snapshot actions:
  - copy snapshot JSON
  - toggle raw snapshot

This changes the batch area from “browse rows and maybe rollback” into an operator console.

## Why This Surpasses Baseline Low-Code Attendance Apps

Compared with typical low-code attendance apps built on general form/workflow platforms, this branch now has stronger domain-specific operations in two places:

1. Rule tuning is explainable.
   Generic low-code tools usually expose forms and flows, but not a scenario lab with per-row diagnostics tied to attendance metrics.
2. Import triage is operational.
   Generic low-code tools often stop at import success/failure; this branch exposes batch diagnostics, mapping visibility, snapshot sections, and next-step guidance in one surface.
3. Rollback decisions are explainable.
   Generic low-code tools usually expose a destructive rollback action without showing estimated affected rows, partial coverage, or policy-sensitive records first.
4. Repair paths are explicit.
   Generic low-code tools rarely tell operators whether they should repair mapping, rerun preview, fix upstream API payloads, or prefer rollback; this branch now does.

## Validation Gates

Phase 1 verification commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Post-Phase Backlog

These are intentionally left for the next round, not for this release candidate:

1. Rollback confirmation flows that embed exact full-batch impact directly into the destructive action.
2. Saved inbox views and reusable filter presets for operations teams.
3. Visual builders for leave policies and payroll templates to remove more JSON editing.
4. Attendance-native workflow nodes for exception handling,补卡, leave, and escalation.
5. Data-scope and field-scope permission controls beyond current role templates.

## Release Recommendation

Phase 1 is now large enough to justify merging as a release candidate once CI is green, because it materially upgrades both:

- admin usability
- low-code differentiation

The next release should position this branch as:

“Explainable attendance rule simulation and operator-grade import triage.”
