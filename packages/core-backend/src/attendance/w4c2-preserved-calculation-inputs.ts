/**
 * Read-only preservation of immutable calculation inputs for OT and live punch.
 * This scope grants no operation authority; callers already own their target/row locks.
 * No policy/calendar reload or business writes belong here.
 */
import {
  computeAttendanceSemanticInputFingerprintV1,
  computeAttendanceProvenanceFingerprintV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  type AttendanceCalculationOutcomeReasonV1,
} from './w4c1-segment-calculator'
import {
  normalizeAttendanceAttributionSnapshotV1,
  normalizeAttendanceContextSnapshotV1,
} from './w4c3b-request-snapshots'
import {
  refuse, object, json, same, frozenCopy, iso, readFrozenRequest,
  bindingFromRequest, assertTerminalApproval, assertFactLink, mergeFrozen,
  buildBoundedApprovedOvertimeFactV1,
  type AttendanceApprovedInputReadScopeV1, type FrozenInput, type Row,
} from './w4c3b-approved-overtime-inputs'
import { applyFrozenManualOverrideSnapshotToDailyProjectionV1 } from './w4c3c-manual-override'
import type {
  AttendanceEvidenceV1, ApprovedAttendanceFactV1, ManualAttendanceOverrideV1,
} from './w4c0-write-boundary-types'

const HEX64 = /^[0-9a-f]{64}$/

export interface PreservedCalculationTargetV1 {
  readonly payload: Pick<FrozenInput['payload'], 'workDate'>
  readonly attribution: FrozenInput['attribution']
  readonly context: FrozenInput['context']
}

export interface PreservedInputs {
  readonly evidence: AttendanceEvidenceV1[]
  readonly approvedFacts: ApprovedAttendanceFactV1[]
  readonly manualOverride: ManualAttendanceOverrideV1 | null
  readonly priorCalculations: Array<{ id: string; semanticFingerprint: string; provenanceFingerprint: string }>
  readonly reviewReason: AttendanceCalculationOutcomeReasonV1 | null
}

export async function readPreservedAuthoritativeCalculationInputsV1(
  witness: AttendanceApprovedInputReadScopeV1,
  parent: Row,
  frozen: PreservedCalculationTargetV1,
  excludedRequestId: string | null,
  currentPunchRef: string | null = null,
  allowUnsupportedTarget = false,
): Promise<PreservedInputs> {
  const { rows } = await witness.trx.query(
    `SELECT c.id::text AS id, c.version, c.calculation_kind, c.outcome, c.entrypoint, c.outcome_reason_code,
            c.projection_effect, c.expected_segment_count, c.segment_snapshot,
            c.attribution_snapshot, c.context_snapshot, c.evidence_snapshot,
            c.approved_facts_snapshot, c.manual_override_snapshot, c.input_provenance,
            c.semantic_input_fingerprint, c.provenance_fingerprint, c.source_definition_fingerprint,
            c.merge_policy, c.calculation_tier, c.engine_version, c.snapshot_schema_version
       FROM attendance_record_calculations c
      WHERE c.org_id = $1 AND c.attendance_record_id = $2::uuid AND c.mode = 'authoritative'
        AND c.version >= (
          SELECT version FROM attendance_record_calculations
           WHERE id = $3::uuid AND org_id = $1 AND attendance_record_id = $2::uuid
        )
      ORDER BY c.version`,
    [witness.org.orgId, parent.id, parent.current_calculation_id],
  )
  if (rows.length === 0 || rows[0].id !== parent.current_calculation_id) {
    refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
  }
  const evidence: AttendanceEvidenceV1[] = []
  const approvedFacts: ApprovedAttendanceFactV1[] = []
  const priorCalculations: PreservedInputs['priorCalculations'] = []
  const manualOverride = json(rows[0].manual_override_snapshot) as ManualAttendanceOverrideV1 | null
  let reviewReason: AttendanceCalculationOutcomeReasonV1 | null = parent.timezone === frozen.context?.timezone
    ? null : 'context_mismatch'
  let previousVersion = 0
  for (const [index, row] of rows.entries()) {
    const attribution = normalizeAttendanceAttributionSnapshotV1(json(row.attribution_snapshot))
    const context = normalizeAttendanceContextSnapshotV1(json(row.context_snapshot))
    const priorEvidence = json(row.evidence_snapshot)
    const priorFacts = json(row.approved_facts_snapshot)
    const override = json(row.manual_override_snapshot)
    const provenance = object(json(row.input_provenance))
    const ref = object(provenance.provenance ?? provenance)
    // A live resolver-date mismatch is a durable review on the command's owned day,
    // never authority to complete or move that parent's pointer onto another day.
    const ownerDateReview = allowUnsupportedTarget && index > 0
      && row.entrypoint === 'live' && row.outcome_reason_code === 'context_mismatch'
      && attribution.posture === 'resolved_v2' && context !== null
      && attribution.value.workDate === context.workDate
      && attribution.value.shiftId === context.shiftId
    if (row.calculation_kind !== 'calculation'
      || row.engine_version !== ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1
      || row.snapshot_schema_version !== 1 || row.calculation_tier !== 'segment_authoritative'
      || !Number.isSafeInteger(row.version) || Number(row.version) <= previousVersion
      || (index === 0 ? row.outcome !== 'completed' || row.projection_effect !== 'set_active'
        : row.outcome !== 'review_required' || row.projection_effect !== 'none')
      || !Array.isArray(priorEvidence) || !Array.isArray(priorFacts) || !same(override, manualOverride)
      || ((index === 0 || !allowUnsupportedTarget) && (attribution.posture !== 'resolved_v2' || context === null))
      || (attribution.posture === 'resolved_v2' && (attribution.value.orgId !== witness.org.orgId
        || attribution.value.userId !== witness.subjectUserId || (!ownerDateReview && attribution.value.workDate !== frozen.payload.workDate)))
      || (context !== null && (context.orgId !== witness.org.orgId
        || context.userId !== witness.subjectUserId || (!ownerDateReview && context.workDate !== frozen.payload.workDate)))) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    previousVersion = Number(row.version)
    if (ownerDateReview) reviewReason = 'context_mismatch'
    const semantic = computeAttendanceSemanticInputFingerprintV1({
      attribution, context, evidence: priorEvidence, approvedFacts: priorFacts,
      manualOverride: override, mergePolicy: row.merge_policy, calculationTier: row.calculation_tier,
      engineVersion: row.engine_version, snapshotSchemaVersion: row.snapshot_schema_version,
    })
    const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1({
      transport: ref.transport, sourceRef: ref.sourceRef, artifactSha256: ref.artifactSha256,
      normalizedCsvSha256: ref.normalizedCsvSha256, convertedSheetName: ref.convertedSheetName,
    })
    if (semantic !== row.semantic_input_fingerprint || provenanceFingerprint !== row.provenance_fingerprint
      || computeAttendanceSourceDefinitionFingerprintV1({ attribution, context }) !== row.source_definition_fingerprint) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_FINGERPRINT_MISMATCH')
    }
    const children = await witness.trx.query(
      `SELECT segment_index FROM attendance_record_segments
        WHERE org_id = $1 AND record_id = $2::uuid AND calculation_id = $3::uuid ORDER BY segment_index`,
      [witness.org.orgId, parent.id, row.id],
    )
    const expectedSegments = index === 0 && context !== null ? context.segments : []
    const expected = expectedSegments.length
    if (row.expected_segment_count !== expected || children.rows.length !== expected
      || children.rows.some((child, i) => child.segment_index !== i)
      || !same(json(row.segment_snapshot), expectedSegments)) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    if (attribution.posture !== 'resolved_v2' || context === null || frozen.attribution.posture !== 'resolved_v2') {
      if (!allowUnsupportedTarget) refuse('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
      reviewReason = 'missing_frozen_context'
    } else if (!same(context, frozen.context) || attribution.value.shiftId !== frozen.attribution.value.shiftId
      || !same(attribution.value.absoluteWindow, frozen.attribution.value.absoluteWindow)
      || !same(attribution.value.attributionWindow, frozen.attribution.value.attributionWindow)) {
      reviewReason = 'context_mismatch'
    }
    mergeFrozen(evidence, priorEvidence as AttendanceEvidenceV1[], (item) => {
      if (typeof object(item).ref !== 'string') refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
      return item.ref
    })
    mergeFrozen(approvedFacts, priorFacts as ApprovedAttendanceFactV1[], (item) => {
      if (typeof object(item).requestId !== 'string') refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
      return item.kind + ':' + item.requestId
    })
    priorCalculations.push({ id: String(row.id), semanticFingerprint: semantic, provenanceFingerprint })
  }
  if (manualOverride !== null) {
    const override = object(manualOverride)
    if (override.actorPosture !== 'attendance_admin' || typeof override.editId !== 'string'
      || typeof override.reason !== 'string' || !HEX64.test(String(override.beforeFingerprint))) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    applyFrozenManualOverrideSnapshotToDailyProjectionV1({
      status: String(parent.status), firstInAt: parent.first_in_at as string | null,
      lastOutAt: parent.last_out_at as string | null, workMinutes: Number(parent.work_minutes),
      lateMinutes: Number(parent.late_minutes), earlyLeaveMinutes: Number(parent.early_leave_minutes),
    }, manualOverride)
  }
  if (excludedRequestId !== null && approvedFacts.some((fact) => fact.requestId === excludedRequestId)) {
    refuse('ATTENDANCE_OVERTIME_FACT_ALREADY_PRESENT')
  }
  // Reviews do not move the pointer. Reconcile any durable approved OT still
  // missing from current + review inputs using its real snapshot and binding.
  const active = await witness.trx.query(
    `SELECT r.id::text AS id, r.request_type FROM attendance_requests r
      WHERE r.org_id = $1 AND r.user_id = $2 AND r.status = 'approved' AND ($4::uuid IS NULL OR r.id <> $4::uuid)
        AND r.request_type IN ('overtime', 'leave', 'missed_check_in', 'missed_check_out',
                               'time_correction', 'outdoor_punch')
        AND (r.work_date = $3::date OR EXISTS (
          SELECT 1 FROM attendance_request_calculation_snapshots s
           WHERE s.org_id = r.org_id AND s.request_id = r.id AND s.payload->>'workDate' = $3::text
        ))
      ORDER BY r.id`,
    [witness.org.orgId, witness.subjectUserId, frozen.payload.workDate, excludedRequestId],
  )
  for (const row of active.rows) {
    if (approvedFacts.some((fact) => fact.requestId === row.id)) continue
    if (row.request_type !== 'overtime') refuse('ATTENDANCE_OVERTIME_NON_OT_FACT_RECOVERY_UNSUPPORTED')
    const recovered = await readFrozenRequest(witness, String(row.id), 'approved', false)
    const binding = bindingFromRequest(recovered.request)
    const fact = buildBoundedApprovedOvertimeFactV1(recovered.frozen, binding)
    if (recovered.frozen.payload.workDate !== frozen.payload.workDate) refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
    await assertTerminalApproval(witness, recovered.request, binding)
    mergeFrozen(approvedFacts, [fact], (item) => item.kind + ':' + item.requestId)
    if (!same(recovered.frozen.context, frozen.context)
      || recovered.frozen.attribution.posture !== 'resolved_v2' || frozen.attribution.posture !== 'resolved_v2'
      || !same(recovered.frozen.attribution.value.absoluteWindow, frozen.attribution.value.absoluteWindow)
      || !same(recovered.frozen.attribution.value.attributionWindow, frozen.attribution.value.attributionWindow)) {
      reviewReason = 'context_mismatch'
    }
  }
  for (const fact of approvedFacts) {
    const factReviewReason = await assertFactLink(witness, fact, frozen, allowUnsupportedTarget)
    if (factReviewReason !== null) reviewReason = factReviewReason
  }

  // Never map adjustment audit events into punch evidence. Inherited imports,
  // approved adjustments and scheduled evidence remain exactly as snapshotted.
  const eventEvidence = evidence.filter((item) => item.kind === 'punch'
    && (item.source === 'attendance_event' || item.source === 'outdoor_approval'))
  const events = await witness.trx.query(
    `SELECT id::text AS id, event_type, occurred_at, source, work_date::text AS work_date
       FROM attendance_events WHERE org_id = $1 AND user_id = $2
        AND (work_date = $3::date OR id::text = ANY($4::text[])) ORDER BY occurred_at, id`,
    [witness.org.orgId, witness.subjectUserId, frozen.payload.workDate, eventEvidence.map((item) => item.ref)],
  )
  for (const item of eventEvidence) {
    const event = events.rows.find((row) => row.id === item.ref)
    if (item.kind !== 'punch') continue
    if (!event || (event.event_type !== 'check_in' && event.event_type !== 'check_out')
      || event.event_type !== item.direction || iso(event.occurred_at) !== item.occurredAt
      || (event.source === 'outdoor_approval' ? 'outdoor_approval' : 'attendance_event') !== item.source) {
      reviewReason = 'frozen_evidence_unavailable'
    }
  }
  for (const event of events.rows) {
    if (event.work_date !== frozen.payload.workDate
      || (event.event_type !== 'check_in' && event.event_type !== 'check_out')
      || evidence.some((item) => item.ref === event.id)) continue
    // Retain a real punch omitted by the predecessor, but do not advertise the
    // incomplete predecessor as a complete reconstruction.
    evidence.push({
      kind: 'punch', ref: String(event.id), direction: event.event_type,
      occurredAt: iso(event.occurred_at) as string,
      source: event.source === 'outdoor_approval' ? 'outdoor_approval' : 'attendance_event',
    })
    if (event.id !== currentPunchRef) reviewReason = 'frozen_evidence_unavailable'
  }
  return frozenCopy({ evidence, approvedFacts, manualOverride, priorCalculations, reviewReason })
}
