# Multitable System Fields Backend - Development - 2026-04-30

## Context

This is the first Phase 4 slice from `docs/development/multitable-feishu-rc-todo-20260430.md`.

The slice deliberately implements the backend seam for stable system fields before attempting frontend configuration polish. The main design decision is to avoid a fake `autoNumber` implementation: row-number style derivation is not stable under delete/import/concurrent create, so `autoNumber` remains deferred until a persistent sequence design is agreed.

Base:

- Worktree: `/tmp/ms2-system-fields-backend-20260430`
- Branch: `codex/multitable-system-fields-backend-20260430`
- Base commit: `origin/main@9d148580`

## Implemented Scope

### System Field Types

Added backend/OpenAPI support for:

- `createdTime`
- `modifiedTime`
- `createdBy`
- `modifiedBy`

Touched contract surfaces:

- `packages/core-backend/src/multitable/field-codecs.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/openapi/src/base.yml`
- `scripts/ops/multitable-openapi-parity.test.mjs`

### Readonly Enforcement

System fields are always readonly through `isFieldAlwaysReadOnly()`.

This means the existing authoritative write guards reject user writes through:

- `RecordWriteService.validateChanges()`
- `RecordService.patchRecord()`
- route-level field mutation guard maps built from `isFieldAlwaysReadOnly()`
- XLSX import/export writable-field filtering through the same permission derivation helper

### Metadata Projection

`query-service` now selects record metadata:

- `created_at`
- `updated_at`
- `created_by`
- `modified_by`

When a sheet has system fields, `mapRecordRow()` injects the corresponding metadata value into `record.data[field.id]`. This overwrites any forged JSON value for that system field ID in `meta_records.data`.

### `modified_by` Persistence

Added migration:

- `packages/core-backend/src/db/migrations/zzzz20260430163000_add_meta_record_modified_by.ts`

Behavior:

- Adds nullable `meta_records.modified_by`.
- Backfills `modified_by = created_by` where possible.
- Adds `idx_meta_records_modified_by`.

Write paths updated:

- `RecordService.createRecord()` sets `created_by` and `modified_by` to the actor.
- `RecordService.patchRecord()` sets `modified_by` to `actorId ?? access.userId`.
- `RecordWriteService.patchRecords()` sets `modified_by` to the patch actor.
- Direct public-form route update path sets `modified_by` to the request actor.
- Attachment delete record-patch path sets `modified_by` to the request actor.

### CI Contract Tightening

The first PR CI run exposed three test doubles with over-specific SQL matching:

- `multitable-records.test.ts` matched only `SELECT id, sheet_id, version, data FROM ...`.
- `multitable-xlsx-routes.test.ts` matched only the pre-metadata record projection.
- `multitable-record-patch.api.test.ts` expected the old three-parameter `UPDATE meta_records` call.

Those tests now match the stable semantic SQL shape instead of the full column list, and PATCH integration assertions include the `modified_by` actor parameter.

## Deferred

`autoNumber` is not included in this slice.

Reason: stable Feishu-like auto number needs a persistent allocation model, not a derived row index. A later slice should define field-level sequence state and create-time allocation semantics.

## Files Changed

- `packages/core-backend/src/db/migrations/zzzz20260430163000_add_meta_record_modified_by.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/multitable/field-codecs.ts`
- `packages/core-backend/src/multitable/permission-derivation.ts`
- `packages/core-backend/src/multitable/query-service.ts`
- `packages/core-backend/src/multitable/record-service.ts`
- `packages/core-backend/src/multitable/record-write-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/unit/multitable-query-service.test.ts`
- `packages/core-backend/tests/unit/multitable-records.test.ts`
- `packages/core-backend/tests/unit/record-service.test.ts`
- `packages/core-backend/tests/unit/record-write-service.test.ts`
- `packages/core-backend/tests/integration/multitable-record-patch.api.test.ts`
- `packages/core-backend/tests/integration/multitable-xlsx-routes.test.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `scripts/ops/multitable-openapi-parity.test.mjs`
- `docs/development/multitable-system-fields-backend-development-20260430.md`
- `docs/development/multitable-system-fields-backend-verification-20260430.md`
