import type { AttendanceLegacyPlanWorkerJobV1, VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'
import {
  parseLegacyImportPublicJobEnvelopeV1,
  sha256HexOfCanonicalJsonV1,
  type LegacyImportBatchPlanV1,
  type LegacyImportPublicJobEnvelopeV1,
} from './w4c3a-legacy-execution-plan'
import type { LegacyImportItemDraftV1, LegacyImportRecordWriteDraftV1 } from './w4c3a-legacy-plan-enqueue'
import { expandAttendancePunchDetailEvidenceV1 } from './w4c3a-punch-detail-evidence'
import { parseAttendancePunchDetailInputV1, type AttendancePunchDetailInputV1 } from './w4c3a-punch-detail-input'

/** An explicit durable command, not a control flag inferred from client metadata. */
export type AttendancePunchDetailJobEnvelopeV1 = LegacyImportPublicJobEnvelopeV1 & Readonly<{
  __punchDetailInput: AttendancePunchDetailInputV1
}>
export type AttendanceImportJobEnvelopeV1 = LegacyImportPublicJobEnvelopeV1 | AttendancePunchDetailJobEnvelopeV1

export class AttendancePunchDetailCommandError extends Error {
  readonly code = 'ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH'
  constructor() {
    super('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    this.name = 'AttendancePunchDetailCommandError'
  }
}

function mismatch(): never {
  throw new AttendancePunchDetailCommandError()
}

/** Absent discriminator preserves the legacy caller. Present-but-invalid never falls back. */
export function readAttendancePunchDetailEnvelopeV1(value: unknown): AttendancePunchDetailJobEnvelopeV1 | null {
  if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, '__punchDetailInput')) return null
  if (Array.isArray(value)) mismatch()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) mismatch()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !('value' in descriptors[key]))) mismatch()
  const { __punchDetailInput, ...legacy } = value as Record<string, unknown>
  return Object.freeze({
    ...parseLegacyImportPublicJobEnvelopeV1(legacy),
    __punchDetailInput: parseAttendancePunchDetailInputV1(__punchDetailInput),
  })
}

export function parseAttendanceImportJobEnvelopeV1(value: unknown): AttendanceImportJobEnvelopeV1 {
  return readAttendancePunchDetailEnvelopeV1(value) ?? parseLegacyImportPublicJobEnvelopeV1(value)
}

export type AttendancePunchDetailCommandScopeV1 = Readonly<{
  orgId: string
  actorId: string
  actorPosture: string
  tokenSubjectUserId: string | null
}>

/** Stable across server batch IDs/freezing times; binds the accepted command and identity. */
export function fingerprintAttendancePunchDetailCommandV1(
  scope: AttendancePunchDetailCommandScopeV1,
  envelope: AttendancePunchDetailJobEnvelopeV1,
): string {
  const parsed = readAttendancePunchDetailEnvelopeV1(envelope)
  if (!parsed) mismatch()
  return sha256HexOfCanonicalJsonV1({
    domain: 'metasheet2:attendance:punch-detail-command:v1',
    orgId: scope.orgId,
    actorId: scope.actorId,
    actorPosture: scope.actorPosture,
    tokenSubjectUserId: scope.tokenSubjectUserId,
    envelope: parsed,
  })
}

export type AttendancePunchDetailPlanBindingInputV1 = AttendancePunchDetailCommandScopeV1 & Readonly<{
  batchId: string
  envelope: unknown
  batch: LegacyImportBatchPlanV1
  items: readonly LegacyImportItemDraftV1[]
  recordWrites: readonly LegacyImportRecordWriteDraftV1[]
  groupEffects: readonly unknown[]
}>

/**
 * Validate the command against digest-covered source items and the single target.
 * This does not mint authorization, calculate projections, or accept frozen policy.
 */
export function requireAttendancePunchDetailPlanBindingV1(
  input: AttendancePunchDetailPlanBindingInputV1,
): Readonly<{ envelope: AttendancePunchDetailJobEnvelopeV1; requestFingerprint: string }> | null {
  const envelope = readAttendancePunchDetailEnvelopeV1(input.envelope)
  const marked = input.items.some((item) => typeof item.rawEvidence?.provenance?.sourceRef === 'string'
    && /^attendance-import:[0-9a-f-]+:punch_events_v1:/.test(item.rawEvidence.provenance.sourceRef))
  const mapping = input.batch.kind === 'normal' ? input.batch.mappingSnapshot : null
  const declared = mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping)
    && (mapping as Record<string, unknown>).kind === 'punch_events_v1'
  if (!envelope) {
    if (marked || declared) mismatch()
    return null
  }
  const command = envelope.__punchDetailInput
  const expected = expandAttendancePunchDetailEvidenceV1(command, input.batchId)
  const requestFingerprint = fingerprintAttendancePunchDetailCommandV1(input, envelope)
  const batch = input.batch
  if (batch.kind !== 'normal' || batch.sourceRowCount !== expected.length
    || batch.source !== 'manual' || batch.idempotencyKey !== envelope.idempotencyKey
    || batch.engine !== envelope.__importEngine
    || batch.recordUpsertStrategy !== envelope.recordUpsertStrategy
    || batch.itemsInsertStrategy !== envelope.itemsInsertStrategy
    || input.items.length !== expected.length || input.recordWrites.length !== 1 || input.groupEffects.length !== 0) mismatch()
  if (sha256HexOfCanonicalJsonV1(batch.mappingSnapshot)
    !== sha256HexOfCanonicalJsonV1({ kind: 'punch_events_v1', envelope, requestFingerprint })) mismatch()
  if (batch.compatibilityMetadata === null || typeof batch.compatibilityMetadata !== 'object'
    || Array.isArray(batch.compatibilityMetadata)
    || (batch.compatibilityMetadata as Record<string, unknown>).punchDetailRequestFingerprint !== requestFingerprint) mismatch()
  const write = input.recordWrites[0]
  const targetRef = JSON.stringify([input.orgId, command.userId, command.workDate])
  if (write.orgId !== input.orgId || write.userId !== command.userId || write.workDate !== command.workDate
    || write.timezone !== command.timezone || write.sourceBatchId !== input.batchId
    || write.sourceOrdinals.length !== expected.length
    || write.sourceOrdinals.some((ordinal, index) => ordinal !== index)) mismatch()
  input.items.forEach((item, index) => {
    if (item.kind !== 'apply' || item.ordinal !== index || item.semanticOrdinal !== index || item.targetRef !== targetRef
      || sha256HexOfCanonicalJsonV1(item.rawEvidence) !== sha256HexOfCanonicalJsonV1(expected[index])) mismatch()
  })
  return Object.freeze({ envelope, requestFingerprint })
}

export function assertAttendancePunchDetailCanonicalBranchV1(
  binding: unknown,
  writePosture: string,
  operationalBranch: string,
): void {
  if (binding !== null && ((writePosture !== 'shadow' && writePosture !== 'authoritative')
    || operationalBranch !== 'strict_targeted')) mismatch()
}


/** Used only after durable digests are verified, and again before registry/effect DML. */
export function requireAttendancePunchDetailStoredPlanBindingV1(
  job: AttendanceLegacyPlanWorkerJobV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): ReturnType<typeof requireAttendancePunchDetailPlanBindingV1> {
  const snapshot = plan.manifest.batch.kind === 'normal' ? plan.manifest.batch.mappingSnapshot : null
  const descriptor = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && (snapshot as Record<string, unknown>).kind === 'punch_events_v1'
    ? snapshot as Record<string, unknown>
    : null
  const binding = requireAttendancePunchDetailPlanBindingV1({
    orgId: job.orgId, actorId: job.actorId, actorPosture: job.actorPosture,
    tokenSubjectUserId: job.tokenSubjectUserId, batchId: job.batchId,
    envelope: descriptor?.envelope, batch: plan.manifest.batch,
    items: plan.items, recordWrites: plan.recordWrites, groupEffects: plan.groupEffects,
  })
  if (descriptor && !binding) mismatch()
  assertAttendancePunchDetailCanonicalBranchV1(binding, job.acceptedWritePosture, job.operationalBranch)
  if (binding && (job.legacyInputFingerprint !== binding.requestFingerprint
    || plan.manifest.legacyInputFingerprint !== binding.requestFingerprint)) mismatch()
  return binding
}
