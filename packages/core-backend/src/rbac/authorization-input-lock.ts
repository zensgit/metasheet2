/**
 * Authorization-input serialization contract: lock order, the two transaction entry points, the
 * intent catalogue and the busy error.
 *
 * Every write to a privilege-classifier input and every decision that depends on a user's privilege
 * class runs inside a contract transaction. A contract transaction takes its locks in one fixed
 * order (rank R0 first, then only higher ranks), holds the world lock (R0) in shared mode unless the
 * write can raise the class of role holders, and reports every acquisition failure as one retryable
 * busy error with a fixed, values-free message.
 *
 * Role rows rank before the namespace-admission locks and the user rows. An intent that writes role
 * content locks its role rows for update; an intent that writes a membership of a role locks the
 * role rows it names in share mode. The entry takes every planned lock; `work` may add locks only
 * through `tx.acquire`, which never goes back to a lower rank. A plan may name witnesses: users
 * that are locked as the basis of a decision and are not write targets. The entry takes exactly
 * the locks the plan names and adds none. A plan, its witness and a request to `tx.acquire` are
 * closed shapes: a key the contract does not define is refused before any statement. `tx.acquire`
 * serves one request at a time.
 *
 * A transaction that holds an organisation's pull-source lock (the advisory lock defined in
 * `directory/pull-source-rule.ts`) is outside this order: it takes no contract lock, and both entry
 * points refuse, before any statement, while the pull-source gate marker is set.
 *
 * Two entry points:
 *   - `withAuthorizationInputTransaction` opens its own transaction: the first statement after
 *     BEGIN pins READ COMMITTED, the lock statements are wrapped in transaction-local lock and
 *     statement timeouts that are restored afterwards, and an `error` listener on the borrowed
 *     connection covers the whole borrow so a lost connection is reported as busy rather than as an
 *     unhandled event. A shared attempt that needs the exclusive world lock is rolled back and the
 *     whole work closure is re-run once in exclusive mode.
 *   - `enterAuthorizationInputTransaction` joins a transaction the caller already opened. It is open
 *     only to the two registered callers whose intents never need the exclusive world lock; the
 *     caller is named by `plan.caller`, `prefix` must equal that caller's registered prefix list,
 *     and a request to upgrade inside the takeover is a contract error.
 *
 * The world lock key is the two-int4 pair (20261106, 1) written as a SQL literal in exactly three
 * statement forms: shared (waiting), shared try and exclusive try. No blocking exclusive form and no
 * session-level form exists. The first key differs from every other fixed two-int4 namespace in
 * this repository (the Yida initialization slot, the two stock-preparation namespaces, the
 * point-in-time recovery namespace, the settlement coordination key and the `(hashtext, hashtext)`
 * pairs); it is registered in `ADVISORY_FIXED_KEY1_REGISTRY`.
 *
 * Neither entry point sets the idle-in-transaction session timeout, and no contract statement
 * carries a client-side query timeout. This module never imports the privilege classifier.
 */
import type { PoolClient } from 'pg'
import { lockUsersForAccessGraphWrite } from '../directory/access-graph-mutex'
import type { LockedAccessGraphUser } from '../directory/access-graph-mutex'
import { isInsidePullSourceGate } from '../directory/pull-source-gate-context'
import { poolManager } from '../integration/db/connection-pool'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../multitable/recovery-authorization-stability'
import { AuthorizationInputContractError, mintAuthorizationInputBrand } from './authorization-input-brand'
import type { AuthorizationInputQueryResult, AuthorizationInputQueryable } from './authorization-input-brand'
import { isClassRaisingPermissionCode, isClassRaisingRoleId } from './authorization-input-classes'

/* ───────────────────────────── lock order ───────────────────────────── */

/** Ranks of every lock a contract transaction may take, strictly increasing in acquisition order. */
export const AUTHORIZATION_INPUT_LOCK_RANKS = Object.freeze({
  R0_WORLD: 0,
  R1_PLATFORM_ADMIN_INVARIANT: 10,
  R2_IDENTITY_MAINTENANCE: 20,
  R2F_SOURCE_SYNC_FREEZE: 25,
  R2R_ROLE_ROW: 27,
  R3_NAMESPACE_ADMISSION: 30,
  R5_USER_ROW: 50,
  R6_DOMAIN: 60,
  R7_SESSION_ROW: 70,
  R8_CHALLENGE_ROW: 80,
} as const)

export type AuthorizationInputLockRank = keyof typeof AUTHORIZATION_INPUT_LOCK_RANKS

export const AUTHORIZATION_INPUT_LOCK_RANK_ORDER: readonly AuthorizationInputLockRank[] = Object.freeze([
  'R0_WORLD',
  'R1_PLATFORM_ADMIN_INVARIANT',
  'R2_IDENTITY_MAINTENANCE',
  'R2F_SOURCE_SYNC_FREEZE',
  'R2R_ROLE_ROW',
  'R3_NAMESPACE_ADMISSION',
  'R5_USER_ROW',
  'R6_DOMAIN',
  'R7_SESSION_ROW',
  'R8_CHALLENGE_ROW',
])

/** The world lock key: a fixed two-int4 pair, written as a SQL literal in every lock statement. */
export const AUTHORIZATION_INPUT_WORLD_LOCK_KEY1 = 20261106
export const AUTHORIZATION_INPUT_WORLD_LOCK_KEY2 = 1

/* ───────────────────────────── statements ───────────────────────────── */

/** Every statement the entry points issue; each `$n` is bound, the world-lock statements take none. */
export const AUTHORIZATION_INPUT_STATEMENTS = Object.freeze({
  setTransaction: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
  isolationProbe: "SELECT current_setting('transaction_isolation') AS isolation",
  readTimeouts: "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
  setTimeouts: "SELECT set_config('lock_timeout', $1, true) AS lock_timeout, set_config('statement_timeout', $2, true) AS statement_timeout",
  worldShared: 'SELECT pg_advisory_xact_lock_shared(20261106, 1)',
  worldSharedTry: 'SELECT pg_try_advisory_xact_lock_shared(20261106, 1) AS acquired',
  worldExclusiveTry: 'SELECT pg_try_advisory_xact_lock(20261106, 1) AS acquired',
  platformAdminInvariant: "SELECT pg_advisory_xact_lock(hashtextextended('user-recycle:platform-admin', 0))",
  namespaceAdmission: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  roleRow: 'SELECT id::text AS id FROM roles WHERE id = $1::text FOR UPDATE',
  roleRowShared: 'SELECT id::text AS id FROM roles WHERE id = $1::text FOR SHARE',
  rolePermissionCodes: 'SELECT role_id::text AS role_id, permission_code FROM role_permissions WHERE role_id = ANY($1::text[])',
} as const)

/** Transaction-local timeouts that wrap the lock statements only; the caller's values are restored afterwards. */
export const AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS = 5000
export const AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS = 10000

/* ───────────────────────────── intents ───────────────────────────── */

export const AUTHORIZATION_INPUT_INTENTS = [
  'GRANT_ROLE',
  'REVOKE_ROLE',
  'GRANT_DIRECT',
  'REVOKE_DIRECT',
  'SET_ADMIN_PROFILE',
  'SET_DELEGATED_SCOPE',
  'SET_ADMISSION',
  'EDIT_ROLE_CONTENT',
  'DELETE_ROLE',
  'PURGE',
  'CASCADE_PARENT_DELETE',
  'BIRTH',
  'CONSUME_CLASS_DECISION',
  'PROJECTION_GRANT',
  'MAINTENANCE',
] as const

export type AuthorizationInputIntent = (typeof AUTHORIZATION_INPUT_INTENTS)[number]

export type AuthorizationInputWorldMode = 'shared' | 'exclusive'

export type AuthorizationInputIntentRule = Readonly<{
  /** World-lock mode the intent starts in. */
  world: AuthorizationInputWorldMode
  /** Whether the entry may re-run the work in exclusive mode after an upgrade request. */
  upgradeable: boolean
  /** Whether the platform administrator invariant lock (R1) is always taken. */
  platformAdminInvariant: boolean
  /** Whether `tx.insertUserForBirth` is available. */
  birth: boolean
}>

const rule = (overrides: Partial<AuthorizationInputIntentRule> = {}): AuthorizationInputIntentRule =>
  Object.freeze({ world: 'shared', upgradeable: false, platformAdminInvariant: false, birth: false, ...overrides })

/** The closed intent catalogue. */
export const AUTHORIZATION_INPUT_INTENT_CATALOG: Readonly<Record<AuthorizationInputIntent, AuthorizationInputIntentRule>> = Object.freeze({
  GRANT_ROLE: rule(),
  REVOKE_ROLE: rule(),
  GRANT_DIRECT: rule(),
  REVOKE_DIRECT: rule(),
  SET_ADMIN_PROFILE: rule(),
  SET_DELEGATED_SCOPE: rule(),
  SET_ADMISSION: rule(),
  EDIT_ROLE_CONTENT: rule({ upgradeable: true }),
  // R1 is not taken for every role delete: the entry refuses a plan that names the reserved
  // platform administrator role, so no role delete can reduce the platform administrators.
  DELETE_ROLE: rule(),
  PURGE: rule(),
  CASCADE_PARENT_DELETE: rule(),
  BIRTH: rule({ birth: true }),
  // A decision made on a user's privilege class. It writes none of the classifier inputs; it may
  // write other tables.
  CONSUME_CLASS_DECISION: rule(),
  PROJECTION_GRANT: rule({ birth: true }),
  MAINTENANCE: rule({ world: 'exclusive' }),
})

/** Statements a takeover caller is registered to have executed before entering. */
export const REGISTERED_TAKEOVER_PREFIXES = ['isolation_pin'] as const
export type RegisteredPrefix = (typeof REGISTERED_TAKEOVER_PREFIXES)[number]

export type AuthorizationInputTakeoverCaller = 'directory_sync' | 'controlled_handover'

/** The two takeover callers, each with its closed intent set and its registered prefix list. */
export const AUTHORIZATION_INPUT_TAKEOVER_CALLERS: Readonly<Record<AuthorizationInputTakeoverCaller, Readonly<{ intents: readonly AuthorizationInputIntent[]; prefixes: readonly RegisteredPrefix[] }>>> = Object.freeze({
  directory_sync: Object.freeze({ intents: Object.freeze(['PROJECTION_GRANT'] as const), prefixes: Object.freeze(['isolation_pin'] as const) }),
  controlled_handover: Object.freeze({ intents: Object.freeze(['CASCADE_PARENT_DELETE'] as const), prefixes: Object.freeze([] as const) }),
})

/* ───────────────────────────── plan and token ───────────────────────────── */

/**
 * Users locked as the basis of a decision, not as write targets. The two lists are independent: the
 * entry takes R5 for `userIds` and R3 for `admissionUserIds`, merged with the plan's targets, and
 * never adds a lock the plan did not name.
 */
export type AuthorizationInputWitness = Readonly<{
  userIds?: readonly string[]
  admissionUserIds?: readonly string[]
}>

export type AuthorizationInputPlan = Readonly<{
  intent: AuthorizationInputIntent
  /** Users whose rows the entry locks (R5), in code-unit order. */
  userIds?: readonly string[]
  /**
   * Roles whose rows the entry locks before R3 and R5, in code-unit order: for update when the
   * intent writes role content, in share mode when it writes a membership of the role.
   */
  roleIds?: readonly string[]
  /** Users whose namespace-admission lock the entry takes (R3), in code-unit order. */
  admissionUserIds?: readonly string[]
  /** Witnesses; refused for the intents that lock role rows for update. */
  witness?: AuthorizationInputWitness
  /** Take the platform administrator invariant lock (R1) even when the intent does not require it. */
  platformAdminInvariant?: boolean
  /** Start in exclusive mode; permitted for `EDIT_ROLE_CONTENT` only (`MAINTENANCE` is always exclusive). */
  world?: AuthorizationInputWorldMode
  /** `try`: a shared acquisition that never waits; a failed try is reported as busy. */
  sharedAcquire?: 'wait' | 'try'
  /** Takeover entry only: the registered caller. */
  caller?: AuthorizationInputTakeoverCaller
}>

/** `held`: the entry's lock statement returned the row. `missing`: it returned no row, so no row lock is held. */
export type AuthorizationInputRoleRowState = 'held' | 'missing'

/** Locks `work` asks the entry to add: R3 for `admissionUserIds`, then R5 for `userIds`. */
export type AuthorizationInputAcquireRequest = Readonly<{
  admissionUserIds?: readonly string[]
  userIds?: readonly string[]
}>

export type AuthorizationInputTx = Readonly<{
  query: (sql: string, params?: unknown[]) => Promise<AuthorizationInputQueryResult>
  locked: ReadonlyMap<string, LockedAccessGraphUser>
  world: AuthorizationInputWorldMode
  plan: AuthorizationInputPlan
  born: ReadonlySet<string>
  /** Every role id of the plan with the state of its row, in both world modes. */
  roleRows: ReadonlyMap<string, AuthorizationInputRoleRowState>
  /** Role ids of the plan whose row did not exist when the entry locked roles: the `missing` keys of `roleRows`. */
  missingRoleIds: readonly string[]
  /**
   * The plan's witnesses as the entry locked them. `userIds`: the witness users whose row the entry
   * locked at R5; a witness whose row does not exist is not in it. `admissionUserIds`: the witness
   * users whose admission lock the entry took at R3.
   */
  witnessed: Readonly<{ userIds: ReadonlySet<string>; admissionUserIds: ReadonlySet<string> }>
  /**
   * Adds locks after the entry: R3 first, then R5, ids in code-unit order, inside the same timeout
   * window as the entry and with the same busy mapping. Ids this transaction already holds are
   * skipped without a statement. A request is refused before any statement when it would take a
   * rank below one already taken, when it would take a second batch of a rank in shared mode, when
   * another request of this transaction has not settled yet, when it carries a key other than the
   * two lists, or when the intent is not one of the two that may add locks: `DELETE_ROLE` adds the
   * admission locks of the members it read, and an exclusive `EDIT_ROLE_CONTENT` adds the rows of
   * the holders it read.
   */
  acquire(request: AuthorizationInputAcquireRequest): Promise<void>
  /** Throws before any statement unless every id is a user row this transaction locked or a user it created. */
  requireUserRows(userIds: readonly string[]): void
  /** Throws before any statement unless the row lock of every role id is held; a `missing` row is not held. */
  requireRoleRows(roleIds: readonly string[]): void
  insertUserForBirth(row: Readonly<Record<string, unknown>>): Promise<{ id: string }>
  open: boolean
}>

export type AuthorizationInputWork<T> = (tx: AuthorizationInputTx) => Promise<T>

/* ───────────────────────────── errors ───────────────────────────── */

export type AuthorizationInputBusyReason =
  | 'exclusive_exhausted'
  | 'lock_timeout'
  | 'statement_timeout'
  | 'deadlock'
  | 'serialization'
  | 'session_terminated'
  | 'connection_lost'

export const AUTHORIZATION_INPUT_BUSY_HTTP_STATUS = 409
export const AUTHORIZATION_INPUT_BUSY_HTTP_CODE = 'AUTHORIZATION_INPUT_BUSY'
export const AUTHORIZATION_INPUT_BUSY_MESSAGE = 'Authorization inputs are busy; retry this change.'

/** The one retryable error every acquisition failure maps to. `busyReason` and `cause` stay out of responses. */
export class AuthorizationInputBusyError extends AuthorizationInputContractError {
  readonly busyReason: AuthorizationInputBusyReason

  constructor(busyReason: AuthorizationInputBusyReason, cause?: unknown) {
    super('AUTHORIZATION_INPUT_BUSY', { status: AUTHORIZATION_INPUT_BUSY_HTTP_STATUS, retryable: true, reason: busyReason, message: AUTHORIZATION_INPUT_BUSY_MESSAGE })
    this.name = 'AuthorizationInputBusyError'
    this.busyReason = busyReason
    if (cause !== undefined) Object.assign(this, { cause })
  }
}

/**
 * Raised by work (or by the entry when a role row planned by `EDIT_ROLE_CONTENT` does not exist) to
 * request the exclusive world lock. In a self-built shared transaction the entry rolls back and
 * re-runs the work in exclusive mode once; in exclusive mode or in a takeover it becomes a contract
 * error.
 */
export class AuthorizationInputUpgradeRequired extends Error {
  readonly reason: string

  constructor(reason: string) {
    super('Authorization input write requires the exclusive world lock')
    this.name = 'AuthorizationInputUpgradeRequired'
    this.reason = reason
  }
}

type ContractErrorCode = Exclude<AuthorizationInputContractError['code'], 'AUTHORIZATION_INPUT_BUSY' | 'AUTHORIZATION_INPUT_TOKEN_REJECTED'>

function contractError(code: ContractErrorCode, reason: string, status = 500): AuthorizationInputContractError {
  return new AuthorizationInputContractError(code, { status, retryable: false, reason, message: CONTRACT_MESSAGES[code] })
}

const CONTRACT_MESSAGES: Readonly<Record<ContractErrorCode, string>> = Object.freeze({
  AUTHORIZATION_INPUT_PLAN_STALE: 'Authorization input plan is stale; retry this change.',
  AUTHORIZATION_INPUT_PLAN_INVALID: 'Authorization input plan is invalid',
  AUTHORIZATION_INPUT_FANOUT_LIMIT: 'Authorization input write exceeds the holder limit',
  AUTHORIZATION_INPUT_HOLDER_UNCLASSIFIABLE: 'Authorization input write has an unclassifiable holder',
  AUTHORIZATION_INPUT_ISOLATION: 'Authorization input transaction is not read committed',
  AUTHORIZATION_INPUT_UPGRADE_LOOP: 'Authorization input write requested the exclusive world lock twice',
  AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER: 'Authorization input takeover cannot take the exclusive world lock',
})

/* ───────────────────────────── busy mapping ───────────────────────────── */

const SESSION_TERMINATED_CODES: ReadonlySet<string> = new Set(['25P03', '57P01', '57P02', '57P03'])

function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * Maps an acquisition or transaction failure to the busy error, or returns null when the error must
 * pass through unchanged (a recovery-lease 40001 keeps its own family; any other error is the
 * caller's). A connection error heard on the borrowed connection maps to `connection_lost`.
 */
export function classifyAuthorizationInputBusyCause(error: unknown, heardConnectionError = false): AuthorizationInputBusyReason | null {
  const code = sqlState(error)
  // A recovery-lease refusal (SQLSTATE 40001 carrying the lease marker) keeps its own family.
  if (code === '40001' && (error as { message?: unknown }).message === RECOVERY_AUTHORITY_BUSY_MARKER) return null
  if (code === '55P03') return 'lock_timeout'
  if (code === '57014') return 'statement_timeout'
  if (code === '40P01') return 'deadlock'
  if (code === '40001') return 'serialization'
  if (code !== null && SESSION_TERMINATED_CODES.has(code)) return 'session_terminated'
  if (heardConnectionError) return 'connection_lost'
  return null
}

function asBusyOrSame(error: unknown, heardConnectionError: boolean): unknown {
  if (error instanceof AuthorizationInputContractError || error instanceof AuthorizationInputUpgradeRequired) return error
  const reason = classifyAuthorizationInputBusyCause(error, heardConnectionError)
  return reason === null ? error : new AuthorizationInputBusyError(reason, error)
}

/* ───────────────────────────── options ───────────────────────────── */

export type AuthorizationInputExclusiveBudget = Readonly<{ attempts: number; baseDelayMs: number; jitterMs: number }>

/** Editor budget: five tries, 200 ms plus up to 100 ms of jitter between tries. */
export const AUTHORIZATION_INPUT_EXCLUSIVE_BUDGET: AuthorizationInputExclusiveBudget = Object.freeze({ attempts: 5, baseDelayMs: 200, jitterMs: 100 })
/** Maintenance budget: longer than the editor's, never a blocking request. */
export const AUTHORIZATION_INPUT_MAINTENANCE_BUDGET: AuthorizationInputExclusiveBudget = Object.freeze({ attempts: 25, baseDelayMs: 200, jitterMs: 100 })
/** Concurrent exclusive attempts per process; a further attempt is reported as busy at once. */
export const AUTHORIZATION_INPUT_MAX_CONCURRENT_EXCLUSIVE = 2

export type AuthorizationInputHandlerClient = { query: (sql: string, params?: unknown[]) => Promise<AuthorizationInputQueryResult>; __rawClient?: PoolClient }

export type AuthorizationInputTransactionRunner = <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>) => Promise<T>

export type AuthorizationInputEntryOptions = Readonly<{
  /** The transaction runner; defaults to the main connection pool's `transaction`. */
  transaction?: AuthorizationInputTransactionRunner
  exclusive?: Partial<AuthorizationInputExclusiveBudget>
  maintenance?: Partial<AuthorizationInputExclusiveBudget>
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Runs after the locks are held and before `work`; a hook for deterministic tests. */
  afterAcquire?: (tx: AuthorizationInputTx) => Promise<void>
}>

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function defaultTransaction<T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>): Promise<T> {
  return poolManager.get().transaction((client) => handler({ query: (sql, params) => client.query(sql, params), __rawClient: client.__rawClient }))
}

/* ───────────────────────────── plan validation ───────────────────────────── */

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Ids must be canonical: non-blank strings without surrounding whitespace, so every lock keys on the same spelling. */
function normalizeIds(values: readonly string[] | undefined, what: string): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', `${what}_not_array`)
  const ids = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', `${what}_blank`)
    if (value.trim() !== value) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', `${what}_not_canonical`)
    ids.add(value)
  }
  return [...ids].sort(compareCodeUnits)
}

/** Intents that lock the role rows they name for update: they write role content. */
const ROLE_ROW_UPDATE_INTENTS: ReadonlySet<AuthorizationInputIntent> = new Set(['EDIT_ROLE_CONTENT', 'DELETE_ROLE', 'MAINTENANCE'])
/** Intents that lock the role rows they name in share mode: they write a membership of the role. */
const ROLE_ROW_SHARE_INTENTS: ReadonlySet<AuthorizationInputIntent> = new Set(['GRANT_ROLE', 'REVOKE_ROLE', 'SET_ADMIN_PROFILE', 'BIRTH', 'PROJECTION_GRANT'])
/** Content intents: a shared-start plan names no users or admissions; `work` adds the locks it needs through `tx.acquire`. */
const CONTENT_INTENTS: ReadonlySet<AuthorizationInputIntent> = new Set(['EDIT_ROLE_CONTENT', 'DELETE_ROLE'])
/** The reserved platform administrator role, compared by exact equality. */
const PLATFORM_ADMIN_ROLE_ID = 'admin'

type NormalizedPlan = Readonly<{
  plan: AuthorizationInputPlan
  ruleOf: AuthorizationInputIntentRule
  /** R5 set: the plan's targets merged with its witnesses. */
  userIds: readonly string[]
  roleIds: readonly string[]
  /** R3 set: the plan's targets merged with its witnesses. */
  admissionUserIds: readonly string[]
  witnessUserIds: readonly string[]
  witnessAdmissionUserIds: readonly string[]
  roleRowMode: 'update' | 'share'
  platformAdminInvariant: boolean
  startWorld: AuthorizationInputWorldMode
  sharedAcquire: 'wait' | 'try'
}>

function mergeIds(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort(compareCodeUnits)
}

/** The shapes are closed: a key the contract does not define names no lock, so it is refused, never ignored. */
const PLAN_KEYS: ReadonlySet<string> = new Set(['intent', 'userIds', 'roleIds', 'admissionUserIds', 'witness', 'platformAdminInvariant', 'world', 'sharedAcquire', 'caller'])
const WITNESS_KEYS: ReadonlySet<string> = new Set(['userIds', 'admissionUserIds'])
const ACQUIRE_REQUEST_KEYS: ReadonlySet<string> = new Set(['admissionUserIds', 'userIds'])

function refuseUnknownKeys(value: object, known: ReadonlySet<string>, reason: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !known.has(key)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', reason)
  }
}

function normalizePlan(plan: AuthorizationInputPlan, entry: 'self' | 'takeover'): NormalizedPlan {
  if (typeof plan !== 'object' || plan === null) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'plan_missing')
  // The catalogue is closed: only its own keys name an intent, never a property inherited from Object.
  if (typeof plan.intent !== 'string' || !Object.hasOwn(AUTHORIZATION_INPUT_INTENT_CATALOG, plan.intent)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'intent_unknown')
  const ruleOf = AUTHORIZATION_INPUT_INTENT_CATALOG[plan.intent]
  refuseUnknownKeys(plan, PLAN_KEYS, 'plan_unknown_key')
  if (plan.witness !== undefined && (typeof plan.witness !== 'object' || plan.witness === null)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'witness_not_object')
  if (plan.witness !== undefined) refuseUnknownKeys(plan.witness, WITNESS_KEYS, 'witness_unknown_key')
  const witnessUserIds = normalizeIds(plan.witness?.userIds, 'witness_user_ids')
  const witnessAdmissionUserIds = normalizeIds(plan.witness?.admissionUserIds, 'witness_admission_user_ids')
  // An intent that locks role rows for update carries no witness, whichever world mode it starts in.
  if (ROLE_ROW_UPDATE_INTENTS.has(plan.intent) && (witnessUserIds.length > 0 || witnessAdmissionUserIds.length > 0)) {
    throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'role_row_update_intent_witness')
  }
  if (entry === 'self' && plan.caller !== undefined) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'caller_on_self_built')
  if (plan.world !== undefined && plan.world !== 'shared' && plan.world !== 'exclusive') throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'world_unknown')
  if (plan.sharedAcquire !== undefined && plan.sharedAcquire !== 'wait' && plan.sharedAcquire !== 'try') throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'shared_acquire_unknown')
  const startWorld: AuthorizationInputWorldMode = ruleOf.world === 'exclusive' ? 'exclusive' : plan.world ?? 'shared'
  if (startWorld === 'exclusive' && !(ruleOf.world === 'exclusive' || ruleOf.upgradeable)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'exclusive_not_permitted')
  if (startWorld === 'exclusive' && entry === 'takeover') throw contractError('AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', 'exclusive_start')
  const userIds = normalizeIds(plan.userIds, 'user_ids')
  const roleIds = normalizeIds(plan.roleIds, 'role_ids')
  const admissionUserIds = normalizeIds(plan.admissionUserIds, 'admission_user_ids')
  // A birth names existing users only as witnesses: a top-level id could be mistaken for a write target.
  if (ruleOf.birth && userIds.length > 0) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'birth_locks_users')
  if (ruleOf.birth && admissionUserIds.length > 0) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'birth_locks_admissions')
  // A projection has no human operator: it names no witness.
  if (plan.intent === 'PROJECTION_GRANT' && (witnessUserIds.length > 0 || witnessAdmissionUserIds.length > 0)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'projection_grant_witness')
  const roleRowMode = ROLE_ROW_UPDATE_INTENTS.has(plan.intent) ? 'update' : 'share'
  if (roleIds.length > 0 && !ROLE_ROW_UPDATE_INTENTS.has(plan.intent) && !ROLE_ROW_SHARE_INTENTS.has(plan.intent)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'role_ids_not_in_intent')
  if (CONTENT_INTENTS.has(plan.intent) && startWorld === 'shared' && (userIds.length > 0 || admissionUserIds.length > 0)) {
    throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'content_intent_locks_users')
  }
  if (plan.intent === 'DELETE_ROLE' && roleIds.includes(PLATFORM_ADMIN_ROLE_ID)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'delete_role_platform_admin')
  return Object.freeze({
    plan,
    ruleOf,
    userIds: mergeIds(userIds, witnessUserIds),
    roleIds,
    admissionUserIds: mergeIds(admissionUserIds, witnessAdmissionUserIds),
    witnessUserIds,
    witnessAdmissionUserIds,
    roleRowMode,
    platformAdminInvariant: ruleOf.platformAdminInvariant || plan.platformAdminInvariant === true,
    startWorld,
    sharedAcquire: plan.sharedAcquire ?? 'wait',
  })
}

/* ───────────────────────────── acquisition ───────────────────────────── */

let inflightExclusive = 0

async function acquireExclusive(query: AuthorizationInputQueryable['query'], budget: AuthorizationInputExclusiveBudget, options: AuthorizationInputEntryOptions | undefined): Promise<void> {
  if (inflightExclusive >= AUTHORIZATION_INPUT_MAX_CONCURRENT_EXCLUSIVE) throw new AuthorizationInputBusyError('exclusive_exhausted')
  inflightExclusive += 1
  try {
    const sleep = options?.sleep ?? defaultSleep
    const random = options?.random ?? Math.random
    const attempts = Math.max(1, Math.floor(budget.attempts))
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await query(AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry)
      if (result.rows[0]?.acquired === true) return
      if (attempt < attempts) await sleep(budget.baseDelayMs + Math.floor(random() * budget.jitterMs))
    }
    throw new AuthorizationInputBusyError('exclusive_exhausted')
  } finally {
    inflightExclusive -= 1
  }
}

function budgetFor(intent: AuthorizationInputIntent, options: AuthorizationInputEntryOptions | undefined): AuthorizationInputExclusiveBudget {
  return intent === 'MAINTENANCE'
    ? Object.freeze({ ...AUTHORIZATION_INPUT_MAINTENANCE_BUDGET, ...options?.maintenance })
    : Object.freeze({ ...AUTHORIZATION_INPUT_EXCLUSIVE_BUDGET, ...options?.exclusive })
}

const BIRTH_COLUMN = /^[a-z][a-z0-9_]*$/

type AcquiredLocks = Readonly<{
  locked: Map<string, LockedAccessGraphUser>
  roleRows: Map<string, AuthorizationInputRoleRowState>
  admissionHeld: Set<string>
}>

/** Sets the transaction-local lock and statement timeouts and returns the function that restores the caller's values. */
async function openTimeoutWindow(query: AuthorizationInputQueryable['query']): Promise<() => Promise<unknown>> {
  const saved = await query(AUTHORIZATION_INPUT_STATEMENTS.readTimeouts)
  const savedLock = String(saved.rows[0]?.lock_timeout ?? '0')
  const savedStatement = String(saved.rows[0]?.statement_timeout ?? '0')
  await query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)])
  return () => query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [savedLock, savedStatement])
}

/**
 * Takes the planned locks in rank order under transaction-local timeouts: R0 in the given mode, R1,
 * each role row (for update or in share mode, by intent), R3 per admission user, then R5 through the
 * canonical user mutex; restores the caller's timeouts afterwards. The state of every planned role
 * row is recorded in both world modes. In shared mode a missing role row requests the upgrade for
 * `EDIT_ROLE_CONTENT` only, whose write may create the row; for every other intent the missing row
 * is recorded and `work` decides. The two refusals that involve no failed statement (a shared try
 * not granted, a missing role row) restore the timeouts before they are raised, since the caller's
 * transaction stays usable; after a failed statement the transaction is aborted and nothing is
 * restored.
 */
async function acquireLocks(client: AuthorizationInputQueryable, normalized: NormalizedPlan, world: AuthorizationInputWorldMode, options: AuthorizationInputEntryOptions | undefined): Promise<AcquiredLocks> {
  const query = (sql: string, params?: unknown[]) => client.query(sql, params)
  const restore = await openTimeoutWindow(query)

  if (world === 'exclusive') {
    await acquireExclusive(query, budgetFor(normalized.plan.intent, options), options)
  } else if (normalized.sharedAcquire === 'try') {
    const result = await query(AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)
    if (result.rows[0]?.acquired !== true) {
      await restore()
      throw new AuthorizationInputBusyError('lock_timeout')
    }
  } else {
    await query(AUTHORIZATION_INPUT_STATEMENTS.worldShared)
  }
  if (normalized.platformAdminInvariant) await query(AUTHORIZATION_INPUT_STATEMENTS.platformAdminInvariant)
  const roleRows = new Map<string, AuthorizationInputRoleRowState>()
  const roleRowStatement = normalized.roleRowMode === 'update' ? AUTHORIZATION_INPUT_STATEMENTS.roleRow : AUTHORIZATION_INPUT_STATEMENTS.roleRowShared
  for (const roleId of normalized.roleIds) {
    const row = await query(roleRowStatement, [roleId])
    roleRows.set(roleId, row.rows.length === 0 ? 'missing' : 'held')
  }
  // Decided by intent, not by whether the intent may upgrade: only a role content edit can create
  // the row it names, and creating a role row is a write that needs the exclusive world lock.
  if (world === 'shared' && normalized.plan.intent === 'EDIT_ROLE_CONTENT' && [...roleRows.values()].includes('missing')) {
    await restore()
    throw new AuthorizationInputUpgradeRequired('role_row_missing')
  }
  for (const userId of normalized.admissionUserIds) await query(AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission, [`namespace-admission:${userId}`])
  const locked = normalized.userIds.length > 0 ? await lockUsersForAccessGraphWrite(client, [...normalized.userIds]) : new Map<string, LockedAccessGraphUser>()
  await restore()
  return Object.freeze({ locked, roleRows, admissionHeld: new Set(normalized.admissionUserIds) })
}

/** A read-only view of a map: the mutators throw, the readers delegate to the live map. */
function readonlyMapView<K, V>(inner: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const refuse = () => {
    throw new TypeError('read-only view')
  }
  const view: Map<K, V> = new Map()
  Object.defineProperties(view, {
    set: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
    get: { value: (key: K) => inner.get(key) },
    has: { value: (key: K) => inner.has(key) },
    size: { get: () => inner.size },
    keys: { value: () => inner.keys() },
    values: { value: () => inner.values() },
    entries: { value: () => inner.entries() },
    forEach: { value: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void) => inner.forEach(callback) },
    [Symbol.iterator]: { value: () => inner[Symbol.iterator]() },
  })
  return Object.freeze(view)
}

/** A read-only view of a set: the mutators throw, the readers delegate to the live set. */
function readonlySetView<T>(inner: ReadonlySet<T>): ReadonlySet<T> {
  const refuse = () => {
    throw new TypeError('read-only view')
  }
  const view: Set<T> = new Set()
  Object.defineProperties(view, {
    add: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
    has: { value: (value: T) => inner.has(value) },
    size: { get: () => inner.size },
    keys: { value: () => inner.keys() },
    values: { value: () => inner.values() },
    entries: { value: () => inner.entries() },
    forEach: { value: (callback: (value: T, value2: T, set: ReadonlySet<T>) => void) => inner.forEach(callback) },
    [Symbol.iterator]: { value: () => inner[Symbol.iterator]() },
  })
  return Object.freeze(view)
}

type MintedTx = Readonly<{ tx: AuthorizationInputTx; close(): void }>

function mintTx(client: AuthorizationInputQueryable, extraClients: readonly object[], normalized: NormalizedPlan, world: AuthorizationInputWorldMode, locks: AcquiredLocks): MintedTx {
  const born = new Set<string>()
  const token = {} as { -readonly [K in keyof AuthorizationInputTx]: AuthorizationInputTx[K] }
  const brand = mintAuthorizationInputBrand(token, [client, ...extraClients])
  const query = async (sql: string, params?: unknown[]): Promise<AuthorizationInputQueryResult> => {
    if (!brand.isOpen()) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'token_closed')
    return client.query(sql, params)
  }
  token.query = query
  // The token exposes read-only views: the lock set and the birth set change only through the entry.
  token.locked = readonlyMapView(locks.locked)
  token.world = world
  token.plan = normalized.plan
  token.born = readonlySetView(born)
  token.roleRows = readonlyMapView(locks.roleRows)
  token.missingRoleIds = Object.freeze([...locks.roleRows].filter(([, state]) => state === 'missing').map(([roleId]) => roleId))
  token.witnessed = Object.freeze({
    // A witness whose row does not exist was not locked.
    userIds: readonlySetView(new Set(normalized.witnessUserIds.filter((userId) => locks.locked.has(userId)))),
    admissionUserIds: readonlySetView(new Set(normalized.witnessAdmissionUserIds)),
  })
  token.requireUserRows = (userIds) => {
    for (const userId of normalizeIds(userIds, 'required_user_ids')) {
      if (!locks.locked.has(userId) && !born.has(userId)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'user_row_not_held')
    }
  }
  token.requireRoleRows = (roleIds) => {
    // Compared by value: a role id the plan named whose row is missing has no row lock.
    for (const roleId of normalizeIds(roleIds, 'required_role_ids')) {
      if (locks.roleRows.get(roleId) !== 'held') throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'role_row_not_held')
    }
  }
  // Highest rank this transaction has taken, and the ranks of which a batch has been taken.
  const ranks = AUTHORIZATION_INPUT_LOCK_RANKS
  let highestRank: number = normalized.userIds.length > 0 ? ranks.R5_USER_ROW : normalized.admissionUserIds.length > 0 ? ranks.R3_NAMESPACE_ADMISSION : normalized.roleIds.length > 0 ? ranks.R2R_ROLE_ROW : normalized.platformAdminInvariant ? ranks.R1_PLATFORM_ADMIN_INVARIANT : ranks.R0_WORLD
  const batchTaken = new Set<number>()
  if (normalized.admissionUserIds.length > 0) batchTaken.add(ranks.R3_NAMESPACE_ADMISSION)
  if (normalized.userIds.length > 0) batchTaken.add(ranks.R5_USER_ROW)
  // Set from the checks of a request until its statements settle. Every check below runs before the
  // first await, so a request made while another is in flight sees the flag and issues nothing.
  let acquiring = false
  token.acquire = async (request) => {
    if (!brand.isOpen()) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'token_closed')
    if (acquiring) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'acquire_in_progress')
    if (typeof request !== 'object' || request === null) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'acquire_request_missing')
    refuseUnknownKeys(request, ACQUIRE_REQUEST_KEYS, 'acquire_request_unknown_key')
    // Ids this transaction already holds are skipped: no statement, and no batch is counted.
    const admissionUserIds = normalizeIds(request.admissionUserIds, 'acquire_admission_user_ids').filter((userId) => !locks.admissionHeld.has(userId))
    const userIds = normalizeIds(request.userIds, 'acquire_user_ids').filter((userId) => !locks.locked.has(userId))
    if (admissionUserIds.length === 0 && userIds.length === 0) return
    const requested: number[] = [...(admissionUserIds.length > 0 ? [ranks.R3_NAMESPACE_ADMISSION] : []), ...(userIds.length > 0 ? [ranks.R5_USER_ROW] : [])]
    if (requested.some((rank) => rank < highestRank)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'acquire_rank_regression')
    if (world === 'shared' && requested.some((rank) => batchTaken.has(rank))) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'acquire_rank_repeated')
    const intent = normalized.plan.intent
    const open = (intent === 'DELETE_ROLE' && userIds.length === 0) || (intent === 'EDIT_ROLE_CONTENT' && world === 'exclusive' && admissionUserIds.length === 0)
    if (!open) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'acquire_not_open')
    acquiring = true
    try {
      const restore = await openTimeoutWindow(query)
      for (const userId of admissionUserIds) {
        await query(AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission, [`namespace-admission:${userId}`])
        locks.admissionHeld.add(userId)
      }
      if (userIds.length > 0) {
        for (const [userId, row] of await lockUsersForAccessGraphWrite({ query }, userIds)) locks.locked.set(userId, row)
      }
      for (const rank of requested) batchTaken.add(rank)
      highestRank = Math.max(highestRank, ...requested)
      await restore()
    } catch (error) {
      throw asBusyOrSame(error, false)
    } finally {
      acquiring = false
    }
  }
  token.insertUserForBirth = async (row) => {
    if (!normalized.ruleOf.birth) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'birth_not_in_intent')
    if (typeof row !== 'object' || row === null) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'birth_row_missing')
    const columns = Object.keys(row)
    if (columns.length === 0 || columns.some((column) => !BIRTH_COLUMN.test(column))) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'birth_column_invalid')
    const placeholders = columns.map((_, index) => `$${index + 1}`)
    const result = await query(`INSERT INTO users (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id::text AS id`, columns.map((column) => row[column]))
    const id = result.rows[0]?.id
    if (result.rows.length !== 1 || typeof id !== 'string' || id.length === 0) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'birth_row_not_returned')
    // A row this transaction locked existed before it: it is not a birth.
    if (locks.locked.has(id)) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'birth_row_already_locked')
    born.add(id)
    return { id }
  }
  Object.defineProperty(token, 'open', { enumerable: true, get: () => brand.isOpen() })
  return Object.freeze({ tx: Object.freeze(token) as AuthorizationInputTx, close: brand.close })
}

/* ───────────────────────────── self-built entry ───────────────────────────── */

/** A transaction that holds a pull-source organisation lock takes no contract lock: refused before any statement. */
function refuseInsidePullSourceGate(): void {
  if (isInsidePullSourceGate()) throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'inside_pull_source_gate')
}

/**
 * A connection error heard before `work` returns makes every later failure of the borrow (including
 * a failed COMMIT) busy; a failure after `work` returned with no error heard before that point is the
 * caller's, because the entry cannot claim that no write reached the database.
 */
async function runSelfBuilt<T>(normalized: NormalizedPlan, world: AuthorizationInputWorldMode, work: AuthorizationInputWork<T>, options: AuthorizationInputEntryOptions | undefined): Promise<T> {
  const transaction = options?.transaction ?? defaultTransaction
  let heardAny = false
  let heardBeforeReturn = false
  let workReturned = false
  let raw: PoolClient | undefined
  const onError = () => {
    heardAny = true
  }
  try {
    return await transaction(async (client) => {
      raw = client.__rawClient
      if (raw && typeof raw.on === 'function') raw.on('error', onError)
      await client.query(AUTHORIZATION_INPUT_STATEMENTS.setTransaction)
      const locks = await acquireLocks(client, normalized, world, options)
      const minted = mintTx(client, raw ? [raw] : [], normalized, world, locks)
      try {
        if (options?.afterAcquire) await options.afterAcquire(minted.tx)
        const value = await work(minted.tx)
        heardBeforeReturn = heardAny
        workReturned = true
        return value
      } finally {
        minted.close()
      }
    })
  } catch (error) {
    if (workReturned && !heardBeforeReturn) throw error
    throw asBusyOrSame(error, heardAny)
  } finally {
    if (raw && typeof raw.removeListener === 'function') raw.removeListener('error', onError)
  }
}

/**
 * Opens a contract transaction, takes the planned locks and runs `work` with the branded token.
 * A shared attempt that raises `AuthorizationInputUpgradeRequired` is rolled back and `work` is run
 * once more in exclusive mode; a second request is `AUTHORIZATION_INPUT_UPGRADE_LOOP`.
 */
export async function withAuthorizationInputTransaction<T>(plan: AuthorizationInputPlan, work: AuthorizationInputWork<T>, options?: AuthorizationInputEntryOptions): Promise<T> {
  refuseInsidePullSourceGate()
  const normalized = normalizePlan(plan, 'self')
  let world = normalized.startWorld
  for (;;) {
    try {
      return await runSelfBuilt(normalized, world, work, options)
    } catch (error) {
      if (!(error instanceof AuthorizationInputUpgradeRequired)) throw error
      if (world === 'exclusive') throw contractError('AUTHORIZATION_INPUT_UPGRADE_LOOP', 'exclusive_requested_twice')
      if (!normalized.ruleOf.upgradeable) throw contractError('AUTHORIZATION_INPUT_UPGRADE_LOOP', 'intent_not_upgradeable')
      world = 'exclusive'
    }
  }
}

/* ───────────────────────────── takeover entry ───────────────────────────── */

/**
 * Joins the caller's open transaction. `plan.caller` names one of the two registered callers,
 * `plan.intent` must be in that caller's closed intent set and `prefix` must equal its registered
 * prefix list; the transaction must be READ COMMITTED. The world lock is taken shared; an upgrade
 * request from `work` is `AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER`. No listener is attached and no
 * session parameter is set: the connection belongs to the caller.
 */
export async function enterAuthorizationInputTransaction<T>(client: AuthorizationInputQueryable, plan: AuthorizationInputPlan, prefix: readonly RegisteredPrefix[], work: AuthorizationInputWork<T>): Promise<T> {
  refuseInsidePullSourceGate()
  const normalized = normalizePlan(plan, 'takeover')
  // The caller registry is closed: only its own keys name a caller.
  const caller = typeof plan.caller === 'string' && Object.hasOwn(AUTHORIZATION_INPUT_TAKEOVER_CALLERS, plan.caller) ? AUTHORIZATION_INPUT_TAKEOVER_CALLERS[plan.caller] : undefined
  if (!caller) throw contractError('AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', 'caller_not_registered')
  if (!caller.intents.includes(plan.intent)) throw contractError('AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', 'intent_outside_closure')
  if (!Array.isArray(prefix) || prefix.length !== caller.prefixes.length || prefix.some((entry, index) => entry !== caller.prefixes[index])) {
    throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'prefix_not_registered')
  }
  if (!client || typeof client.query !== 'function') throw contractError('AUTHORIZATION_INPUT_PLAN_INVALID', 'client_missing')

  const locks = await (async (): Promise<AcquiredLocks> => {
    try {
      const isolation = await client.query(AUTHORIZATION_INPUT_STATEMENTS.isolationProbe)
      if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') throw contractError('AUTHORIZATION_INPUT_ISOLATION', 'not_read_committed')
      return await acquireLocks(client, normalized, 'shared', undefined)
    } catch (error) {
      if (error instanceof AuthorizationInputUpgradeRequired) throw contractError('AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', error.reason)
      throw asBusyOrSame(error, false)
    }
  })()
  const raw = (client as { __rawClient?: object }).__rawClient
  const minted = mintTx(client, raw ? [raw] : [], normalized, 'shared', locks)
  try {
    return await work(minted.tx)
  } catch (error) {
    if (error instanceof AuthorizationInputUpgradeRequired) throw contractError('AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', error.reason)
    throw error
  } finally {
    minted.close()
  }
}

/* ───────────────────────────── reads under the world lock ───────────────────────────── */

/**
 * The subset of `roleIds` that currently raise the privilege class: the id itself is class-raising,
 * or the role holds a class-raising code. Read under the world lock, the answer is stable for the
 * rest of the transaction. The read joins `role_permissions` by role id and never `roles`.
 */
export async function readClassRaisingRoleIds(tx: AuthorizationInputTx, roleIds: readonly string[]): Promise<ReadonlySet<string>> {
  const ids = normalizeIds(roleIds, 'role_ids')
  const raising = new Set<string>(ids.filter((roleId) => isClassRaisingRoleId(roleId)))
  const remaining = ids.filter((roleId) => !raising.has(roleId))
  if (remaining.length === 0) return raising
  const result = await tx.query(AUTHORIZATION_INPUT_STATEMENTS.rolePermissionCodes, [remaining])
  for (const row of result.rows) {
    if (typeof row.role_id === 'string' && isClassRaisingPermissionCode(row.permission_code)) raising.add(row.role_id)
  }
  return raising
}
