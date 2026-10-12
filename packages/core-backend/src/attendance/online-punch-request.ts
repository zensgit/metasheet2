import { createHash } from 'node:crypto'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import { deriveAttendanceOperationCandidateIdentityV1, parseCanonicalAttendanceRolloutOrgKeyV1 } from './w4c0-identity'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import type { AttendanceResultOperationEnvelopeInputV1 } from './w4c0-operation-registry'

export const ONLINE_PUNCH_SOURCE_REF = 'plugin-attendance:POST /api/attendance/punch:online-v1'
export const OLD_OUTDOOR_PUNCH_SOURCE_REF = 'plugin-attendance:POST /api/attendance/punch#outdoor-approval'
const requests = new WeakSet<object>()
const companions = new WeakMap<object, OnlinePunchRequestV1>()

export interface OnlinePunchClientFrameV1 {
  readonly eventType: 'check_in' | 'check_out'
  readonly timezone: string | null
  readonly source: string | null
  readonly location: Record<string, unknown> | null
  readonly meta: Record<string, unknown> | null
  readonly photoFileId: string | null
  readonly requestNamedOrgId: string | null
}
export interface OnlinePunchRequestV1 {
  readonly orgId: string
  readonly userId: string
  readonly tokenSubjectUserId: string
  readonly operationId: string
  readonly fingerprint: string
  readonly registryInput: AttendanceResultOperationEnvelopeInputV1
}
export interface OnlinePunchReceiptV1 {
  readonly version: 'attendance-online-punch-v1'
  readonly status: 200 | 202
  readonly body: { readonly ok: true; readonly data: Record<string, unknown> }
}
function conflict(): never { throw new AttendanceW4OperationError('ATTENDANCE_OPERATION_CONFLICT') }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|')
}

/** Independent, immutable online domain; the historical normalizer and payload v1 are untouched. */
export function buildOnlinePunchRequestV1(input: {
  orgId: string; userId: string; tokenSubjectUserId: string; operationId: string; client: OnlinePunchClientFrameV1
}): OnlinePunchRequestV1 {
  const orgId = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId) as string
  if (!input.userId || !input.tokenSubjectUserId || input.userId !== input.tokenSubjectUserId) conflict()
  const source = Object.freeze({ sourceKind: 'direct_live_punch', clientOperationId: input.operationId })
  const operationId = deriveAttendanceOperationCandidateIdentityV1(source).operationId
  const client = input.client
  if (!exact(client, ['eventType', 'timezone', 'source', 'location', 'meta', 'photoFileId', 'requestNamedOrgId'])
    || !['check_in', 'check_out'].includes(client.eventType)
    || ['timezone', 'source', 'photoFileId', 'requestNamedOrgId'].some(key => client[key] !== null && typeof client[key] !== 'string')
    || ['location', 'meta'].some(key => client[key] !== null && !record(client[key]))) conflict()
  const fingerprint = createHash('sha256').update(canonicalAttendanceJsonV1({
    version: 'attendance-online-punch-v1', orgId, userId: input.userId,
    tokenSubjectUserId: input.tokenSubjectUserId, client,
  })).digest('hex')
  const registryInput = Object.freeze({ orgId, entrypoint: 'live_punch' as const, batch: null,
    commands: Object.freeze([Object.freeze({ source, commandFingerprint: fingerprint })]),
  })
  const request = Object.freeze({ orgId, userId: input.userId, tokenSubjectUserId: input.tokenSubjectUserId,
    operationId, fingerprint, registryInput })
  requests.add(request)
  return request
}
export function requireOnlinePunchRequestV1(input: unknown): OnlinePunchRequestV1 {
  if (!record(input) || !requests.has(input)) conflict()
  return input as unknown as OnlinePunchRequestV1
}
export function parseOnlinePunchReceiptV1(value: unknown): OnlinePunchReceiptV1 {
  if (!exact(value, ['version', 'status', 'body']) || value.version !== 'attendance-online-punch-v1'
    || (value.status !== 200 && value.status !== 202)
    || !exact(value.body, ['ok', 'data']) || value.body.ok !== true || !record(value.body.data)) conflict()
  const data = value.body.data
  if (value.status === 200 && (!record(data.event) || !record(data.record))) conflict()
  if (value.status === 202 && (data.pendingApproval !== true || !record(data.request))) conflict()
  return JSON.parse(canonicalAttendanceJsonV1(value)) as OnlinePunchReceiptV1
}
export function makeOnlinePunchReceiptV1(status: 200 | 202, body: unknown): OnlinePunchReceiptV1 {
  return parseOnlinePunchReceiptV1(JSON.parse(canonicalAttendanceJsonV1({ version: 'attendance-online-punch-v1', status, body })))
}
export class OnlinePunchClaimCollisionError extends Error {
  constructor() { super('ONLINE_PUNCH_CLAIM_COLLISION'); this.name = 'OnlinePunchClaimCollisionError' }
}
export function isOnlinePunchClaimPrimaryKeyCollision(error: unknown): boolean {
  return record(error) && error.code === '23505' && error.constraint === 'pk_attendance_result_operations'
    && (error.table === undefined || error.table === 'attendance_result_operations')
}
/** Only the private marker from an owned claim may restart a whole rolled-back transaction. */
export async function retryOnlinePunchClaimV1<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await run() } catch (error) {
      if (!(error instanceof OnlinePunchClaimCollisionError)) throw error
      if (attempt >= 2) conflict()
    }
  }
}

/** The captured outdoor adapter lends its common request only to the same transaction. */
export async function withOnlinePunchCompanionV1<T>(client: object, request: OnlinePunchRequestV1, run: () => Promise<T>): Promise<T> {
  requireOnlinePunchRequestV1(request)
  if (companions.has(client)) conflict()
  companions.set(client, request)
  try { return await run() } finally { companions.delete(client) }
}
export function readOnlinePunchCompanionV1(client: object): OnlinePunchRequestV1 | null {
  return companions.get(client) ?? null
}
export class OnlinePunchConnectionUncertainError extends Error {
  readonly code = 'W4C2_ONLINE_CONNECTION_UNCERTAIN'
  readonly httpStatus = 503
  constructor() { super('W4C2_ONLINE_CONNECTION_UNCERTAIN'); this.name = 'OnlinePunchConnectionUncertainError' }
}
