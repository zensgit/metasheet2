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
  readonly response: unknown
  readonly resolvedRequestId: string | null
  readonly lifecycleEvents: readonly [{
    readonly eventKind: AttendanceW4OutboxEventKindV1
    readonly payload: unknown
  }]
}

export interface AttendanceRequestOperationContextV1 {
  readonly operationId: string | null
  readonly correlationId: string
  readonly acceptedWritePosture: 'legacy_projection_only' | 'shadow' | 'authoritative' | null
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
  ): Promise<AttendanceRequestOperationExecutionV1>
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

export interface AttendanceRequestOperationBoundaryV1 {
  execute(input: AttendanceRequestOperationBoundaryInputV1): Promise<AttendanceRequestOperationBoundaryResultV1>
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
        return await runAttendanceResultOperationTransactionV1(connection.client, async (trx) => {
          const shapedTrx = pluginTrx(trx)
          const adapter = deps.adapters[input.kind]
          const operation = Object.freeze({
            operationId: input.operationId,
            correlationId: input.correlationId,
            acceptedWritePosture: null,
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
          if (!canonicalOrg) {
            if (input.operationId !== null) fail('W4C3B_REQUEST_ORG_OUTSIDE_W4_DOMAIN')
            const result = await adapter.execute(shapedTrx, identityPrepared, Object.freeze({
              ...operation,
              acceptedWritePosture: 'legacy_projection_only' as const,
            }))
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
              }))
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
          }))
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
        })
      } finally {
        connection.release()
      }
    },
  }
}
