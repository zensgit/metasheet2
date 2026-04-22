# Approval integration fixture — advisory-lock serialization

- Branch: `codex/approval-fixture-advisory-lock-20260421`
- Worktree: `.worktrees/fixture-lock`
- Baseline: `origin/main@6c5c652d1` (`feat(infra): add Redis runtime stores for token bucket and circuit breaker (#1016)`)
- Date: 2026-04-21

## 1. Scope

Eliminate the file-parallel DDL race observed during the 2026-04-21 WP1 or-mode
rebase verification. Previously the two approval integration test files each
defined a local `ensureApprovalTables()` with a non-atomic DDL sequence
(`DROP CONSTRAINT IF EXISTS` followed by `ADD CONSTRAINT`; `DROP INDEX IF EXISTS`
followed by `CREATE UNIQUE INDEX`). Running both files in a single vitest
invocation under default file-parallelism let the two workers' `beforeAll`
phases interleave on the shared catalog and emit `42710` (duplicate_object)
or `23505` (pg_class unique violation). The workaround in that PR was to run
the two files in separate `vitest run` invocations; this change removes the
need for that workaround.

The DDL itself is not changing — just how concurrent callers serialize.

## 2. Design

### 2.1 Advisory lock semantics

The shared helper acquires `pg_advisory_xact_lock(hashtext('approval-schema-bootstrap'))`
at the top of a `BEGIN ... COMMIT` envelope.

- `pg_advisory_xact_lock` is released automatically on `COMMIT` or `ROLLBACK`,
  so we don't need an explicit unlock path and we can't leak the lock on a
  thrown error.
- The single-argument form takes an `int8`; `hashtext` returns `int4` which
  Postgres up-casts transparently. No explicit cast is required.
- Advisory locks are mutually exclusive on the same key — the second worker
  that tries to acquire it blocks until the first commits or rolls back.

### 2.2 Client-scope vs pool-scope — why `pg.Pool.connect()`

Advisory locks are **owned by a Postgres backend (session)**, not by the pg
client pool. If the helper issued DDL via `ConnectionPool.query(...)`, each
statement could be checked out on a different backend and the lock would not
protect subsequent statements. The helper therefore:

1. reaches through `poolManager.get().getInternalPool()` to the underlying
   `pg.Pool` (the `ConnectionPool` wrapper does not expose `connect()`
   directly — `.transaction()` is the closest, but it packages its own
   BEGIN/COMMIT and doesn't match the manual envelope the task requires);
2. calls `pool.connect()` once to pin a dedicated `PoolClient` / backend;
3. issues `BEGIN`, `pg_advisory_xact_lock(...)`, every DDL statement, and
   `COMMIT` through that same client;
4. in `catch`, calls `ROLLBACK` (swallowing a second-level error so the
   original cause surfaces), then `throw`;
5. in `finally`, calls `client.release()` so the connection returns to the
   pool regardless of outcome.

Only `ensureApprovalSchemaReady` is exported. No leaked internals.

### 2.3 DDL body

The two original `ensureApprovalTables` bodies were byte-for-byte identical
apart from a comment block in Pack 1A referencing the source migrations. The
shared helper preserves those migration references (they are a useful
signpost for future maintainers) and otherwise adopts the DDL verbatim.

## 3. Files

- **Added** `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts`
  — the serialized schema bootstrap.
- **Modified** `packages/core-backend/tests/integration/approval-wp1-any-mode.api.test.ts`
  — removed the local `ensureApprovalTables` body, imported
  `ensureApprovalSchemaReady` from the new helper, replaced the single call
  site in `beforeAll`.
- **Modified** `packages/core-backend/tests/integration/approval-pack1a-lifecycle.api.test.ts`
  — same refactor shape.

No business assertions, fixtures, or `describeIfDatabase` guards were
altered.

## 4. Follow-ups

- If future integration tests need the same schema bootstrap, they should
  import `ensureApprovalSchemaReady` rather than copy-pasting the DDL —
  parallel execution only stays safe if **every** caller passes through the
  advisory lock.
- The long-term fix is to run migrations (`20250924105000`,
  `zzzz20260404100000`, `zzzz20260411120100`, `zzzz20260411123000`) once
  from a shared `globalSetup` hook rather than bootstrapping idempotently in
  each `beforeAll`. That is out of scope for this PR but would let us drop
  the helper entirely.
