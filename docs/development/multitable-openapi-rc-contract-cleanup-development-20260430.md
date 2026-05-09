# Multitable OpenAPI RC Contract Cleanup - Development - 2026-04-30

## Context

Phase 3 closes the Feishu RC contract drift found after the XLSX backend route merge. The goal is to make OpenAPI, generated dist artifacts, and backend runtime validation agree on the multitable field/view surface before staging RC smoke.

Base:

- Worktree: `/tmp/ms2-openapi-rc-contract-20260430`
- Branch: `codex/multitable-openapi-rc-contract-cleanup-20260430`
- Base commit: `origin/main@751cb8439` after clean rebase
- Preceding dependency: `#1275` XLSX backend routes merged at `5c4130913`

## Changes

### Field Type Contract

Added a shared `MultitableFieldType` schema in `packages/openapi/src/base.yml` and pointed create/update field request schemas at it.

The enum now covers the runtime field surface:

- `string`
- `number`
- `boolean`
- `date`
- `formula`
- `select`
- `multiSelect`
- `link`
- `lookup`
- `rollup`
- `attachment`
- `currency`
- `percent`
- `rating`
- `url`
- `email`
- `phone`
- `longText`

Backend Zod validation in `packages/core-backend/src/routes/univer-meta.ts` now uses the same widened field type set for create/update field routes. This prevents OpenAPI from advertising types that the route layer rejects, and prevents MF2 field types from being treated as frontend-only.

`mapFieldType()` also now preserves the batch1 field types instead of falling back to `string`. The focused integration test caught this as a real response-shape bug after Zod accepted `currency` but `serializeFieldRow()` returned `type: "string"`.

### View Type Contract

Added a shared `MultitableViewType` schema and pointed view response/create/update contracts at it.

The enum now covers:

- `grid`
- `form`
- `kanban`
- `gallery`
- `calendar`
- `timeline`
- `gantt`
- `hierarchy`

This makes Gantt and Hierarchy explicit API-level contracts instead of unconstrained strings.

### XLSX Route Audit

Confirmed Phase 2 XLSX routes are present in OpenAPI:

- `POST /api/multitable/sheets/{sheetId}/import-xlsx`
- `GET /api/multitable/sheets/{sheetId}/export-xlsx`

Added the `Content-Disposition` response header to the export contract so the OpenAPI source documents the binary filename behavior already implemented by the backend.

### Guardrail

Extended `scripts/ops/multitable-openapi-parity.test.mjs` to assert:

- Field type enum exactly matches the RC runtime surface.
- View type enum exactly matches the RC view surface.
- Create/update field route schemas use `MultitableFieldType`.
- Create/update view route schemas use `MultitableViewType`.
- XLSX import/export routes exist.
- XLSX export documents truncation and content-disposition headers.

### Generated Artifacts

Regenerated:

- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`

## Scope Control

In scope:

- OpenAPI schema cleanup.
- Generated OpenAPI dist refresh.
- Backend field type validation parity.
- Backend field response serialization parity for batch1 field types.
- Focused integration/parity tests.
- TODO status update for Phase 2 merge and Phase 3 completion.

Out of scope:

- Frontend UI changes.
- New field implementations.
- New view implementations.
- Staging smoke execution.
- System fields, record history, subscriptions.

## Files Changed

- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/multitable.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/multitable-context.api.test.ts`
- `scripts/ops/multitable-openapi-parity.test.mjs`
- `docs/development/multitable-feishu-rc-todo-20260430.md`
- `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
- `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`
