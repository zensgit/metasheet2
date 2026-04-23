# Multitable M3 query-service extraction development

Date: 2026-04-23
Branch: `codex/multitable-m3-query-service-20260423`
Base: `origin/main@6a677f9c3`

## Scope

M3 extracts the read/query side of `packages/core-backend/src/multitable/records.ts`
into a dedicated seam:

- `listRecords`
- `queryRecords`
- `queryRecordsWithCursor`
- cursor encode/decode helpers
- deterministic record query cache key helper

The public `multitable/records.ts` API remains compatible. Existing callers
that import from `records.ts` continue to work; the file now delegates read
queries to `query-service.ts` and keeps create/patch/delete/get behavior local.

## Design

### New module

`packages/core-backend/src/multitable/query-service.ts` owns query-only behavior:

- sheet/field existence loading before list/query operations
- filter validation against loaded fields
- search normalization
- order normalization
- offset/limit validation
- cursor keyset pagination
- `meta_records.data` JSON normalization for read rows

This separates read-path SQL construction from write-path validation and link
mutation logic.

### Shared errors

`MultitableRecordValidationError` and `MultitableRecordNotFoundError` moved to
`packages/core-backend/src/multitable/record-errors.ts`.

`records.ts` re-exports those classes so existing imports do not change.

### Compatibility wrapper

`records.ts` now:

- re-exports query helper types and functions from `query-service.ts`
- delegates `listRecords`, `queryRecords`, and `queryRecordsWithCursor`
- keeps `getRecord`, `createRecord`, `patchRecord`, and `deleteRecord`
  implementation unchanged

No route or plugin caller was forced to change.

## Non-goals

- No behavior change to filtering, sorting, search, cursor pagination, or cache
  key format.
- No lookup/rollup materialization changes. This slice only creates the seam
  needed for a future query service to own richer read projections.
- No route rewiring. Existing route/plugin imports remain stable through
  `records.ts`.

## Files

- `packages/core-backend/src/multitable/query-service.ts`
- `packages/core-backend/src/multitable/record-errors.ts`
- `packages/core-backend/src/multitable/records.ts`
- `packages/core-backend/tests/unit/multitable-query-service.test.ts`
- `docs/development/multitable-m3-query-service-development-20260423.md`
- `docs/development/multitable-m3-query-service-verification-20260423.md`
