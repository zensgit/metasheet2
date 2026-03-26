# Multitable OpenAPI Parity Design

Date: 2026-03-26
Branch: `codex/multitable-next`

## Goal

Close the contract gap between the live multitable runtime and the published OpenAPI without touching the user's in-progress multitable UI work.

## Scope

This slice updates only the multitable OpenAPI source, generated artifacts, and a focused contract test.

Included:

- add `POST /api/multitable/person-fields/prepare`
- add `DELETE /api/multitable/sheets/{sheetId}`
- add `PATCH /api/multitable/records/{recordId}`
- add `config` to multitable view schema and create/update request bodies
- add select-field `options` to `MultitableField`
- add attachment summary maps to the view payload and record/form/submit/patch result schemas
- add selector constraints where OpenAPI request bodies can express `sheetId | viewId`
- add a focused parity test that locks the above contract points

Excluded:

- multitable workbench UI changes
- dirty WIP under `apps/web/src/multitable/**`
- pilot release-gate script cleanup

## Why this slice first

The runtime and frontend types already depend on these fields and routes:

- `packages/core-backend/src/routes/univer-meta.ts`
- `apps/web/src/multitable/types.ts`

But `packages/openapi/src/paths/multitable.yml` and `packages/openapi/src/base.yml` were missing or under-describing them. That drift breaks generated clients, downstream contract checks, and release confidence.

## Design

### 1. Promote attachment summaries to first-class schemas

Add:

- `MultitableAttachmentSummaryMap`
- `MultitableViewAttachmentSummaries`

These mirror the runtime shape already returned by the grid and form/record flows.

### 2. Stop inlining stale response shapes

Introduce or complete reusable schemas for:

- `MultitableViewData`
- `MultitablePersonFieldPrepareResult`
- `MultitableRecordMutationResult`
- `MultitableFormSubmitResult`
- `MultitablePatchResult`

This keeps path entries smaller and makes future drift easier to spot.

### 3. Align view config with runtime

`meta_views.config` is already persisted and returned by the backend, so `MultitableView` plus the create/update request bodies must expose `config`.

### 4. Document select options and selector semantics

`MultitableField` now exposes select `options`, matching the serialized field rows already returned by runtime.

For operations that resolve a sheet from `sheetId` or `viewId`, the contract now does two things:

- request bodies use `anyOf` where OpenAPI can express the selector requirement
- query-parameter operations add explicit descriptions where OpenAPI cannot express cross-parameter requirements cleanly

### 5. Add a narrow parity test

Add a node test that reads `packages/openapi/dist/openapi.json` and asserts the exact routes and schema refs added by this slice. This prevents the same drift from reappearing silently.

## Expected outcome

After this change, OpenAPI becomes a faithful description of the multitable runtime for:

- direct grid view load
- person field preset preparation
- single-record patch
- batch patch
- record/form context
- form submit
- view config persistence

This is a higher-fidelity contract than the previous baseline and moves the multitable slice closer to release-grade parity.
