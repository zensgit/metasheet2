/**
 * Pull-source write gate: the one place a write that may add a pull source to an organisation, or
 * remove the organisation's approval-routing policy, is decided and carried out.
 *
 * Invariants of this module:
 *  - It imports the pull-source rule module, the database module and the pull-source gate marker
 *    module, and nothing else. It does not import the directory sync module, so that module (and any
 *    provider entry) can call it without a cycle.
 *  - A caller hands it two kinds of function and no other: the `write` of a gated write, and `joins`,
 *    the judgement made under the locks from the status the gate read. Every other statement of a gate
 *    transaction is issued by this module's own code: the row lock, the organisation lock, the policy
 *    and source reads, and the whole body of a policy clear. No function of this module takes a
 *    transaction body from its caller.
 *  - A gate transaction holds the organisation lock, which is outside the authorization-input lock
 *    order. The whole transaction therefore runs inside `runInsidePullSourceGate`: both
 *    authorization-input entry points refuse, before any statement, when they are reached from `write`
 *    or `joins`, on this connection or on another.
 *  - A gated write and the check that allows it run on one connection, in one transaction: the `write`
 *    callback receives the connection this module opened and no other.
 *  - Every gate transaction pins READ COMMITTED as its first statement, bounds lock waits and statement
 *    time with `SET LOCAL`, and takes the organisation lock before it reads the policy or counts sources.
 *    A transaction that cannot take the organisation lock ends; it never continues without it.
 *  - Lock order inside a gate transaction: the row the write changes (when there is one), then the
 *    organisation lock, then the reads, then the write.
 *  - A deadlock, a lock wait that timed out and a cancelled statement all end the transaction with
 *    nothing written and surface as `DirectoryRoutingGateBusyError`. A source count that cannot be read
 *    surfaces as `DirectoryRoutingGateUnavailableError`; it is never read as zero.
 *  - The gate checks that a policy row exists. It does not judge whether the policy's target is healthy.
 *  - The switch is read on every call. `enforce: 'always'` does not read it.
 */
import { query as poolQuery, transaction } from '../db/pg'
import { runInsidePullSourceGate } from './pull-source-gate-context'
import {
  APPROVAL_ROUTING_POLICY_EXISTS_SQL,
  DirectoryRoutingPolicyRequiredError,
  PULL_SOURCE_THRESHOLD,
  PullSourceCountUnavailableError,
  countActivePullSources,
  countOtherActivePullSources,
  directoryOrgLockSql,
  isApprovalRoutingRequirePolicyEnabled,
} from './pull-source-rule'

/** The connection a gate transaction runs on; the pool satisfies it for a write that is not gated. */
export interface PullSourceGateClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Upper bound of any single lock wait inside a gate transaction. */
export const PULL_SOURCE_GATE_LOCK_TIMEOUT = '5s'
/**
 * Upper bound of any single statement inside a gate transaction. It is below the pool's default client-side
 * query timeout (30 s), so a statement that runs out of time is ended by the server with SQLSTATE 57014,
 * which the gate answers as busy.
 */
export const PULL_SOURCE_GATE_STATEMENT_TIMEOUT = '25s'

export const DIRECTORY_ROUTING_GATE_BUSY_CODE = 'DIRECTORY_ROUTING_GATE_BUSY' as const
/** Fixed sentence: carries no organisation id, integration, count or driver text. */
export const DIRECTORY_ROUTING_GATE_BUSY_MESSAGE =
  'The directory source check is busy with a concurrent change; nothing was changed. Retry.'

export const DIRECTORY_ROUTING_GATE_UNAVAILABLE_CODE = 'DIRECTORY_ROUTING_GATE_UNAVAILABLE' as const
/** Fixed sentence: carries no organisation id, integration, count or driver text. */
export const DIRECTORY_ROUTING_GATE_UNAVAILABLE_MESSAGE =
  'The directory source check could not be completed; nothing was changed. Retry.'

/** SQLSTATEs that end a gate transaction as retryable: deadlock victim, lock wait timeout, cancelled statement. */
export const PULL_SOURCE_GATE_BUSY_SQLSTATES = Object.freeze(['40P01', '55P03', '57014'] as const)

/** A gate transaction lost a lock race or ran out of time. Nothing was written; the caller may retry. */
export class DirectoryRoutingGateBusyError extends Error {
  readonly code = DIRECTORY_ROUTING_GATE_BUSY_CODE
  /** The SQLSTATE that ended the transaction; for a values-free log line, never for a response body. */
  readonly sqlState: string

  constructor(sqlState: string) {
    super(DIRECTORY_ROUTING_GATE_BUSY_MESSAGE)
    this.name = 'DirectoryRoutingGateBusyError'
    this.sqlState = sqlState
  }
}

/** A gate transaction could not read the source count. Nothing was written; the caller may retry. */
export class DirectoryRoutingGateUnavailableError extends Error {
  readonly code = DIRECTORY_ROUTING_GATE_UNAVAILABLE_CODE

  constructor() {
    super(DIRECTORY_ROUTING_GATE_UNAVAILABLE_MESSAGE)
    this.name = 'DirectoryRoutingGateUnavailableError'
  }
}

/**
 * The row a gated write changes was read, under its lock, in another organisation than the one the gate
 * was opened for. The transaction ends before the organisation lock is taken and nothing is written. The
 * caller decides what its own entry answers; this sentence is not a response body.
 */
export class PullSourceGateRowMovedError extends Error {
  constructor() {
    super('The row of a gated directory source write belongs to another organisation')
    this.name = 'PullSourceGateRowMovedError'
  }
}

function sqlStateOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * The error a failed transaction of this package surfaces as: a deadlock, a lock wait that timed out and a
 * cancelled statement become `DirectoryRoutingGateBusyError`, an unreadable source count becomes
 * `DirectoryRoutingGateUnavailableError`, and anything else passes unchanged. It is applied to the failure
 * of the transaction itself, where nothing was written; never to a step that runs after the commit.
 */
export function asPullSourceGateFailure(error: unknown): unknown {
  if (error instanceof PullSourceCountUnavailableError) return new DirectoryRoutingGateUnavailableError()
  const sqlState = sqlStateOf(error)
  if (sqlState !== null && (PULL_SOURCE_GATE_BUSY_SQLSTATES as readonly string[]).includes(sqlState)) {
    return new DirectoryRoutingGateBusyError(sqlState)
  }
  return error
}

/** The row a gate transaction locks before the organisation lock: the one its write changes. */
interface GateRow {
  integrationId: string
  provider: string
}

/**
 * Locks the row a gated write changes and returns the status read under that lock (null when the row is
 * gone). The organisation lock that follows is keyed by the organisation the caller read before the
 * lock, so a row that no longer belongs to it ends the transaction.
 */
async function lockGateRow(client: PullSourceGateClient, orgId: string, row: GateRow): Promise<string | null> {
  const locked = await client.query(
    `SELECT org_id, status
       FROM directory_integrations
      WHERE id = $1 AND provider = $2
        FOR UPDATE`,
    [row.integrationId, row.provider],
  )
  const found = locked.rows[0]
  if (!found) return null
  if (found.org_id !== orgId) throw new PullSourceGateRowMovedError()
  return String(found.status)
}

/**
 * Runs `body` in a gate transaction for one organisation: READ COMMITTED, bounded waits, the optional
 * row lock, then the organisation lock, then `body`, all with the pull-source gate marker set. Private to
 * this module: the two bodies it runs are the ones below.
 */
async function runPullSourceGateTransaction<T>(
  orgId: string,
  body: (client: PullSourceGateClient, lockedStatus: string | null) => Promise<T>,
  row?: GateRow,
): Promise<T> {
  try {
    return await runInsidePullSourceGate(() => transaction(async (client) => {
      // First statement: under a higher default isolation level the snapshot would otherwise be taken by
      // the lock statement itself, before the lock is granted, and the reads below would not see what a
      // concurrent holder committed.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      // SET LOCAL only: a session-level setting would stay on the pooled connection.
      await client.query(`SET LOCAL lock_timeout = '${PULL_SOURCE_GATE_LOCK_TIMEOUT}'`)
      await client.query(`SET LOCAL statement_timeout = '${PULL_SOURCE_GATE_STATEMENT_TIMEOUT}'`)
      const lockedStatus = row ? await lockGateRow(client, orgId, row) : null
      await client.query(directoryOrgLockSql('$1'), [orgId])
      return body(client, lockedStatus)
    }))
  } catch (error) {
    throw asPullSourceGateFailure(error)
  }
}

export interface PullSourceWriteTarget {
  orgId: string
  provider: string
  corpId: string
  /**
   * 'flagged': an entry that existed before the rule; it is gated only while the switch is on.
   * 'always': an entry for a further provider; it is gated whatever the switch says.
   */
  enforce: 'flagged' | 'always'
}

export interface PullSourceWriteContext {
  /** True when the write runs inside a gate transaction, under the organisation lock. */
  gated: boolean
  /**
   * The status the gate read from the row under its lock. Null when the write is not gated, when it has
   * no row to lock, and when the row is gone.
   */
  lockedStatus: string | null
  /** True when the gate checked this write as one that adds a pull source, and allowed it. */
  joined: boolean
}

export interface PullSourceWriteGateOptions {
  /**
   * The id of the row the write changes, for a write that changes an existing row of the target's
   * provider. The gate locks it (`FOR UPDATE`) before the organisation lock and reads its status.
   */
  lockRowId?: string
  /**
   * Whether the write adds a pull source, decided from the status read under the row lock. Without it the
   * write is treated as adding one. It is called inside the gate transaction, after both locks are held.
   */
  joins?: (lockedStatus: string | null) => boolean
  env?: NodeJS.ProcessEnv
}

export interface PullSourceWriteOutcome<T> {
  result: T
  gated: boolean
  joined: boolean
}

/**
 * The check made under the organisation lock: may the external source `(provider, corpId)` become, or
 * stay, an active pull source of the organisation?
 *  - the local directory is not a pull source: allowed;
 *  - the organisation has an approval-routing policy: allowed;
 *  - the organisation has no other active pull source: allowed (rows of this same external source are
 *    not counted, so a second row of a source the organisation already has is allowed);
 *  - otherwise refused with `DirectoryRoutingPolicyRequiredError`.
 */
async function assertPullSourceMayJoin(client: PullSourceGateClient, target: PullSourceWriteTarget): Promise<void> {
  if (target.provider === 'local') return
  const policy = await client.query(APPROVAL_ROUTING_POLICY_EXISTS_SQL, [target.orgId])
  if (policy.rows.length > 0) return
  const others = await countOtherActivePullSources(
    (sql, params) => client.query(sql, params),
    target.orgId,
    target.provider,
    target.corpId,
  )
  if (others > 0) throw new DirectoryRoutingPolicyRequiredError()
}

/**
 * Carries out a write that may add a pull source to an organisation.
 *
 * `enforce: 'flagged'` with the switch off: `write` runs as it did before the rule, on the pool, with no
 * transaction, no lock and no policy read. Otherwise `write` runs inside a gate transaction, after the
 * check above has allowed it (or after `joins` said the write adds no source).
 *
 * `write` is one statement on the connection it is given: an INSERT into, or an UPDATE of, the
 * integration table, with its parameters computed before the call. What follows the statement (reading
 * the returned row, deciding what an empty result means) belongs to the caller, after this function
 * returns.
 */
export async function runGatedPullSourceWrite<T>(
  target: PullSourceWriteTarget,
  write: (client: PullSourceGateClient, context: PullSourceWriteContext) => Promise<T>,
  options: PullSourceWriteGateOptions = {},
): Promise<PullSourceWriteOutcome<T>> {
  if (target.enforce === 'flagged' && !isApprovalRoutingRequirePolicyEnabled(options.env)) {
    const result = await write({ query: poolQuery }, { gated: false, lockedStatus: null, joined: false })
    return { result, gated: false, joined: false }
  }
  return runPullSourceGateTransaction<PullSourceWriteOutcome<T>>(
    target.orgId,
    async (client, lockedStatus) => {
      const joined = options.joins ? options.joins(lockedStatus) : true
      if (joined) await assertPullSourceMayJoin(client, target)
      const result = await write(client, { gated: true, lockedStatus, joined })
      return { result, gated: true, joined }
    },
    options.lockRowId === undefined ? undefined : { integrationId: options.lockRowId, provider: target.provider },
  )
}

/** What a policy clear did: no policy row, refused, or removed (with the canonical it pointed at). */
export type RoutingPolicyClearOutcome =
  | { kind: 'absent' }
  | { kind: 'blocked' }
  | { kind: 'cleared'; previous: string }

/**
 * Removes the organisation's routing policy for one purpose, in a gate transaction: organisation lock,
 * then the policy row, then the source count, then the delete. The same lock serialises it against every
 * write that adds a pull source, so "two or more active pull sources and no policy" cannot be reached by
 * removing the policy. The rule does not read the approval-routing switch.
 *  - no policy row: `absent`, whatever the source count;
 *  - two or more active pull sources: `blocked`, the row stays;
 *  - otherwise the row is deleted: `cleared`.
 */
export async function runGatedRoutingPolicyClear(orgId: string, purpose: string): Promise<RoutingPolicyClearOutcome> {
  return runPullSourceGateTransaction<RoutingPolicyClearOutcome>(orgId, async (client) => {
    const existing = await client.query(
      `SELECT canonical_integration_id::text AS canonical_integration_id
         FROM org_directory_routing_policy
        WHERE org_id = $1 AND purpose = $2
          FOR UPDATE`,
      [orgId, purpose],
    )
    const previous = existing.rows[0]?.canonical_integration_id
    if (typeof previous !== 'string') return { kind: 'absent' }
    const activeSources = await countActivePullSources((sql, params) => client.query(sql, params), orgId)
    if (activeSources >= PULL_SOURCE_THRESHOLD) return { kind: 'blocked' }
    await client.query(
      `DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2`,
      [orgId, purpose],
    )
    return { kind: 'cleared', previous }
  })
}
