import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import { ATTENDANCE_ACTOR_POSTURES_V1 } from './w4c0-authorization'
import { parseCanonicalAttendanceRolloutOrgKeyV1 } from './w4c0-identity'
import { sha256HexOfCanonicalJsonV1 } from './w4c3a-legacy-execution-plan'
import { readAttendancePunchDetailEnvelopeV1 } from './w4c3a-punch-detail-command'
import {
  buildAttendancePunchDetailPreparedPlanV1,
  type AttendancePunchDetailPreparationInputV1,
} from './w4c3a-punch-detail-prepare'

type Scope = AttendancePunchDetailPreparationInputV1['scope']
type Envelope = AttendancePunchDetailPreparationInputV1['envelope']
type FrozenTarget = Pick<AttendancePunchDetailPreparationInputV1, 'attribution' | 'context' | 'policySourceProof'>
const RECORD_KEYS = ['schemaVersion', 'kind', 'jobId', 'batchId', 'scope', 'envelope', 'previewLimit',
  'frozenTarget', 'requestFingerprint', 'preview'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

function fail(suffix: 'INVALID' | 'DIGEST_MISMATCH' | 'IDENTITY_MISMATCH' | 'RESULT_MISMATCH'): never {
  throw new Error(`ATTENDANCE_PUNCH_DETAIL_PREVIEW_${suffix}`)
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key)
    || !('value' in descriptors[key]))) fail('INVALID')
  return value as Record<string, unknown>
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value
}

function parseScope(value: unknown): Scope {
  const scope = exactObject(value, ['orgId', 'actorId', 'actorPosture', 'tokenSubjectUserId'])
  parseCanonicalAttendanceRolloutOrgKeyV1(scope.orgId)
  if (!text(scope.actorId) || !ATTENDANCE_ACTOR_POSTURES_V1.includes(scope.actorPosture as Scope['actorPosture'])
    || (scope.tokenSubjectUserId !== null && !text(scope.tokenSubjectUserId))) fail('INVALID')
  return Object.freeze({ orgId: scope.orgId as string, actorId: scope.actorId,
    actorPosture: scope.actorPosture as Scope['actorPosture'], tokenSubjectUserId: scope.tokenSubjectUserId as string | null })
}

function parseCommand(value: unknown, limit: unknown): { envelope: Envelope; previewLimit: number } {
  const envelope = readAttendancePunchDetailEnvelopeV1(value)
  if (!envelope || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 1000) fail('INVALID')
  if (envelope.idempotencyKey !== null && (!text(envelope.idempotencyKey) || envelope.idempotencyKey.length > 128)) fail('INVALID')
  return { envelope, previewLimit: limit as number }
}

/** Preview retries never collide with commit commands or depend on a fresh server UUID. */
export function fingerprintAttendancePunchDetailPreviewRequestV1(scope: Scope, envelope: Envelope, previewLimit: number): string {
  return sha256HexOfCanonicalJsonV1({ domain: 'metasheet2:attendance:punch-detail-preview-request:v1',
    scope: parseScope(scope), ...parseCommand(envelope, previewLimit) })
}

function project(preparation: AttendancePunchDetailPreparationInputV1, previewLimit: number) {
  const { calculation } = buildAttendancePunchDetailPreparedPlanV1(preparation)
  const input = preparation.envelope.__punchDetailInput
  const items = input.punches.map((punch, sourceOrdinal) => ({ sourceOrdinal, ...punch }))
  return {
    inputKind: 'punch_events_v1' as const, eventCount: items.length, targetCount: 1,
    total: items.length, rowCount: items.length, processedRows: items.length, failedRows: 0,
    items: items.slice(0, previewLimit), previewLimit, truncated: items.length > previewLimit,
    targets: [{ userId: input.userId, workDate: input.workDate, outcome: calculation.outcome,
      reasonCode: calculation.outcomeReasonCode, dailyProjection: calculation.dailyProjection, segments: calculation.segments }],
    engine: preparation.envelope.__importEngine,
    recordUpsertStrategy: preparation.envelope.recordUpsertStrategy,
    csvWarnings: [], groupWarnings: [],
  }
}

export type AttendancePunchDetailPreviewRecordV1 = Readonly<{
  schemaVersion: 1
  kind: 'punch_events_preview_v1'
  jobId: string
  batchId: string
  scope: Scope
  envelope: Envelope
  previewLimit: number
  frozenTarget: FrozenTarget
  requestFingerprint: string
  preview: ReturnType<typeof project>
}>
export type AttendancePunchDetailPreviewBindingV1 = Readonly<{
  jobId: string
  batchId: string
  scope: Scope
  requestFingerprint: string
  snapshotDigest: string
}>

function detached<T>(value: T): T {
  const copy = JSON.parse(canonicalAttendanceJsonV1(value)) as T
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === 'object') {
      Object.values(item).forEach(freeze)
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}

function reconstruct(value: unknown): AttendancePunchDetailPreviewRecordV1 {
  const row = exactObject(value, RECORD_KEYS)
  if (row.schemaVersion !== 1 || row.kind !== 'punch_events_preview_v1'
    || typeof row.jobId !== 'string' || !UUID.test(row.jobId)
    || typeof row.batchId !== 'string' || !UUID.test(row.batchId)) fail('INVALID')
  const scope = parseScope(row.scope)
  const { envelope, previewLimit } = parseCommand(row.envelope, row.previewLimit)
  const frozen = exactObject(row.frozenTarget, ['attribution', 'context', 'policySourceProof'])
  exactObject(frozen.policySourceProof, ['sourceDefinition', 'sourceFingerprint'])
  const attribution = exactObject(frozen.attribution, ['kind', 'attribution', 'reconstruction'])
  if (attribution.kind !== 'resolved_v2') fail('INVALID')
  const frozenTarget = frozen as FrozenTarget
  const requestFingerprint = fingerprintAttendancePunchDetailPreviewRequestV1(scope, envelope, previewLimit)
  if (row.requestFingerprint !== requestFingerprint) fail('IDENTITY_MISMATCH')
  const preview = project({ scope, envelope, batchId: row.batchId, ...frozenTarget, chunkConfig: null }, previewLimit)
  if (canonicalAttendanceJsonV1(row.preview) !== canonicalAttendanceJsonV1(preview)) fail('RESULT_MISMATCH')
  return detached({ schemaVersion: 1, kind: 'punch_events_preview_v1', jobId: row.jobId, batchId: row.batchId,
    scope, envelope, previewLimit, frozenTarget, requestFingerprint, preview })
}

/** Internal server freeze only. It does not mint a write context or return a commit plan. */
export function buildAttendancePunchDetailPreviewRecordV1(input: {
  jobId: string
  preparation: AttendancePunchDetailPreparationInputV1
  previewLimit: number
}): Readonly<{ record: AttendancePunchDetailPreviewRecordV1; snapshotDigest: string }> {
  const { scope, envelope, batchId, attribution, context, policySourceProof } = input.preparation
  const record = reconstruct({ schemaVersion: 1, kind: 'punch_events_preview_v1', jobId: input.jobId,
    batchId, scope, envelope, previewLimit: input.previewLimit,
    frozenTarget: { attribution, context, policySourceProof },
    requestFingerprint: fingerprintAttendancePunchDetailPreviewRequestV1(scope, envelope, input.previewLimit),
    preview: project(input.preparation, input.previewLimit) })
  return Object.freeze({ record, snapshotDigest: sha256HexOfCanonicalJsonV1(record) })
}

/** Expected fields come from the independently frozen job row, never from this JSON itself. */
export function verifyAttendancePunchDetailPreviewRecordV1(
  value: unknown, expected: AttendancePunchDetailPreviewBindingV1,
): AttendancePunchDetailPreviewRecordV1 {
  exactObject(value, RECORD_KEYS)
  if (typeof expected.snapshotDigest !== 'string' || !SHA256.test(expected.snapshotDigest)
    || sha256HexOfCanonicalJsonV1(value) !== expected.snapshotDigest) fail('DIGEST_MISMATCH')
  const record = reconstruct(value)
  if (record.jobId !== expected.jobId || record.batchId !== expected.batchId
    || record.requestFingerprint !== expected.requestFingerprint
    || canonicalAttendanceJsonV1(record.scope) !== canonicalAttendanceJsonV1(parseScope(expected.scope))) fail('IDENTITY_MISMATCH')
  return record
}
