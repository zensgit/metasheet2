/**
 * W4C-3b Stage P12 — immutable attendance request calculation snapshots.
 *
 * Scope (lock sections 4.2, 7.2, 12.5; OD-W4C-33):
 *  - Append versioned request snapshots on W4-enabled create/edit.
 *  - Bind the latest exact version/fingerprint at final approve/reject with
 *    terminal approval_instances.version + RETURNING approval_records.id.
 *  - legacy_projection_only writes zero snapshot rows and preserves request DML.
 *  - Pre-W4 missing snapshot is never upgraded from live config.
 *  - Does NOT implement P13 calculation/fact production or P14 cancellation.
 *
 * Callers pass the existing request transaction client. All snapshot DML shares
 * that transaction; an injected failure rolls request/snapshot/binding back.
 */

import crypto from 'node:crypto'
import {
  AttendanceW4IdentityError,
  acquireAttendanceCalculationRolloutLock,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import { validateFrozenContextShape } from './w4c1-segment-calculator'
import type {
  AttendanceAttributionSnapshotV1,
  FrozenAttendanceContextV1,
  FrozenWorkDateAttributionV2,
} from './w4c0-write-boundary-types'

// ---------------------------------------------------------------------------
// Errors (values-free closed codes)
// ---------------------------------------------------------------------------

export const W4C3B_REQUEST_SNAPSHOT_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'W4C3B_REQUEST_SNAPSHOT_INPUT_INVALID',
  REQUEST_NOT_FOUND: 'W4C3B_REQUEST_SNAPSHOT_REQUEST_NOT_FOUND',
  REQUEST_ORG_MISMATCH: 'W4C3B_REQUEST_SNAPSHOT_REQUEST_ORG_MISMATCH',
  REQUEST_SUBJECT_MISMATCH: 'W4C3B_REQUEST_SNAPSHOT_REQUEST_SUBJECT_MISMATCH',
  REQUEST_TYPE_MISMATCH: 'W4C3B_REQUEST_SNAPSHOT_REQUEST_TYPE_MISMATCH',
  REQUEST_NOT_PENDING: 'W4C3B_REQUEST_SNAPSHOT_REQUEST_NOT_PENDING',
  EXPECTED_VERSION_CONFLICT: 'W4C3B_REQUEST_SNAPSHOT_EXPECTED_VERSION_CONFLICT',
  EXPECTED_FINGERPRINT_CONFLICT: 'W4C3B_REQUEST_SNAPSHOT_EXPECTED_FINGERPRINT_CONFLICT',
  MISSING_SNAPSHOT_AUTHORITATIVE: 'W4C3B_REQUEST_SNAPSHOT_MISSING_AUTHORITATIVE',
  BINDING_INVALID: 'W4C3B_REQUEST_SNAPSHOT_BINDING_INVALID',
  POSTURE_BLOCKED: 'W4C3B_REQUEST_SNAPSHOT_POSTURE_BLOCKED',
} as const)

export type W4c3bRequestSnapshotErrorCode =
  (typeof W4C3B_REQUEST_SNAPSHOT_ERROR_CODES)[keyof typeof W4C3B_REQUEST_SNAPSHOT_ERROR_CODES]

export class AttendanceRequestSnapshotError extends Error {
  readonly statusCode: number
  readonly code: W4c3bRequestSnapshotErrorCode

  constructor(code: W4c3bRequestSnapshotErrorCode, statusCode: number, message: string) {
    super(message)
    this.name = 'AttendanceRequestSnapshotError'
    this.code = code
    this.statusCode = statusCode
  }
}

function fail(
  code: W4c3bRequestSnapshotErrorCode,
  statusCode: number,
  message: string,
): never {
  throw new AttendanceRequestSnapshotError(code, statusCode, message)
}

// ---------------------------------------------------------------------------
// Client adapter (plugin trx returns row arrays; pg PoolClient returns { rows })
// ---------------------------------------------------------------------------

export type W4c3bRequestSnapshotQueryClient = {
  query: (
    sql: string,
    params?: readonly unknown[] | unknown[],
  ) => Promise<
    | Array<Record<string, unknown>>
    | { rows: Array<Record<string, unknown>>; rowCount?: number | null }
  >
}

async function queryRows(
  client: W4c3bRequestSnapshotQueryClient,
  sql: string,
  params?: readonly unknown[],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(sql, params as unknown[])
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && Array.isArray(result.rows)) return result.rows
  return []
}

function asW4Trx(client: W4c3bRequestSnapshotQueryClient): AttendanceW4TransactionClientV1 {
  return {
    query: async (sqlText: string, params?: unknown[]) => {
      const rows = await queryRows(client, sqlText, params)
      return { rows }
    },
  }
}

// ---------------------------------------------------------------------------
// Closed payload + fingerprint (lock 4.2 / 7.2)
// ---------------------------------------------------------------------------

const PAYLOAD_FINGERPRINT_DOMAIN =
  'metasheet2:attendance:w4:request-calculation-snapshot-payload:v1'

const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const REQUEST_TYPES = Object.freeze([
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
  'outdoor_punch',
  'shift_swap',
  'schedule_dispatch',
] as const)

export type AttendanceRequestSnapshotRequestTypeV1 =
  (typeof REQUEST_TYPES)[number]

export type AttendanceRequestCalculationPayloadV1 = Readonly<{
  schemaVersion: 1
  workDate: string
  requestedInAt: string | null
  requestedOutAt: string | null
  reason: string | null
  minutes: number | null
  leaveTypeCode: string | null
  outdoorPunch: Readonly<{
    eventType: 'check_in' | 'check_out'
    occurredAt: string
    timezone: string
    source: string
  }> | null
}>

const PAYLOAD_KEYS = Object.freeze([
  'schemaVersion',
  'workDate',
  'requestedInAt',
  'requestedOutAt',
  'reason',
  'minutes',
  'leaveTypeCode',
  'outdoorPunch',
] as const)

const OUTDOOR_KEYS = Object.freeze([
  'eventType',
  'occurredAt',
  'timezone',
  'source',
] as const)

const UNSUPPORTED_REASONS = Object.freeze([
  'legacy_v1',
  'missing',
  'ambiguous',
  'unresolved',
] as const)

const ATTRIBUTION_SOURCES = Object.freeze([
  'live_resolution',
  'request_creation',
  'import_resolution',
  'scheduled_resolution',
] as const)

const ATTRIBUTION_V2_KEYS = Object.freeze([
  'schemaVersion',
  'resolverVersion',
  'orgId',
  'userId',
  'workDate',
  'shiftId',
  'reasonCode',
  'resolvedAt',
  'absoluteWindow',
  'attributionWindow',
  'attributionTailMinutes',
  'extendedByApprovedOvertime',
  'windowEvidenceFingerprint',
  'source',
] as const)

function requireNonEmptyString(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return value
}

function requireUuid(value: unknown): string {
  const text = requireNonEmptyString(value, 36)
  if (!UUID_RE.test(text)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return text.toLowerCase()
}

function requireRequestType(value: unknown): AttendanceRequestSnapshotRequestTypeV1 {
  const text = requireNonEmptyString(value, 64)
  if (!(REQUEST_TYPES as readonly string[]).includes(text)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return text as AttendanceRequestSnapshotRequestTypeV1
}

function requireDateKey(value: unknown): string {
  const text = requireNonEmptyString(value, 10)
  if (!DATE_RE.test(text)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return text
}

function optionalIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
    }
    return value.toISOString()
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return value
}

function optionalNonEmptyOrNull(value: unknown, max = 2000): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > max) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  // Empty string is stored as null in the closed payload (no missing-field ambiguity).
  if (value.length === 0) return null
  return value
}

function optionalNonNegIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return value
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== keys.length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.get || descriptor.set) return false
  }
  return true
}

function normalizeOutdoorPunch(
  value: unknown,
): AttendanceRequestCalculationPayloadV1['outdoorPunch'] {
  if (value === null || value === undefined) return null
  if (!hasExactKeys(value, OUTDOOR_KEYS)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  const eventType = value.eventType
  if (eventType !== 'check_in' && eventType !== 'check_out') {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return Object.freeze({
    eventType,
    occurredAt: requireNonEmptyString(value.occurredAt, 64),
    timezone: requireNonEmptyString(value.timezone, 64),
    source: requireNonEmptyString(value.source, 64),
  })
}

/**
 * Normalize a closed calculation-affecting request payload. Unknown keys fail.
 * Does not accept form_snapshot or mutable approval transport fields.
 */
export function normalizeAttendanceRequestCalculationPayloadV1(
  input: unknown,
): AttendanceRequestCalculationPayloadV1 {
  if (!hasExactKeys(input, PAYLOAD_KEYS)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  if (input.schemaVersion !== 1) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    workDate: requireDateKey(input.workDate),
    requestedInAt: optionalIsoOrNull(input.requestedInAt),
    requestedOutAt: optionalIsoOrNull(input.requestedOutAt),
    reason: optionalNonEmptyOrNull(input.reason),
    minutes: optionalNonNegIntOrNull(input.minutes),
    leaveTypeCode: optionalNonEmptyOrNull(input.leaveTypeCode, 64),
    outdoorPunch: normalizeOutdoorPunch(input.outdoorPunch),
  })
}

/**
 * Build a closed payload from a locked attendance_requests row + optional
 * type-specific fields. Ignores form_snapshot / approvalFlow / resolution.
 */
export function buildAttendanceRequestCalculationPayloadFromRequestRowV1(input: {
  readonly workDate: unknown
  readonly requestedInAt?: unknown
  readonly requestedOutAt?: unknown
  readonly reason?: unknown
  readonly minutes?: unknown
  readonly leaveTypeCode?: unknown
  readonly outdoorPunch?: unknown
}): AttendanceRequestCalculationPayloadV1 {
  return normalizeAttendanceRequestCalculationPayloadV1({
    schemaVersion: 1,
    workDate:
      typeof input.workDate === 'string'
        ? input.workDate.slice(0, 10)
        : input.workDate instanceof Date
          ? input.workDate.toISOString().slice(0, 10)
          : input.workDate,
    requestedInAt: input.requestedInAt ?? null,
    requestedOutAt: input.requestedOutAt ?? null,
    reason: input.reason ?? null,
    minutes: input.minutes ?? null,
    leaveTypeCode: input.leaveTypeCode ?? null,
    outdoorPunch: input.outdoorPunch ?? null,
  })
}

export function computeAttendanceRequestPayloadFingerprintV1(
  payload: AttendanceRequestCalculationPayloadV1,
): string {
  const normalized = normalizeAttendanceRequestCalculationPayloadV1(payload)
  return crypto
    .createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(PAYLOAD_FINGERPRINT_DOMAIN, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonicalAttendanceJsonV1(normalized), 'utf8'),
      ]),
    )
    .digest('hex')
}

// ---------------------------------------------------------------------------
// Attribution / context closed validators
// ---------------------------------------------------------------------------

function validateWindow(value: unknown): { startAt: string; endAt: string } {
  if (!hasExactKeys(value, ['startAt', 'endAt'])) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return {
    startAt: requireNonEmptyString(value.startAt, 64),
    endAt: requireNonEmptyString(value.endAt, 64),
  }
}

function normalizeResolvedV2(value: unknown): FrozenWorkDateAttributionV2 {
  if (!hasExactKeys(value, ATTRIBUTION_V2_KEYS)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  if (value.schemaVersion !== 2) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  if (!(ATTRIBUTION_SOURCES as readonly unknown[]).includes(value.source)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  if (typeof value.extendedByApprovedOvertime !== 'boolean') {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  if (
    typeof value.attributionTailMinutes !== 'number' ||
    !Number.isSafeInteger(value.attributionTailMinutes) ||
    value.attributionTailMinutes < 0
  ) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    resolverVersion: requireNonEmptyString(value.resolverVersion, 128),
    orgId: requireNonEmptyString(value.orgId, 128),
    userId: requireNonEmptyString(value.userId, 128),
    workDate: requireDateKey(value.workDate),
    shiftId: requireNonEmptyString(value.shiftId, 128),
    reasonCode: requireNonEmptyString(value.reasonCode, 128),
    resolvedAt: requireNonEmptyString(value.resolvedAt, 64),
    absoluteWindow: Object.freeze(validateWindow(value.absoluteWindow)),
    attributionWindow: Object.freeze(validateWindow(value.attributionWindow)),
    attributionTailMinutes: value.attributionTailMinutes,
    extendedByApprovedOvertime: value.extendedByApprovedOvertime,
    windowEvidenceFingerprint: (() => {
      const fp = requireNonEmptyString(value.windowEvidenceFingerprint, 64)
      if (!LOWER_HEX_64.test(fp)) {
        fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
      }
      return fp
    })(),
    source: value.source as FrozenWorkDateAttributionV2['source'],
  })
}

export function normalizeAttendanceAttributionSnapshotV1(
  input: unknown,
): AttendanceAttributionSnapshotV1 {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  const posture = (input as { posture?: unknown }).posture
  if (posture === 'unsupported') {
    if (
      !hasExactKeys(input, [
        'posture',
        'sourceSchemaVersion',
        'reason',
        'sourceFingerprint',
      ])
    ) {
      fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
    }
    const schema = input.sourceSchemaVersion
    if (schema !== 0 && schema !== 1 && schema !== null) {
      fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
    }
    if (!(UNSUPPORTED_REASONS as readonly unknown[]).includes(input.reason)) {
      fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
    }
    const fp = input.sourceFingerprint
    if (fp !== null) {
      if (typeof fp !== 'string' || !LOWER_HEX_64.test(fp)) {
        fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
      }
    }
    return Object.freeze({
      posture: 'unsupported' as const,
      sourceSchemaVersion: schema as 0 | 1 | null,
      reason: input.reason as 'legacy_v1' | 'missing' | 'ambiguous' | 'unresolved',
      sourceFingerprint: fp as string | null,
    })
  }
  if (posture === 'resolved_v2') {
    if (!hasExactKeys(input, ['posture', 'value'])) {
      fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
    }
    return Object.freeze({
      posture: 'resolved_v2' as const,
      value: normalizeResolvedV2(input.value),
    })
  }
  fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
}

/** Explicit unsupported posture when request-time V2 cannot be frozen. */
export function buildUnsupportedRequestAttributionSnapshotV1(
  reason: 'legacy_v1' | 'missing' | 'ambiguous' | 'unresolved' = 'missing',
  sourceFingerprint: string | null = null,
): AttendanceAttributionSnapshotV1 {
  return normalizeAttendanceAttributionSnapshotV1({
    posture: 'unsupported',
    sourceSchemaVersion: null,
    reason,
    sourceFingerprint,
  })
}

export function normalizeAttendanceContextSnapshotV1(
  input: unknown,
): FrozenAttendanceContextV1 | null {
  if (input === null || input === undefined) return null
  if (!validateFrozenContextShape(input)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  const canonical = canonicalAttendanceJsonV1(input)
  return Object.freeze(JSON.parse(canonical) as FrozenAttendanceContextV1)
}

// ---------------------------------------------------------------------------
// Snapshot row shapes
// ---------------------------------------------------------------------------

export type AttendanceRequestCalculationSnapshotRowV1 = Readonly<{
  orgId: string
  requestId: string
  version: number
  requestType: AttendanceRequestSnapshotRequestTypeV1
  subjectUserId: string
  payload: AttendanceRequestCalculationPayloadV1
  payloadFingerprint: string
  attributionSnapshot: AttendanceAttributionSnapshotV1
  contextSnapshot: FrozenAttendanceContextV1 | null
  createdBy: string
}>

export type AttendanceRequestSnapshotAppendResultV1 =
  | { readonly kind: 'legacy_skipped'; readonly writePosture: 'legacy_projection_only' }
  | {
      readonly kind: 'appended'
      readonly writePosture: 'shadow' | 'authoritative'
      readonly snapshot: AttendanceRequestCalculationSnapshotRowV1
    }

export type AttendanceRequestTerminalSnapshotBindingV1 = Readonly<{
  schemaVersion: 1
  kind: 'w4c3b_request_snapshot_terminal_binding'
  orgId: string
  requestId: string
  requestType: AttendanceRequestSnapshotRequestTypeV1
  subjectUserId: string
  requestSnapshotVersion: number
  requestSnapshotFingerprint: string
  approvalVersion: number
  approvalRecordId: string
  action: 'approve' | 'reject'
  bindingPosture: 'bound' | 'unsupported_pre_w4_shadow'
}>

export type AttendanceRequestTerminalBindResultV1 =
  | { readonly kind: 'legacy_skipped'; readonly writePosture: 'legacy_projection_only' }
  | {
      readonly kind: 'bound'
      readonly writePosture: 'shadow' | 'authoritative'
      readonly binding: AttendanceRequestTerminalSnapshotBindingV1
      readonly snapshot: AttendanceRequestCalculationSnapshotRowV1
    }
  | {
      readonly kind: 'unsupported_pre_w4_shadow'
      readonly writePosture: 'shadow'
      readonly binding: AttendanceRequestTerminalSnapshotBindingV1
    }

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type WritePosture = 'legacy_projection_only' | 'shadow' | 'authoritative'

async function resolveWritePosture(
  client: W4c3bRequestSnapshotQueryClient,
  orgId: string,
): Promise<WritePosture> {
  const trx = asW4Trx(client)
  let orgKey: ReturnType<typeof parseCanonicalAttendanceRolloutOrgKeyV1>
  try {
    orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(orgId)
  } catch (error) {
    if (
      error instanceof AttendanceW4IdentityError &&
      error.code === 'W4C0_ROLLOUT_ORG_KEY_INVALID'
    ) {
      // Legacy tenant keys cannot be admitted to the canonical W4 rollout.
      return 'legacy_projection_only'
    }
    throw error
  }
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, orgKey)
  if (posture.writePosture === 'blocked') {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.POSTURE_BLOCKED,
      503,
      'Attendance calculation posture is blocked',
    )
  }
  if (
    posture.writePosture === 'legacy_projection_only' ||
    posture.writePosture === 'shadow' ||
    posture.writePosture === 'authoritative'
  ) {
    return posture.writePosture
  }
  fail(
    W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.POSTURE_BLOCKED,
    503,
    'Attendance calculation posture is blocked',
  )
}

type RequestSnapshotMaterialV1 = Readonly<{
  attributionSnapshot: unknown
  contextSnapshot: unknown
}>

type RequestSnapshotMaterialResolverV1 = () => Promise<RequestSnapshotMaterialV1>

async function resolveSnapshotMaterial(input: {
  readonly attributionSnapshot?: unknown
  readonly contextSnapshot?: unknown
  readonly resolveSnapshots?: RequestSnapshotMaterialResolverV1
}): Promise<Readonly<{
  attributionSnapshot: AttendanceAttributionSnapshotV1
  contextSnapshot: FrozenAttendanceContextV1 | null
}>> {
  const resolved = input.resolveSnapshots ? await input.resolveSnapshots() : input
  const attributionSnapshot = normalizeAttendanceAttributionSnapshotV1(
    resolved.attributionSnapshot ?? buildUnsupportedRequestAttributionSnapshotV1('missing'),
  )
  const contextSnapshot = normalizeAttendanceContextSnapshotV1(
    resolved.contextSnapshot ?? null,
  )
  if (
    (attributionSnapshot.posture === 'resolved_v2' && contextSnapshot === null) ||
    (attributionSnapshot.posture === 'unsupported' && contextSnapshot !== null)
  ) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  return Object.freeze({ attributionSnapshot, contextSnapshot })
}

function assertSnapshotMaterialCongruence(input: {
  readonly orgId: string
  readonly subjectUserId: string
  readonly payload: AttendanceRequestCalculationPayloadV1
  readonly attributionSnapshot: AttendanceAttributionSnapshotV1
  readonly contextSnapshot: FrozenAttendanceContextV1 | null
}): void {
  if (input.attributionSnapshot.posture === 'resolved_v2') {
    const value = input.attributionSnapshot.value
    if (
      value.orgId !== input.orgId ||
      value.userId !== input.subjectUserId ||
      value.workDate !== input.payload.workDate
    ) {
      fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 409, 'Request snapshot identity mismatch')
    }
  }
  if (input.contextSnapshot !== null) {
    const context = input.contextSnapshot
    if (
      context.orgId !== input.orgId ||
      context.userId !== input.subjectUserId ||
      context.workDate !== input.payload.workDate ||
      input.attributionSnapshot.posture !== 'resolved_v2' ||
      context.shiftId !== input.attributionSnapshot.value.shiftId
    ) {
      fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 409, 'Request snapshot identity mismatch')
    }
  }
}

function requireExpectedSnapshotToken(input: {
  readonly expectedSnapshotVersion?: number
  readonly expectedSnapshotFingerprint?: string
}): Readonly<{ version: number; fingerprint: string }> {
  if (
    !Number.isSafeInteger(input.expectedSnapshotVersion) ||
    (input.expectedSnapshotVersion as number) < 1
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_VERSION_CONFLICT,
      409,
      'Request snapshot version conflict',
    )
  }
  if (
    typeof input.expectedSnapshotFingerprint !== 'string' ||
    !LOWER_HEX_64.test(input.expectedSnapshotFingerprint)
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_FINGERPRINT_CONFLICT,
      409,
      'Request snapshot fingerprint conflict',
    )
  }
  return Object.freeze({
    version: input.expectedSnapshotVersion as number,
    fingerprint: input.expectedSnapshotFingerprint,
  })
}

type LockedRequestRow = {
  id: string
  orgId: string
  userId: string
  approvalInstanceId: string | null
  requestType: AttendanceRequestSnapshotRequestTypeV1
  status: string
  workDate: string
  requestedInAt: string | null
  requestedOutAt: string | null
  reason: string | null
}

async function lockAttendanceRequestRow(
  client: W4c3bRequestSnapshotQueryClient,
  input: {
    orgId: string
    requestId: string
    subjectUserId: string
    requestType: AttendanceRequestSnapshotRequestTypeV1
    requirePending: boolean
  },
): Promise<LockedRequestRow> {
  const rows = await queryRows(
    client,
    `SELECT id::text AS id,
            org_id::text AS org_id,
            user_id::text AS user_id,
            approval_instance_id::text AS approval_instance_id,
            request_type::text AS request_type,
            status::text AS status,
            work_date::text AS work_date,
            requested_in_at,
            requested_out_at,
            reason
       FROM attendance_requests
      WHERE id = $1::uuid
      FOR UPDATE`,
    [input.requestId],
  )
  if (rows.length !== 1) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.REQUEST_NOT_FOUND,
      404,
      'Attendance request not found',
    )
  }
  const row = rows[0]
  const orgId = typeof row.org_id === 'string' ? row.org_id : ''
  const userId = typeof row.user_id === 'string' ? row.user_id : ''
  const requestType = typeof row.request_type === 'string' ? row.request_type : ''
  const status = typeof row.status === 'string' ? row.status : ''
  if (orgId !== input.orgId) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.REQUEST_ORG_MISMATCH,
      409,
      'Attendance request org mismatch',
    )
  }
  if (userId !== input.subjectUserId) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.REQUEST_SUBJECT_MISMATCH,
      409,
      'Attendance request subject mismatch',
    )
  }
  if (requestType !== input.requestType) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.REQUEST_TYPE_MISMATCH,
      409,
      'Attendance request type mismatch',
    )
  }
  if (input.requirePending && status !== 'pending') {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.REQUEST_NOT_PENDING,
      409,
      'Attendance request is not pending',
    )
  }
  return {
    id: String(row.id),
    orgId,
    userId,
    approvalInstanceId:
      typeof row.approval_instance_id === 'string' && row.approval_instance_id.length > 0
        ? row.approval_instance_id
        : null,
    requestType: requestType as AttendanceRequestSnapshotRequestTypeV1,
    status,
    workDate: String(row.work_date ?? '').slice(0, 10),
    requestedInAt: optionalIsoOrNull(row.requested_in_at ?? null),
    requestedOutAt: optionalIsoOrNull(row.requested_out_at ?? null),
    reason: optionalNonEmptyOrNull(row.reason ?? null),
  }
}

async function lockLatestSnapshot(
  client: W4c3bRequestSnapshotQueryClient,
  orgId: string,
  requestId: string,
): Promise<AttendanceRequestCalculationSnapshotRowV1 | null> {
  const rows = await queryRows(
    client,
    `SELECT org_id::text AS org_id,
            request_id::text AS request_id,
            version,
            request_type::text AS request_type,
            subject_user_id::text AS subject_user_id,
            payload,
            payload_fingerprint,
            attribution_snapshot,
            context_snapshot,
            created_by::text AS created_by
       FROM attendance_request_calculation_snapshots
      WHERE org_id = $1
        AND request_id = $2::uuid
      ORDER BY version DESC
      LIMIT 1
      FOR UPDATE`,
    [orgId, requestId],
  )
  if (rows.length === 0) return null
  return mapSnapshotRow(rows[0])
}

function mapSnapshotRow(row: Record<string, unknown>): AttendanceRequestCalculationSnapshotRowV1 {
  const payload = normalizeAttendanceRequestCalculationPayloadV1(
    typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  )
  const attribution = normalizeAttendanceAttributionSnapshotV1(
    typeof row.attribution_snapshot === 'string'
      ? JSON.parse(row.attribution_snapshot)
      : row.attribution_snapshot,
  )
  const contextRaw =
    row.context_snapshot === null || row.context_snapshot === undefined
      ? null
      : typeof row.context_snapshot === 'string'
        ? JSON.parse(row.context_snapshot)
        : row.context_snapshot
  const context = normalizeAttendanceContextSnapshotV1(contextRaw)
  const version = Number(row.version)
  if (!Number.isSafeInteger(version) || version < 1) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 500, 'Invalid request snapshot input')
  }
  const fingerprint = String(row.payload_fingerprint ?? '')
  if (!LOWER_HEX_64.test(fingerprint)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 500, 'Invalid request snapshot input')
  }
  return Object.freeze({
    orgId: String(row.org_id),
    requestId: String(row.request_id).toLowerCase(),
    version,
    requestType: requireRequestType(row.request_type),
    subjectUserId: String(row.subject_user_id),
    payload,
    payloadFingerprint: fingerprint,
    attributionSnapshot: attribution,
    contextSnapshot: context,
    createdBy: String(row.created_by),
  })
}

async function insertSnapshotRow(
  client: W4c3bRequestSnapshotQueryClient,
  row: AttendanceRequestCalculationSnapshotRowV1,
): Promise<void> {
  await queryRows(
    client,
    `INSERT INTO attendance_request_calculation_snapshots
       (org_id, request_id, version, request_type, subject_user_id,
        payload, payload_fingerprint, attribution_snapshot, context_snapshot, created_by)
     VALUES
       ($1, $2::uuid, $3, $4, $5,
        $6::jsonb, $7, $8::jsonb, $9::jsonb, $10)`,
    [
      row.orgId,
      row.requestId,
      row.version,
      row.requestType,
      row.subjectUserId,
      JSON.stringify(row.payload),
      row.payloadFingerprint,
      JSON.stringify(row.attributionSnapshot),
      row.contextSnapshot === null ? null : JSON.stringify(row.contextSnapshot),
      row.createdBy,
    ],
  )
}

function freezeBinding(
  binding: AttendanceRequestTerminalSnapshotBindingV1,
): AttendanceRequestTerminalSnapshotBindingV1 {
  return Object.freeze({ ...binding })
}

// ---------------------------------------------------------------------------
// Public append / bind API
// ---------------------------------------------------------------------------

export type AppendAttendanceRequestCreateSnapshotInputV1 = Readonly<{
  client: W4c3bRequestSnapshotQueryClient
  orgId: string
  requestId: string
  requestType: string
  subjectUserId: string
  actorUserId: string
  /** Closed payload; if omitted, derived from the locked request row + optional fields. */
  payload?: AttendanceRequestCalculationPayloadV1 | unknown
  /** Optional closed payload field overrides when deriving from the request row. */
  payloadFields?: {
    readonly minutes?: unknown
    readonly leaveTypeCode?: unknown
    readonly outdoorPunch?: unknown
  }
  attributionSnapshot?: unknown
  contextSnapshot?: unknown
  /** Lazy read-only resolver invoked only after non-legacy posture is locked. */
  resolveSnapshots?: RequestSnapshotMaterialResolverV1
}>

/**
 * After attendance_requests parent INSERT: append version 1 under W4 postures.
 * legacy_projection_only returns legacy_skipped with zero DML.
 */
export async function appendAttendanceRequestCreateSnapshotV1(
  input: AppendAttendanceRequestCreateSnapshotInputV1,
): Promise<AttendanceRequestSnapshotAppendResultV1> {
  const orgId = requireNonEmptyString(input.orgId, 128)
  const requestId = requireUuid(input.requestId)
  const requestType = requireRequestType(input.requestType)
  const subjectUserId = requireNonEmptyString(input.subjectUserId, 128)
  const actorUserId = requireNonEmptyString(input.actorUserId, 128)

  const writePosture = await resolveWritePosture(input.client, orgId)
  if (writePosture === 'legacy_projection_only') {
    return { kind: 'legacy_skipped', writePosture }
  }

  // Create is always version 1; concurrent double-create of the same request id
  // is impossible (PK). Refuse if a snapshot already exists.
  const existing = await lockLatestSnapshot(input.client, orgId, requestId)
  if (existing) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_VERSION_CONFLICT,
      409,
      'Request snapshot already exists for create',
    )
  }

  const locked = await lockAttendanceRequestRow(input.client, {
    orgId,
    requestId,
    subjectUserId,
    requestType,
    requirePending: true,
  })

  const payload = input.payload
    ? normalizeAttendanceRequestCalculationPayloadV1(input.payload)
    : buildAttendanceRequestCalculationPayloadFromRequestRowV1({
        workDate: locked.workDate,
        requestedInAt: locked.requestedInAt,
        requestedOutAt: locked.requestedOutAt,
        reason: locked.reason,
        minutes: input.payloadFields?.minutes,
        leaveTypeCode: input.payloadFields?.leaveTypeCode,
        outdoorPunch: input.payloadFields?.outdoorPunch,
      })

  const { attributionSnapshot, contextSnapshot } = await resolveSnapshotMaterial(input)
  assertSnapshotMaterialCongruence({
    orgId,
    subjectUserId,
    payload,
    attributionSnapshot,
    contextSnapshot,
  })

  const snapshot: AttendanceRequestCalculationSnapshotRowV1 = Object.freeze({
    orgId,
    requestId,
    version: 1,
    requestType,
    subjectUserId,
    payload,
    payloadFingerprint: computeAttendanceRequestPayloadFingerprintV1(payload),
    attributionSnapshot,
    contextSnapshot,
    createdBy: actorUserId,
  })

  await insertSnapshotRow(input.client, snapshot)
  return { kind: 'appended', writePosture, snapshot }
}

export type AppendAttendanceRequestEditSnapshotInputV1 = Readonly<{
  client: W4c3bRequestSnapshotQueryClient
  orgId: string
  requestId: string
  requestType: string
  subjectUserId: string
  actorUserId: string
  /** OD-W4C-33: exact latest token; mandatory for every non-legacy edit. */
  expectedSnapshotVersion?: number
  expectedSnapshotFingerprint?: string
  /** Current row type when this edit changes request_type. */
  currentRequestType?: string
  payload?: AttendanceRequestCalculationPayloadV1 | unknown
  payloadFields?: {
    readonly minutes?: unknown
    readonly leaveTypeCode?: unknown
    readonly outdoorPunch?: unknown
  }
  attributionSnapshot?: unknown
  contextSnapshot?: unknown
  /** Lazy read-only resolver invoked only after posture/OCC locks. */
  resolveSnapshots?: RequestSnapshotMaterialResolverV1
}>

/**
 * Pending business edit: lock request + latest snapshot and append exactly one
 * next version (A -> B -> A yields v3; fingerprint is not unique).
 */
export async function appendAttendanceRequestEditSnapshotV1(
  input: AppendAttendanceRequestEditSnapshotInputV1,
): Promise<AttendanceRequestSnapshotAppendResultV1> {
  const orgId = requireNonEmptyString(input.orgId, 128)
  const requestId = requireUuid(input.requestId)
  const requestType = requireRequestType(input.requestType)
  const subjectUserId = requireNonEmptyString(input.subjectUserId, 128)
  const actorUserId = requireNonEmptyString(input.actorUserId, 128)

  const writePosture = await resolveWritePosture(input.client, orgId)
  if (writePosture === 'legacy_projection_only') {
    return { kind: 'legacy_skipped', writePosture }
  }

  const expected = requireExpectedSnapshotToken(input)
  const locked = await lockAttendanceRequestRow(input.client, {
    orgId,
    requestId,
    subjectUserId,
    requestType: requireRequestType(input.currentRequestType ?? input.requestType),
    requirePending: true,
  })

  const latest = await lockLatestSnapshot(input.client, orgId, requestId)
  if (!latest) {
    // Pre-W4 request under W4 posture: never upgrade by minting from live config
    // on edit. Authoritative refuses; shadow refuses edit append the same way so
    // a later terminal bind can take the unsupported_pre_w4_shadow path without
    // inventing a pseudo-create from current config.
    if (writePosture === 'authoritative') {
      fail(
        W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.MISSING_SNAPSHOT_AUTHORITATIVE,
        409,
        'Pre-W4 request cannot be edited under authoritative posture',
      )
    }
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_VERSION_CONFLICT,
      409,
      'Pre-W4 request has no snapshot to edit',
    )
  }

  if (
    expected.version !== latest.version
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_VERSION_CONFLICT,
      409,
      'Request snapshot version conflict',
    )
  }
  if (
    expected.fingerprint !== latest.payloadFingerprint
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_FINGERPRINT_CONFLICT,
      409,
      'Request snapshot fingerprint conflict',
    )
  }

  const payload = input.payload
    ? normalizeAttendanceRequestCalculationPayloadV1(input.payload)
    : buildAttendanceRequestCalculationPayloadFromRequestRowV1({
        workDate: locked.workDate,
        requestedInAt: locked.requestedInAt,
        requestedOutAt: locked.requestedOutAt,
        reason: locked.reason,
        minutes: input.payloadFields?.minutes,
        leaveTypeCode: input.payloadFields?.leaveTypeCode,
        outdoorPunch: input.payloadFields?.outdoorPunch,
      })

  const hasNewMaterial = Boolean(
    input.resolveSnapshots ||
    input.attributionSnapshot !== undefined ||
    input.contextSnapshot !== undefined,
  )
  const { attributionSnapshot, contextSnapshot } = hasNewMaterial
    ? await resolveSnapshotMaterial(input)
    : {
        attributionSnapshot: latest.attributionSnapshot,
        contextSnapshot: latest.contextSnapshot,
      }
  assertSnapshotMaterialCongruence({
    orgId,
    subjectUserId,
    payload,
    attributionSnapshot,
    contextSnapshot,
  })

  const snapshot: AttendanceRequestCalculationSnapshotRowV1 = Object.freeze({
    orgId,
    requestId,
    version: latest.version + 1,
    requestType,
    subjectUserId,
    payload,
    payloadFingerprint: computeAttendanceRequestPayloadFingerprintV1(payload),
    attributionSnapshot,
    contextSnapshot,
    createdBy: actorUserId,
  })

  await insertSnapshotRow(input.client, snapshot)
  return { kind: 'appended', writePosture, snapshot }
}

export type BindAttendanceRequestTerminalSnapshotInputV1 = Readonly<{
  client: W4c3bRequestSnapshotQueryClient
  orgId: string
  requestId: string
  requestType: string
  subjectUserId: string
  action: 'approve' | 'reject'
  /** Terminal approval_instances.version written in this transaction. */
  approvalVersion: number
  /**
   * Decimal string of RETURNING approval_records.id. Must be the id produced
   * in THIS transaction — never a client-supplied or form_snapshot value.
   */
  approvalRecordId: string
  /** Optional optimistic concurrency for decision path. */
  expectedSnapshotVersion?: number
  expectedSnapshotFingerprint?: string
}>

/**
 * Final approve/reject: lock latest snapshot and seal a durable closed binding
 * of (snapshot version/fingerprint + approvalVersion + approvalRecordId).
 *
 * Call AFTER INSERT approval_records ... RETURNING id and BEFORE relying on
 * any mutable form_snapshot for calculation facts.
 *
 * Pre-W4 missing snapshot:
 *  - legacy_projection_only: no-op
 *  - shadow: allow terminal legacy action; return unsupported_pre_w4_shadow
 *    binding without inventing a snapshot from live config
 *  - authoritative: fail before the caller should have done terminal DML;
 *    prefer lockAttendanceRequestSnapshotBeforeTerminalDecisionV1 first
 */
export async function bindAttendanceRequestTerminalSnapshotV1(
  input: BindAttendanceRequestTerminalSnapshotInputV1,
): Promise<AttendanceRequestTerminalBindResultV1> {
  const orgId = requireNonEmptyString(input.orgId, 128)
  const requestId = requireUuid(input.requestId)
  const requestType = requireRequestType(input.requestType)
  const subjectUserId = requireNonEmptyString(input.subjectUserId, 128)
  if (input.action !== 'approve' && input.action !== 'reject') {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.INPUT_INVALID, 400, 'Invalid request snapshot input')
  }
  if (
    typeof input.approvalVersion !== 'number' ||
    !Number.isSafeInteger(input.approvalVersion) ||
    input.approvalVersion < 1
  ) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.BINDING_INVALID, 400, 'Invalid terminal binding')
  }
  const approvalRecordId = requireNonEmptyString(input.approvalRecordId, 32)
  if (!/^[0-9]+$/.test(approvalRecordId)) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.BINDING_INVALID, 400, 'Invalid terminal binding')
  }

  const writePosture = await resolveWritePosture(input.client, orgId)
  if (writePosture === 'legacy_projection_only') {
    return { kind: 'legacy_skipped', writePosture }
  }

  const lockedRequest = await lockAttendanceRequestRow(input.client, {
    orgId,
    requestId,
    subjectUserId,
    requestType,
    requirePending: false,
  })

  const latest = await lockLatestSnapshot(input.client, orgId, requestId)

  // Cross-check the returned row against the request's locked approval instance,
  // terminal action, and terminal version. The host port must not turn an
  // arbitrary existing BIGSERIAL value into a request-snapshot binding.
  if (lockedRequest.approvalInstanceId === null) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.BINDING_INVALID, 409, 'Invalid terminal binding')
  }
  const recordRows = await queryRows(
    input.client,
    `SELECT id::text AS id
       FROM approval_records
      WHERE id = $1::bigint
        AND instance_id = $2
        AND action = $3
        AND to_version = $4
      LIMIT 1`,
    [approvalRecordId, lockedRequest.approvalInstanceId, input.action, input.approvalVersion],
  )
  if (recordRows.length !== 1 || String(recordRows[0].id) !== approvalRecordId) {
    fail(W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.BINDING_INVALID, 409, 'Invalid terminal binding')
  }

  if (!latest) {
    if (writePosture === 'authoritative') {
      fail(
        W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.MISSING_SNAPSHOT_AUTHORITATIVE,
        409,
        'Pre-W4 request cannot terminalize under authoritative posture',
      )
    }
    // shadow: preserve exact legacy terminal action; do not mint a snapshot
    // from current schedule/config.
    const binding = freezeBinding({
      schemaVersion: 1,
      kind: 'w4c3b_request_snapshot_terminal_binding',
      orgId,
      requestId,
      requestType,
      subjectUserId,
      requestSnapshotVersion: 0,
      requestSnapshotFingerprint: '0'.repeat(64),
      approvalVersion: input.approvalVersion,
      approvalRecordId,
      action: input.action,
      bindingPosture: 'unsupported_pre_w4_shadow',
    })
    return { kind: 'unsupported_pre_w4_shadow', writePosture: 'shadow', binding }
  }

  if (
    input.expectedSnapshotVersion !== undefined &&
    input.expectedSnapshotVersion !== latest.version
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_VERSION_CONFLICT,
      409,
      'Request snapshot version conflict',
    )
  }
  if (
    input.expectedSnapshotFingerprint !== undefined &&
    input.expectedSnapshotFingerprint !== latest.payloadFingerprint
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_FINGERPRINT_CONFLICT,
      409,
      'Request snapshot fingerprint conflict',
    )
  }

  const binding = freezeBinding({
    schemaVersion: 1,
    kind: 'w4c3b_request_snapshot_terminal_binding',
    orgId,
    requestId,
    requestType,
    subjectUserId,
    requestSnapshotVersion: latest.version,
    requestSnapshotFingerprint: latest.payloadFingerprint,
    approvalVersion: input.approvalVersion,
    approvalRecordId,
    action: input.action,
    bindingPosture: 'bound',
  })

  return { kind: 'bound', writePosture, binding, snapshot: latest }
}

/**
 * Pre-terminal lock: call BEFORE approval_instances / approval_records /
 * attendance_requests terminal DML so authoritative missing-snapshot fails
 * closed with zero terminal writes.
 */
export async function lockAttendanceRequestSnapshotBeforeTerminalDecisionV1(input: {
  client: W4c3bRequestSnapshotQueryClient
  orgId: string
  requestId: string
  requestType: string
  subjectUserId: string
  expectedSnapshotVersion?: number
  expectedSnapshotFingerprint?: string
}): Promise<
  | { readonly kind: 'legacy_skipped'; readonly writePosture: 'legacy_projection_only' }
  | {
      readonly kind: 'locked'
      readonly writePosture: 'shadow' | 'authoritative'
      readonly snapshot: AttendanceRequestCalculationSnapshotRowV1
    }
  | {
      readonly kind: 'missing_shadow_allowed'
      readonly writePosture: 'shadow'
    }
> {
  const orgId = requireNonEmptyString(input.orgId, 128)
  const requestId = requireUuid(input.requestId)
  const requestType = requireRequestType(input.requestType)
  const subjectUserId = requireNonEmptyString(input.subjectUserId, 128)

  const writePosture = await resolveWritePosture(input.client, orgId)
  if (writePosture === 'legacy_projection_only') {
    return { kind: 'legacy_skipped', writePosture }
  }

  await lockAttendanceRequestRow(input.client, {
    orgId,
    requestId,
    subjectUserId,
    requestType,
    requirePending: true,
  })

  const latest = await lockLatestSnapshot(input.client, orgId, requestId)
  if (!latest) {
    if (writePosture === 'authoritative') {
      fail(
        W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.MISSING_SNAPSHOT_AUTHORITATIVE,
        409,
        'Pre-W4 request cannot terminalize under authoritative posture',
      )
    }
    return { kind: 'missing_shadow_allowed', writePosture: 'shadow' }
  }

  if (
    input.expectedSnapshotVersion !== undefined &&
    input.expectedSnapshotVersion !== latest.version
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_VERSION_CONFLICT,
      409,
      'Request snapshot version conflict',
    )
  }
  if (
    input.expectedSnapshotFingerprint !== undefined &&
    input.expectedSnapshotFingerprint !== latest.payloadFingerprint
  ) {
    fail(
      W4C3B_REQUEST_SNAPSHOT_ERROR_CODES.EXPECTED_FINGERPRINT_CONFLICT,
      409,
      'Request snapshot fingerprint conflict',
    )
  }

  return { kind: 'locked', writePosture, snapshot: latest }
}

/** Closed metadata key for durable binding witness on the terminal request row. */
export const W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY =
  'w4RequestSnapshotTerminalBinding' as const
