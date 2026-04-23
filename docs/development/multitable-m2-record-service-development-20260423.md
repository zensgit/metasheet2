# Multitable M2 slice 2 — record-service create/delete extraction

Date: 2026-04-23
Branch: `codex/multitable-m2-record-service-20260423`
Initial base: `main@6d5f965e4`
Rebased base before PR update: `main@78d382aa`

## Goal

Continue the M2 extraction after `attachment-service.ts` by moving direct
record create/delete semantics out of the 7k+ line `univer-meta.ts` route and
into a dedicated backend service seam.

This is intentionally narrower than full record write service unification:

- `POST /records` direct create is extracted
- `DELETE /records/:recordId` direct delete is extracted
- existing `POST /patch` remains owned by `RecordWriteService`
- existing `PATCH /records/:recordId` and form submit paths remain unchanged

## Code changes

### 1. New service

File:
`packages/core-backend/src/multitable/record-service.ts`

Added `RecordService` with:

- `createRecord(input)`
- `deleteRecord(input)`

The service owns the non-HTTP business logic previously inline in the route:

- create field guard construction
- select/link/attachment/formula value handling
- direct field-validation execution
- transactional `meta_records` insert
- `meta_links` fanout on create
- delete preflight / record-level write policy
- transactional `SELECT ... FOR UPDATE`, `expectedVersion` check, link cleanup,
  and `meta_records` delete
- realtime publish and `eventBus.emit`

### 2. Route delegation

File:
`packages/core-backend/src/routes/univer-meta.ts`

The route keeps:

- zod request parsing
- `resolveMetaSheetId`
- request auth/access resolution
- sheet capability resolution
- HTTP status/error mapping

The route delegates create/delete to `RecordService` and translates service
errors back into the existing response shapes.

### 3. Focused unit coverage

File:
`packages/core-backend/tests/unit/record-service.test.ts`

New tests lock:

- create success emits realtime + `multitable.record.created`
- missing link target rejects create
- direct field validation failure rejects create with structured field errors
- delete success emits realtime + `multitable.record.deleted`
- delete `expectedVersion` mismatch raises `VersionConflictError`
- record-level own-write policy blocks delete
- missing delete target raises `RecordNotFoundError`

## Explicit defer

- Do not move `POST /patch`; it is already on `RecordWriteService`
- Do not move `PATCH /records/:recordId`; it has Yjs invalidation and hydration
  semantics that deserve a separate slice
- Do not move form submit create path
- Do not refactor attachment delete
- Do not add new create/delete Yjs bridge semantics

## Risk notes

- This slice is a pure extraction of create/delete semantics; no HTTP contract
  change is intended.
- `RecordService.deleteRecord()` still accepts a route-provided
  `resolveSheetAccess()` callback so Express/user-context capability logic stays
  in the route layer.
