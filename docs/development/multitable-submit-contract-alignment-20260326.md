# Multitable Submit Contract Alignment

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Goal

Align pilot smoke, readiness, backend contract coverage, and operator evidence around the real multitable form submit endpoint:

- runtime/client contract: `POST /api/multitable/views/:viewId/submit`
- smoke/readiness check name: `api.multitable.view-submit`

This slice stays intentionally clear of the in-progress multitable UI files in the worktree and only tightens clean script, backend integration, and deployment-template surfaces.

## Why

Before this change:

- live smoke still posted to `/api/views/:viewId/submit`
- smoke/readiness still used the old check name `api.multitable.legacy-submit`
- pilot acceptance docs still described a legacy submit path
- backend integration had direct patch coverage already, but lacked an explicit missing-record case and lacked any delete-sheet contract coverage

That left a drift between runtime, client, operator evidence, and release gating.

## Scope

### 1. Live smoke and readiness

- rename `submitLegacyForm()` to `submitViewForm()`
- switch the smoke POST target to `/api/multitable/views/:viewId/submit`
- rename the emitted smoke/readiness check from `api.multitable.legacy-submit` to `api.multitable.view-submit`
- rename metadata from `legacySubmitRecordId` to `viewSubmitRecordId`

### 2. Focused backend contract coverage

- add `DELETE /api/multitable/sheets/:sheetId` success and not-found tests
- add `PATCH /api/multitable/records/:recordId` not-found coverage for the focused direct endpoint

### 3. Operator/UAT evidence wording

- update the UAT template to reference the real submit path instead of a legacy route

## Files

- `scripts/verify-multitable-live-smoke.mjs`
- `scripts/ops/multitable-pilot-readiness.mjs`
- `scripts/ops/multitable-pilot-readiness.test.mjs`
- `packages/core-backend/tests/integration/multitable-context.api.test.ts`
- `packages/core-backend/tests/integration/multitable-record-form.api.test.ts`
- `docs/deployment/multitable-uat-signoff-template-20260323.md`

## Design Notes

- The check rename is intentionally narrow. It does not add a new capability; it removes a stale name that no longer matches runtime.
- The new backend tests target existing clean integration files so the canonical release gate gets stronger without expanding into the dirty UI workbench files.
- The UAT template now asks operators to verify the actual supported endpoint, keeping sign-off language consistent with runtime and smoke evidence.
