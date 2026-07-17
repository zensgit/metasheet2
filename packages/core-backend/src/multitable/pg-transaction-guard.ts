/**
 * Runtime transaction-boundary guard for multi-statement atomic writes (#4336 / #4340 review P1).
 *
 * A compile-time marker alone is FORGEABLE — any caller can slap `isTransaction: true` onto a pg Pool, and the
 * two INSERTs of an "atomic" write then run on separate auto-committed connections (half-state on failure: the
 * first row durably committed, the second missing). The only trustworthy signal is the DATABASE's own
 * transaction state, so `assertInTransaction` probes it: `pg_current_xact_id()` assigns-and-returns the
 * CURRENT transaction's id; called twice through the same handle it returns the SAME id iff both statements
 * ran inside one ongoing transaction. Every non-transactional handle fails the probe:
 *   - a Pool: statements land on arbitrary connections, each its own implicit transaction → different xids;
 *   - a single client in AUTOCOMMIT (no BEGIN): each statement is its own implicit transaction → different xids;
 *   - withTransaction's non-transactional queryFn fallback (deps.transaction absent) → different xids;
 *   - a FORGED `isTransaction` marker over any of the above → unchanged: the probe asks Postgres, not the caller.
 *
 * Cost: two trivial SELECTs per guarded call, before any write. Acceptable for the low-volume approval /
 * automation write paths this protects; the failure it prevents (a permanently half-committed outbox / ledger
 * state) is unrecoverable without manual repair.
 *
 * THREAT-MODEL BOUNDARY: the guard targets ACCIDENTAL misuse — every honest-but-wrong handle (pool, autocommit
 * client, forged boolean marker over either) is caught, because the probe asks Postgres itself. A handle that
 * actively FABRICATES query results (recognizes the probe SQL and answers a fake constant xid while routing
 * writes elsewhere) can defeat any client-side probe in principle; that class is indistinguishable from a
 * hostile database driver and is out of scope — no calling-convention or probe can defend against a layer
 * that lies about what the database said.
 */
import type { Queryable } from './automation-durable-dispatcher'

/**
 * Call-site documentation type: signals at compile time that a real transaction handle is expected. The
 * marker itself proves NOTHING (it is forgeable) — `assertInTransaction` below is the enforcement.
 */
export interface TransactionalQueryable extends Queryable {
  readonly isTransaction: true
}

/** Throws unless `trx` is a handle onto one ONGOING database transaction (probed via pg_current_xact_id). */
export async function assertInTransaction(trx: Queryable, context: string): Promise<void> {
  const probe = async (): Promise<string> => {
    const res = await trx.query(`SELECT pg_current_xact_id()::text AS xid`)
    const xid = res?.rows?.[0]?.xid
    if (typeof xid !== 'string' || xid === '') {
      throw new TypeError(`${context}: transaction probe returned no xid — the handle is not a usable database connection`)
    }
    return xid
  }
  const first = await probe()
  const second = await probe()
  if (first !== second) {
    throw new TypeError(
      `${context} must run inside a real database TRANSACTION: the two probe statements ran in different transactions (xid ${first} then ${second}). A pool, an autocommit client, or a forged isTransaction marker cannot provide the atomicity this write requires — BEGIN a transaction and pass that handle.`,
    )
  }
}
