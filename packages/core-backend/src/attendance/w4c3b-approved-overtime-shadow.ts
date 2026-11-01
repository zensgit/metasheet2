/**
 * OT shadow input recovery and comparison. Owns no terminal/legacy projection
 * DML: the core's one-use preparation surrounds the plugin's existing upsert.
 */
import {
  acquireAttendanceCalculationTargetLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
} from './w4c0-identity'
import {
  computeAttendanceCommandFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
  computeAttendanceProvenanceFingerprintV1,
  type AttendanceInputProvenanceRefV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  ATTENDANCE_CALCULATION_OUTCOME_REASONS_V1,
  calculateAttendanceSegmentsV1,
  type AttendanceCalculationOutcomeReasonV1,
} from './w4c1-segment-calculator'
import { insertShadowCalculationV1 } from './w4c2-shadow-calculation-core'
import {
  buildUnsupportedRequestAttributionSnapshotV1,
  normalizeAttendanceAttributionSnapshotV1,
  normalizeAttendanceContextSnapshotV1,
  type AttendanceRequestTerminalBindResultV1,
} from './w4c3b-request-snapshots'
import {
  refuse, object, json, same, frozenCopy, iso, readOvertimeRequestSource,
  bindingFromRequest, assertTerminalApproval, assertFactLink, mergeFrozen,
  buildBoundedApprovedOvertimeFactV1, validateMissingApprovedOvertimeBindingV1,
  type Row,
} from './w4c3b-approved-overtime-inputs'
import {
  requireAttendanceRequestDecisionCalculationWitnessV1,
  recordAttendanceRequestDecisionCalculationResultV1,
  type AttendanceRequestDecisionCalculationWitnessV1 as Witness,
  type AttendanceRequestOperationContextV1,
  type AttendanceRequestPluginTrxV1,
} from './w4c3b-request-operation-boundary'
import { applyFrozenManualOverrideSnapshotToDailyProjectionV1 } from './w4c3c-manual-override'
import { ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1 } from './w7-compare-window-status'
import type {
  ApprovedAttendanceFactV1, AttendanceEvidenceV1, ManualAttendanceOverrideV1,
  PreparedDailyProjectionV1,
} from './w4c0-write-boundary-types'
import type { ApprovedOvertimePreTerminalSnapshotV1 } from './w4c3b-approved-overtime'

type Source = Awaited<ReturnType<typeof readOvertimeRequestSource>>
type FrozenSource = Pick<Source, 'payload' | 'frozen'>
type Bound = Exclude<AttendanceRequestTerminalBindResultV1, { kind: 'legacy_skipped' }>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64 = /^[0-9a-f]{64}$/

interface ShadowInputs {
  evidence: AttendanceEvidenceV1[]
  approvedFacts: ApprovedAttendanceFactV1[]
  manualOverride: ManualAttendanceOverrideV1 | null
  priorCalculations: Array<{ id: string; semanticFingerprint: string; provenanceFingerprint: string }>
  unresolvedRequestIds: string[]
  sourcePreimageFingerprint: string
  reviewReason: AttendanceCalculationOutcomeReasonV1 | null
}

export interface PreparedOvertimeShadowV1 {
  readonly kind: 'shadow_bound' | 'shadow_unsupported_frozen' | 'shadow_missing_request_snapshot'
  readonly requestId: string
  readonly source: FrozenSource
  readonly approvalInstanceId: string
  readonly approvalVersion: number
  readonly parent: Row | null
  readonly inputs: ShadowInputs
}

async function readShadowParent(witness: Witness, workDate: string): Promise<Row | null> {
  const { rows } = await witness.trx.query(
    `SELECT id::text AS id, org_id, user_id, work_date::text AS work_date,
            current_calculation_id::text AS current_calculation_id,
            projection_owner, visibility_state, visibility_reason, timezone, is_workday,
            status, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes,
            meta, source_batch_id::text AS source_batch_id
       FROM attendance_records
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date FOR UPDATE`,
    [witness.org.orgId, witness.subjectUserId, workDate],
  )
  if (rows.length === 0) return null
  if (rows.length !== 1) refuse('ATTENDANCE_OVERTIME_PARENT_AMBIGUOUS')
  const row = rows[0]
  if (row.visibility_state !== 'active' || row.visibility_reason !== 'active') {
    refuse('ATTENDANCE_OVERTIME_RETIRED_PARENT')
  }
  if (row.projection_owner !== 'legacy_untracked' || row.current_calculation_id !== null) {
    refuse('ATTENDANCE_OVERTIME_SHADOW_PARENT_OWNERSHIP_MISMATCH')
  }
  if (typeof row.id !== 'string' || !UUID.test(row.id)
    || row.org_id !== witness.org.orgId || row.user_id !== witness.subjectUserId || row.work_date !== workDate
    || typeof row.timezone !== 'string' || typeof row.status !== 'string' || typeof row.is_workday !== 'boolean'
    || ['work_minutes', 'late_minutes', 'early_leave_minutes']
      .some((field) => !Number.isSafeInteger(row[field]) || Number(row[field]) < 0)) {
    refuse('ATTENDANCE_OVERTIME_SOURCE_SHAPE_INVALID')
  }
  return frozenCopy({
    ...row, meta: json(row.meta), first_in_at: iso(row.first_in_at), last_out_at: iso(row.last_out_at),
  })
}

function sourceContext(source: FrozenSource) {
  return {
    payload: source.payload,
    attribution: source.frozen?.attribution ?? buildUnsupportedRequestAttributionSnapshotV1('missing', null),
    context: source.frozen?.context ?? null,
  }
}

function validateEvidence(evidence: unknown): asserts evidence is AttendanceEvidenceV1[] {
  if (!Array.isArray(evidence)) refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
  for (const item of evidence) {
    const row = object(item)
    const keys = row.kind === 'scheduled_absence' ? ['kind', 'ref']
      : ['kind', 'ref', 'direction', 'occurredAt', 'source']
    if (!same(Object.keys(row).sort(), keys.sort()) || typeof row.ref !== 'string' || row.ref.length === 0
      || !['punch', 'approved_adjustment', 'scheduled_absence'].includes(String(row.kind))) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    if (row.kind !== 'scheduled_absence' && (
      (row.direction !== 'check_in' && row.direction !== 'check_out')
      || typeof row.occurredAt !== 'string' || iso(row.occurredAt) !== row.occurredAt
      || (row.kind === 'punch'
        ? !['attendance_event', 'outdoor_approval', 'import'].includes(String(row.source))
        : row.source !== 'correction'))) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
  }
}

/**
 * Immutable history is read in version order under the target lock; mutable
 * sources are re-read in the same SERIALIZABLE execution before insertion.
 * Never lock another approval's request after holding this daily target.
 */
export async function readNonCurrentApprovedOvertimeInputsV1(
  witness: Witness, parent: Row | null, source: FrozenSource, requestId: string,
): Promise<ShadowInputs> {
  const frozen = sourceContext(source)
  const workDate = source.payload.workDate
  const history = parent === null ? { rows: [] as Row[] } : await witness.trx.query(
    `SELECT c.id::text AS id, c.version, c.mode, c.operation_id::text AS operation_id,
            c.entrypoint, c.calculation_kind, c.outcome, c.outcome_reason_code,
            c.projection_effect, c.expected_segment_count, c.segment_snapshot,
            c.attribution_snapshot, c.context_snapshot, c.evidence_snapshot,
            c.approved_facts_snapshot, c.manual_override_snapshot, c.input_provenance,
            c.semantic_input_fingerprint, c.provenance_fingerprint, c.source_definition_fingerprint,
            c.merge_policy, c.calculation_tier, c.engine_version, c.snapshot_schema_version
       FROM attendance_record_calculations c
      WHERE c.org_id = $1 AND c.attendance_record_id = $2::uuid ORDER BY c.version`,
    [witness.org.orgId, parent.id],
  )
  const ordinary = history.rows.filter((row) => {
    if (row.mode !== 'shadow' && row.mode !== 'authoritative') {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    const provenance = object(json(row.input_provenance))
    if (row.operation_id === null) {
      if (row.mode !== 'shadow' || !Object.prototype.hasOwnProperty.call(provenance, ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1)) {
        refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
      }
      return false // W7 auxiliary comparison is never an input authority.
    }
    // A hidden authoritative review has no current projection. Its frozen
    // evidence/facts still belong to this day and must survive the next decision.
    if (row.mode === 'authoritative' && witness.org.acceptedWritePosture === 'authoritative') {
      if (row.outcome !== 'review_required' || row.projection_effect !== 'none') {
        refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
      }
      return true
    }
    return row.mode === 'shadow'
  })
  // Restrict first completion to a complete ordinary live-review cohort.
  // Mixed/shadow histories retain their existing conservative recovery behavior.
  const revalidatableLiveHistory = ordinary.length > 0 && ordinary.every((row) =>
    row.mode === 'authoritative' && row.entrypoint === 'live'
    && row.calculation_kind === 'calculation' && row.outcome === 'review_required'
    && row.outcome_reason_code === 'context_mismatch' && row.projection_effect === 'none')
  const completedRows = ordinary.filter((row) => row.outcome === 'completed')
  const latestCompleted = completedRows[completedRows.length - 1]
  const selected = ordinary.filter((row) => !latestCompleted || Number(row.version) >= Number(latestCompleted.version))
  const evidence: AttendanceEvidenceV1[] = []
  const approvedFacts: ApprovedAttendanceFactV1[] = []
  const priorCalculations: ShadowInputs['priorCalculations'] = []
  const unresolvedRequestIds = new Set<string>()
  let manualOverride: ManualAttendanceOverrideV1 | null = null
  let reviewReason: ShadowInputs['reviewReason'] = parent !== null && parent.visibility_state === 'active' && !latestCompleted
    ? 'frozen_evidence_unavailable' : null
  if (witness.org.acceptedWritePosture === 'shadow'
    && history.rows.some((row) => row.mode === 'authoritative')) reviewReason = 'frozen_evidence_unavailable'
  const childPreimages: Row[][] = []
  let previousVersion = 0
  for (const row of selected) {
    const attribution = normalizeAttendanceAttributionSnapshotV1(json(row.attribution_snapshot))
    const context = normalizeAttendanceContextSnapshotV1(json(row.context_snapshot))
    const priorEvidence = json(row.evidence_snapshot)
    const priorFacts = json(row.approved_facts_snapshot)
    const override = json(row.manual_override_snapshot) as ManualAttendanceOverrideV1 | null
    const provenance = object(json(row.input_provenance))
    const ref = object(provenance.provenance ?? provenance)
    if (!UUID.test(String(row.id)) || !UUID.test(String(row.operation_id))
      || !Number.isSafeInteger(row.version) || Number(row.version) <= previousVersion
      || row.calculation_kind !== 'calculation'
      || row.calculation_tier !== (row.mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow')
      || row.engine_version !== ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 || row.snapshot_schema_version !== 1
      || !['append', 'merge', 'override'].includes(String(row.merge_policy))
      || !['completed', 'review_required'].includes(String(row.outcome)) || row.projection_effect !== 'none'
      || !(ATTENDANCE_CALCULATION_OUTCOME_REASONS_V1 as readonly unknown[]).includes(row.outcome_reason_code)
      || !Array.isArray(priorFacts)
      || (attribution.posture === 'resolved_v2' && (attribution.value.orgId !== witness.org.orgId
        || attribution.value.userId !== witness.subjectUserId || attribution.value.workDate !== workDate))
      || (context !== null && (context.orgId !== witness.org.orgId || context.userId !== witness.subjectUserId
        || context.workDate !== workDate
        || (attribution.posture === 'resolved_v2' && context.shiftId !== attribution.value.shiftId)))) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    validateEvidence(priorEvidence)
    previousVersion = Number(row.version)
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
      [witness.org.orgId, parent!.id, row.id],
    )
    childPreimages.push(children.rows)
    const completed = row.outcome === 'completed'
    const expected = completed && context !== null ? context.segments.length : 0
    if ((completed && (attribution.posture !== 'resolved_v2' || context === null))
      || row.expected_segment_count !== expected || children.rows.length !== expected
      || children.rows.some((child, i) => child.segment_index !== i)
      // Existing live/scheduled reviews retain their frozen segment definition
      // even though they have no children; OT reviews persist an empty snapshot.
      || (completed ? !same(json(row.segment_snapshot), context!.segments)
        : !same(json(row.segment_snapshot), [])
          && (context === null || !same(json(row.segment_snapshot), context.segments)))) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    if (priorCalculations.length === 0) manualOverride = override
    else if (!same(manualOverride, override)) refuse('ATTENDANCE_OVERTIME_PRIOR_INPUT_CONFLICT')
    mergeFrozen(evidence, priorEvidence, (item) => item.ref)
    mergeFrozen(approvedFacts, priorFacts as ApprovedAttendanceFactV1[], (item) => item.kind + ':' + item.requestId)
    priorCalculations.push({ id: String(row.id), semanticFingerprint: semantic, provenanceFingerprint })
    if (attribution.posture !== 'resolved_v2' || context === null) reviewReason = 'frozen_evidence_unavailable'
    else if (!same(context, frozen.context) || frozen.attribution.posture !== 'resolved_v2'
      || !same(attribution.value.absoluteWindow, frozen.attribution.value.absoluteWindow)
      || !same(attribution.value.attributionWindow, frozen.attribution.value.attributionWindow)) {
      reviewReason = 'context_mismatch'
    }
    // A later command may revalidate a historical live identity-drift review
    // against the exact same frozen definition. It grants no authority to
    // reinterpret another context, recover missing inputs or reactivate an ops retirement.
    const revalidatedLiveContextReview = revalidatableLiveHistory
      && witness.org.acceptedWritePosture === 'authoritative'
      && parent?.visibility_state === 'retired' && parent.visibility_reason === 'review_placeholder'
      && parent.current_calculation_id === null && row.mode === 'authoritative'
      && row.entrypoint === 'live' && row.outcome_reason_code === 'context_mismatch'
      && attribution.posture === 'resolved_v2' && context !== null
      && frozen.attribution.posture === 'resolved_v2' && same(context, frozen.context)
      && same(attribution.value.absoluteWindow, frozen.attribution.value.absoluteWindow)
      && same(attribution.value.attributionWindow, frozen.attribution.value.attributionWindow)
    // Review does not prove completeness just because its facts happen to be empty.
    if (row.outcome === 'review_required' && !revalidatedLiveContextReview
      && ['frozen_evidence_unavailable', 'missing_frozen_context', 'context_mismatch',
        'legacy_attribution_not_upgradeable', 'input_schema_invalid'].includes(String(row.outcome_reason_code))) {
      reviewReason = row.outcome_reason_code as AttendanceCalculationOutcomeReasonV1
    }
    if (provenance.overtimeShadow !== undefined) {
      const marker = object(provenance.overtimeShadow)
      if (marker.schemaVersion !== 1 || !Array.isArray(marker.unresolvedRequestIds)
        || marker.unresolvedRequestIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
        refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
      }
      for (const id of marker.unresolvedRequestIds) unresolvedRequestIds.add(id as string)
    }
  }
  if (manualOverride !== null) {
    if (manualOverride.actorPosture !== 'attendance_admin' || (typeof manualOverride.editId !== 'string' || !UUID.test(manualOverride.editId))
      || typeof manualOverride.reason !== 'string' || !HEX64.test(manualOverride.beforeFingerprint)) {
      refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
    }
    applyFrozenManualOverrideSnapshotToDailyProjectionV1({
      status: 'normal', firstInAt: null, lastOutAt: null,
      workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null,
    }, manualOverride)
  }
  const active = await witness.trx.query(
    `SELECT r.id::text AS id, r.request_type FROM attendance_requests r
      WHERE r.org_id = $1 AND r.user_id = $2 AND r.status = 'approved' AND r.id <> $4::uuid
        AND r.request_type IN ('overtime', 'leave', 'missed_check_in', 'missed_check_out',
                               'time_correction', 'outdoor_punch')
        AND (r.work_date = $3::date OR EXISTS (
          SELECT 1 FROM attendance_request_calculation_snapshots s
           WHERE s.org_id = r.org_id AND s.request_id = r.id AND s.payload->>'workDate' = $3::text
        )) ORDER BY r.id`,
    [witness.org.orgId, witness.subjectUserId, workDate, requestId],
  )
  const recoveredSources: unknown[] = []
  for (const row of active.rows) {
    if (approvedFacts.some((fact) => fact.requestId === row.id)) continue
    if (row.request_type !== 'overtime') {
      unresolvedRequestIds.add(String(row.id))
      continue
    }
    const recovered = await readOvertimeRequestSource(witness, String(row.id), 'approved', false)
    if (recovered.payload.workDate !== workDate) refuse('ATTENDANCE_OVERTIME_FACT_LINK_INVALID')
    recoveredSources.push({ payload: recovered.payload, frozen: recovered.frozen })
    if (recovered.frozen === null) {
      unresolvedRequestIds.add(String(row.id))
      continue
    }
    const binding = bindingFromRequest(recovered.request)
    const fact = buildBoundedApprovedOvertimeFactV1(recovered.frozen, binding)
    await assertTerminalApproval(witness, recovered.request, binding)
    mergeFrozen(approvedFacts, [fact], (item) => item.kind + ':' + item.requestId)
  }
  if (approvedFacts.some((fact) => fact.requestId === requestId)) refuse('ATTENDANCE_OVERTIME_FACT_ALREADY_PRESENT')
  for (const fact of approvedFacts) {
    const reason = await assertFactLink(witness, fact, frozen, true)
    if (reason !== null) reviewReason = reason
  }
  const events = await witness.trx.query(
    `SELECT id::text AS id, event_type, occurred_at, source, work_date::text AS work_date, meta
       FROM attendance_events WHERE org_id = $1 AND user_id = $2
        AND (work_date = $3::date OR id::text = ANY($5::text[]))
        AND NOT (event_type = 'adjustment' AND COALESCE(meta->>'requestId', '') = $4)
      ORDER BY occurred_at, id`,
    [witness.org.orgId, witness.subjectUserId, workDate, requestId,
      evidence.filter((item) => item.kind === 'punch' && item.source !== 'import').map((item) => item.ref)],
  )
  const eventPreimage: Row[] = events.rows.map((row) => ({ ...row, occurred_at: iso(row.occurred_at) }))
  for (const item of evidence) {
    if (item.kind !== 'punch' || item.source === 'import') continue
    const event = eventPreimage.find((row) => row.id === item.ref)
    if (!event || event.event_type !== item.direction || event.occurred_at !== item.occurredAt
      || (event.source === 'outdoor_approval' ? 'outdoor_approval' : 'attendance_event') !== item.source) {
      reviewReason = 'frozen_evidence_unavailable'
    }
  }
  for (const event of eventPreimage) {
    if (event.work_date !== workDate) continue
    if (event.event_type === 'check_in' || event.event_type === 'check_out') {
      if (!evidence.some((item) => item.ref === event.id)) {
        evidence.push({
          kind: 'punch', ref: String(event.id), direction: event.event_type,
          occurredAt: event.occurred_at as string,
          source: event.source === 'outdoor_approval' ? 'outdoor_approval' : 'attendance_event',
        })
        if (latestCompleted) reviewReason = 'frozen_evidence_unavailable'
      }
    } else if (event.event_type === 'adjustment') {
      const requestRef = event.meta === null ? null : object(json(event.meta)).requestId
      if (!approvedFacts.some((fact) => fact.requestId === requestRef)) reviewReason = 'frozen_evidence_unavailable'
    } else {
      reviewReason = 'frozen_evidence_unavailable'
    }
  }
  // These durable ledgers prove absence of otherwise invisible import/manual
  // inputs; matching daily endpoints alone is deliberately insufficient.
  const imports = await witness.trx.query(
    `SELECT id::text AS id, batch_id::text AS batch_id, record_id::text AS record_id, preview_snapshot
       FROM attendance_import_items
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date ORDER BY id`,
    [witness.org.orgId, witness.subjectUserId, workDate],
  )
  const edits = await witness.trx.query(
    `SELECT id::text AS id, record_id::text AS record_id, before_snapshot, after_snapshot, reason,
            idempotency_key, actor_user_id, evidence, before_status, after_status
       FROM attendance_record_result_edits
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date ORDER BY created_at, id`,
    [witness.org.orgId, witness.subjectUserId, workDate],
  )
  if (imports.rows.length > 0 || parent?.source_batch_id != null
    || evidence.some((item) => item.kind === 'punch' && item.source === 'import')) {
    // Preserve verified frozen imports, but this bounded bridge does not prove
    // item-by-item import survival/rollback from the legacy ledger alone.
    reviewReason = 'frozen_evidence_unavailable'
  }
  const marker = parent === null || parent.meta === null ? null : object(parent.meta).manual_result_edit
  // Shadow's legacy audit UUID is distinct from the canonical operation UUID.
  // Follow the sealed producer response rather than assuming those IDs coincide.
  // The record-operation seal binds result IDs; it does not carry result hashes.
  const manualSources = manualOverride === null ? { rows: [] as Row[] } : await witness.trx.query(
    `SELECT op.actor_id, op.response_snapshot, c.manual_override_snapshot
       FROM attendance_result_operations op
       JOIN attendance_record_calculations c
         ON c.org_id = op.org_id AND c.id = op.resolved_calculation_id
        AND c.operation_id = op.operation_id
      WHERE op.org_id = $1 AND op.operation_id = $2::uuid
        AND op.entrypoint = 'manual_edit' AND op.capability = 'manual_edit'
        AND op.state = 'completed' AND op.accepted_write_posture = 'shadow'
        AND op.resolved_record_id = $3::uuid AND c.attendance_record_id = $3::uuid
        AND c.entrypoint = 'manual_override' AND c.mode = 'shadow' AND c.outcome = 'completed'`,
    [witness.org.orgId, manualOverride.editId, parent?.id],
  )
  if (manualOverride === null) {
    if (marker != null || edits.rows.length > 0) reviewReason = 'frozen_evidence_unavailable'
  } else {
    const producer = manualSources.rows.length === 1 ? manualSources.rows[0] : null
    const response = producer === null ? null : json(producer.response_snapshot)
    const data = response && typeof response === 'object' ? (response as Row).data : null
    const rawAudit = data && typeof data === 'object' ? (data as Row).edit : null
    const audit = rawAudit && typeof rawAudit === 'object' && !Array.isArray(rawAudit) ? rawAudit as Row : null
    // A later unrepresented edit cannot be hidden by an older valid link.
    const latest = edits.rows[edits.rows.length - 1]
    if (producer === null || !same(json(producer.manual_override_snapshot), manualOverride)
      || !audit || typeof audit !== 'object' || !latest
      || audit.id !== latest.id || audit.orgId !== witness.org.orgId
      || audit.recordId !== parent?.id || audit.userId !== witness.subjectUserId || audit.workDate !== workDate
      || latest.record_id !== parent?.id || audit.idempotencyKey !== latest.idempotency_key
      || audit.actorUserId !== producer.actor_id || latest.actor_user_id !== producer.actor_id
      || audit.reason !== manualOverride.reason || latest.reason !== manualOverride.reason
      || audit.beforeStatus !== latest.before_status || audit.afterStatus !== latest.after_status
      || !same(audit.beforeSnapshot, json(latest.before_snapshot))
      || !same(audit.afterSnapshot, json(latest.after_snapshot))
      || !same(audit.evidence, json(latest.evidence))
      || (marker != null && (typeof marker !== 'object' || (marker as Row).auditId !== latest.id))) {
      reviewReason = 'frozen_evidence_unavailable'
    }
  }
  if (parent !== null && frozen.context !== null && parent.timezone !== frozen.context.timezone) {
    reviewReason = 'context_mismatch'
  }
  if (unresolvedRequestIds.size > 0) reviewReason = 'frozen_evidence_unavailable'
  return frozenCopy({
    evidence, approvedFacts, manualOverride, priorCalculations,
    unresolvedRequestIds: [...unresolvedRequestIds].sort(), reviewReason,
    sourcePreimageFingerprint: computeAttendanceCommandFingerprintV1({
      history: history.rows, childPreimages, events: eventPreimage, active: active.rows,
      recoveredSources, imports: imports.rows, edits: edits.rows, manualSources: manualSources.rows,
    }),
  })
}

export async function prepareApprovedOvertimeShadowV1(
  witness: Witness, requestId: string, preTerminal: ApprovedOvertimePreTerminalSnapshotV1,
): Promise<PreparedOvertimeShadowV1> {
  const source = await readOvertimeRequestSource(witness, requestId, 'pending', true)
  if (witness.org.acceptedWritePosture !== 'shadow' || preTerminal?.writePosture !== 'shadow'
    || (source.frozen === null
      ? preTerminal.kind !== 'missing_shadow_allowed'
      : preTerminal.kind !== 'locked' || !same(preTerminal.snapshot, source.frozen.snapshot))) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_VERSION_CONFLICT')
  }
  const approvalInstanceId = source.request.approval_instance_id
  if (typeof approvalInstanceId !== 'string' || approvalInstanceId.length === 0) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_APPROVAL_MISMATCH')
  }
  const approval = await witness.trx.query(
    `SELECT version FROM approval_instances WHERE id = $1 AND status = 'pending' FOR UPDATE`,
    [approvalInstanceId],
  )
  const approvalVersion = Number(approval.rows[0]?.version)
  if (approval.rows.length !== 1 || !Number.isSafeInteger(approvalVersion) || approvalVersion < 0) {
    refuse('ATTENDANCE_OVERTIME_TERMINAL_APPROVAL_MISMATCH')
  }
  const target = createVerifiedAttendanceCalculationTargetIdentityV1({
    org: witness.org, userId: witness.subjectUserId, workDate: source.payload.workDate,
  })
  await acquireAttendanceCalculationTargetLocks(witness.trx, [target])
  const parent = await readShadowParent(witness, source.payload.workDate)
  const frozenSource = { payload: source.payload, frozen: source.frozen }
  const inputs = await readNonCurrentApprovedOvertimeInputsV1(witness, parent, frozenSource, requestId)
  return frozenCopy({
    kind: source.frozen === null ? 'shadow_missing_request_snapshot'
      : source.frozen.attribution.posture === 'resolved_v2' && source.frozen.context !== null
        ? 'shadow_bound' : 'shadow_unsupported_frozen',
    requestId, source: frozenSource, approvalInstanceId, approvalVersion, parent, inputs,
  })
}

export async function appendApprovedOvertimeShadowV1(
  facade: AttendanceRequestPluginTrxV1, operation: AttendanceRequestOperationContextV1,
  witness: Witness, plan: PreparedOvertimeShadowV1, bound: Bound,
): Promise<{ recordId: string; outcome: 'completed' | 'review_required'; dailyProjection: PreparedDailyProjectionV1 | null }> {
  const source = await readOvertimeRequestSource(witness, plan.requestId, 'approved', true)
  if (!same({ payload: source.payload, frozen: source.frozen }, plan.source)
    || source.request.approval_instance_id !== plan.approvalInstanceId) {
    refuse('ATTENDANCE_OVERTIME_SNAPSHOT_CONTEXT_MISMATCH')
  }
  if (bound?.writePosture !== 'shadow') refuse('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  let fact: ApprovedAttendanceFactV1 | null = null
  if (source.frozen === null) {
    if (bound.kind !== 'unsupported_pre_w4_shadow') refuse('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
    validateMissingApprovedOvertimeBindingV1(source.request, bound.binding)
  } else {
    if (bound.kind !== 'bound' || !same(bound.snapshot, source.frozen.snapshot)) {
      refuse('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
    }
    fact = buildBoundedApprovedOvertimeFactV1(source.frozen, bound.binding)
  }
  await assertTerminalApproval(witness, source.request, bound.binding, plan.approvalVersion)
  // The only allowed parent change is the plugin's existing legacy upsert. Its
  // served row supplies comparison values; old evidence/metadata come from prepare.
  const parent = await readShadowParent(witness, source.payload.workDate)
  if (parent === null || (plan.parent !== null && parent.id !== plan.parent.id)
    || (plan.parent !== null && (parent.first_in_at !== plan.parent.first_in_at
      || parent.last_out_at !== plan.parent.last_out_at))) {
    refuse('ATTENDANCE_OVERTIME_PARENT_CHANGED')
  }
  if (plan.parent === null) {
    const history = await witness.trx.query(
      'SELECT id FROM attendance_record_calculations WHERE org_id = $1 AND attendance_record_id = $2::uuid',
      [witness.org.orgId, parent.id],
    )
    if (history.rows.length !== 0) refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_CHANGED')
  }
  const preserved = await readNonCurrentApprovedOvertimeInputsV1(witness, plan.parent, plan.source, plan.requestId)
  if (!same(preserved, plan.inputs)) refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_CHANGED')
  const frozen = sourceContext(plan.source)
  const approvedFacts = fact === null ? [...preserved.approvedFacts] : [...preserved.approvedFacts, fact]
  // Unsupported frozen sources keep their original calculator reason/context.
  const calculation = plan.kind !== 'shadow_bound' || preserved.reviewReason === null
    ? calculateAttendanceSegmentsV1({
      attribution: frozen.attribution, context: frozen.context, evidence: preserved.evidence, approvedFacts,
    })
    : { outcome: 'review_required' as const, outcomeReasonCode: preserved.reviewReason,
      segments: [], dailyProjection: null }
  const provenanceRef: AttendanceInputProvenanceRefV1 = {
    transport: 'approved_request', sourceRef: plan.requestId,
    artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null,
  }
  const overtimeShadow = {
    schemaVersion: 1, kind: plan.kind, requestId: plan.requestId, terminalBinding: bound.binding,
    unresolvedRequestIds: [...new Set([
      ...preserved.unresolvedRequestIds, ...(fact === null ? [plan.requestId] : []),
    ])].sort(),
    sourcePreimageFingerprint: preserved.sourcePreimageFingerprint,
  }
  const payloadFingerprint = computeAttendanceCommandFingerprintV1({
    kind: 'approved_overtime', overtimeShadow,
  })
  const versions = await witness.trx.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM attendance_record_calculations
      WHERE org_id = $1 AND attendance_record_id = $2::uuid`,
    [witness.org.orgId, parent.id],
  )
  const version = Number(versions.rows[0]?.next)
  if (!Number.isSafeInteger(version) || version < 1) refuse('ATTENDANCE_OVERTIME_PRIOR_INPUTS_INCOMPLETE')
  if (requireAttendanceRequestDecisionCalculationWitnessV1(facade, operation) !== witness
    || operation.acceptedWritePosture !== 'shadow') refuse('ATTENDANCE_OVERTIME_OPERATION_MISMATCH')
  const written = await insertShadowCalculationV1(witness.trx, {
    orgId: witness.org.orgId, recordId: String(parent.id), version, entrypoint: 'approved_overtime',
    operationId: witness.identity.id, attribution: frozen.attribution, context: frozen.context,
    segmentSnapshot: calculation.outcome === 'completed' ? frozen.context!.segments : [],
    evidence: preserved.evidence, approvedFacts, manualOverride: preserved.manualOverride, mergePolicy: 'merge',
    provenanceRef, inputProvenance: {
      ...provenanceRef, payloadFingerprint, priorCalculations: preserved.priorCalculations, overtimeShadow,
    },
    ...calculation, actorId: witness.actorId, correlationId: operation.correlationId,
    legacyProjection: {
      workDate: source.payload.workDate, status: String(parent.status),
      firstInAt: parent.first_in_at as string | null, lastOutAt: parent.last_out_at as string | null,
      workMinutes: Number(parent.work_minutes), lateMinutes: Number(parent.late_minutes),
      earlyLeaveMinutes: Number(parent.early_leave_minutes),
    },
  })
  const stored = await witness.trx.query(
    `SELECT id::text AS id, semantic_input_fingerprint, provenance_fingerprint,
            source_definition_fingerprint, outcome, outcome_reason_code, projection_effect,
            expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
            projected_work_minutes, projected_late_minutes, projected_early_leave_minutes
       FROM attendance_record_calculations
      WHERE id = $1::uuid AND org_id = $2 AND attendance_record_id = $3::uuid
        AND entrypoint = 'approved_overtime' AND operation_id = $4::uuid AND mode = 'shadow'`,
    [written.calculationId, witness.org.orgId, parent.id, witness.identity.id],
  )
  const row = stored.rows[0]
  if (stored.rows.length !== 1 || row.semantic_input_fingerprint !== written.semanticFingerprint
    || row.provenance_fingerprint !== written.provenanceFingerprint
    || row.source_definition_fingerprint !== computeAttendanceSourceDefinitionFingerprintV1({ attribution: frozen.attribution, context: frozen.context })
    || row.outcome !== calculation.outcome || row.outcome_reason_code !== calculation.outcomeReasonCode
    || row.projection_effect !== 'none' || row.expected_segment_count !== calculation.segments.length
    || (calculation.outcome === 'review_required' && [
      'projected_status', 'projected_first_in_at', 'projected_last_out_at',
      'projected_work_minutes', 'projected_late_minutes', 'projected_early_leave_minutes',
    ].some((field) => row[field] !== null))
    || !same(await readShadowParent(witness, source.payload.workDate), parent)) {
    refuse('ATTENDANCE_OVERTIME_RESULT_PROOF_MISMATCH')
  }
  recordAttendanceRequestDecisionCalculationResultV1(facade, operation, {
    resolvedRecordId: String(parent.id), resolvedCalculationId: written.calculationId,
    resultSemanticFingerprint: String(row.semantic_input_fingerprint),
    resultProvenanceFingerprint: String(row.provenance_fingerprint),
  })
  // Comparison daily values must never replace the response's served legacy row.
  return frozenCopy({ recordId: String(parent.id), outcome: calculation.outcome, dailyProjection: null })
}
