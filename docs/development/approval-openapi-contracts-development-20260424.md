# Approval OpenAPI Contracts Development - 2026-04-24

## Goal

Bring the approval OpenAPI contract and generated SDK back in line with the live approval routes that have landed across WP2/WP3/WP4.

The main gap was that runtime routes had moved to direct response shapes and new inbox/read/remind endpoints, while the OpenAPI package still described older or missing contracts.

## Scope

- Updated `packages/openapi/src/paths/approvals.yml`.
- Added missing approval response schemas in `packages/openapi/src/base.yml`.
- Added generated SDK type coverage in `packages/openapi/dist-sdk/tests/approval-paths.test.ts`.
- Regenerated `packages/openapi/dist/*`.
- Regenerated `packages/openapi/dist-sdk/index.d.ts`.
- Fixed `packages/openapi/tools/validate.ts` for ESM execution.
- Added missing shared baseline schemas/responses that blocked SDK generation:
  - `DirectErrorResponse`
  - `AttendancePunchEvent`
  - `Conflict`

## Contract Decisions

Approval runtime routes now use direct response objects, not `{ ok, data }` wrappers, for the core list/detail/create/action/template paths documented in this slice.

Newly documented live routes:

- `GET /api/approvals`
- `GET /api/approvals/pending`
- `POST /api/approvals/sync/plm`
- `GET /api/approvals/{id}`
- `POST /api/approvals/{id}/actions`
- `GET /api/approvals/{id}/history`
- `GET /api/approvals/pending-count`
- `POST /api/approvals/{id}/mark-read`
- `POST /api/approvals/mark-all-read`
- `POST /api/approvals/{id}/remind`

Template direct responses were also aligned for create/get/patch/publish/version detail routes.

## Compatibility

`UnifiedApprovalHistoryDTO` now includes deprecated snake_case aliases beside camelCase fields. It only requires `id` and `action`, because the platform route can return snake_case DB rows without camelCase `toStatus` or `metadata`.

`GET /api/approvals/pending` stays documented as legacy/deprecated and points consumers toward `GET /api/approvals?tab=pending`.

## Tooling Fix

`packages/openapi/tools/validate.ts` used `__dirname` in an ESM package. It now derives `__dirname` from `import.meta.url`.

The validator whitelist also now includes `/api/health`, matching the actual API path.

## Files

- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/approvals.yml`
- `packages/openapi/tools/validate.ts`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist-sdk/index.d.ts`
- `packages/openapi/dist-sdk/tests/approval-paths.test.ts`

## Remaining Work

This slice closes the approval contract gap currently visible in the generated SDK.

Follow-up candidates:

- Add runtime HTTP contract tests that compare selected live responses against generated OpenAPI schemas.
- Sweep non-approval domains for stale wrapper-vs-direct response drift.
