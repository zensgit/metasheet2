# Multitable Sheet Permission Fixture Refresh Development Notes

Date: 2026-05-05
Branch: `codex/multitable-permission-fixture-20260505`

## Scope

This change refreshes the integration-test fixture for
`packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts`.

No production code is changed.

## Problem

The multitable sheet permission integration suite drifted behind the current
runtime query surface. The runtime now routes more record writes through
`RecordService` / `RecordWriteService` and permission candidates through the
shared permission service. The test fixture still mocked older SQL shapes, so
valid runtime paths failed with `Unhandled SQL in test`.

The failing areas were:

- Candidate eligibility now performs batch permission checks across
  `user_permissions`, `user_roles`, role permissions, and legacy `users.permissions`.
- Record create uses the current `created_by` parameter shape where `version` is
  a SQL literal.
- Patch/delete paths can lock records while returning `data` in addition to
  ownership and version fields.
- Record writes emit revision rows, formula dependency probes, and best-effort
  subscriber notification queries.

## Implementation

The fixture-level `createMockPool()` now accepts the existing `userPermissionMap`
so shared mock SQL can reuse each test's permission setup instead of duplicating
candidate filtering logic in every case.

Added generic fixture handlers for:

- Batch user permission eligibility:
  `user_permissions` joined through `user_roles` and `role_permissions`.
- Admin-role eligibility lookup through `user_roles`.
- Bulk role permission lookup by role id array, bridged to the tests' existing
  single-role lookup handlers.
- Legacy `users.permissions` fallback eligibility.
- AutoNumber sheet advisory-lock acknowledgements for create-record paths that
  now pass through `RecordService.createRecord()`.
- `meta_record_revisions` insert acknowledgements.
- Formula dependency recalculation probes with no dependent formula fields.
- `meta_record_subscriptions` best-effort notification lookups with no
  subscribers.

The write-own cases were updated to match the current record-service shapes:

- Create-record fixture reads params as `[recordId, sheetId, dataJson, createdBy]`.
- Patch fixture supports both old and current `FOR UPDATE` projections and
  returns `data` when the runtime requests it.
- Delete fixture supports `SELECT id, sheet_id, version, data ... FOR UPDATE`.

## Parallel Review

A read-only explorer independently inspected the same failures and reached the
same conclusion: this was test fixture drift, not a product-code regression.
The explorer specifically recommended keeping all behavior assertions unchanged,
which this patch does.

## Non-Goals

- No route, service, permission, or database behavior changes.
- No assertion relaxation.
- No broader multitable permission refactor.
