# Multitable Post-Commit Hooks Development - 2026-04-24

## Goal

Replace the direct Yjs invalidator seam in multitable record writes with a generic post-commit hook seam.

This keeps REST/Yjs consistency cleanup in the authoritative write path, while avoiding a permanent dependency from `RecordWriteService` and `RecordService` to Yjs-specific infrastructure.

## Scope

- Added `packages/core-backend/src/multitable/post-commit-hooks.ts`.
- Updated `RecordWriteService` to accept `RecordPostCommitHook[]`.
- Updated `RecordService` to accept `RecordPostCommitHook[]`.
- Kept `setYjsInvalidator(...)` as a compatibility shim.
- Updated app boot and `univer-meta` route wiring to install `createYjsInvalidationPostCommitHook(...)`.
- Updated focused unit/integration assertions to use the generic hook seam.

## Design

The new hook context is intentionally small:

- `recordIds`
- `sheetId`
- `actorId`
- `source`

`createYjsInvalidationPostCommitHook(...)` preserves the previous source rule:

- REST/default writes invalidate Yjs state.
- `source === 'yjs-bridge'` skips invalidation.
- Empty record sets are ignored.

Hooks run immediately after the DB transaction succeeds, before lookup/rollup recomputation, summary rebuild, and realtime/eventBus fan-out. This preserves the Yjs invalidation timing requirement: cancel pending bridge flushes as soon as the authoritative REST write commits. Hook failures are best-effort: they are logged, later hooks still run, and the record write is not rolled back after the transaction has already committed.

## Compatibility

Existing callers that still use `setYjsInvalidator(...)` continue to work. New boot wiring uses `setPostCommitHooks(...)` directly.

The route-level direct-SQL PATCH path still receives the same Yjs invalidation behavior because `univer-meta` now installs the hook after constructing the service.

## Files

- `packages/core-backend/src/multitable/post-commit-hooks.ts`
- `packages/core-backend/src/multitable/record-write-service.ts`
- `packages/core-backend/src/multitable/record-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/tests/unit/record-write-service.test.ts`
- `packages/core-backend/tests/unit/record-service.test.ts`
- `packages/core-backend/tests/unit/yjs-rest-invalidation.test.ts`
- `packages/core-backend/tests/integration/multitable-record-patch.api.test.ts`

## Remaining Work

No functional follow-up is required for this slice.

Optional follow-up: migrate future post-commit side effects such as audit-side cache invalidation or attachment-derived cleanup onto the same hook interface instead of adding new constructor arguments.
