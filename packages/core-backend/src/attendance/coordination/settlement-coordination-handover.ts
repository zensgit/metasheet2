/**
 * Attendance settlement coordination — S1, the handover (BEGIN + S2), the transaction-ending
 * primitives, session-lock cleanup and the handover credential.
 *
 * Nothing here borrows or releases connections. Every function reports an outcome and leaves the
 * connection decision to the caller (the coordinator), which owns the connection:
 *   - `contended`: the try lost; give the connection back normally, then back off;
 *   - `uncertain`: the protocol state of the connection is unknown (idle proof failed, a statement
 *     errored or its result was lost, a re-grant or an unlock returned false, ROLLBACK failed,
 *     COMMIT failed with anything but 40001 / 40P01, or BEGIN / COMMIT was not acknowledged with its
 *     command tag — PostgreSQL answers COMMIT in an already failed transaction with ROLLBACK and no
 *     error, and a client that reports no tags cannot prove either).
 *     The caller must destroy the connection with
 *     `release(err)`; destroying the backend is also what drops any session-level advisory lock it
 *     may still hold. Nothing here ever calls `pg_advisory_unlock_all`.
 *
 * The credential proves that THIS transaction on THIS connection was handed over for THIS org. It
 * is bound to the transaction, not to the connection object: pooled connections are reused, so the
 * credential is invalidated before COMMIT or ROLLBACK is sent, and a credential from an earlier
 * transaction never verifies on a later one. COMMIT and ROLLBACK refuse, before sending anything, a
 * connection that is not the one the live credential is bound to.
 */
import {
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  type AttendanceW4TransactionClientV1,
} from '../w4c0-identity'
import {
  AttendanceCoordinationKeyError,
  buildSettlementCoordinationKeyV1,
  canonicalizeSettlementCoordinationOrgV1,
  type SettlementCoordinationKeyV1,
} from './settlement-coordination-key'
import {
  buildSettlementCoordinationS1Sql,
  buildSettlementCoordinationS2Sql,
  buildSettlementCoordinationSessionUnlockSql,
  type SettlementCoordinationS2TimeoutsV1,
} from './settlement-coordination-statements'

/**
 * A query result as the coordination primitives read it: the rows plus pg's command tag. BEGIN and
 * COMMIT are trusted only on their tags (S1 note 6, S2 BEGIN self-check).
 */
export interface SettlementCoordinationQueryResultV1 {
  command: string
  rows: Array<Record<string, unknown>>
}

/**
 * The connection the coordination primitives run on. Unlike the W4 client it must report pg's command
 * tag, so a wrapper that drops the tag cannot be handed to S1, the handover, COMMIT, ROLLBACK or the
 * session unlock at all (S3 note 6). It is still a W4 client: business code and the W4 runner take it
 * as one.
 */
export interface SettlementCoordinationTransactionClientV1 extends AttendanceW4TransactionClientV1 {
  query(sqlText: string, params?: unknown[]): Promise<SettlementCoordinationQueryResultV1>
}

export interface SettlementCoordinationPlanV1 {
  readonly key: SettlementCoordinationKeyV1
  /** Set only for a canonical org whose entry needs the class-00 family. */
  readonly classZeroKey: bigint | null
}

export function planSettlementCoordinationV1(
  org: unknown,
  options: Readonly<{ needsClassZero: boolean }>,
): SettlementCoordinationPlanV1 {
  const key = buildSettlementCoordinationKeyV1(org)
  const classZeroKey = key.org.kind === 'canonical' && options.needsClassZero === true
    ? buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(key.org.lexical))
    : null
  return Object.freeze({ key, classZeroKey })
}

export type SettlementCoordinationUncertainReasonV1 =
  | 's1-not-idle'
  | 's1-statement-failed'
  | 's1-result-invalid'
  | 's1-undo-failed'
  | 'begin-failed'
  | 'begin-unacknowledged'
  | 's2-statement-failed'
  | 's2-result-invalid'
  | 's2-regrant-failed'
  | 's2-unlock-failed'
  | 'unlock-statement-failed'
  | 'unlock-returned-false'
  | 'rollback-failed'
  | 'commit-failed'
  | 'commit-not-committed'
  /** The connection reported an error (pg's 'error' event) while the unit held it. */
  | 'connection-error'

export type SettlementCoordinationUncertainV1 = Readonly<{
  kind: 'uncertain'
  reason: SettlementCoordinationUncertainReasonV1
  error?: unknown
}>

/** Error to hand to `release(err)` when an outcome is `uncertain`. */
export class AttendanceCoordinationConnectionUncertainError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_CONNECTION_UNCERTAIN'
  readonly reason: SettlementCoordinationUncertainReasonV1

  constructor(reason: SettlementCoordinationUncertainReasonV1) {
    super(`ATTENDANCE_COORDINATION_CONNECTION_UNCERTAIN:${reason}`)
    this.name = 'AttendanceCoordinationConnectionUncertainError'
    this.reason = reason
  }
}

/** COMMIT returned without error but without the COMMIT tag (PostgreSQL rolled the transaction back). */
export class AttendanceCoordinationCommitNotCommittedError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_COMMIT_NOT_COMMITTED'
  readonly command: string | null

  constructor(command: unknown) {
    const observed = typeof command === 'string' ? command : null
    super(`ATTENDANCE_COORDINATION_COMMIT_NOT_COMMITTED:${observed ?? 'no-command-tag'}`)
    this.name = 'AttendanceCoordinationCommitNotCommittedError'
    this.command = observed
  }
}

function uncertain(reason: SettlementCoordinationUncertainReasonV1, error?: unknown): SettlementCoordinationUncertainV1 {
  return Object.freeze(error === undefined ? { kind: 'uncertain' as const, reason } : { kind: 'uncertain' as const, reason, error })
}

function statementKeys(plan: SettlementCoordinationPlanV1) {
  return { key2: plan.key.key2, classZeroKey: plan.classZeroKey }
}

function singleRow(result: unknown): Record<string, unknown> | null {
  const rows = (result as { rows?: unknown } | null)?.rows
  if (!Array.isArray(rows) || rows.length !== 1) return null
  const row = rows[0]
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null
}

// ---------------------------------------------------------------------------
// S1
// ---------------------------------------------------------------------------

export type SettlementCoordinationS1OutcomeV1 =
  | Readonly<{ kind: 'acquired' }>
  | Readonly<{ kind: 'contended'; family: 'dedicated' | 'class-00' }>
  | SettlementCoordinationUncertainV1

/** Runs S1 in autocommit on an idle, freshly borrowed connection (simple protocol: no values). */
export async function runSettlementCoordinationS1V1(
  client: SettlementCoordinationTransactionClientV1,
  plan: SettlementCoordinationPlanV1,
): Promise<SettlementCoordinationS1OutcomeV1> {
  const sql = buildSettlementCoordinationS1Sql(statementKeys(plan))
  let row: Record<string, unknown> | null
  try {
    row = singleRow(await client.query(sql))
  } catch (error) {
    return uncertain('s1-statement-failed', error)
  }
  if (row === null) return uncertain('s1-result-invalid')
  if (row.idle !== true) return uncertain('s1-not-idle')
  if (row.k_ok === false) return Object.freeze({ kind: 'contended' as const, family: 'dedicated' as const })
  if (row.k_ok !== true) return uncertain('s1-result-invalid')
  if (row.c_ok === true) return Object.freeze({ kind: 'acquired' as const })
  if (row.c_ok !== false) return uncertain('s1-result-invalid')
  if (row.k_undo !== true) return uncertain('s1-undo-failed')
  return Object.freeze({ kind: 'contended' as const, family: 'class-00' as const })
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

const MINT = Symbol('settlement-coordination-credential-mint')
const activeCredentials = new WeakMap<object, SettlementCoordinationCredentialV1>()

export class SettlementCoordinationCredentialV1 {
  readonly #connection: object
  readonly #orgLexical: string
  readonly #classZeroHeld: boolean
  #active = true

  constructor(mint: symbol, connection: object, orgLexical: string, classZeroHeld: boolean) {
    if (mint !== MINT) throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_CREDENTIAL_FORGED')
    this.#connection = connection
    this.#orgLexical = orgLexical
    this.#classZeroHeld = classZeroHeld
    Object.freeze(this)
  }

  /** True only for a genuine credential (brand check, not `instanceof`) that is live on `connection`. */
  static isLiveOn(credential: unknown, connection: object): credential is SettlementCoordinationCredentialV1 {
    if (typeof credential !== 'object' || credential === null || !(#active in credential)) return false
    if (!credential.#active) return false
    if (credential.#connection !== connection) return false
    return activeCredentials.get(connection) === credential
  }

  static matches(
    credential: unknown,
    connection: object,
    orgLexical: string,
    needsClassZero: boolean,
  ): boolean {
    if (!SettlementCoordinationCredentialV1.isLiveOn(credential, connection)) return false
    if (credential.#orgLexical !== orgLexical) return false
    if (needsClassZero && !credential.#classZeroHeld) return false
    return true
  }

  static invalidate(credential: SettlementCoordinationCredentialV1): void {
    credential.#active = false
    if (activeCredentials.get(credential.#connection) === credential) activeCredentials.delete(credential.#connection)
  }
}

function mintCredential(connection: object, plan: SettlementCoordinationPlanV1): SettlementCoordinationCredentialV1 {
  const previous = activeCredentials.get(connection)
  if (previous) SettlementCoordinationCredentialV1.invalidate(previous)
  const credential = new SettlementCoordinationCredentialV1(MINT, connection, plan.key.org.lexical, plan.classZeroKey !== null)
  activeCredentials.set(connection, credential)
  return credential
}

/**
 * True only for the live credential of the transaction currently handed over on `connection`,
 * for the same org, and (when the caller needs it) with the class-00 family held.
 */
export function verifySettlementCoordinationCredentialV1(
  connection: object,
  credential: unknown,
  org: unknown,
  options: Readonly<{ needsClassZero: boolean }>,
): boolean {
  let orgLexical: string
  try {
    orgLexical = canonicalizeSettlementCoordinationOrgV1(org).lexical
  } catch {
    return false
  }
  return SettlementCoordinationCredentialV1.matches(credential, connection, orgLexical, options.needsClassZero === true)
}

/** Safety net for release paths: drops whatever credential is live on `connection`. */
export function invalidateSettlementCoordinationCredentialsV1(connection: object): void {
  const live = activeCredentials.get(connection)
  if (live) SettlementCoordinationCredentialV1.invalidate(live)
}

// ---------------------------------------------------------------------------
// Handover: BEGIN, then S2 as the first snapshot-taking statement
// ---------------------------------------------------------------------------

export type SettlementCoordinationIsolationV1 = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
const ISOLATIONS: ReadonlySet<string> = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'])

export interface SettlementCoordinationHandoverOptionsV1 {
  readonly isolation: SettlementCoordinationIsolationV1
  readonly timeouts: SettlementCoordinationS2TimeoutsV1
  readonly entryLabel: string
}

export type SettlementCoordinationHandoverOutcomeV1 =
  | Readonly<{ kind: 'handed-over'; credential: SettlementCoordinationCredentialV1 }>
  | SettlementCoordinationUncertainV1

async function rollbackQuietly(client: SettlementCoordinationTransactionClientV1): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // The outcome is already `uncertain`; the caller destroys the connection either way.
  }
}

/** Observers of a handover. `decided` runs once the outcome is known, before any cleanup ROLLBACK. */
export interface SettlementCoordinationHandoverHooksV1 {
  readonly decided?: () => void
}

/**
 * Call only after S1 returned `acquired` on the same connection. BEGIN goes as its own statement;
 * S2 must be the first snapshot-taking statement of the transaction, so nothing else is sent in
 * between.
 */
export async function runSettlementCoordinationHandoverV1(
  client: SettlementCoordinationTransactionClientV1,
  plan: SettlementCoordinationPlanV1,
  options: SettlementCoordinationHandoverOptionsV1,
  hooks: SettlementCoordinationHandoverHooksV1 = {},
): Promise<SettlementCoordinationHandoverOutcomeV1> {
  if (!ISOLATIONS.has(options.isolation)) throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_ISOLATION_INVALID')
  const s2 = buildSettlementCoordinationS2Sql({
    ...statementKeys(plan),
    timeouts: options.timeouts,
    entryLabel: options.entryLabel,
  })
  // The cleanup ROLLBACK of a failed handover is not part of the try (budget: §3.2 step 9).
  const cleanUp = async (reason: SettlementCoordinationUncertainReasonV1, error?: unknown): Promise<SettlementCoordinationUncertainV1> => {
    hooks.decided?.()
    await rollbackQuietly(client)
    return uncertain(reason, error)
  }
  let begun: unknown
  try {
    begun = await client.query(`BEGIN ISOLATION LEVEL ${options.isolation}`)
  } catch (error) {
    return uncertain('begin-failed', error)
  }
  // COMMIT is trusted only on its COMMIT tag. A client that does not report command tags would turn
  // every real commit into `commit-not-committed` after the business work is done; refuse it here,
  // before anything happens inside the transaction.
  if ((begun as { command?: unknown } | null)?.command !== 'BEGIN') return cleanUp('begin-unacknowledged')
  let row: Record<string, unknown> | null
  try {
    row = singleRow(await client.query(s2))
  } catch (error) {
    return cleanUp('s2-statement-failed', error)
  }
  if (row === null) return cleanUp('s2-result-invalid')
  if (row.x_k !== true || row.x_c !== true) return cleanUp('s2-regrant-failed')
  if (row.u_k !== true || row.u_c !== true) return cleanUp('s2-unlock-failed')
  return Object.freeze({ kind: 'handed-over' as const, credential: mintCredential(client, plan) })
}

// ---------------------------------------------------------------------------
// Ending the handed-over transaction
// ---------------------------------------------------------------------------

export type SettlementCoordinationCommitOutcomeV1 =
  | Readonly<{ kind: 'committed' }>
  /** 40001 / 40P01 at COMMIT: the server rolled the transaction back; the connection is intact. */
  | Readonly<{ kind: 'retryable'; error: unknown }>
  | SettlementCoordinationUncertainV1

export type SettlementCoordinationRollbackOutcomeV1 =
  | Readonly<{ kind: 'rolled-back' }>
  | SettlementCoordinationUncertainV1

function isRetryableCommitError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '40001' || code === '40P01'
}

/**
 * Refuses, before anything is invalidated or sent, to end a transaction through a connection that is
 * not the one the live credential is bound to. The owning transaction stays open with its credential,
 * so its owner can still end it.
 */
function assertCredentialHeldBy(connection: object, credential: unknown): asserts credential is SettlementCoordinationCredentialV1 {
  if (!SettlementCoordinationCredentialV1.isLiveOn(credential, connection)) {
    throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_CREDENTIAL_MISMATCH')
  }
}

export async function commitSettlementCoordinationTransactionV1(
  client: SettlementCoordinationTransactionClientV1,
  credential: SettlementCoordinationCredentialV1,
): Promise<SettlementCoordinationCommitOutcomeV1> {
  assertCredentialHeldBy(client, credential)
  SettlementCoordinationCredentialV1.invalidate(credential)
  let result: unknown
  try {
    result = await client.query('COMMIT')
  } catch (error) {
    if (isRetryableCommitError(error)) return Object.freeze({ kind: 'retryable' as const, error })
    return uncertain('commit-failed', error)
  }
  // Only the exact COMMIT tag proves the commit: a transaction that already failed answers COMMIT
  // with ROLLBACK and no error, and a client that reports no tag proves nothing.
  const command = (result as { command?: unknown } | null)?.command
  if (command !== 'COMMIT') return uncertain('commit-not-committed', new AttendanceCoordinationCommitNotCommittedError(command))
  return Object.freeze({ kind: 'committed' as const })
}

export async function rollbackSettlementCoordinationTransactionV1(
  client: SettlementCoordinationTransactionClientV1,
  credential: SettlementCoordinationCredentialV1,
): Promise<SettlementCoordinationRollbackOutcomeV1> {
  assertCredentialHeldBy(client, credential)
  SettlementCoordinationCredentialV1.invalidate(credential)
  try {
    await client.query('ROLLBACK')
  } catch (error) {
    return uncertain('rollback-failed', error)
  }
  return Object.freeze({ kind: 'rolled-back' as const })
}

// ---------------------------------------------------------------------------
// Cleanup before handover (S1 acquired, unit abandoned)
// ---------------------------------------------------------------------------

export type SettlementCoordinationReleaseOutcomeV1 =
  | Readonly<{ kind: 'released' }>
  | SettlementCoordinationUncertainV1

/**
 * Releases exactly the session-level shared locks S1 took for this plan. Both unlocks must return
 * true; anything else means the session's lock state is unknown and the connection must be
 * destroyed.
 */
export async function releaseSettlementCoordinationSessionLocksV1(
  client: SettlementCoordinationTransactionClientV1,
  plan: SettlementCoordinationPlanV1,
): Promise<SettlementCoordinationReleaseOutcomeV1> {
  let row: Record<string, unknown> | null
  try {
    row = singleRow(await client.query(buildSettlementCoordinationSessionUnlockSql(statementKeys(plan))))
  } catch (error) {
    return uncertain('unlock-statement-failed', error)
  }
  if (row === null || row.u_k !== true || row.u_c !== true) return uncertain('unlock-returned-false')
  return Object.freeze({ kind: 'released' as const })
}
