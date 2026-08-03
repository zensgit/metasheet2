/**
 * W4C-3c: canonical write boundary for manual_edit, recompute, and ops_retirement.
 *
 * These three source entrypoints share the same SERIALIZABLE preflight / claim /
 * seal skeleton as the request-operation boundary, but use distinct capabilities
 * (manual_edit | recompute | retirement) and closed payload schemas from
 * w4c0-source-commands. Adapters are installed once by the plugin host; HTTP
 * routes and operator scripts submit closed data only.
 *
 * Recompute is a NEW capability pair:
 *   - policy=frozen_prior (default / prior-policy)
 *   - policy=current_policy (explicit current-policy, contextDecision records
 *     current_policy_requested)
 * Neither is described as a migrated production recompute path.
 */
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceCalculationRolloutLock,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
} from './w4c0-identity'
import {
  createAuthorizedAttendanceWriteContextV1,
  type AttendanceActorPostureV1,
  type AttendanceWriteCapabilityV1,
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

export const ATTENDANCE_RECORD_OPERATION_KINDS_V1 = Object.freeze([
  'manual_edit',
  'recompute',
  'ops_retirement',
] as const)

export type AttendanceRecordOperationKindV1 = (typeof ATTENDANCE_RECORD_OPERATION_KINDS_V1)[number]

const KIND_CAPABILITY: Readonly<Record<AttendanceRecordOperationKindV1, AttendanceWriteCapabilityV1>> =
  Object.freeze({
    manual_edit: 'manual_edit',
    recompute: 'recompute',
    ops_retirement: 'retirement',
  })

const KIND_SOURCE_REF: Readonly<Record<AttendanceRecordOperationKindV1, string>> = Object.freeze({
  manual_edit: 'plugin-attendance:POST /api/attendance/anomaly-result-edits',
  recompute: 'plugin-attendance:POST /api/attendance/records/:id/recompute',
  ops_retirement: 'scripts/attendance:ops_retirement',
})

export class AttendanceW4RecordBoundaryError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, httpStatus = 422) {
    super(code)
    this.name = 'AttendanceW4RecordBoundaryError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function fail(code: string, httpStatus = 422): never {
  throw new AttendanceW4RecordBoundaryError(code, httpStatus)
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
  if (value === undefined) fail('W4C3C_RECORD_RESPONSE_INVALID', 500)
  return JSON.parse(JSON.stringify(value)) as unknown
}

export interface AttendanceRecordPluginTrxV1 {
  query(sqlText: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>
  readonly __w4CanonicalTrx: true
}

function pluginTrx(client: AttendanceW4TransactionClientV1): AttendanceRecordPluginTrxV1 {
  return {
    __w4CanonicalTrx: true,
    async query(sqlText: string, params?: unknown[]) {
      const result = await client.query(sqlText, params ?? [])
      return result.rows
    },
  }
}

export interface AttendanceRecordOperationPreparedV1<TState = unknown> {
  readonly orgId: string
  readonly actorId: string
  readonly actorPosture: AttendanceActorPostureV1
  readonly tokenSubjectUserId: string | null
  readonly subjectUserId: string
  readonly targetWorkDate: string
  readonly subjectScope: AttendanceWriteSubjectScopeV1
  readonly commandPayload: Readonly<Record<string, unknown>>
  readonly state: TState
}

export interface AttendanceRecordOperationExecutionV1 {
  readonly response: unknown
  readonly resolvedRecordId: string | null
  readonly resolvedCalculationId: string | null
  readonly lifecycleEvents: readonly [{
    readonly eventKind: AttendanceW4OutboxEventKindV1
    readonly payload: unknown
  }]
}

export interface AttendanceRecordOperationContextV1 {
  readonly operationId: string | null
  readonly correlationId: string
  readonly acceptedWritePosture: 'legacy_projection_only' | 'shadow' | 'authoritative' | null
}

export interface AttendanceRecordOperationAdapterV1<TState = unknown> {
  prepareIdentity(
    trx: AttendanceRecordPluginTrxV1,
    routeInput: unknown,
    operation: AttendanceRecordOperationContextV1,
  ): Promise<AttendanceRecordOperationPreparedV1<unknown>>
  prepare(
    trx: AttendanceRecordPluginTrxV1,
    routeInput: unknown,
    operation: AttendanceRecordOperationContextV1,
  ): Promise<AttendanceRecordOperationPreparedV1<TState>>
  execute(
    trx: AttendanceRecordPluginTrxV1,
    prepared: AttendanceRecordOperationPreparedV1<TState>,
    operation: AttendanceRecordOperationContextV1,
  ): Promise<AttendanceRecordOperationExecutionV1>
}

export type AttendanceRecordOperationAdaptersV1 = Readonly<{
  [K in AttendanceRecordOperationKindV1]: AttendanceRecordOperationAdapterV1
}>

export interface AttendanceRecordOperationBoundaryConnectionV1 {
  readonly client: AttendanceW4TransactionClientV1
  release(): void
}

export interface AttendanceRecordOperationBoundaryInputV1 {
  readonly kind: AttendanceRecordOperationKindV1
  readonly operationId: string | null
  readonly correlationId: string
  readonly routeInput: unknown
  /** Optional sourceRef override (e.g. operator script vs HTTP). */
  readonly sourceRef?: string
}

export type AttendanceRecordOperationBoundaryResultV1 =
  | { readonly kind: 'legacy'; readonly response: unknown }
  | { readonly kind: 'legacy_compat'; readonly response: unknown }
  | { readonly kind: 'executed'; readonly response: unknown }
  | { readonly kind: 'replay'; readonly response: unknown }

export interface AttendanceRecordOperationBoundaryV1 {
  execute(input: AttendanceRecordOperationBoundaryInputV1): Promise<AttendanceRecordOperationBoundaryResultV1>
}

export interface AttendanceRecordOperationBoundaryDepsV1 {
  acquireConnection(): Promise<AttendanceRecordOperationBoundaryConnectionV1>
  adapters: AttendanceRecordOperationAdaptersV1
}

function normalizeInput(input: unknown): AttendanceRecordOperationBoundaryInputV1 {
  const code = 'W4C3C_RECORD_BOUNDARY_INPUT_INVALID'
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const object = input as Record<string, unknown>
  const keys = Object.getOwnPropertyNames(object)
  if (keys.includes('sourceRef')) {
    exactObject(object, ['kind', 'operationId', 'correlationId', 'routeInput', 'sourceRef'], code)
  } else {
    exactObject(object, ['kind', 'operationId', 'correlationId', 'routeInput'], code)
  }
  const kind = object.kind
  if (typeof kind !== 'string' || !(ATTENDANCE_RECORD_OPERATION_KINDS_V1 as readonly string[]).includes(kind)) {
    fail(code)
  }
  const operationKind = kind as AttendanceRecordOperationKindV1
  const correlationId = object.correlationId
  if (typeof correlationId !== 'string' || correlationId.length === 0 || correlationId.length > 128) fail(code)
  let sourceRef: string | undefined
  if (object.sourceRef !== undefined) {
    if (typeof object.sourceRef !== 'string' || object.sourceRef.length === 0 || object.sourceRef.length > 256) {
      fail(code)
    }
    sourceRef = object.sourceRef
  }
  return Object.freeze({
    kind: operationKind,
    operationId: uuidOrNull(object.operationId, code),
    correlationId,
    routeInput: frozenJsonCopy(object.routeInput, code),
    sourceRef,
  })
}

function buildEnvelope(
  input: AttendanceRecordOperationBoundaryInputV1,
  prepared: AttendanceRecordOperationPreparedV1,
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
  identity: AttendanceRecordOperationPreparedV1,
  prepared: AttendanceRecordOperationPreparedV1,
): boolean {
  return identity.orgId === prepared.orgId
    && identity.actorId === prepared.actorId
    && identity.actorPosture === prepared.actorPosture
    && identity.tokenSubjectUserId === prepared.tokenSubjectUserId
    && identity.subjectUserId === prepared.subjectUserId
    && identity.targetWorkDate === prepared.targetWorkDate
    && JSON.stringify(identity.subjectScope) === JSON.stringify(prepared.subjectScope)
    && JSON.stringify(identity.commandPayload) === JSON.stringify(prepared.commandPayload)
}

export function createAttendanceRecordOperationBoundaryV1(
  deps: AttendanceRecordOperationBoundaryDepsV1,
): AttendanceRecordOperationBoundaryV1 {
  if (typeof deps?.acquireConnection !== 'function') fail('W4C3C_RECORD_CONNECTION_PROVIDER_INVALID', 500)
  for (const kind of ATTENDANCE_RECORD_OPERATION_KINDS_V1) {
    const adapter = deps?.adapters?.[kind]
    if (
      !adapter
      || typeof adapter.prepareIdentity !== 'function'
      || typeof adapter.prepare !== 'function'
      || typeof adapter.execute !== 'function'
    ) {
      fail('W4C3C_RECORD_ADAPTERS_INVALID', 500)
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
            if (input.operationId !== null) fail('W4C3C_RECORD_ORG_OUTSIDE_W4_DOMAIN')
            const result = await adapter.execute(shapedTrx, identityPrepared, Object.freeze({
              ...operation,
              acceptedWritePosture: 'legacy_projection_only' as const,
            }))
            return { kind: 'legacy' as const, response: result.response }
          }

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
          const sourceRef = input.sourceRef ?? KIND_SOURCE_REF[input.kind]
          const authorization = createAuthorizedAttendanceWriteContextV1({
            actorId: identityPrepared.actorId,
            actorPosture: identityPrepared.actorPosture,
            tokenSubjectUserId: identityPrepared.tokenSubjectUserId,
            orgId: envelope.orgId,
            subjectScope: identityPrepared.subjectScope,
            capability: KIND_CAPABILITY[input.kind],
            sourceRef,
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

          const targetIdentity = createVerifiedAttendanceCalculationTargetIdentityV1({
            org: preflight.org,
            userId: identityPrepared.subjectUserId,
            workDate: identityPrepared.targetWorkDate,
          })
          await acquireAttendanceCalculationTargetLocks(trx, [targetIdentity])

          const prepared = input.operationId === null
            ? identityPrepared
            : await adapter.prepare(shapedTrx, input.routeInput, operation)
          if (!preparedIdentityCongruent(identityPrepared, prepared)) {
            fail('W4C3C_RECORD_IDENTITY_CHANGED', 409)
          }

          const result = await adapter.execute(shapedTrx, prepared, Object.freeze({
            ...operation,
            acceptedWritePosture: preflight.org.acceptedWritePosture,
          }))
          if (preflight.kind === 'legacy_no_operation') {
            return { kind: 'legacy' as const, response: result.response }
          }

          const identity = preflight.itemIdentities[0]
          if (!identity) fail('W4C3C_RECORD_OPERATION_IDENTITY_MISSING', 500)
          const isLegacyCompat = preflight.org.acceptedWritePosture === 'legacy_projection_only'
          const [event] = result.lifecycleEvents
          if (!event) fail('W4C3C_RECORD_LIFECYCLE_EVENT_MISSING', 500)
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
            resolvedRecordId: result.resolvedRecordId,
            resolvedCalculationId: result.resolvedCalculationId,
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

/** Entrypoint/capability matrix positive control for forged authorization tests. */
export function assertRecordOperationCapabilityMatchV1(
  kind: AttendanceRecordOperationKindV1,
  capability: AttendanceWriteCapabilityV1,
): void {
  if (KIND_CAPABILITY[kind] !== capability) {
    const error = new Error('ATTENDANCE_ENTRYPOINT_CAPABILITY_MISMATCH')
    ;(error as Error & { code: string }).code = 'ATTENDANCE_ENTRYPOINT_CAPABILITY_MISMATCH'
    throw error
  }
}

export function recordOperationCapabilityForKindV1(
  kind: AttendanceRecordOperationKindV1,
): AttendanceWriteCapabilityV1 {
  return KIND_CAPABILITY[kind]
}
