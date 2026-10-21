/**
 * Transaction-bound `ConnectionPool` facade for `RecordService` (设计锁 ADR
 * docs/development/multitable-copy-sheet-with-data-adr-20260926.md §7.2, CS-15, CS-18).
 *
 * WHY THIS EXISTS. `RecordService.createRecord` is the ONE record write entry point and it opens its own
 * `pool.transaction(...)` per row. Every `RecordService` in the repo is built with the real pool
 * (`new RecordService(pool, eventBus)` — `univer-meta.ts` import-xlsx / duplicate, `automation-service.ts`),
 * so per-row COMMITs are the norm there. The copy-sheet action must instead be ALL-OR-NOTHING (CS-18: a
 * failure at row k leaves ZERO rows for the new sheet id in every table), so the 2000 `createRecord` calls
 * have to run INSIDE the copy route's single transaction. The ADR names the shape and states there is no
 * precedent (§7.2 "没有现成先例"):
 *
 *     new RecordService({ query: txQuery, transaction: (h) => h({ query: txQuery }) }, eventBus)
 *
 * This module is that shape, as a named, tested value rather than an inline literal at the call site.
 *
 * WHAT IT DOES. `query` is the caller's in-transaction query handle. `transaction(handler)` does NOT issue
 * `BEGIN` / `COMMIT` / `ROLLBACK` and does not take a connection: it invokes `handler` with the SAME
 * `query`, so everything the service writes lands in the caller's transaction and rolls back with it. A
 * throw propagates unchanged — the CALLER's `pool.transaction` is what rolls back.
 *
 * WHAT IT MUST NOT BE USED FOR. Anything that relies on `pool.transaction` COMMITTING (post-commit hooks,
 * "the row is visible to other connections now" assumptions). The copy path suppresses every post-commit
 * side effect of `createRecord` via `input.copy` (CS-19), so nothing in it observes a commit that never
 * happens per row. Advisory locks taken through this facade belong to the caller's transaction and are
 * released at ITS end — exactly what §7.2 step 4/5 relies on (the fences are held once for the whole copy
 * and every per-row re-acquisition is a same-session re-entry).
 */

import type { ConnectionPool, QueryFn, TransactionHandler } from './record-service'

/**
 * Build a `ConnectionPool` whose `query` and `transaction` both run on `txQuery` — the caller's live
 * in-transaction query handle. Pure: no I/O of its own, no state.
 */
export function createTransactionBoundPool(txQuery: QueryFn): ConnectionPool {
  return {
    query: (sql, params) => txQuery(sql, params),
    transaction: <T>(handler: TransactionHandler<T>) => handler({ query: (sql, params) => txQuery(sql, params) }),
  }
}
