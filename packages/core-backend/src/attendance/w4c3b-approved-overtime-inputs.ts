/**
 * EP01: validate creation-frozen overtime input before terminal approval DML.
 * Frozen source readers and pure validators; no current-policy or calendar fallback.
 */
import {
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  extractAttendanceRequestPayloadMetadataFieldsV1,
  normalizeAttendanceAttributionSnapshotV1,
  normalizeAttendanceContextSnapshotV1,
  W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY,
  normalizeAttendanceRequestCalculationPayloadV1,
  type AttendanceRequestCalculationPayloadV1,
  type AttendanceRequestCalculationSnapshotRowV1,
  type AttendanceRequestTerminalSnapshotBindingV1,
} from './w4c3b-request-snapshots'
import type { ApprovedAttendanceFactV1 } from './w4c0-write-boundary-types'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import type { AttendanceCalculationOutcomeReasonV1 } from './w4c1-segment-calculator'
import type { AttendanceRequestDecisionCalculationWitnessV1 } from './w4c3b-request-operation-boundary'

export type Row = Record<string, unknown>
export type FrozenInput = ReturnType<typeof validateApprovedOvertimeSnapshotInputV1>
export type AttendanceApprovedInputReadScopeV1 = Pick<
  AttendanceRequestDecisionCalculationWitnessV1, 'trx' | 'org' | 'subjectUserId'
> & Partial<Pick<AttendanceRequestDecisionCalculationWitnessV1, 'actorId'>>
type Witness = AttendanceApprovedInputReadScopeV1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64 = /^[0-9a-f]{64}$/

export class AttendanceApprovedOvertimeInputError extends Error {
  readonly httpStatus = 409
  constructor(readonly code: string) {
    super(code)
    this.name = 'AttendanceApprovedOvertimeInputError'
  }
}

export function refuse(code: string): never {
  throw new AttendanceApprovedOvertimeInputError(code)
}

export function object(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse('ATTENDANCE_OVERTIME_SOURCE_SHAPE_INVALID')
  }
  return value as Row
}

export function json(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    refuse('ATTENDANCE_OVERTIME_SOURCE_SHAPE_INVALID')
  }
}

export function same(a: unknown, b: unknown): boolean {
  return canonicalAttendanceJsonV1(a) === canonicalAttendanceJsonV1(b)
}

/** Clone first: caller and query rows never alias the recursively frozen plan. */
export function frozenCopy<T>(value: T): T {
  const clone = JSON.parse(canonicalAttendanceJsonV1(value)) as T
  function freeze(item: unknown): void {
    if (item === null || typeof item !== 'object') return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(clone)
  return clone
}

export function iso(value: unknown): string | null {
  if (value === null) return null
  if (!(value instanceof Date) && typeof value !== 'string') {
    refuse('ATTENDANCE_OVERTIME_SOURCE_SHAPE_INVALID')
  }
  const date = value instanceof Date ? value : new Date(value as string)
  if (!Number.isFinite(date.getTime())) refuse('ATTENDANCE_OVERTIME_SOURCE_SHAPE_INVALID')
  return date.toISOString()
}

export function validateApprovedOvertimeSnapshotInputV1(input: {
  readonly orgId: string
  readonly subjectUserId: string
  readonly request: Readonly<Record<string, unknown>>
  readonly snapshot: AttendanceRequestCalculationSnapshotRowV1
}) {
  const { request, snapshot, orgId, subjectUserId } = input
  if (request.org_id !== orgId || request.user_id !== subjectUserId
    || request.id !== snapshot.requestId || request.request_type !== 'overtime'
    || snapshot.orgId !== orgId || snapshot.subjectUserId !== subjectUserId
    || snapshot.requestType !== 'overtime'
    || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_IDENTITY_MISMATCH')
  }
  const payload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
    workDate: request.work_date,
    requestedInAt: request.requested_in_at,
    requestedOutAt: request.requested_out_at,
    reason: request.reason,
    ...extractAttendanceRequestPayloadMetadataFieldsV1(request.metadata),
  })
  if (computeAttendanceRequestPayloadFingerprintV1(snapshot.payload) !== snapshot.payloadFingerprint
    || computeAttendanceRequestPayloadFingerprintV1(payload) !== snapshot.payloadFingerprint) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH')
  }
  const attribution = normalizeAttendanceAttributionSnapshotV1(snapshot.attributionSnapshot)
  const context = normalizeAttendanceContextSnapshotV1(snapshot.contextSnapshot)
  if ((attribution.posture === 'resolved_v2' && (
    attribution.value.orgId !== orgId || attribution.value.userId !== subjectUserId
    || attribution.value.workDate !== payload.workDate))
    || (context !== null && (context.orgId !== orgId || context.userId !== subjectUserId
      || context.workDate !== payload.workDate
      || (attribution.posture === 'resolved_v2' && context.shiftId !== attribution.value.shiftId)))) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_CONTEXT_MISMATCH')
  }
  // The attribution window is kept verbatim; approval never manufactures a larger window.
  return Object.freeze({ snapshot, payload, attribution, context })
}

export function validateApprovedOvertimeFrozenInputV1(
  input: Parameters<typeof validateApprovedOvertimeSnapshotInputV1>[0],
) {
  const frozen = validateApprovedOvertimeSnapshotInputV1(input)
  if (frozen.attribution.posture !== 'resolved_v2' || frozen.context === null) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
  }
  return Object.freeze({ ...frozen, attribution: frozen.attribution, context: frozen.context })
}

export function buildBoundedApprovedOvertimeFactV1(
  frozen: FrozenInput,
  binding: AttendanceRequestTerminalSnapshotBindingV1,
): Extract<ApprovedAttendanceFactV1, { kind: 'overtime' }> {
  const { snapshot, payload } = frozen
  if (binding.schemaVersion !== 1 || binding.kind !== 'w4c3b_request_snapshot_terminal_binding'
    || binding.action !== 'approve' || binding.bindingPosture !== 'bound'
    || binding.orgId !== snapshot.orgId || binding.requestId !== snapshot.requestId
    || binding.subjectUserId !== snapshot.subjectUserId || binding.requestType !== 'overtime'
    || binding.requestSnapshotVersion !== snapshot.version
    || binding.requestSnapshotFingerprint !== snapshot.payloadFingerprint
    || !Number.isSafeInteger(binding.approvalVersion) || binding.approvalVersion < 1
    || !/^[1-9][0-9]*$/.test(binding.approvalRecordId)) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  }
  // DG-OT-01: the legacy helper name is retained for callers. A frozen
  // minute-only fact reports unknown origin honestly; it never supplies endpoints.
  validateBoundedOvertimeCoverageV1(payload, true)
  return Object.freeze({
    kind: 'overtime',
    requestId: snapshot.requestId,
    requestSnapshotVersion: snapshot.version,
    requestSnapshotFingerprint: snapshot.payloadFingerprint,
    approvalVersion: binding.approvalVersion,
    approvalRecordId: binding.approvalRecordId,
    coverage: payload.requestedInAt === null || payload.requestedOutAt === null
      ? Object.freeze({
        kind: 'minutes_only_unbounded',
        minutes: payload.minutes!,
        source: 'request_snapshot_unattributed',
      })
      : Object.freeze({
        kind: 'bounded_interval',
        startAt: payload.requestedInAt,
        endAt: payload.requestedOutAt,
        minutes: payload.minutes!,
      }),
  })
}

export async function readOvertimeRequestSource(
  witness: Witness, requestId: string, status: 'pending' | 'approved', lockDecision: boolean,
  requireResolved = false,
): Promise<{ request: Row; payload: AttendanceRequestCalculationPayloadV1; frozen: FrozenInput | null }> {
  if (!UUID.test(requestId)) refuse('ATTENDANCE_OVERTIME_REQUEST_ID_INVALID')
  const requests = await witness.trx.query(
    `SELECT id::text AS id, org_id, user_id, request_type, status,
            work_date::text AS work_date, requested_in_at, requested_out_at,
            reason, metadata, approval_instance_id::text AS approval_instance_id
       FROM attendance_requests
      WHERE id = $1::uuid AND org_id = $2 AND user_id = $3
      ${lockDecision ? 'FOR UPDATE' : ''}`,
    [requestId, witness.org.orgId, witness.subjectUserId],
  )
  if (requests.rows.length !== 1 || requests.rows[0].status !== status) {
    refuse('ATTENDANCE_OVERTIME_REQUEST_STATE_MISMATCH')
  }
  const request = requests.rows[0]
  if (request.id !== requestId || request.org_id !== witness.org.orgId
    || request.user_id !== witness.subjectUserId || request.request_type !== 'overtime') {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_IDENTITY_MISMATCH')
  }
  const payload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
    workDate: request.work_date, requestedInAt: request.requested_in_at,
    requestedOutAt: request.requested_out_at, reason: request.reason,
    ...extractAttendanceRequestPayloadMetadataFieldsV1(request.metadata),
  })
  const snapshots = await witness.trx.query(
    `SELECT org_id, request_id::text AS request_id, version, request_type,
            subject_user_id, payload, payload_fingerprint,
            attribution_snapshot, context_snapshot, created_by
       FROM attendance_request_calculation_snapshots
      WHERE org_id = $1 AND request_id = $2::uuid
      ORDER BY version DESC LIMIT 1
      ${lockDecision ? 'FOR UPDATE' : ''}`,
    [witness.org.orgId, requestId],
  )
  if (snapshots.rows.length === 0) {
    if (requireResolved) refuse('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
    return { request, payload, frozen: null }
  }
  const row = snapshots.rows[0]
  if (row.request_type !== 'overtime' || !HEX64.test(String(row.payload_fingerprint))) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_IDENTITY_MISMATCH')
  }
  const validate = requireResolved ? validateApprovedOvertimeFrozenInputV1 : validateApprovedOvertimeSnapshotInputV1
  const frozen = validate({
    orgId: witness.org.orgId, subjectUserId: witness.subjectUserId, request,
    snapshot: {
      orgId: String(row.org_id), requestId: String(row.request_id), version: Number(row.version),
      requestType: 'overtime', subjectUserId: String(row.subject_user_id),
      payload: normalizeAttendanceRequestCalculationPayloadV1(json(row.payload)),
      payloadFingerprint: String(row.payload_fingerprint),
      attributionSnapshot: normalizeAttendanceAttributionSnapshotV1(json(row.attribution_snapshot)),
      contextSnapshot: normalizeAttendanceContextSnapshotV1(json(row.context_snapshot)),
      createdBy: String(row.created_by),
    },
  })
  validateBoundedOvertimeCoverageV1(frozen.payload, true)
  return { request, payload, frozen: frozenCopy(frozen) }
}

export function validateBoundedOvertimeCoverageV1(
  payload: AttendanceRequestCalculationPayloadV1, allowSnapshotUnattributed = false,
): void {
  if (payload.minutes === null || !Number.isSafeInteger(payload.minutes) || payload.minutes < 0) {
    refuse('ATTENDANCE_OVERTIME_COVERAGE_INVALID')
  }
  if (payload.requestedInAt === null || payload.requestedOutAt === null) {
    if (allowSnapshotUnattributed) return
    refuse('ATTENDANCE_OVERTIME_MINUTES_PROVENANCE_UNRESOLVED')
  }
  if (Date.parse(payload.requestedInAt) >= Date.parse(payload.requestedOutAt)) {
    refuse('ATTENDANCE_OVERTIME_COVERAGE_INVALID')
  }
}

export async function readFrozenRequest(
  witness: Witness, requestId: string, status: 'pending' | 'approved', lockDecision: boolean,
): Promise<{ request: Row; frozen: FrozenInput }> {
  const source = await readOvertimeRequestSource(witness, requestId, status, lockDecision, true)
  if (source.frozen === null) refuse('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
  const frozen = validateApprovedOvertimeFrozenInputV1({
    orgId: witness.org.orgId, subjectUserId: witness.subjectUserId,
    request: source.request, snapshot: source.frozen.snapshot,
  })
  return { request: source.request, frozen: frozenCopy(frozen) }
}

export function bindingFromRequest(request: Row): AttendanceRequestTerminalSnapshotBindingV1 {
  const metadata = object(json(request.metadata))
  return object(metadata[W4C3B_REQUEST_SNAPSHOT_TERMINAL_BINDING_META_KEY]) as unknown as
    AttendanceRequestTerminalSnapshotBindingV1
}

export async function assertTerminalApproval(
  witness: Witness, request: Row, binding: AttendanceRequestTerminalSnapshotBindingV1, previousVersion?: number,
): Promise<void> {
  if (!same(bindingFromRequest(request), binding) || !/^[1-9][0-9]*$/.test(binding.approvalRecordId)
    || !Number.isSafeInteger(binding.approvalVersion) || binding.approvalVersion < 1
    || (previousVersion !== undefined && binding.approvalVersion !== previousVersion + 1)) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  }
  const result = await witness.trx.query(
    `SELECT ar.id::text AS id, ar.actor_id, ar.from_version
       FROM approval_records ar JOIN approval_instances ai ON ai.id = ar.instance_id
      WHERE ar.id = $1::bigint AND ar.instance_id = $2
        AND ar.action = 'approve' AND ar.to_status = 'approved' AND ar.to_version = $3
        AND ai.status = 'approved' AND ai.version = $3`,
    [binding.approvalRecordId, request.approval_instance_id, binding.approvalVersion],
  )
  if (result.rows.length !== 1 || (previousVersion !== undefined && (
    Number(result.rows[0].from_version) !== previousVersion || result.rows[0].actor_id !== witness.actorId
  ))) refuse('ATTENDANCE_OVERTIME_TERMINAL_APPROVAL_MISMATCH')
}

/** Link inherited facts to immutable snapshots and real terminal approval rows. */
export async function assertFactLink(
  witness: Witness, fact: ApprovedAttendanceFactV1,
  frozen: {
    readonly payload: Pick<FrozenInput['payload'], 'workDate'>
    readonly attribution: FrozenInput['attribution']
    readonly context: FrozenInput['context']
  }, allowUnsupported = false,
): Promise<AttendanceCalculationOutcomeReasonV1 | null> {
  const workDate = frozen.payload.workDate
  if (fact.kind === 'reversal') refuse('ATTENDANCE_OVERTIME_REVERSAL_RECOVERY_UNSUPPORTED')
  if (!UUID.test(fact.requestId) || !/^[1-9][0-9]*$/.test(fact.approvalRecordId)
    || !HEX64.test(fact.requestSnapshotFingerprint)
    || !Number.isSafeInteger(fact.requestSnapshotVersion) || fact.requestSnapshotVersion < 1
    || !Number.isSafeInteger(fact.approvalVersion) || fact.approvalVersion < 1) {
    refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
  }
  const result = await witness.trx.query(
    `SELECT r.id::text AS id, r.request_type, r.status, r.metadata,
            r.approval_instance_id::text AS approval_instance_id,
            s.payload, s.payload_fingerprint, s.subject_user_id, s.request_type AS snapshot_type,
             s.attribution_snapshot, s.context_snapshot
       FROM attendance_requests r
       JOIN attendance_request_calculation_snapshots s
         ON s.org_id = r.org_id AND s.request_id = r.id AND s.version = $4
      WHERE r.org_id = $1 AND r.user_id = $2 AND r.id = $3::uuid`,
    [witness.org.orgId, witness.subjectUserId, fact.requestId, fact.requestSnapshotVersion],
  )
  if (result.rows.length !== 1) refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
  const request = result.rows[0]
  const payload = normalizeAttendanceRequestCalculationPayloadV1(json(request.payload))
  const kindMatches = fact.kind === 'correction'
    ? ['missed_check_in', 'missed_check_out', 'time_correction'].includes(String(request.request_type))
    : request.request_type === fact.kind
  const binding = bindingFromRequest(request)
  if (request.status !== 'approved' || !kindMatches
    || request.snapshot_type !== request.request_type || request.subject_user_id !== witness.subjectUserId
    || payload.workDate !== workDate || request.payload_fingerprint !== fact.requestSnapshotFingerprint
    || computeAttendanceRequestPayloadFingerprintV1(payload) !== fact.requestSnapshotFingerprint
    || binding.schemaVersion !== 1 || binding.kind !== 'w4c3b_request_snapshot_terminal_binding'
    || binding.bindingPosture !== 'bound' || binding.action !== 'approve'
    || binding.orgId !== witness.org.orgId || binding.subjectUserId !== witness.subjectUserId
    || binding.requestType !== request.request_type || binding.requestId !== fact.requestId
    || binding.requestSnapshotVersion !== fact.requestSnapshotVersion
    || binding.requestSnapshotFingerprint !== fact.requestSnapshotFingerprint
    || binding.approvalVersion !== fact.approvalVersion || binding.approvalRecordId !== fact.approvalRecordId) {
    refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
  }
  await assertTerminalApproval(witness, request, binding)
  if (fact.kind === 'overtime' || fact.kind === 'leave') {
    object(fact.coverage)
    if (fact.kind === 'overtime' && fact.coverage.kind !== 'bounded_interval'
      && (fact.coverage.kind !== 'minutes_only_unbounded'
        || fact.coverage.source !== 'request_snapshot_unattributed'
        || (payload.requestedInAt !== null && payload.requestedOutAt !== null))) {
      refuse('ATTENDANCE_OVERTIME_MINUTES_PROVENANCE_UNRESOLVED')
    }
    if (fact.coverage.minutes !== payload.minutes
      || (fact.kind === 'leave' && fact.leaveType !== payload.leaveTypeCode)) {
      refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
    }
    if (fact.coverage.kind === 'bounded_interval') {
      if (fact.coverage.startAt !== payload.requestedInAt || fact.coverage.endAt !== payload.requestedOutAt) {
        refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
      }
    } else if (fact.coverage.kind !== 'minutes_only_unbounded'
      || (fact.coverage.source !== 'explicit_minutes' && fact.coverage.source !== 'policy_default'
        && !(fact.kind === 'overtime' && fact.coverage.source === 'request_snapshot_unattributed'))) {
      refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
    }
  } else if (fact.kind === 'outdoor_punch') {
    if (payload.outdoorPunch?.eventType !== fact.direction
      || payload.outdoorPunch.occurredAt !== fact.occurredAt) {
      refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
    }
  } else if (fact.kind === 'correction') {
    if ((fact.direction !== 'check_in' && fact.direction !== 'check_out')
      || fact.occurredAt !== (fact.direction === 'check_in' ? payload.requestedInAt : payload.requestedOutAt)) {
      refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
    }
  } else {
    refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
  }
  if (fact.kind === 'overtime') {
    // Revalidate the exact bound snapshot even when a prior review already
    // carries the fact; the review's own context does not replace its origin.
    const attribution = normalizeAttendanceAttributionSnapshotV1(json(request.attribution_snapshot))
    const context = normalizeAttendanceContextSnapshotV1(json(request.context_snapshot))
    if ((attribution.posture === 'resolved_v2' && (
      attribution.value.orgId !== witness.org.orgId || attribution.value.userId !== witness.subjectUserId
      || attribution.value.workDate !== workDate))
      || (context !== null && (context.orgId !== witness.org.orgId
        || context.userId !== witness.subjectUserId || context.workDate !== workDate
        || (attribution.posture === 'resolved_v2' && context.shiftId !== attribution.value.shiftId)))) {
      refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
    }
    if (attribution.posture !== 'resolved_v2' || context === null
      || frozen.attribution.posture !== 'resolved_v2') {
      if (allowUnsupported) return 'missing_frozen_context'
      refuse('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
    }
    if (!same(context, frozen.context)
      || attribution.value.shiftId !== frozen.attribution.value.shiftId
      || !same(attribution.value.absoluteWindow, frozen.attribution.value.absoluteWindow)
      || !same(attribution.value.attributionWindow, frozen.attribution.value.attributionWindow)) {
      return 'context_mismatch'
    }
  }
  return null
}

export function mergeFrozen<T>(target: T[], incoming: readonly T[], key: (item: T) => string): void {
  for (const item of incoming) {
    const existing = target.find((candidate) => key(candidate) === key(item))
    if (existing !== undefined && !same(existing, item)) refuse('ATTENDANCE_OVERTIME_PRIOR_INPUT_CONFLICT')
    if (existing === undefined) target.push(item)
  }
}


/** Unsupported sentinel is binding provenance only; never an approved-fact identity. */
export function validateMissingApprovedOvertimeBindingV1(
  request: Row, binding: AttendanceRequestTerminalSnapshotBindingV1,
): void {
  if (binding.schemaVersion !== 1 || binding.kind !== 'w4c3b_request_snapshot_terminal_binding'
    || binding.action !== 'approve' || binding.bindingPosture !== 'unsupported_pre_w4_shadow'
    || binding.orgId !== request.org_id || binding.subjectUserId !== request.user_id
    || binding.requestId !== request.id || binding.requestType !== 'overtime'
    || binding.requestSnapshotVersion !== 0 || binding.requestSnapshotFingerprint !== '0'.repeat(64)
    || !Number.isSafeInteger(binding.approvalVersion) || binding.approvalVersion < 1
    || !/^[1-9][0-9]*$/.test(binding.approvalRecordId)) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  }
}
