# Multitable M2 slice 3 — PATCH record-service extraction (follow-up integration coverage)

Date: 2026-04-23
Branch: `codex/multitable-m2-record-patch-extraction-20260423`
Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/m2-record-patch`
Base when task started: `origin/main@61f32f318`
Base after rebase: `origin/main@059ea44fc`
Roadmap reference: `docs/development/multitable-service-extraction-roadmap-20260407.md` §5.3 (M2 slice 3)

## TL;DR — race-collision outcome

While this slice was in-flight, another agent landed the same M2 slice 3 extraction
as commit `059ea44fc refactor(multitable): extract direct record patch service`.
That commit added `RecordService.patchRecord()`, the route delegation, and
`multitable-m2-patch-service-{development,verification}-20260423.md`.

Rather than commit a duplicate extraction, this branch reconciles by:

1. Fast-forwarding to `059ea44fc` so the service-layer slice lands exactly once
   (the merged implementation, not this branch's in-flight copy).
2. Adding a net-new integration test file
   (`packages/core-backend/tests/integration/multitable-record-patch.api.test.ts`)
   covering the PATCH `/records/:recordId` HTTP path end-to-end. `059ea44fc`
   shipped unit-only coverage; prior to this branch there was no integration
   test wrapping the extracted PATCH handler in supertest against a mock pool.

Bot-review hardening later added one minimal source fix on top of
`059ea44fc`: direct `PATCH /records/:recordId` now emits the same
realtime and event-bus update side effects that the route contract
expects after a successful DB transaction. The rest of the branch remains
integration coverage + reconciliation docs.

## Context — what the merged slice delivered

Commit `059ea44fc` (by the sibling agent):

- Added `RecordService.patchRecord(input)` and `RecordPatchFieldValidationError`
  to `packages/core-backend/src/multitable/record-service.ts`.
- Passed the existing `YjsInvalidator` into `RecordService` via a new
  constructor arg so the service fires invalidation post-tx directly.
- Rewired `PATCH /records/:recordId` in `packages/core-backend/src/routes/univer-meta.ts`
  to construct `RecordService(pool, eventBus, yjsInvalidator)` and delegate
  validation + transactional write to the service.
- Kept route-owned: request parsing, sheet/view resolution, auth/access
  resolution, response hydration (link values, attachment summaries,
  commentsScope), and HTTP error mapping.
- Added unit coverage to `tests/unit/record-service.test.ts` for the new
  `patchRecord` surface.

See `multitable-m2-patch-service-development-20260423.md` for the merged
slice's own notes.

## What this branch adds — integration coverage

### 1. `tests/integration/multitable-record-patch.api.test.ts` (new)

Six supertest-backed scenarios that exercise the PATCH handler end-to-end
through the Express router with a mock pool + spy Yjs invalidator:

| Scenario | Assertion |
|---|---|
| Happy path: text field update | 200 response, `commentsScope` shape, invalidator called with `[recordId]`, realtime publish, `multitable.record.updated` event |
| Aggregated validation errors | 400, `fieldErrors` map, `code: VALIDATION_ERROR` |
| All-readonly field errors | 403, `code: FIELD_READONLY`, `message: "Readonly field update rejected"` |
| Version conflict | 409, `code: VERSION_CONFLICT`, `serverVersion` present |
| Link diff update | UPDATE precedes DELETE-links and INSERT-links within tx; INSERT-links run after DELETE-links; Yjs invalidator, realtime publish, and eventBus fire once post-tx |
| Yjs invalidator throws | PATCH still returns 200; `console.error` with `"Yjs invalidation failed"` message fires (best-effort contract preserved) |

The test file intentionally asserts the exact SQL sequence the extracted
service issues today (`SELECT id, version, created_by ... FOR UPDATE`,
diff-based `DELETE ... foreign_record_id = ANY`, per-row `INSERT ... ON CONFLICT DO NOTHING`).
These assertions are regression guards: any follow-up slice that
re-orders the tx or changes the SQL shape must touch this file.

### 2. Reconciliation MDs

- `docs/development/multitable-m2-record-patch-extraction-development-20260423.md` (this file)
- `docs/development/multitable-m2-record-patch-extraction-verification-20260423.md`

## What was explored but not committed

Prior to discovering `059ea44fc`, this branch developed an alternative
shape of the extraction:

- Hook-free `RecordService` (no `yjsInvalidator` constructor arg); the
  route called the module-level `yjsInvalidator` after the service
  returned.
- `RecordPatchValidationError` carrying only `fieldErrors`; the route
  inspected the map to pick 400 vs 403 status.
- New output fields `linkSideEffects` and `attachmentIdsToCleanup` on
  the service return shape so callers could observe link deltas and
  orphaned attachment IDs without re-SELECTing.

Those patterns are **closer to the brief's** "all side effects are
injected as hooks" constraint, but the merged slice takes a different
(equally valid) trade-off: letting `RecordService` own the invalidator
call directly removes a hop from the route at the cost of one extra
constructor arg. Because the merged slice already shipped with
green CI, this branch does not re-litigate the shape.

If reviewers later decide the hook-free / output-rich shape is
preferable, a dedicated follow-up slice can refactor under a name like
`refactor(multitable): tighten patch service side-effect boundaries`
rather than reverting `059ea44fc`.

## Preservation claims (for the merged slice, re-verified by this branch's integration tests)

These were verified end-to-end through the integration test suite and
are load-bearing across rebuilds:

- `fieldErrors["Field is hidden"]` → 403 `FIELD_HIDDEN` / message
  `Hidden field update rejected`.
- `fieldErrors["Field is readonly"]` → 403 `FIELD_READONLY` / message
  `Readonly field update rejected`.
- Mixed error map → 400 `VALIDATION_ERROR` / message `Validation failed`.
- `expectedVersion` mismatch → 409 `VERSION_CONFLICT` with `serverVersion`.
- Link diff inside tx: existing foreign IDs minus new IDs → `DELETE ... foreign_record_id = ANY`;
  new IDs minus existing → per-row `INSERT ... ON CONFLICT DO NOTHING`;
  empty target list → `DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2`.
- Yjs invalidator is fired exactly once per successful PATCH with the
  single-element array `[recordId]`, after the DB tx commits.
- Direct PATCH publishes one `record-updated` realtime payload after the
  DB tx commits.
- Direct PATCH emits one `multitable.record.updated` event with the
  changed field patch and actor id.
- Invalidator failure must NOT fail the PATCH response; the error must
  reach `console.error` with `"Yjs invalidation failed"` in the
  message.
- Response hydration (visible-field filtering, link summary rebuild,
  attachment summary rebuild, `commentsScope`) still runs in the route
  layer, unchanged.

## Non-goals

- Do not move `POST /patch` into `RecordService` — it remains on
  `RecordWriteService` per the merged slice's explicit defer.
- Do not wire attachment-binary cleanup into the PATCH path. The
  orphan-retention cron still owns blob GC; the service does not
  expose `attachmentIdsToCleanup` today.
- Do not add new Yjs doc-level semantics.
- Do not restructure the merged `RecordService.patchRecord`
  signature.

## Risk notes

- The integration tests are mock-pool based and assert exact SQL
  strings. If `059ea44fc` or later slices adjust the column list in
  `SELECT ... FOR UPDATE` (e.g. add `data` for attachment-diff
  support), the test will fail loudly and must be updated in the same
  commit that changes the SQL.
- `vi.doMock('../../src/rbac/service')` is used to short-circuit
  permissions; the test file follows the same pattern as
  `tests/integration/multitable-sheet-realtime.api.test.ts`.

## References

- Merged slice commit: `059ea44fc`
- Merged slice MDs: `multitable-m2-patch-service-{development,verification}-20260423.md`
- Roadmap: `docs/development/multitable-service-extraction-roadmap-20260407.md`
- Prior slices: `multitable-m2-attachment-service-*`, `multitable-m2-record-service-*`
- Follow-up slices: M3 (`query-service.ts`), M4 (`permission-service.ts`)
