/**
 * Pull-source write gate: the one place a write that may add a pull source to an organisation, or
 * remove the organisation's approval-routing policy, is decided and carried out.
 *
 * Invariants of this module:
 *  - It depends on the pull-source rule module and the database module only. It does not import the
 *    directory sync module, so that module (and any provider entry) can call it without a cycle.
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
import {
  APPROVAL_ROUTING_POLICY_EXISTS_SQL,
  DirectoryRoutingPolicyRequiredError,
  PullSourceCountUnavailableError,
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

export interface PullSourceGateTransactionOptions<L> {
  /**
   * Runs before the organisation lock is taken: lock the row the write changes (`FOR UPDATE`) and return
   * what was read under that lock. The returned value is handed to the transaction body.
   */
  lockTarget?: (client: PullSourceGateClient) => Promise<L>
}

/**
 * Runs `body` in a gate transaction for one organisation: READ COMMITTED, bounded waits, the optional
 * row lock, then the organisation lock, then `body`. Used by every writer that takes the organisation
 * lock: a write that may add a pull source, and the removal of the approval-routing policy.
 */
export async function runPullSourceGateTransaction<T, L = undefined>(
  orgId: string,
  body: (client: PullSourceGateClient, locked: L) => Promise<T>,
  options: PullSourceGateTransactionOptions<L> = {},
): Promise<T> {
  try {
    return await transaction(async (client) => {
      // First statement: under a higher default isolation level the snapshot would otherwise be taken by
      // the lock statement itself, before the lock is granted, and the reads below would not see what a
      // concurrent holder committed.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      // SET LOCAL only: a session-level setting would stay on the pooled connection.
      await client.query(`SET LOCAL lock_timeout = '${PULL_SOURCE_GATE_LOCK_TIMEOUT}'`)
      await client.query(`SET LOCAL statement_timeout = '${PULL_SOURCE_GATE_STATEMENT_TIMEOUT}'`)
      const locked = options.lockTarget ? await options.lockTarget(client) : (undefined as L)
      await client.query(directoryOrgLockSql('$1'), [orgId])
      return body(client, locked)
    })
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

export interface PullSourceWriteContext<L> {
  /** True when the write runs inside a gate transaction, under the organisation lock. */
  gated: boolean
  /** What `lockTarget` read under the row lock; undefined when the write is not gated or has no row to lock. */
  locked: L | undefined
  /** True when the gate checked this write as one that adds a pull source, and allowed it. */
  joined: boolean
}

export interface PullSourceWriteGateOptions<L> extends PullSourceGateTransactionOptions<L> {
  /**
   * Whether the write adds a pull source, decided from the row read under the lock. Without it the write
   * is treated as adding one. It is called inside the gate transaction, after both locks are held.
   */
  joins?: (locked: L) => boolean
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
 */
export async function runGatedPullSourceWrite<T, L = undefined>(
  target: PullSourceWriteTarget,
  write: (client: PullSourceGateClient, context: PullSourceWriteContext<L>) => Promise<T>,
  options: PullSourceWriteGateOptions<L> = {},
): Promise<PullSourceWriteOutcome<T>> {
  if (target.enforce === 'flagged' && !isApprovalRoutingRequirePolicyEnabled(options.env)) {
    const result = await write({ query: poolQuery }, { gated: false, locked: undefined, joined: false })
    return { result, gated: false, joined: false }
  }
  return runPullSourceGateTransaction<PullSourceWriteOutcome<T>, L>(
    target.orgId,
    async (client, locked) => {
      const joined = options.joins ? options.joins(locked) : true
      if (joined) await assertPullSourceMayJoin(client, target)
      const result = await write(client, { gated: true, locked, joined })
      return { result, gated: true, joined }
    },
    { lockTarget: options.lockTarget },
  )
}
