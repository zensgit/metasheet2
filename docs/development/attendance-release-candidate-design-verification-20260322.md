# Attendance Release Candidate Design And Verification

Date: 2026-03-22
Branch: `codex/attendance-run20-followup-20260320`
PR: `#536`
Merged main commit: `796be28e7de27bd07efed118e79e1fe25e09953e`
Runtime verification baseline head: `2edb62ab42f994f51b979caa8bacbd1ed2ea9d8e`

## 1. Release Candidate Overview

This release candidate turns the attendance admin surface from a set of CRUD-oriented sections into an explainable, operations-ready low-code control plane.

The core release claim is:

> Explainable attendance rule simulation and operator-grade import triage.

Compared with the earlier branch state, this RC now gives administrators three things that were previously too implicit:

1. Simulate rule changes with explainable output instead of only editing JSON.
2. Triage import batches with visibility, diagnosis, and guided actions instead of only browsing rows.
3. Make rollback and retry decisions with impact context instead of destructive blind actions.

## 2. Product Positioning

This branch does not try to compete with pure attendance SaaS on narrow workflows alone. It is closer to a low-code attendance solution built inside a platform shell:

- rule design and simulation
- import mapping and execution planning
- batch inbox triage and rollback analysis
- scheduling, holiday, leave, and payroll administration under one admin shell

The current admin shell lives in:

- `apps/web/src/views/AttendanceView.vue`

Within that shell, the current release candidate hardens these surfaces:

- `AttendanceRulesAndGroupsSection.vue`
- `AttendanceImportWorkflowSection.vue`
- `AttendanceImportBatchesSection.vue`
- `AttendanceSchedulingAdminSection.vue`
- `AttendanceHolidayDataSection.vue`

## 3. Design Summary

### 3.1 Rule-Set Scenario Lab

The rule-set area now behaves like a scenario lab instead of a JSON-only editor.

Delivered design elements:

- structured builder synchronized with JSON config
- one-click scenario presets for on-time, late, early leave, missing check-out, and rest-day overtime
- scorecards for flagged rows, clean rows, missing punches, non-working-day rows, and average work minutes
- preview recommendations generated from builder state and result shape

Primary files:

- `apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminRulesAndGroups.ts`

### 3.2 Explainable Rule Resolution

Preview output is now explainable instead of opaque.

Delivered design elements:

- resolved config panel showing the normalized server-side config
- config change summary for changed, added, and removed leaf fields
- row-level diagnosis with severity, metrics, guidance, and source payload visibility

This is the key design move that makes rule tuning auditable for administrators instead of only readable by developers.

### 3.3 Import Workflow Planning

The import workflow no longer stops at form submission. It now exposes plan-level information before execution.

Delivered design elements:

- execution lane planning for preview and import paths
- lane hints that explain why the system chose sync, chunked, or async execution
- mapping, user-map, and group-sync summary surfaced in the current import plan

Primary files:

- `apps/web/src/views/attendance/AttendanceImportWorkflowSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminImportWorkflow.ts`

### 3.4 Batch Inbox And Triage Console

The import batch area is now an operator console.

Delivered design elements:

- inbox filters for search, status, engine, source, creator, and created-date window
- time-slice presets for today, last 7 days, last 30 days, and this month
- saved inbox views stored browser-locally and scoped by `orgId`
- selected-batch visibility cues with reveal action if filters hide the active batch
- anomaly summary, issue chips, mapping viewer, operator notes, and structured snapshot diagnostics

Primary files:

- `apps/web/src/views/attendance/AttendanceImportBatchesSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminImportBatches.ts`

### 3.5 Safe Rollback And Guided Retry

This RC strengthens operational safety around destructive and recovery actions.

Delivered design elements:

- loaded-item rollback impact estimation
- exact full-batch impact refresh
- rollback confirmation messages with impact basis, coverage, committed-row estimate, preview-only rows, warning rows, and policy-sensitive rows
- targeted retry guidance derived from mapping gaps, warnings, source type, and engine profile

This moves the UX from “rollback if needed” to “rollback with explicit blast-radius context”.

### 3.6 Admin Reliability Hardening

The branch also includes several reliability fixes that directly affect release readiness:

- admin RBAC compatibility so pre-parsed `req.user.role/permissions` are honored correctly
- batch route ordering fix to stop `/users/batch/*` from being shadowed by `/:userId/*`
- holiday calendar navigation/selection hardening
- scheduling validation and edit-state feedback

These fixes reduce failure risk for the administrative path rather than adding isolated UI polish.

## 4. Commit Trail For This RC

High-signal commits in the current RC stack:

- `a1a069aef` `feat(attendance-web): add rule set builder preview`
- `d90daf15a` `feat(attendance-web): add anomaly console and rule preview builder`
- `bae9df58c` `fix(attendance-web): restore admin release build`
- `5068631bc` `feat(attendance-web): ship explainable admin labs`
- `526a214c7` `feat(attendance-web): add inbox and config diff`
- `42941497e` `feat(attendance-web): extend batch inbox filters`
- `08e84b8c6` `feat(attendance-web): add batch rollback estimates`
- `6d6028e6e` `feat(attendance-web): add full-batch import guidance`
- `3554cb61d` `feat(attendance-web): embed rollback impact confirmation`
- `2edb62ab4` `feat(attendance-web): save batch inbox views`

## 5. Verification Baseline

The runtime verification baseline for this RC is head `2edb62ab42f994f51b979caa8bacbd1ed2ea9d8e`.

### 5.1 Local Verification

Frontend verification completed on the RC runtime baseline:

- `pnpm --filter @metasheet/web exec vitest run tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts --watch=false`
  - result: `18 passed`
- `pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false`
  - result: `70 passed`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - result: passed
- `pnpm --filter @metasheet/web build`
  - result: passed

Backend verification completed earlier on the same RC code line before this documentation pass:

- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`
  - result: passed
- `pnpm --filter @metasheet/core-backend exec vitest run src/rbac/__tests__/rbac.test.ts`
  - result: passed
- `pnpm exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts`
  - result: passed

### 5.2 GitHub Checks

GitHub checks for runtime baseline head `2edb62ab42f994f51b979caa8bacbd1ed2ea9d8e` were green on 2026-03-22:

- `coverage`
- `contracts (dashboard)`
- `contracts (openapi)`
- `contracts (strict)`
- `core-backend-cache`
- `e2e`
- `migration-replay`
- `pr-validate`
- `telemetry-plugin`
- `test (18.x)`
- `test (20.x)`

`Strict E2E with Enhanced Gates` was skipped, not failed.

## 6. Release And Publication Outcome

As of 2026-03-22, this branch has already crossed the release gate and been published through the repository's auto-deploy path.

Observed final state:

- `PR #536` merged into `main` at `2026-03-22T10:51:09Z`
- merge commit: `796be28e7de27bd07efed118e79e1fe25e09953e`
- publication workflow:
  - `Build and Push Docker Images`
  - run: `#23401465080`
  - result: `success`
  - deploy completed at `2026-03-22T10:54:34Z`
- companion workflow on the same push:
  - `Deploy to Production`
  - run: `#23401465079`
  - result: `success`
  - `build-and-push` and `deploy` jobs were skipped, so this was not the live deploy path

This means:

1. The branch cleared the PR-level release candidate gate.
2. The merged `main` commit has already been built, pushed, and remotely deployed.
3. The release is live through the repository's standard main-branch deployment path.
4. No new semver tag was minted during this flow; the root package version remains `2.5.0`.

## 7. Out Of Scope For This Release

The following items are intentionally left for the next phase:

- visual builders for leave policies
- visual builders for payroll templates
- attendance-native workflow nodes and templates
- finer-grained data-scope and field-scope permission controls

## 8. Recommendation

Do not continue feature expansion on this already-published line without opening a new follow-up branch.

The correct next action is:

1. treat `796be28e7de27bd07efed118e79e1fe25e09953e` as the released mainline state
2. open a new follow-up branch only for post-release fixes or next-scope enhancements
3. cut a semantic tag only if release bookkeeping requires a named artifact beyond the successful main deployment

This release is justified on the basis of:

- explainable rule simulation
- operator-grade import triage
- safer rollback and retry flows
- validated frontend and backend guardrails
- successful main-branch deployment
