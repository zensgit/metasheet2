/**
 * W4C-0 (#4556) Stage C — canonical write-boundary TYPE declarations
 * (lock sections 4.1, 4.2, 4.3, 8.1). Types only: `executeAttendanceResultOperation`
 * orchestration, prepare, and apply require the W4C-1 pure calculator and the
 * W4C-2/3 private entrypoint adapters — W4C-0 delivers the interfaces with no
 * caller cutover, plus the registry/lock/authorization machinery they compose
 * (see w4c0-operation-registry.ts).
 *
 * These are verbatim transcriptions of the locked shapes; changing a member is
 * a contract change, not a refactor.
 */
import type {
  AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import type { AuthorizedAttendanceWriteContextV1 } from './w4c0-authorization'
import type { AttendanceInputProvenanceRefV1 } from './w4c0-fingerprints'
import type { NormalizedAttendanceSourceOperationEnvelopeV1 } from './w4c0-source-commands'

// ---------------------------------------------------------------------------
// Section 4.1 — untrusted internal intent (minted by private adapters only).
// ---------------------------------------------------------------------------

export type AttendanceCalculationEntrypointV1 =
  | 'live'
  | 'legacy_import'
  | 'integration_sync'
  | 'correction'
  | 'approved_leave'
  | 'approved_overtime'
  | 'outdoor_approval'
  | 'manual_override'
  | 'recompute'
  | 'scheduled'
  | 'approval_reversal'
  | 'import_rollback'
  | 'ops_retirement'

export type AttendanceEvidenceInputV1 =
  | { kind: 'persisted_event_ref'; eventId: string }
  | {
      kind: 'import_boundary'
      importItemId: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
    }
  | {
      kind: 'import_metric_snapshot_ref'
      operationItemId: string
      snapshotVersion: 1
    }
  | { kind: 'scheduled_absence_ref'; scheduledRunId: string }
  | { kind: 'approved_request_ref'; requestId: string }

export interface ApprovedAttendanceFactRefV1 {
  requestId: string
  expectedKind: 'leave' | 'overtime' | 'correction' | 'outdoor_punch' | 'reversal'
}

export interface AttendanceCalculationIntentV1 {
  schemaVersion: 1
  orgId: string
  userId: string
  requestedWorkDate: string | null
  entrypoint: AttendanceCalculationEntrypointV1
  attributionSource: 'resolve_now' | 'request_snapshot' | 'prior_calculation'
  attributionRef: string | null
  contextSource: 'resolved_attribution' | 'request_snapshot' | 'prior_calculation'
  contextRef: string | null
  evidenceInputs: AttendanceEvidenceInputV1[]
  approvedFactRefs: ApprovedAttendanceFactRefV1[]
  manualOverrideRef: string | null
  mergePolicy: 'append' | 'merge' | 'override' | 'reversal' | 'retire'
  provenanceRef: AttendanceInputProvenanceRefV1
  sourceBatchId: string | null
  operationId: string | null
  correlationId: string
}

// ---------------------------------------------------------------------------
// Section 4.1 — frozen attribution/context snapshots.
// ---------------------------------------------------------------------------

export interface FrozenWorkDateAttributionV2 {
  schemaVersion: 2
  resolverVersion: string
  orgId: string
  userId: string
  workDate: string
  shiftId: string
  reasonCode: string
  resolvedAt: string
  absoluteWindow: { startAt: string; endAt: string }
  attributionWindow: { startAt: string; endAt: string }
  attributionTailMinutes: number
  extendedByApprovedOvertime: boolean
  windowEvidenceFingerprint: string
  source: 'live_resolution' | 'request_creation' | 'import_resolution' | 'scheduled_resolution'
}

export type AttendanceAttributionSnapshotV1 =
  | { posture: 'resolved_v2'; value: FrozenWorkDateAttributionV2 }
  | {
      posture: 'unsupported'
      sourceSchemaVersion: 0 | 1 | null
      reason: 'legacy_v1' | 'missing' | 'ambiguous' | 'unresolved'
      sourceFingerprint: string | null
    }

export interface FrozenAttendanceContextV1 {
  schemaVersion: 1
  selector: 'legacy'
  orgId: string
  userId: string
  workDate: string
  timezone: string
  shiftId: string
  isWorkday: boolean
  holidayKind: string | null
  calculationGroupId: null
  roundingMinutes: number
  severeLateThresholdMinutes: number
  absenceLateThresholdMinutes: number
  segments: Array<{
    index: 0 | 1 | 2
    startTime: string
    endTime: string
    startDayOffset: 0
    endDayOffset: 0 | 1
    lateGraceMinutes: number
    earlyLeaveGraceMinutes: number
  }>
}

// ---------------------------------------------------------------------------
// Section 4.2 — closed evidence and approved facts.
// ---------------------------------------------------------------------------

export type AttendanceEvidenceV1 =
  | {
      kind: 'punch'
      ref: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
      source: 'attendance_event' | 'outdoor_approval' | 'import'
    }
  | {
      kind: 'approved_adjustment'
      ref: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
      source: 'correction'
    }
  | { kind: 'scheduled_absence'; ref: string }

export type ApprovedFactCoverageV1 =
  | { kind: 'bounded_interval'; startAt: string; endAt: string; minutes: number }
  | { kind: 'minutes_only_unbounded'; minutes: number; source: 'explicit_minutes' | 'policy_default' }

interface ApprovedFactBaseV1 {
  requestId: string
  requestSnapshotVersion: number
  requestSnapshotFingerprint: string
  approvalVersion: number
  approvalRecordId: string
}

export type ApprovedAttendanceFactV1 =
  | (ApprovedFactBaseV1 & { kind: 'leave'; coverage: ApprovedFactCoverageV1; leaveType: string })
  | (ApprovedFactBaseV1 & { kind: 'overtime'; coverage: ApprovedFactCoverageV1 })
  | (ApprovedFactBaseV1 & {
      kind: 'correction'
      direction: 'check_in' | 'check_out'
      occurredAt: string
      supersededEvidenceRef: string
    })
  | (ApprovedFactBaseV1 & { kind: 'outdoor_punch'; direction: 'check_in' | 'check_out'; occurredAt: string })
  | (ApprovedFactBaseV1 & { kind: 'reversal'; reversesApprovalRecordId: string })

export interface ManualAttendanceOverrideV1 {
  editId: string
  beforeFingerprint: string
  reason: string
  actorPosture: 'attendance_admin'
  operations: Array<{ op: 'set' | 'unset'; field: string; value: unknown }>
}

// ---------------------------------------------------------------------------
// Section 4.1 — prepared plan (trusted; produced only by prepare).
// ---------------------------------------------------------------------------

export interface PreparedDailyProjectionV1 {
  firstInAt: string | null
  lastOutAt: string | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  status: string
  timezone: string
  workDate: string
  meta: Record<string, unknown> | null
}

export type AttendanceProjectionDirectiveV1 =
  | { kind: 'apply_legacy'; projection: PreparedDailyProjectionV1 }
  | { kind: 'apply_segment'; projection: PreparedDailyProjectionV1 }
  | { kind: 'preserve' }
  | {
      kind: 'restore'
      restoresCalculationId: string
      parentState: {
        projectionOwner: 'legacy_untracked' | 'w4'
        currentCalculationId: string | null
        visibilityState: 'active' | 'retired'
        visibilityReason: 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement'
        projection: PreparedDailyProjectionV1 | null
      }
    }
  | { kind: 'retire' }

export interface AttendanceInputProvenanceV1 {
  transport: AttendanceInputProvenanceRefV1['transport']
  sourceRef: string
  artifactSha256: string | null
  normalizedCsvSha256: string | null
  convertedSheetName: string | null
}

export interface PreparedAttendanceResultV1 {
  outcome: 'baseline' | 'completed' | 'review_required' | 'reversed'
  outcomeReasonCode: string
  segments: Array<Record<string, unknown>>
  dailyProjection: PreparedDailyProjectionV1 | null
}

export interface PreparedAttendanceCalculationV1 {
  schemaVersion: 1
  engineVersion: string
  nextCalculationVersion: number
  mode: 'shadow' | 'authoritative'
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
  contextDecision:
    | 'resolved_attribution'
    | 'request_frozen'
    | 'prior_calculation_frozen'
    | 'current_policy_requested'
    | 'unavailable'
  segmentSnapshot: FrozenAttendanceContextV1['segments'] | []
  evidence: AttendanceEvidenceV1[]
  approvedFacts: ApprovedAttendanceFactV1[]
  manualOverride: ManualAttendanceOverrideV1 | null
  mergePolicy: AttendanceCalculationIntentV1['mergePolicy']
  calculationTier: 'legacy_shadow' | 'segment_authoritative'
  inputProvenance: AttendanceInputProvenanceV1
  semanticInputFingerprint: string
  provenanceFingerprint: string
  sourceDefinitionFingerprint: string | null
  result: PreparedAttendanceResultV1
}

export type PreparedAttendanceWritePlanV1 =
  | {
      posture: 'legacy_projection_only'
      operationId: string | null
      operationCommandFingerprint: string
      calculation: null
      projectionDirective: { kind: 'apply_legacy'; projection: PreparedDailyProjectionV1 }
    }
  | {
      posture: 'shadow' | 'eligible' | 'authoritative'
      operationId: string
      operationCommandFingerprint: string
      calculation: PreparedAttendanceCalculationV1
      projectionDirective: AttendanceProjectionDirectiveV1
    }

// ---------------------------------------------------------------------------
// Section 8.1 — canonical boundary signatures. `LockedAttendanceCalculationSourcesV1`
// is a non-serializable witness minted only inside the canonical transaction.
// ---------------------------------------------------------------------------

declare const W4C0LockedSources: unique symbol
export type LockedAttendanceCalculationSourcesV1 = { readonly [W4C0LockedSources]: 'LockedAttendanceCalculationSourcesV1' }

export interface AttendanceCalculationWriteResultV1 {
  calculationId: string | null
  recordId: string | null
  outcome: string
  responseSnapshot: unknown
}

export interface AttendanceCalculationOperationResultV1 {
  replayed: boolean
  batchResponse: unknown | null
  itemResponses: Readonly<Record<string, unknown>>
}

export type ExecuteAttendanceResultOperationV1 = (
  authorization: AuthorizedAttendanceWriteContextV1,
  envelope: NormalizedAttendanceSourceOperationEnvelopeV1,
) => Promise<AttendanceCalculationOperationResultV1>

export type PrepareAttendanceCalculationLockedV1 = (
  trx: AttendanceW4TransactionClientV1,
  authorization: AuthorizedAttendanceWriteContextV1,
  locked: LockedAttendanceCalculationSourcesV1,
  intent: AttendanceCalculationIntentV1,
) => Promise<PreparedAttendanceCalculationV1>

export type ApplyPreparedAttendanceCalculationLockedV1 = (
  trx: AttendanceW4TransactionClientV1,
  authorization: AuthorizedAttendanceWriteContextV1,
  locked: LockedAttendanceCalculationSourcesV1,
  prepared: PreparedAttendanceWritePlanV1,
) => Promise<AttendanceCalculationWriteResultV1>

export type WriteAttendanceCalculationsBatchV1 = (
  trx: AttendanceW4TransactionClientV1,
  authorization: AuthorizedAttendanceWriteContextV1,
  intents: AttendanceCalculationIntentV1[],
) => Promise<AttendanceCalculationWriteResultV1[]>
