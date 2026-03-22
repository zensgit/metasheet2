# Attendance Release Candidate Design

Date: 2026-03-22
Branch: `codex/attendance-run20-followup-20260320`
PR: `#536`

## Goal

This release candidate upgrades attendance admin from a set of CRUD sections into an explainable low-code control plane.

The release claim is:

> Explainable attendance rule simulation and operator-grade import triage.

## Product Positioning

This branch is closer to a low-code attendance solution inside a platform shell than a narrow attendance SaaS page.

The admin shell is centered in:

- `apps/web/src/views/AttendanceView.vue`

The release-candidate scope hardens these surfaces:

- `AttendanceRulesAndGroupsSection.vue`
- `AttendanceImportWorkflowSection.vue`
- `AttendanceImportBatchesSection.vue`
- `AttendanceSchedulingAdminSection.vue`
- `AttendanceHolidayDataSection.vue`

## Design Areas

### 1. Rule-Set Scenario Lab

The rule-set area now behaves like a simulation surface instead of a JSON-only editor.

Delivered:

- structured builder synchronized with JSON config
- one-click scenario presets
- preview scorecards for flagged rows, clean rows, missing punches, non-working-day rows, and average work minutes
- preview recommendations derived from builder state and result shape

Primary files:

- `apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminRulesAndGroups.ts`

### 2. Explainable Rule Resolution

Preview output is now explainable instead of opaque.

Delivered:

- resolved config panel for server-normalized rule config
- config change summary for changed, added, and removed leaf fields
- row-level diagnosis with severity, metrics, hints, and source payload

This is the main low-code differentiator on the rule side.

### 3. Import Workflow Planning

The import flow now surfaces its execution plan before commit.

Delivered:

- preview/import lane planning
- explicit lane hints for sync, chunked, and async paths
- mapping, user-map, and group-sync summary in the current import plan

Primary files:

- `apps/web/src/views/attendance/AttendanceImportWorkflowSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminImportWorkflow.ts`

### 4. Batch Inbox And Triage Console

The import batch area is now an operator console rather than a plain batch list.

Delivered:

- inbox filters for search, status, engine, source, creator, and created-date window
- time-slice presets
- saved inbox views stored browser-locally and scoped by `orgId`
- selected-batch visibility cues with reveal action
- issue chips, anomaly summary, operator notes, mapping viewer, and snapshot diagnostics

Primary files:

- `apps/web/src/views/attendance/AttendanceImportBatchesSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminImportBatches.ts`

### 5. Safe Rollback And Guided Retry

Operational actions now have explicit safety context.

Delivered:

- loaded-item rollback impact estimate
- exact full-batch impact refresh
- rollback confirmation with impact basis, coverage, committed-row estimate, preview-only rows, warnings, and policy-sensitive rows
- targeted retry guidance based on mapping gaps, warnings, source type, and engine profile

This changes rollback from a blind destructive action into an explained decision.

### 6. Admin Reliability Hardening

The RC also includes reliability fixes that directly improve release readiness:

- admin RBAC compatibility with pre-parsed `req.user.role/permissions`
- batch route ordering fix for `/users/batch/*`
- holiday calendar navigation/selection hardening
- scheduling validation and edit-state feedback

## High-Signal Commit Trail

- `a1a069aef` `feat(attendance-web): add rule set builder preview`
- `d90daf15a` `feat(attendance-web): add anomaly console and rule preview builder`
- `5068631bc` `feat(attendance-web): ship explainable admin labs`
- `526a214c7` `feat(attendance-web): add inbox and config diff`
- `08e84b8c6` `feat(attendance-web): add batch rollback estimates`
- `6d6028e6e` `feat(attendance-web): add full-batch import guidance`
- `3554cb61d` `feat(attendance-web): embed rollback impact confirmation`
- `2edb62ab4` `feat(attendance-web): save batch inbox views`

## Out Of Scope For This RC

- visual builders for leave policies
- visual builders for payroll templates
- attendance-native workflow nodes and templates
- finer-grained data-scope and field-scope permission controls

## Design Recommendation

Do not expand feature scope further on this branch.

This RC already contains the right release shape:

- explainable rule simulation
- operator-grade import triage
- safer rollback and retry flows
- hardened admin reliability
