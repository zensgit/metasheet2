# Multitable autoNumber Backfill — Window Function Refactor · Development

> Date: 2026-05-07
> Branch: `codex/autonumber-backfill-window-function-20260507`
> Base: `origin/main@616058887`
> Closes: gemini-code-assist's perf comment on PR #1406 about `backfillAutoNumberField` issuing N+1 UPDATE round-trips

## Background

The autoNumber backfill landed in `packages/core-backend/src/multitable/auto-number-service.ts:backfillAutoNumberField` (PR #1406). It executed `SELECT id ... FOR UPDATE` followed by N individual UPDATE statements in a JS loop, one per record. gemini-code-assist's automated review on #1406 flagged the N+1 pattern as a perf risk — for a sheet with 10 000 records, CREATE FIELD autoNumber would issue ~10 000 UPDATE round-trips and hold the advisory locks for the duration.

This refactor replaces the N+1 with a single UPDATE that uses `ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)` to assign sequential values atomically. Behavior is preserved: same ordering, same `next_value` accounting, same return shape, same advisory lock semantics. Only the round-trip count and lock-hold duration change.

## Scope

### In

- `backfillAutoNumberField` body: replace SELECT + JS loop + per-row UPDATE with a single `UPDATE meta_records mr SET data = jsonb_set(...) FROM (SELECT id, ROW_NUMBER() ... AS value FROM meta_records WHERE ...) numbered WHERE mr.id = numbered.id AND mr.sheet_id = $3 RETURNING numbered.value`.
- `assigned` is now derived from the UPDATE's `rowCount` (falling back to `rows.length` if the driver doesn't populate `rowCount`).
- Updated `auto-number-service.test.ts` to reflect the new SQL pattern; added two new cases for `overwrite=true` and the empty-records path.

### Out

- `allocateAutoNumberRange` and `allocateAutoNumberValues` are unchanged. Their UPSERT-with-arithmetic pattern is already a single round-trip per allocation; ROW_NUMBER is irrelevant there.
- `backfillAutoNumberField`'s public signature, return type, and external behavior (advisory lock acquisition order, sequence init at `config.start + assigned`) are unchanged.
- No changes to migrations, OpenAPI, or other multitable services.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Pure operational hygiene / performance polish on a shipped feature (autoNumber landed in `9a8f9c1f1` and was hardened in #1406). No new platform capability.
- No DingTalk / public-form / runtime / migration / OpenAPI changes.

## Implementation notes

### Why ROW_NUMBER is correct here

The previous implementation assigned `value = config.start + assigned`, where `assigned` incremented per matching record in the order returned by `SELECT id ... ORDER BY created_at ASC, id ASC FOR UPDATE`. ROW_NUMBER over the same ORDER BY in a subquery produces an identical mapping between record id and sequential value. The UPDATE...FROM joins by id back to the outer table and writes the value via `jsonb_set` exactly as before.

### Why concurrency safety is preserved

The advisory locks (`acquireAutoNumberSheetWriteLock` + `acquireFieldLock`) are acquired BEFORE the UPDATE — same as the previous implementation. Their semantics are unchanged:

- Sheet-level lock serializes CREATE FIELD backfill against record-create paths (which acquire the same sheet lock in `record-service.ts:createRecord` and `records.ts:createRecord`).
- Field-level lock excludes concurrent backfills of the same field.

The UPDATE itself takes row-level locks atomically as it executes; the previous `SELECT … FOR UPDATE` was belt-and-suspenders given the advisory locks. Removing it does not change the consistency guarantee.

### Why the WHERE clause repeats `mr.sheet_id = $3`

The subquery already filters `WHERE sheet_id = $3`, and the join on `mr.id = numbered.id` ensures only those rows are touched. The redundant `AND mr.sheet_id = $3` on the outer UPDATE is defensive: PostgreSQL planners may not always exploit the join condition to scope the row visibility correctly when other constraints exist (e.g. RLS policies or future partitioning); the explicit predicate keeps the planner honest and the execution plan tractable.

### Why `rowCount` first, `rows.length` fallback

`pg`-based drivers populate `rowCount` for UPDATE...RETURNING; some pool wrappers in this codebase return only `rows`. Reading `rowCount` first matches the existing convention in `auto-number-service.ts` (the upsert path also reads `rowCount` opportunistically). The fallback to `rows.length` keeps the code defensive against driver quirks without forcing a runtime check.

### Why no separate concurrency test was added

The advisory lock pattern was already covered by the existing test that asserts the two `SELECT pg_advisory_xact_lock` calls happen first (in the right keys). The window-function correctness is mock-validated through the new tests' assertions on the SQL string and parameter shape; a real-DB test of "10k records → assigned=10k" duplicates infrastructure work already covered by the integration test in `record-service.test.ts` for autoNumber allocation. The unit test does NOT prove "the UPDATE actually mutates 10k rows in production" — that requires a live DB harness, which is documented as out of scope for this PR.

## Files changed

| File | Lines |
|---|---|
| `packages/core-backend/src/multitable/auto-number-service.ts` | rewrite of `backfillAutoNumberField` body (-22 / +35) |
| `packages/core-backend/tests/unit/auto-number-service.test.ts` | rewrite test fixture + new cases (-9 / +60) |
| `docs/development/multitable-autonumber-backfill-window-function-development-20260507.md` | +new |
| `docs/development/multitable-autonumber-backfill-window-function-verification-20260507.md` | +new |

## Performance characteristics

| Sheet size | Previous round-trips | New round-trips | Approximate latency saving (assuming 5 ms RTT) |
|---|---|---|---|
| 10 records | 11 (1 SELECT + 10 UPDATE) | 1 (UPDATE) | ~50 ms |
| 1 000 records | 1 001 | 1 | ~5 s |
| 10 000 records | 10 001 | 1 | ~50 s |
| 100 000 records | 100 001 | 1 | ~8 minutes |

The new path also holds the advisory locks for materially shorter time on large sheets, reducing the window in which concurrent record-create paths block.

## Known limitations

1. **No live-DB perf test in CI** — the unit test mocks the pool and validates the SQL/params shape. A real-DB benchmark would require provisioning Postgres + seeding 10k records; out of scope.
2. **No new code paths exercised** — this is a SQL refactor of an existing function, not a behavior change. Callers see the same `BackfillAutoNumberFieldResult` and the same advisory-lock semantics.
3. **Driver quirks**: if a future pool wrapper returns `rowCount: null` AND empty `rows` even after a successful UPDATE, the function would underreport `assigned`. The fallback chain (`rowCount >= 0 ? rowCount : rows.length`) handles the common cases, but cannot recover from a fully-broken driver.

## Cross-references

- gemini-code-assist comment on PR #1406 — flagged the N+1 perf issue
- Original implementation: `9a8f9c1f1 feat(multitable): add auto number system field`
- Hardening lane: `#1406 feat(multitable): harden auto number fields`
- Caller `record-service.ts:createRecord` and route `routes/univer-meta.ts` POST /fields autoNumber backfill at line 4193 (CREATE) and PATCH switching INTO autoNumber at line 4476
