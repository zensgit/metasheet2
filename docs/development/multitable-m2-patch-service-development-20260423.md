# Multitable M2 slice 3 — direct PATCH service extraction

Date: 2026-04-23
Branch: `codex/multitable-m2-patch-service-20260423`
Base: `main@61f32f318`
Paired with: `docs/development/multitable-m2-patch-service-verification-20260423.md`

## Goal

Continue the M2 backend extraction after `attachment-service.ts` and
`record-service` create/delete by moving the direct `PATCH /records/:recordId`
mutation seam out of `univer-meta.ts` and into `RecordService`.

This slice targets only the legacy direct record patch endpoint. It does not
change the authoritative batch patch path owned by `RecordWriteService`.

## Code changes

### 1. `RecordService.patchRecord()`

File: `packages/core-backend/src/multitable/record-service.ts`

Added `patchRecord(input)` to own the non-HTTP mutation semantics previously
inline in the route:

- field mutation guard construction from current sheet fields
- hidden/read-only/lookup/rollup rejection
- select option validation
- link normalization, single-link enforcement, linked-record existence checks
- attachment id normalization and attachment existence checks
- row-level `own-write` enforcement through shared `ensureRecordWriteAllowed`
- `expectedVersion` conflict check under `SELECT ... FOR UPDATE`
- `meta_records.data` patch + `version++`
- `meta_links` delta mutation for link fields
- best-effort Yjs invalidation after commit

The route still owns request parsing, sheet/view resolution, auth/session access,
capability resolution, HTTP status mapping, and response hydration.

### 2. Route delegation

File: `packages/core-backend/src/routes/univer-meta.ts`

`PATCH /records/:recordId` now delegates its mutation body to
`RecordService.patchRecord()` and then keeps the existing response shaping:

- reload updated row
- hydrate link values
- filter hidden/property-scoped fields
- build attachment summaries
- return the same `commentsScope` shape

The load-bearing Yjs invalidation comment moved from route code into service
behavior. The failure policy is unchanged: invalidator errors are logged and
swallowed so the REST write still succeeds.

### 3. Focused unit coverage

File: `packages/core-backend/tests/unit/record-service.test.ts`

Added direct patch coverage for:

- successful scalar + link patch
- stale link delete and new link insert
- Yjs invalidator call
- hidden field rejection with legacy `FIELD_HIDDEN` / `403` classification
- expectedVersion conflict before update
- own-write policy rejection for non-owned rows

## Explicit defer

- Do not move `POST /patch`; it remains on `RecordWriteService`.
- Do not move public form submit/update paths.
- Do not add new Yjs bridge write semantics.
- Do not change response hydration or comments scope shape.
- Do not add frontend changes.

## Risk notes

- The service now reloads sheet fields internally for patch validation and
  returns them to the route for response hydration, avoiding a second field
  query in the route.
- The route still performs the initial record lookup so it can resolve sheet
  capabilities before calling the service.
- Yjs invalidation remains best-effort and intentionally does not fail the REST
  patch path.
