/**
 * W4C-3b P13: canonical request-operation owner for create/edit/decision/cancel.
 *
 * The plugin installs the four fixed adapters once at activation. HTTP routes
 * submit closed data only; they cannot supply callbacks, prepared drafts, lock
 * witnesses, or transaction clients. Preparation may lock/read authoritative
 * rows, but the operation preflight and claim always precede the adapter's first
 * request/event/approval/assignment/ledger write. All work shares the same
 * SERIALIZABLE transaction and connection.
 */
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { parseCanonicalAttendanceRolloutOrgKeyV1 } from './w4c0-identity'
import {
  createAuthorizedAttendanceWriteContextV1,
  type AttendanceActorPostureV1,
  type AttendanceWriteSubjectScopeV1,
} from './w4c0-authorization'
import {
  attendanceResultOperationPreflightV1,
  runAttendanceResultOperationTransactionV1,
  sealAttendanceResultOperationV1,
} from './w4c0-operation-registry'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
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
}

export interface AttendanceRequestOperationAdapterV1<TState = unknown> {
  prepare(
    trx: AttendanceRequestPluginTrxV1,
    routeInput: unknown,
  ): Promise<AttendanceRequestOperationPreparedV1<TState>>
  execute(
    trx: AttendanceRequestPluginTrxV1,
    prepared: AttendanceRequestOperationPreparedV1<TState>,
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

const SOURCE_REFS: Readonly<Record<AttendanceRequestOperationKindV1, string>> = Object.freeze({
  request_create: 'plugin-attendance:POST /api/attendance/requests',
  request_pending_edit: 'plugin-attendance:PUT /api/attendance/requests/:id',
  request_decision: 'plugin-attendance:POST /api/attendance/requests/:id/:decision',
  request_cancel: 'plugin-attendance:POST /api/attendance/requests/:id/cancel',
})

function normalizeInput(input: unknown): AttendanceRequestOperationBoundaryInputV1 {
  const code = 'W4C3B_REQUEST_BOUNDARY_INPUT_INVALID'
  const fields = exactObject(input, ['kind', 'operationId', 'correlationId', 'routeInput'], code)
  const kind = fields.kind
  if (typeof kind !== 'string' || !(ATTENDANCE_REQUEST_OPERATION_KINDS_V1 as readonly string[]).includes(kind)) {
    fail(code)
  }
  const correlationId = fields.correlationId
  if (typeof correlationId !== 'string' || correlationId.length === 0 || correlationId.length > 128) fail(code)
  return Object.freeze({
    kind: kind as AttendanceRequestOperationKindV1,
    operationId: uuidOrNull(fields.operationId, code),
    correlationId,
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

export function createAttendanceRequestOperationBoundaryV1(
  deps: AttendanceRequestOperationBoundaryDepsV1,
): AttendanceRequestOperationBoundaryV1 {
  if (typeof deps?.acquireConnection !== 'function') fail('W4C3B_REQUEST_CONNECTION_PROVIDER_INVALID', 500)
  for (const kind of ATTENDANCE_REQUEST_OPERATION_KINDS_V1) {
    const adapter = deps?.adapters?.[kind]
    if (!adapter || typeof adapter.prepare !== 'function' || typeof adapter.execute !== 'function') {
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
          const prepared = await adapter.prepare(shapedTrx, input.routeInput)

          let canonicalOrg = true
          try {
            parseCanonicalAttendanceRolloutOrgKeyV1(prepared.orgId)
          } catch {
            canonicalOrg = false
          }
          if (!canonicalOrg) {
            if (input.operationId !== null) fail('W4C3B_REQUEST_ORG_OUTSIDE_W4_DOMAIN')
            const result = await adapter.execute(shapedTrx, prepared)
            return { kind: 'legacy' as const, response: result.response }
          }

          const envelope = buildEnvelope(input, prepared)
          const authorization = createAuthorizedAttendanceWriteContextV1({
            actorId: prepared.actorId,
            actorPosture: prepared.actorPosture,
            tokenSubjectUserId: prepared.tokenSubjectUserId,
            orgId: envelope.orgId,
            subjectScope: prepared.subjectScope,
            capability: 'approval_apply',
            sourceRef: SOURCE_REFS[input.kind],
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

          const result = await adapter.execute(shapedTrx, prepared)
          if (preflight.kind === 'legacy_no_operation') {
            return { kind: 'legacy' as const, response: result.response }
          }

          const identity = preflight.itemIdentities[0]
          if (!identity) fail('W4C3B_REQUEST_OPERATION_IDENTITY_MISSING', 500)
          await sealAttendanceResultOperationV1(trx, identity, {
            responseSnapshot: jsonValue(result.response),
            resolvedRequestId: result.resolvedRequestId,
          })
          return {
            kind: preflight.org.acceptedWritePosture === 'legacy_projection_only' ? 'legacy_compat' as const : 'executed' as const,
            response: result.response,
          }
        })
      } finally {
        connection.release()
      }
    },
  }
}
