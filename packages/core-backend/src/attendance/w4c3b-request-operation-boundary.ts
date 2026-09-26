/**
 * W4C-3b P13: canonical request-operation owner for create/edit/decision/cancel.
 *
 * The plugin installs the four fixed adapters once at activation. HTTP routes
 * submit closed data only; they cannot supply callbacks, prepared drafts, lock
 * witnesses, or transaction clients. Preparation may perform the non-locking
 * reads needed to mint the authorization witness and command envelope. Source
 * locks and every request/event/approval/assignment/ledger write belong to
 * execute, after operation replay/preflight. All work shares the same
 * SERIALIZABLE transaction and connection.
 *
 * Host-owned route variants distinguish every specialized write surface that
 * shares one of the four operation kinds. SourceRef is derived only from the
 * closed (kind, routeVariant) pair — never from request body keys.
 */
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  acquireAttendanceCalculationRolloutLock,
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
} from './w4c0-identity'
import {
  createAuthorizedAttendanceWriteContextV1,
  type AttendanceActorPostureV1,
  type AttendanceWriteSubjectScopeV1,
} from './w4c0-authorization'
import {
  attendanceResultOperationPreflightV1,
  enqueueAttendanceResultEventOutboxV1,
  runAttendanceResultOperationTransactionV1,
  sealAttendanceResultOperationV1,
} from './w4c0-operation-registry'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import type { AttendanceW4OutboxEventKindV1 } from './w4c0-operation-contract'
import { computeAttendanceBusinessKeyFingerprintV1 } from './w4c0-fingerprints'
import {
  normalizeAttendanceSourceOperationEnvelopeV1,
  type NormalizedAttendanceSourceOperationEnvelopeV1,
} from './w4c0-source-commands'

export const ATTENDANCE_REQUEST_OPERATION_KINDS_V1 = Object.freeze([
  'request_create',
  'request_pending_edit',
  'request_decision',
  'request_cancel',
] as const)

export type AttendanceRequestOperationKindV1 = (typeof ATTENDANCE_REQUEST_OPERATION_KINDS_V1)[number]

/** Closed create-family variants owned by the host; only route code may supply these. */
export const ATTENDANCE_REQUEST_CREATE_ROUTE_VARIANTS_V1 = Object.freeze([
  'generic',
  'outdoor',
  'schedule_dispatch',
  'shift_swap',
] as const)

export type AttendanceRequestCreateRouteVariantV1 =
  (typeof ATTENDANCE_REQUEST_CREATE_ROUTE_VARIANTS_V1)[number]

export const ATTENDANCE_REQUEST_SPECIALIZED_ROUTE_VARIANTS_V1 = Object.freeze([
  'schedule_dispatch_cancel',
  'shift_swap_accept',
  'shift_swap_reject',
  'shift_swap_cancel',
] as const)

export type AttendanceRequestSpecializedRouteVariantV1 =
  (typeof ATTENDANCE_REQUEST_SPECIALIZED_ROUTE_VARIANTS_V1)[number]

export type AttendanceRequestOperationRouteVariantV1 =
  | AttendanceRequestCreateRouteVariantV1
  | AttendanceRequestSpecializedRouteVariantV1

export class AttendanceW4RequestBoundaryError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, httpStatus = 422) {
    super(code)
    this.name = 'AttendanceW4RequestBoundaryError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function fail(code: string, httpStatus = 422): never {
  throw new AttendanceW4RequestBoundaryError(code, httpStatus)
}

function exactObject(input: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const object = input as Record<string, unknown>
  if (Object.getOwnPropertySymbols(object).length > 0) fail(code)
  const names = Object.getOwnPropertyNames(object)
  if (names.length !== keys.length) fail(code)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (!descriptor || !('value' in descriptor)) fail(code)
  }
  return object
}

const UUID_SYNTAX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function uuidOrNull(value: unknown, code: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length !== 36 || !UUID_SYNTAX.test(value)) fail(code)
  return value.toLowerCase()
}

function frozenJsonCopy(value: unknown, code: string, depth = 0): unknown {
  if (depth > 16) fail(code)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code)
    return value
  }
  if (typeof value !== 'object') fail(code)
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => frozenJsonCopy(entry, code, depth + 1)))
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) fail(code)
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code)
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) fail(code)
    copy[key] = frozenJsonCopy(descriptor.value, code, depth + 1)
  }
  return Object.freeze(copy)
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) fail('W4C3B_REQUEST_RESPONSE_INVALID', 500)
  return JSON.parse(JSON.stringify(value)) as unknown
}

export interface AttendanceRequestPluginTrxV1 {
  query(sqlText: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>
  readonly __w4CanonicalTrx: true
}

function pluginTrx(client: AttendanceW4TransactionClientV1): AttendanceRequestPluginTrxV1 {
  return {
    __w4CanonicalTrx: true,
    async query(sqlText: string, params?: unknown[]) {
      const result = await client.query(sqlText, params ?? [])
      return result.rows
    },
  }
}

export interface AttendanceRequestOperationPreparedV1<TState = unknown> {
  readonly orgId: string
  readonly actorId: string
  readonly actorPosture: AttendanceActorPostureV1
  readonly tokenSubjectUserId: string | null
  readonly subjectUserId: string
  readonly subjectScope: AttendanceWriteSubjectScopeV1
  readonly commandPayload: Readonly<Record<string, unknown>>
  readonly state: TState
}

export interface AttendanceRequestOperationExecutionV1 {
  /**
   * Absent on every successful execution. Present only on the refusal member below, which is what
   * makes this pair a discriminated union the compiler can narrow without every existing adapter
   * having to start returning a tag it never returned before.
   */
  readonly kind?: undefined
  readonly response: unknown
  readonly resolvedRequestId: string | null
  readonly lifecycleEvents: readonly [{
    readonly eventKind: AttendanceW4OutboxEventKindV1
    readonly payload: unknown
  }]
}

/**
 * Lock §3 C-3 / §11-④ (lock:126-130) — a BUSINESS refusal, returned by the adapter instead of
 * thrown.
 *
 * `w4c3b-approved-leave-cancellation.ts` already returns the business outcome `review_required`
 * as a value (`:76`, `:165`); its only production consumer turned that value straight back into a
 * `throw` (`plugins/plugin-attendance/index.cjs`, the
 * `ATTENDANCE_CANCELLATION_REVIEW_REQUIRED` 409). A throw aborts the caller's transaction path,
 * so a cancel round could never PERSIST its `blocked` closure — the lock is explicit that this is
 * the C-1 reuse point and that it 「不得写成照既有先例」. Hence: the adapter now returns this, and
 * the ONE place that decides what to do with it is the boundary, per entry.
 *
 * 「业务拒绝与基础设施异常是两条路径、两种返回,不共用 throw」(lock §3 C-3, last line): this type is
 * the business-rejection path. Infrastructure failures keep throwing and are nobody's decision.
 */
export interface AttendanceRequestOperationBusinessRefusalV1 {
  readonly kind: 'business_refused'
  /**
   * Stable machine code for the refusal, and — pinned here so 判据 IV cannot drift — the `<code>`
   * that C-3's engine record reason `business_blocked:<code>` is built from (lock §14.2 判据 IV).
   * A bounded, queryable token; the fine-grained business cause travels in `detail`, not in the
   * reason string.
   */
  readonly code: string
  /**
   * The adapter's own finer-grained cause (for the approved-leave cancellation: the
   * `ApprovedLeaveCancellationReviewReasonV1`, e.g. `record_missing`). Carried into the C-3
   * closure's record metadata, never concatenated into the reason.
   */
  readonly detail: string | null
  /**
   * The error the HTTP entry throws, CONSTRUCTED BY THE ADAPTER and thrown unchanged by this
   * boundary. The adapter owns the host's error class and its exact payload, so the HTTP response
   * stays byte-for-byte what it is today (status, code, message, validation details) — the
   * 账侧字节等价 acceptance line (lock §8 期 1). The boundary never re-derives it.
   */
  readonly httpError: unknown
}

export type AttendanceRequestOperationExecutionResultV1 =
  | AttendanceRequestOperationExecutionV1
  | AttendanceRequestOperationBusinessRefusalV1

export interface AttendanceRequestOperationContextV1 {
  readonly operationId: string | null
  readonly correlationId: string
  readonly acceptedWritePosture: 'legacy_projection_only' | 'shadow' | 'authoritative' | null
  /**
   * #4899 residual R4: the org's resolved `referenceSegments` posture bit, carried down
   * to `execute` so approval finalization does NOT re-resolve it.
   *
   * The boundary already resolves the posture under the class-`00` rollout SHARED advisory
   * lock BEFORE `execute` runs (`resolveSegmentCalculationPosture`, either in the null-ID
   * branch below or inside `attendanceResultOperationPreflightV1`). Re-resolving inside
   * finalization repeats a lock-take plus a SELECT for a value that cannot have changed —
   * the shared lock is transaction-scoped and still held — and it re-takes that lock AFTER
   * the request row lock, which is the exact ordering the #4899 owner-P1 counterexample
   * exists to forbid. One resolve per transaction, above every row lock, consumed by both
   * the finalization reference guards and the calculation read path.
   *
   * `false` in every phase where no posture has been resolved yet (the prepare-phase
   * context) and for every org outside the canonical W4 domain — fail-closed, matching the
   * port's own non-canonical answer (`src/index.ts`, `W4C0_ROLLOUT_ORG_KEY_INVALID` =>
   * `{ effectiveState: 'legacy', referenceSegments: false }`).
   */
  readonly referenceSegments: boolean
  /** Host-validated route family; null is the generic non-create surface. */
  readonly routeVariant: AttendanceRequestOperationRouteVariantV1 | null
}

export interface AttendanceRequestOperationAdapterV1<TState = unknown> {
  /**
   * Read-only identity projection used by stable-ID preflight. It may read only
   * durable route identity (for example request org/subject), never mutable
   * flow/status/evidence required by execute. Completed replay returns before
   * prepare() is called.
   */
  prepareIdentity(
    trx: AttendanceRequestPluginTrxV1,
    routeInput: unknown,
    operation: AttendanceRequestOperationContextV1,
  ): Promise<AttendanceRequestOperationPreparedV1<unknown>>
  prepare(
    trx: AttendanceRequestPluginTrxV1,
    routeInput: unknown,
    operation: AttendanceRequestOperationContextV1,
  ): Promise<AttendanceRequestOperationPreparedV1<TState>>
  execute(
    trx: AttendanceRequestPluginTrxV1,
    prepared: AttendanceRequestOperationPreparedV1<TState>,
    operation: AttendanceRequestOperationContextV1,
  ): Promise<AttendanceRequestOperationExecutionResultV1>
}

export type AttendanceRequestOperationAdaptersV1 = Readonly<{
  [K in AttendanceRequestOperationKindV1]: AttendanceRequestOperationAdapterV1
}>

export interface AttendanceRequestOperationBoundaryConnectionV1 {
  readonly client: AttendanceW4TransactionClientV1
  release(): void
}

export interface AttendanceRequestOperationBoundaryInputV1 {
  readonly kind: AttendanceRequestOperationKindV1
  readonly operationId: string | null
  readonly correlationId: string
  /**
   * Host-owned route-family discriminator. Create requires its closed family;
   * non-create generic routes use null and specialized routes use only the
   * pair allowed by normalizeRouteVariant. Never read this from request data.
   */
  readonly routeVariant: AttendanceRequestOperationRouteVariantV1 | null
  readonly routeInput: unknown
}

export type AttendanceRequestOperationBoundaryResultV1 =
  | { readonly kind: 'legacy'; readonly response: unknown }
  | { readonly kind: 'legacy_compat'; readonly response: unknown }
  | { readonly kind: 'executed'; readonly response: unknown }
  | { readonly kind: 'replay'; readonly response: unknown }

/**
 * Lock §3 C-1 (lock:88-92) — the external transaction entry. It carries exactly the
 * `execute` input plus the caller's transaction client. There is deliberately no field for the
 * run mode (`acceptedWritePosture`), the actor posture, or any other authorization credential:
 * 「运行模式、授权凭据不得由普通请求参数指定」. Those are resolved by the boundary inside the
 * transaction, from the org's rollout posture and the adapter's own identity preparation, exactly
 * as they are on the HTTP entry — this input cannot influence them.
 */
export interface AttendanceRequestOperationExternalTransactionInputV1 {
  /**
   * Caller-owned transaction client. The caller owns BEGIN/COMMIT/ROLLBACK and the connection's
   * lifetime; this boundary issues none of them and releases nothing. Everything this protocol
   * writes commits — or rolls back — with the caller's transaction, which is the whole point:
   * 判据 II requires C-1's business cancellation and the approval side's round/instance writes to
   * be one atomic unit (lock §14.2 判据 II).
   */
  readonly client: AttendanceW4TransactionClientV1
  readonly kind: AttendanceRequestOperationKindV1
  /**
   * NOT nullable here, unlike `execute`. A null id routes into the legacy branch that skips
   * operation preflight, identity congruence, the outbox and the seal — i.e. it skips the very
   * W4 operation protocol this entry exists to reuse (lock §3 C-1: 「复用同一套 W4 操作协议」).
   * Refused with a typed code rather than silently degraded.
   */
  readonly operationId: string
  readonly correlationId: string
  readonly routeVariant: AttendanceRequestOperationRouteVariantV1 | null
  readonly routeInput: unknown
}

/**
 * What `executeInExternalTransaction` can answer: everything `execute` can, PLUS the business
 * refusal that `execute` throws instead (lock §3 C-3 「两条路径、两种返回」).
 *
 * `business_refused` means, exactly: the attendance domain declined this cancellation on business
 * grounds, and NOTHING this entry did remains in the caller's transaction — the attempt was rolled
 * back to a boundary-owned savepoint before returning (see the entry). The caller's transaction is
 * intact and can still write and COMMIT its C-3 closure, which is the whole reason this is a return
 * and not a throw. It carries no `response`: there is no sealed operation to respond with.
 */
export type AttendanceRequestOperationExternalTransactionResultV1 =
  | AttendanceRequestOperationBoundaryResultV1
  | {
    readonly kind: 'business_refused'
    readonly code: string
    readonly detail: string | null
  }

export interface AttendanceRequestOperationBoundaryV1 {
  execute(input: AttendanceRequestOperationBoundaryInputV1): Promise<AttendanceRequestOperationBoundaryResultV1>
  /**
   * Same protocol, caller-owned connection and transaction (lock §3 C-1: 「仅移交连接与事务生命周期
   * 的所有权」). Caller obligations, both enforced rather than documented:
   *  - the transaction is `ISOLATION LEVEL SERIALIZABLE` (what `execute`'s own runner opens);
   *  - the caller already holds this org's class-`00` rollout SHARED advisory lock, taken BEFORE
   *    any row lock it holds.
   */
  executeInExternalTransaction(
    input: AttendanceRequestOperationExternalTransactionInputV1,
  ): Promise<AttendanceRequestOperationExternalTransactionResultV1>
}

export interface AttendanceRequestOperationBoundaryDepsV1 {
  acquireConnection(): Promise<AttendanceRequestOperationBoundaryConnectionV1>
  adapters: AttendanceRequestOperationAdaptersV1
}

/** Truthful source_ref values for each request_create route family. */
export const ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1: Readonly<
  Record<AttendanceRequestCreateRouteVariantV1, string>
> = Object.freeze({
  generic: 'plugin-attendance:POST /api/attendance/requests',
  outdoor: 'plugin-attendance:POST /api/attendance/punch#outdoor-approval',
  schedule_dispatch: 'plugin-attendance:POST /api/attendance/schedule-dispatch-requests',
  shift_swap: 'plugin-attendance:POST /api/attendance/shift-swap-requests',
})

const NON_CREATE_SOURCE_REFS: Readonly<
  Record<Exclude<AttendanceRequestOperationKindV1, 'request_create'>, string>
> = Object.freeze({
  request_pending_edit: 'plugin-attendance:PUT /api/attendance/requests/:id',
  request_decision: 'plugin-attendance:POST /api/attendance/requests/:id/:decision',
  request_cancel: 'plugin-attendance:POST /api/attendance/requests/:id/cancel',
})

const SPECIALIZED_SOURCE_REFS: Readonly<Record<AttendanceRequestSpecializedRouteVariantV1, string>> = Object.freeze({
  schedule_dispatch_cancel: 'plugin-attendance:POST /api/attendance/schedule-dispatch-requests/:id/cancel',
  shift_swap_accept: 'plugin-attendance:POST /api/attendance/shift-swap-requests/:id/accept',
  shift_swap_reject: 'plugin-attendance:POST /api/attendance/shift-swap-requests/:id/reject',
  shift_swap_cancel: 'plugin-attendance:POST /api/attendance/shift-swap-requests/:id/cancel',
})

const SPECIALIZED_ROUTE_KINDS: Readonly<
  Record<AttendanceRequestSpecializedRouteVariantV1, AttendanceRequestOperationKindV1>
> = Object.freeze({
  schedule_dispatch_cancel: 'request_cancel',
  shift_swap_accept: 'request_decision',
  shift_swap_reject: 'request_decision',
  shift_swap_cancel: 'request_cancel',
})

function normalizeRouteVariant(
  kind: AttendanceRequestOperationKindV1,
  raw: unknown,
  code: string,
): AttendanceRequestOperationRouteVariantV1 | null {
  if (kind === 'request_create') {
    if (typeof raw !== 'string') fail(code)
    if (!(ATTENDANCE_REQUEST_CREATE_ROUTE_VARIANTS_V1 as readonly string[]).includes(raw)) {
      fail(code)
    }
    return raw as AttendanceRequestCreateRouteVariantV1
  }
  if (raw === null) return null
  if (
    typeof raw !== 'string'
    || !(ATTENDANCE_REQUEST_SPECIALIZED_ROUTE_VARIANTS_V1 as readonly string[]).includes(raw)
  ) fail(code)
  const variant = raw as AttendanceRequestSpecializedRouteVariantV1
  if (SPECIALIZED_ROUTE_KINDS[variant] !== kind) fail(code)
  return variant
}

function resolveSourceRef(
  kind: AttendanceRequestOperationKindV1,
  routeVariant: AttendanceRequestOperationRouteVariantV1 | null,
): string {
  if (kind === 'request_create') {
    if (routeVariant === null) fail('W4C3B_REQUEST_ROUTE_VARIANT_MISMATCH', 500)
    return ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1[routeVariant]
  }
  if (routeVariant !== null) {
    if (
      !(ATTENDANCE_REQUEST_SPECIALIZED_ROUTE_VARIANTS_V1 as readonly string[]).includes(routeVariant)
      || SPECIALIZED_ROUTE_KINDS[routeVariant as AttendanceRequestSpecializedRouteVariantV1] !== kind
    ) fail('W4C3B_REQUEST_ROUTE_VARIANT_MISMATCH', 500)
    return SPECIALIZED_SOURCE_REFS[routeVariant as AttendanceRequestSpecializedRouteVariantV1]
  }
  return NON_CREATE_SOURCE_REFS[kind]
}

function normalizeInput(input: unknown): AttendanceRequestOperationBoundaryInputV1 {
  const code = 'W4C3B_REQUEST_BOUNDARY_INPUT_INVALID'
  const fields = exactObject(input, ['kind', 'operationId', 'correlationId', 'routeVariant', 'routeInput'], code)
  const kind = fields.kind
  if (typeof kind !== 'string' || !(ATTENDANCE_REQUEST_OPERATION_KINDS_V1 as readonly string[]).includes(kind)) {
    fail(code)
  }
  const operationKind = kind as AttendanceRequestOperationKindV1
  const correlationId = fields.correlationId
  if (typeof correlationId !== 'string' || correlationId.length === 0 || correlationId.length > 128) fail(code)
  const routeVariant = normalizeRouteVariant(operationKind, fields.routeVariant, code)
  return Object.freeze({
    kind: operationKind,
    operationId: uuidOrNull(fields.operationId, code),
    correlationId,
    routeVariant,
    routeInput: frozenJsonCopy(fields.routeInput, code),
  })
}

/**
 * Lock §3 C-1. Separate from `normalizeInput` because the external entry's contract differs in
 * exactly two ways and both must be refusals, not coercions: it carries a caller-owned `client`,
 * and its `operationId` may not be null. Everything else is normalized by the SAME `normalizeInput`
 * so the two entries cannot drift into accepting different inputs.
 */
function normalizeExternalTransactionInput(input: unknown): {
  client: AttendanceW4TransactionClientV1
  input: AttendanceRequestOperationBoundaryInputV1
} {
  const code = 'W4C3B_REQUEST_EXTERNAL_TRANSACTION_INPUT_INVALID'
  const fields = exactObject(
    input,
    ['client', 'kind', 'operationId', 'correlationId', 'routeVariant', 'routeInput'],
    code,
  )
  const client = fields.client
  if (typeof client !== 'object' || client === null || typeof (client as { query?: unknown }).query !== 'function') {
    fail(code)
  }
  if (typeof fields.operationId !== 'string') fail(code)
  const normalized = normalizeInput({
    kind: fields.kind,
    operationId: fields.operationId,
    correlationId: fields.correlationId,
    routeVariant: fields.routeVariant,
    routeInput: fields.routeInput,
  })
  // `normalizeInput` accepts null; this entry does not (see the input type's own doc comment).
  if (normalized.operationId === null) fail(code)
  return { client: client as AttendanceW4TransactionClientV1, input: normalized }
}

/**
 * Caller obligation 1 (lock §3 C-1: 「调用方须满足隔离级别与锁序」). `execute`'s own runner opens
 * `BEGIN ISOLATION LEVEL SERIALIZABLE`; a caller-owned transaction at READ COMMITTED would run the
 * identical protocol under a weaker snapshot, so the W4 preflight's replay/posture predicates could
 * be read under one snapshot and written under another. Asserted, not documented: PostgreSQL fixes
 * the isolation level at the transaction's first statement, so a caller cannot repair this after
 * the fact and a silent downgrade must be refused up front.
 */
async function assertExternalTransactionIsolationV1(
  client: AttendanceW4TransactionClientV1,
): Promise<void> {
  // Order matters. `current_setting('transaction_isolation')` also answers for the IMPLICIT
  // single-statement transaction of an autocommit connection, and it answers with
  // `default_transaction_isolation` — so on a deployment configured
  // `default_transaction_isolation = serializable` an autocommit caller would PASS an
  // isolation-only check and then run this whole protocol statement-by-statement autocommitted:
  // no atomicity at all, partial business cancellation, exactly what 判据 II (lock §14.2, "同一
  // 事务内 … COMMIT") forbids. That is a fail-OPEN gate in a check whose entire value is failing
  // closed, so prove an open transaction block FIRST.
  //
  // `SAVEPOINT` is only legal inside a transaction block: outside one PostgreSQL raises
  // `25P01 no_active_sql_transaction`. Same probe statement and same SQLSTATEs as the in-repo
  // precedent `assertConnectionIsIdleV1` (`w4c0-identity.ts:1424-1449`) — that one asserts NOT in
  // a transaction, this one asserts IN one, so the success/`25P01` branches are its mirror image.
  // A `25P02` (open but already aborted) is also refused: the caller's transaction can no longer
  // commit anything, so running the protocol in it could only produce a doomed write.
  try {
    await client.query('SAVEPOINT w4c3b_external_txn_probe', [])
  } catch (error) {
    const sqlState = typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined
    if (sqlState === '25P01' || sqlState === '25P02') {
      fail('W4C3B_REQUEST_EXTERNAL_TRANSACTION_NOT_OPEN', 500)
    }
    throw error // never mask an unrelated failure as either answer
  }
  // Probe succeeded: an open, non-aborted transaction block. Clean the probe savepoint out of the
  // caller's subtransaction stack fully before going on — `ROLLBACK TO SAVEPOINT` alone leaves it
  // DEFINED (see the precedent's own empirically-verified note), so RELEASE as well. The caller
  // must be left inside no subtransaction it never created, on the success path too.
  await client.query('ROLLBACK TO SAVEPOINT w4c3b_external_txn_probe', []).catch(() => undefined)
  await client.query('RELEASE SAVEPOINT w4c3b_external_txn_probe', []).catch(() => undefined)

  const result = await client.query("SELECT current_setting('transaction_isolation') AS isolation", [])
  const isolation = (result.rows[0] as { isolation?: unknown } | undefined)?.isolation
  if (typeof isolation !== 'string' || isolation.toLowerCase() !== 'serializable') {
    fail('W4C3B_REQUEST_EXTERNAL_TRANSACTION_ISOLATION_INVALID', 500)
  }
}

/**
 * Caller obligation 2 (lock §3 C-2 全局锁序, and lock §14.2's requirement that the census 「包含
 * rollout 共享锁与 advisory 锁」). Reuses the production key builder — not a second derivation — so
 * a future change to the key cannot leave this check probing a stale one. The `pg_locks` predicate
 * is the shape already used in-repo for advisory-lock-held probes
 * (`w4c0-operation-registry.ts:979-982`); `ShareLock` is what `pg_advisory_xact_lock_shared`
 * registers and `ExclusiveLock` is what `pg_advisory_xact_lock` registers — a caller holding the
 * exclusive lock satisfies the ordering obligation a fortiori, so both are accepted.
 */
async function assertExternalTransactionRolloutLockHeldV1(
  client: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<void> {
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(orgId)
  const key = buildAttendanceCalculationRolloutAdvisoryKey(orgKey)
  const result = await client.query(
    `SELECT 1 FROM pg_locks
      WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
        AND objsubid = 1
        AND classid::bigint = (($1::bigint >> 32) & 4294967295)
        AND objid::bigint = ($1::bigint & 4294967295)
        AND mode IN ('ShareLock', 'ExclusiveLock')`,
    [key.toString()],
  )
  if (result.rows.length === 0) {
    fail('W4C3B_REQUEST_EXTERNAL_TRANSACTION_ROLLOUT_LOCK_NOT_HELD', 500)
  }
}

/**
 * The single decision point for a business refusal (lock §3 C-3 / §11-④). Every `adapter.execute`
 * call site in the protocol funnels through here, so no branch can quietly treat a refusal as a
 * successful execution and go on to enqueue an outbox event or seal the operation.
 *
 * - HTTP entry (`mode` absent): throw the adapter's OWN error object, unchanged. Not a
 *   re-derivation — the same instance the adapter constructed, so status, code, message and
 *   validation details are exactly what shipped today (账侧字节等价, lock §8 期 1).
 * - External entry: return the decision to the caller. The approval side then persists its C-3
 *   closure in the same transaction; the refused attempt itself is undone by the entry's savepoint.
 *
 * Returns `null` when the result is an ordinary execution, so callers narrow on that.
 */
function isBusinessRefusal(
  result: AttendanceRequestOperationExecutionResultV1,
): result is AttendanceRequestOperationBusinessRefusalV1 {
  return (result as { kind?: unknown }).kind === 'business_refused'
}

function takeBusinessRefusal(
  result: AttendanceRequestOperationBusinessRefusalV1,
  mode: { readonly externalTransaction: true } | undefined,
): { readonly kind: 'business_refused'; readonly code: string; readonly detail: string | null } {
  // Validate before acting on it. A malformed refusal must not become an untyped throw of
  // `undefined` on the HTTP entry, nor a closure reason built from a non-string on the external
  // one; both would be worse than a 500 that names the defect.
  if (typeof result.code !== 'string' || result.code.length === 0) {
    fail('W4C3B_REQUEST_BUSINESS_REFUSAL_INVALID', 500)
  }
  if (result.detail !== null && typeof result.detail !== 'string') {
    fail('W4C3B_REQUEST_BUSINESS_REFUSAL_INVALID', 500)
  }
  if (mode?.externalTransaction !== true) {
    if (result.httpError === null || result.httpError === undefined) {
      fail('W4C3B_REQUEST_BUSINESS_REFUSAL_INVALID', 500)
    }
    throw result.httpError
  }
  return { kind: 'business_refused' as const, code: result.code, detail: result.detail }
}

function buildEnvelope(
  input: AttendanceRequestOperationBoundaryInputV1,
  prepared: AttendanceRequestOperationPreparedV1,
): NormalizedAttendanceSourceOperationEnvelopeV1 {
  return normalizeAttendanceSourceOperationEnvelopeV1({
    schemaVersion: 1,
    orgId: prepared.orgId,
    correlationId: input.correlationId,
    command: {
      schemaVersion: 1,
      kind: input.kind,
      subjectUserId: prepared.subjectUserId,
      operationId: input.operationId,
      payload: prepared.commandPayload,
    },
    batch: null,
  })
}

function preparedIdentityCongruent(
  identity: AttendanceRequestOperationPreparedV1,
  prepared: AttendanceRequestOperationPreparedV1,
): boolean {
  return identity.orgId === prepared.orgId
    && identity.actorId === prepared.actorId
    && identity.actorPosture === prepared.actorPosture
    && identity.tokenSubjectUserId === prepared.tokenSubjectUserId
    && identity.subjectUserId === prepared.subjectUserId
    && JSON.stringify(identity.subjectScope) === JSON.stringify(prepared.subjectScope)
    && JSON.stringify(identity.commandPayload) === JSON.stringify(prepared.commandPayload)
}

export function createAttendanceRequestOperationBoundaryV1(
  deps: AttendanceRequestOperationBoundaryDepsV1,
): AttendanceRequestOperationBoundaryV1 {
  if (typeof deps?.acquireConnection !== 'function') fail('W4C3B_REQUEST_CONNECTION_PROVIDER_INVALID', 500)
  for (const kind of ATTENDANCE_REQUEST_OPERATION_KINDS_V1) {
    const adapter = deps?.adapters?.[kind]
    if (
      !adapter
      || typeof adapter.prepareIdentity !== 'function'
      || typeof adapter.prepare !== 'function'
      || typeof adapter.execute !== 'function'
    ) {
      fail('W4C3B_REQUEST_ADAPTERS_INVALID', 500)
    }
  }

  return {
    async execute(rawInput) {
      const input = normalizeInput(rawInput)
      const connection = await deps.acquireConnection()
      try {
        const result = await runAttendanceResultOperationTransactionV1(connection.client, async (trx) =>
          runRequestOperationProtocolV1(trx, deps.adapters, input))
        // Unreachable by construction: without `mode.externalTransaction` the protocol THROWS the
        // adapter's own HTTP error on a business refusal rather than returning one, which is what
        // keeps this entry's observable behaviour byte-identical to what shipped. Asserted anyway,
        // fail-closed, so that a future edit which makes the protocol return here cannot silently
        // hand a refusal to an HTTP caller as if it were a result.
        if (result.kind === 'business_refused') fail('W4C3B_REQUEST_BUSINESS_REFUSAL_UNHANDLED', 500)
        return result
      } finally {
        connection.release()
      }
    },

    async executeInExternalTransaction(rawInput) {
      const { client, input } = normalizeExternalTransactionInput(rawInput)
      // §3 C-1 (lock:88-92) — the caller owns the connection and the transaction lifecycle, so
      // the two properties this protocol would otherwise establish for itself have to be proven
      // rather than assumed. Both are enforced BEFORE the first statement that can take a lock or
      // write a row, and both fail closed with a typed code. Neither is derivable from
      // `rawInput`: a caller cannot declare itself compliant.
      await assertExternalTransactionIsolationV1(client)
      // The second precondition (the caller already holds this org's class-`00` rollout SHARED
      // advisory lock) needs the org, which only `prepareIdentity` can supply — so it is asserted
      // inside the protocol, at the one point where the org is known and before the protocol's
      // own first lock. See `assertExternalTransactionRolloutLockHeldV1`.
      //
      // The attempt runs inside a boundary-owned SAVEPOINT. A business refusal (lock §3 C-3) is
      // discovered LATE — the verdict is produced BY appending the cancellation calculation, after
      // the operation-registry row, the `FOR UPDATE` row locks and the calculation/segment rows
      // already exist in this transaction. On the HTTP entry the throw discards all of that. Here
      // the caller goes on to COMMIT its C-3 closure, so without this savepoint every one of those
      // rows — including an operation row that is REGISTERED BUT NEVER SEALED, which is the replay
      // contract's input — would commit as a side effect of a refusal. Rolling back to the
      // savepoint makes the refused attempt leave nothing behind: 判据 II's negative control R2
      // wants 「零业务取消」, and a committed unsealed operation row is not zero.
      //
      // Measured on PostgreSQL 15.17, not recalled (probe transcript in the verification MD):
      // after `ROLLBACK TO SAVEPOINT` the caller's transaction is still usable and commits; the
      // rows and the xact advisory lock taken INSIDE the savepoint are gone; and the caller's own
      // rollout advisory lock, taken BEFORE the savepoint, survives — so a caller that makes a
      // second call in the same transaction still passes the rollout-lock precondition.
      return runExternalTransactionAttemptInSavepointV1(client, () =>
        runRequestOperationProtocolV1(client, deps.adapters, input, { externalTransaction: true }))
    },
  }
}

/**
 * The savepoint discipline of the external entry, in ONE place so that what it does on a refusal
 * and what it deliberately does NOT do on an infrastructure exception are both directly testable
 * without a database. `executeInExternalTransaction` is its only production caller; `run` is the
 * protocol.
 *
 * On a BUSINESS refusal the attempt is rolled back and the savepoint released, so the refused
 * attempt leaves nothing in the caller's transaction and the caller is left inside no
 * subtransaction it did not create — `ROLLBACK TO` alone leaves the savepoint DEFINED, so the
 * RELEASE is not optional. The caller can then write and COMMIT its C-3 closure.
 *
 * On an infrastructure exception nothing is issued at all: that is the OTHER path (lock §3 C-3
 * 「两条路径、两种返回」). The error propagates with the whole transaction left for the caller to
 * roll back, and after a database error the transaction is aborted, so a RELEASE here would itself
 * fail and would mask the real error. Hence no `finally` and no `catch`.
 */
export async function runExternalTransactionAttemptInSavepointV1(
  client: AttendanceW4TransactionClientV1,
  run: () => Promise<AttendanceRequestOperationExternalTransactionResultV1>,
): Promise<AttendanceRequestOperationExternalTransactionResultV1> {
  await client.query('SAVEPOINT w4c3b_external_txn_attempt', [])
  const result = await run()
  if (result.kind === 'business_refused') {
    await client.query('ROLLBACK TO SAVEPOINT w4c3b_external_txn_attempt', [])
  }
  await client.query('RELEASE SAVEPOINT w4c3b_external_txn_attempt', [])
  return result
}

/**
 * The single copy of the W4 request-operation protocol (§10-⑫, lock:83-92):
 * prepareIdentity → canonical-org classification → rollout-shared-lock posture resolve →
 * authorization context → operation replay preflight → prepare + identity congruence →
 * adapter.execute → outbox enqueue → seal.
 *
 * `execute` runs it inside a boundary-owned SERIALIZABLE transaction on a boundary-owned
 * connection; `executeInExternalTransaction` runs the SAME body on a caller-owned client inside a
 * caller-owned transaction. Lock §3 C-1: the external entry "仅移交连接与事务生命周期的所有权" —
 * nothing else about the protocol may differ between the two entries, which is why this is one
 * function and not two.
 *
 * `mode.externalTransaction` therefore steers no PROTOCOL STEP: its only effect is one
 * external-only precondition (the rollout-lock check below, which needs the org that
 * `prepareIdentity` resolves and so cannot be hoisted to the entry). That check can only REFUSE —
 * it never changes which steps run, in which order, or with what inputs. Every step after it is
 * reached identically by both entries.
 */
async function runRequestOperationProtocolV1(
  trx: AttendanceW4TransactionClientV1,
  adapters: AttendanceRequestOperationAdaptersV1,
  input: AttendanceRequestOperationBoundaryInputV1,
  mode?: { readonly externalTransaction: true },
): Promise<AttendanceRequestOperationExternalTransactionResultV1> {
        {
          const shapedTrx = pluginTrx(trx)
          const adapter = adapters[input.kind]
          const operation = Object.freeze({
            operationId: input.operationId,
            correlationId: input.correlationId,
            acceptedWritePosture: null,
            // Prepare phase: no posture resolved yet, and prepare performs no reference
            // writes. Fail-closed until a resolve under the rollout lock supplies it.
            referenceSegments: false,
            routeVariant: input.routeVariant,
          })
          const identityPrepared = input.operationId === null
            ? await adapter.prepare(shapedTrx, input.routeInput, operation)
            : await adapter.prepareIdentity(shapedTrx, input.routeInput, operation)

          let canonicalOrg = true
          try {
            parseCanonicalAttendanceRolloutOrgKeyV1(identityPrepared.orgId)
          } catch {
            canonicalOrg = false
          }
          if (mode?.externalTransaction === true) {
            // Lock §3 C-2 (lock:108-113): 建议全局顺序 rollout/advisory 锁 → 轮次引擎实例 → 原单据实例
            // → attendance_requests → 余额批次. The external caller has ALREADY taken its own row
            // locks (the cancel round's engine instance, the original document instance) before
            // reaching this entry, so if it had not also already taken the rollout lock, this
            // protocol's own `acquireAttendanceCalculationRolloutLock` below would take it AFTER
            // those row locks — the exact reversed order that phase 1's Q-A census proved
            // deadlocks deterministically (40P01) against any holder taking them in the ratified
            // order (`approval-cancel-round-lock-order-census.db.test.ts`, "the REVERSED order …
            // deadlocks DETERMINISTICALLY"). Verified, not documented: the check reads `pg_locks`
            // for THIS backend, so a non-compliant caller is refused instead of deadlocking.
            //
            // This proves the lock is held NOW, which cannot by itself prove it was taken before
            // the caller's row locks (`pg_locks` carries no acquisition order). It is the strongest
            // mechanical check available here and it catches the only violation that is reachable
            // in practice — a caller that never takes the lock at all. The ordering obligation on
            // callers that do take it stays a documented obligation, stated here rather than
            // silently implied.
            if (!canonicalOrg) fail('W4C3B_REQUEST_ORG_OUTSIDE_W4_DOMAIN')
            await assertExternalTransactionRolloutLockHeldV1(trx, identityPrepared.orgId)
          }
          if (!canonicalOrg) {
            if (input.operationId !== null) fail('W4C3B_REQUEST_ORG_OUTSIDE_W4_DOMAIN')
            const result = await adapter.execute(shapedTrx, identityPrepared, Object.freeze({
              ...operation,
              acceptedWritePosture: 'legacy_projection_only' as const,
              // Outside the canonical W4 domain the port itself answers
              // `{ effectiveState: 'legacy', referenceSegments: false }`; mirror it exactly.
              referenceSegments: false,
            }))
            if (isBusinessRefusal(result)) return takeBusinessRefusal(result, mode)
            return { kind: 'legacy' as const, response: result.response }
          }

          // Null-ID legacy clients predate the W4 identity/liveness contract.
          // Resolve posture under the canonical shared lock first: ordinary
          // legacy keeps byte-identical authorization behavior and zero W4
          // rows, while suspended or W4-enabled orgs still fail closed before
          // the adapter's first source DML.
          if (input.operationId === null) {
            const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(identityPrepared.orgId)
            await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
            const posture = await resolveSegmentCalculationPosture(trx, orgKey)
            if (posture.writePosture === 'blocked') {
              throw new AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')
            }
            if (posture.writePosture === 'legacy_projection_only') {
              const result = await adapter.execute(shapedTrx, identityPrepared, Object.freeze({
                ...operation,
                acceptedWritePosture: 'legacy_projection_only' as const,
                // Read the RESOLVED bit rather than hardcoding `false`. It is false for
                // every legacy row today, but deriving it from `writePosture` here would
                // create a second place that decides what `legacy` admits.
                referenceSegments: posture.referenceSegments,
              }))
              if (isBusinessRefusal(result)) return takeBusinessRefusal(result, mode)
              return { kind: 'legacy' as const, response: result.response }
            }
          }

          const envelope = buildEnvelope(input, identityPrepared)
          const authorization = createAuthorizedAttendanceWriteContextV1({
            actorId: identityPrepared.actorId,
            actorPosture: identityPrepared.actorPosture,
            tokenSubjectUserId: identityPrepared.tokenSubjectUserId,
            orgId: envelope.orgId,
            subjectScope: identityPrepared.subjectScope,
            capability: 'approval_apply',
            sourceRef: resolveSourceRef(input.kind, input.routeVariant),
          })
          const preflight = await attendanceResultOperationPreflightV1(
            trx,
            authorization,
            envelope.registryInput,
          )
          if (preflight.kind === 'replay') {
            const response = Object.values(preflight.responses.itemResponses)[0] ?? null
            return { kind: 'replay' as const, response }
          }
          if (preflight.kind === 'suspended') {
            throw new AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')
          }

          const prepared = input.operationId === null
            ? identityPrepared
            : await adapter.prepare(shapedTrx, input.routeInput, operation)
          if (!preparedIdentityCongruent(identityPrepared, prepared)) {
            fail('W4C3B_REQUEST_IDENTITY_CHANGED', 409)
          }

          const result = await adapter.execute(shapedTrx, prepared, Object.freeze({
            ...operation,
            acceptedWritePosture: preflight.org.acceptedWritePosture,
            // From the preflight's own resolve, taken under the rollout SHARED lock at
            // step 2 — the one resolution this transaction performs.
            referenceSegments: preflight.referenceSegments,
          }))
          // Before the outbox enqueue and before the seal — a refused attempt must leave neither.
          // On the HTTP entry this throws exactly where the adapter used to throw: the adapter
          // returned immediately at its refusal point, so no statement runs between the old throw
          // site and this one.
          if (isBusinessRefusal(result)) return takeBusinessRefusal(result, mode)
          if (preflight.kind === 'legacy_no_operation') {
            return { kind: 'legacy' as const, response: result.response }
          }

          const identity = preflight.itemIdentities[0]
          if (!identity) fail('W4C3B_REQUEST_OPERATION_IDENTITY_MISSING', 500)
          const isLegacyCompat = preflight.org.acceptedWritePosture === 'legacy_projection_only'
          const [event] = result.lifecycleEvents
          if (!event) fail('W4C3B_REQUEST_LIFECYCLE_EVENT_MISSING', 500)
          if (!isLegacyCompat) {
            await enqueueAttendanceResultEventOutboxV1(trx, identity, [{
              eventKind: event.eventKind,
              payload: event.payload,
              payloadSchemaVersion: 1,
              businessKeyFingerprint: computeAttendanceBusinessKeyFingerprintV1({
                kind: event.eventKind,
                orgId: envelope.orgId,
                operationId: identity.id,
              }),
            }])
          }
          await sealAttendanceResultOperationV1(trx, identity, {
            responseSnapshot: jsonValue(result.response),
            resolvedRequestId: result.resolvedRequestId,
          })
          return {
            kind: isLegacyCompat ? 'legacy_compat' as const : 'executed' as const,
            response: result.response,
          }
        }
}
