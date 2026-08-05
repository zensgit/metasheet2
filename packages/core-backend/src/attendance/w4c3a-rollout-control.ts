/**
 * W4C-3a internal rollout-control commands.
 *
 * These commands deliberately have no PluginServices, route, flag, or index
 * surface. They are the control-side half of the §7.9/§8.2 protocol only.
 *
 * W4C-5 transition-safety amendment (docs/development/attendance-issue-4556-
 * w4c5-transition-safety-amendment-20260804.md, OD-W4C-61=(a)): this module is
 * the hardened canonical transition boundary sections 1-6 describe. It is the
 * ONLY transition DML path; no route, generic plugin service, or second
 * competing implementation exists. Preparation/tooling (a separate,
 * independently gated PR) may only call this boundary — it must never touch
 * rollout DML directly.
 */
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceResultOperationLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  isAttendanceCalculationOrgAllowlistedV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOperationIdentityV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  type AttendanceAcceptedWritePostureV1,
  type AttendanceRolloutStateV1,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import { ATTENDANCE_CALCULATION_AFFECTING_REQUEST_TYPES_V1 } from './w4c3b-request-snapshots'

export class AttendanceW4C3aRolloutControlError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4C3aRolloutControlError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4C3aRolloutControlError(code)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
const REF_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TRANSITION_STATES = new Set<AttendanceRolloutStateV1>([
  'legacy',
  'shadow',
  'eligible',
  'authoritative',
  'suspended',
])

// ---------------------------------------------------------------------------
// Amendment section 1: the closed legal transition matrix. This is the SOLE
// source of pair legality and comparison write posture; the DB trigger
// (attendance_w4_rollout_state_guard) enforces the identical set as a
// defense-in-depth backstop, never as the primary gate. Every other pair
// fails here, before any lock beyond the rollout advisory lock itself.
// ---------------------------------------------------------------------------
type LegalTransitionRow = Readonly<{
  from: AttendanceRolloutStateV1
  to: AttendanceRolloutStateV1
  comparisonWritePosture: AttendanceAcceptedWritePostureV1
}>

const LEGAL_TRANSITIONS: readonly LegalTransitionRow[] = Object.freeze([
  { from: 'legacy', to: 'shadow', comparisonWritePosture: 'shadow' },
  { from: 'shadow', to: 'eligible', comparisonWritePosture: 'shadow' },
  { from: 'eligible', to: 'shadow', comparisonWritePosture: 'shadow' },
  { from: 'eligible', to: 'authoritative', comparisonWritePosture: 'authoritative' },
  { from: 'shadow', to: 'legacy', comparisonWritePosture: 'legacy_projection_only' },
  { from: 'authoritative', to: 'suspended', comparisonWritePosture: 'authoritative' },
  { from: 'suspended', to: 'authoritative', comparisonWritePosture: 'authoritative' },
])

function findLegalTransition(
  from: AttendanceRolloutStateV1,
  to: AttendanceRolloutStateV1,
): LegalTransitionRow | undefined {
  return LEGAL_TRANSITIONS.find((row) => row.from === from && row.to === to)
}

const ELIGIBILITY_AUTHORITY_TARGETS = new Set<AttendanceRolloutStateV1>(['eligible', 'authoritative'])
const CALCULATION_ENTRY_TARGETS = new Set<AttendanceRolloutStateV1>(['shadow', 'eligible', 'authoritative'])

const RETRYABLE_JOB_STATUSES = ['queued', 'failed']
const NONTERMINAL_LEGACY_JOB_STATUSES = ['queued', 'running']

// ---------------------------------------------------------------------------
// Evidence references (amendment section 4): the command NEVER collects or
// validates the manifest itself — that is a separately authorized tooling
// concern. It accepts only the exact manifest hash plus a closed set of
// opaque, values-free reference strings and stores them verbatim.
// ---------------------------------------------------------------------------
const BASE_EVIDENCE_REFERENCE_KEYS = ['imageSha', 'ownerAuthorizationRef', 'syntheticOrgRef'] as const
const RESUME_EVIDENCE_REFERENCE_KEYS = ['ownerIncidentReviewRef', 'offlineReplayArtifactRef'] as const

export type BaseEvidenceReferenceKeyV1 = (typeof BASE_EVIDENCE_REFERENCE_KEYS)[number]
export type ResumeEvidenceReferenceKeyV1 = (typeof RESUME_EVIDENCE_REFERENCE_KEYS)[number]
export type EvidenceReferenceKeyV1 = BaseEvidenceReferenceKeyV1 | ResumeEvidenceReferenceKeyV1

export type EvidenceReferencesV1 = Readonly<Record<EvidenceReferenceKeyV1, string>>

function isResumePair(from: AttendanceRolloutStateV1, to: AttendanceRolloutStateV1): boolean {
  return from === 'suspended' && to === 'authoritative'
}

function requireEvidenceReferences(
  value: unknown,
  from: AttendanceRolloutStateV1,
  to: AttendanceRolloutStateV1,
): EvidenceReferencesV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail('W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID')
  }
  const expectedKeys: readonly string[] = isResumePair(from, to)
    ? [...BASE_EVIDENCE_REFERENCE_KEYS, ...RESUME_EVIDENCE_REFERENCE_KEYS]
    : BASE_EVIDENCE_REFERENCE_KEYS
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== expectedKeys.length) fail('W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID')
  const out: Record<string, string> = {}
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.get || descriptor.set) {
      fail('W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID')
    }
    const raw = (value as Record<string, unknown>)[key]
    if (typeof raw !== 'string' || !REF_VALUE.test(raw)) {
      fail('W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID')
    }
    out[key] = raw
  }
  return Object.freeze(out) as EvidenceReferencesV1
}

type ControlInput = Readonly<{
  orgId: string
  batchId: string
  actorId: string
  correlationId: string
  engineVersion: string
}>

export type CloseLegacyRollbackWindowInputV1 = ControlInput & Readonly<{
  reasonCode: 'legacy_rollback_window_closed'
}>

export type TransitionAttendanceCalculationRolloutInputV1 = Omit<ControlInput, 'batchId'> & Readonly<{
  targetState: AttendanceRolloutStateV1
  expectedState: AttendanceRolloutStateV1
  expectedVersion: number
  evidenceManifestSha256: string
  evidenceReferences: EvidenceReferencesV1
  reasonCode: 'rollout_transition'
}>

export type AttendanceW4C3aRolloutControlResultV1 = Readonly<{
  orgId: string
  state: AttendanceRolloutStateV1
  batchId: string | null
}>

type SourceTarget = Readonly<{ userId: string; workDate: string }>
type BatchReferenceState = Readonly<{
  batchStatus: string
  closed: boolean
  hasFrozenPreimage: boolean
  hasW4Reference: boolean
}>

let afterExclusiveRolloutLockForTests: ((kind: 'close' | 'transition') => Promise<void>) | null = null
let beforeEventInsertForTests: (() => Promise<void>) | null = null

/** Test-only deterministic barrier. It is not imported by production wiring. */
export function __setW4C3aRolloutControlAfterExclusiveLockForTests(
  hook: ((kind: 'close' | 'transition') => Promise<void>) | null,
): void {
  afterExclusiveRolloutLockForTests = hook
}

/**
 * Test-only atomicity seam (amendment completion gate 7): fires after the
 * rollout-state UPDATE and before the rollout-event INSERT, in the same
 * transaction. It is not imported by production wiring.
 */
export function __setW4C3aRolloutControlBeforeEventInsertForTests(
  hook: (() => Promise<void>) | null,
): void {
  beforeEventInsertForTests = hook
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) fail(code)
  return value
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) fail(code)
  return value
}

function requireRolloutState(value: unknown, code: string): AttendanceRolloutStateV1 {
  if (typeof value !== 'string' || !TRANSITION_STATES.has(value as AttendanceRolloutStateV1)) fail(code)
  return value as AttendanceRolloutStateV1
}

function requireManifestSha256(value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) fail('W4C3A_ROLLOUT_CONTROL_MANIFEST_INVALID')
  return value
}

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail('W4C3A_ROLLOUT_CONTROL_EXPECTED_VERSION_INVALID')
  }
  return value
}

function requireExactInputKeys(input: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail(code)
  const own = Object.getOwnPropertyNames(input)
  if (own.length !== keys.length) fail(code)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) fail(code)
  }
  return input as Record<string, unknown>
}

function normalizeCloseInput(input: CloseLegacyRollbackWindowInputV1): CloseLegacyRollbackWindowInputV1 {
  if (!input || input.reasonCode !== 'legacy_rollback_window_closed') fail('W4C3A_ROLLOUT_CONTROL_INPUT_INVALID')
  return Object.freeze({
    orgId: String(parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)),
    batchId: requireUuid(input.batchId, 'W4C3A_ROLLOUT_CONTROL_BATCH_INVALID'),
    actorId: requireText(input.actorId, 'W4C3A_ROLLOUT_CONTROL_ACTOR_INVALID'),
    correlationId: requireUuid(input.correlationId, 'W4C3A_ROLLOUT_CONTROL_CORRELATION_INVALID'),
    engineVersion: requireText(input.engineVersion, 'W4C3A_ROLLOUT_CONTROL_ENGINE_INVALID'),
    reasonCode: input.reasonCode,
  })
}

const TRANSITION_INPUT_KEYS = [
  'orgId',
  'actorId',
  'correlationId',
  'engineVersion',
  'targetState',
  'expectedState',
  'expectedVersion',
  'evidenceManifestSha256',
  'evidenceReferences',
  'reasonCode',
] as const

type NormalizedTransitionInput = TransitionAttendanceCalculationRolloutInputV1 & Readonly<{
  comparisonWritePosture: AttendanceAcceptedWritePostureV1
}>

function normalizeTransitionInput(
  rawInput: TransitionAttendanceCalculationRolloutInputV1,
): NormalizedTransitionInput {
  const input = requireExactInputKeys(
    rawInput,
    TRANSITION_INPUT_KEYS,
    'W4C3A_ROLLOUT_CONTROL_INPUT_INVALID',
  )
  if (input.reasonCode !== 'rollout_transition') fail('W4C3A_ROLLOUT_CONTROL_INPUT_INVALID')
  const orgId = String(parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId))
  const actorId = requireText(input.actorId, 'W4C3A_ROLLOUT_CONTROL_ACTOR_INVALID')
  const correlationId = requireUuid(input.correlationId, 'W4C3A_ROLLOUT_CONTROL_CORRELATION_INVALID')
  const engineVersion = requireText(input.engineVersion, 'W4C3A_ROLLOUT_CONTROL_ENGINE_INVALID')
  const targetState = requireRolloutState(input.targetState, 'W4C3A_ROLLOUT_CONTROL_INPUT_INVALID')
  const expectedState = requireRolloutState(input.expectedState, 'W4C3A_ROLLOUT_CONTROL_EXPECTED_STATE_INVALID')
  const expectedVersion = requireExpectedVersion(input.expectedVersion)
  const evidenceManifestSha256 = requireManifestSha256(input.evidenceManifestSha256)
  // The claimed pair is validated against the closed matrix BEFORE any lock or DB access — a
  // caller-asserted illegal pair can never proceed regardless of true persisted state.
  const legal = findLegalTransition(expectedState, targetState)
  if (!legal) fail('W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION')
  const evidenceReferences = requireEvidenceReferences(input.evidenceReferences, expectedState, targetState)
  return Object.freeze({
    orgId,
    actorId,
    correlationId,
    engineVersion,
    targetState,
    expectedState,
    expectedVersion,
    evidenceManifestSha256,
    evidenceReferences,
    reasonCode: 'rollout_transition' as const,
    comparisonWritePosture: legal.comparisonWritePosture,
  })
}

async function loadSourceOperationIdentities(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchIds: readonly string[],
): Promise<VerifiedAttendanceOperationIdentityV1[]> {
  if (batchIds.length === 0) return []
  const [batches, items] = await Promise.all([
    trx.query(
      `SELECT org_id AS "orgId", entrypoint, 'batch'::text AS kind,
              batch_command_id::text AS "operationId", accepted_write_posture AS "acceptedWritePosture",
              identity_source_kind AS "identitySourceKind", source_root_id::text AS "sourceRootId",
              NULL::int AS "inputOrdinal", NULL::text AS "proofSemanticFingerprint",
              NULL::text AS "proofUserId", NULL::text AS "proofWorkDate"
         FROM attendance_result_operation_batches
        WHERE org_id = $1 AND entrypoint IN ('import_batch', 'integration_batch')
          AND batch_command_id = ANY($2::uuid[])
        ORDER BY entrypoint, batch_command_id`,
      [orgId, batchIds],
    ),
    trx.query(
      `SELECT org_id AS "orgId", entrypoint, 'item'::text AS kind,
              operation_id::text AS "operationId", accepted_write_posture AS "acceptedWritePosture",
              identity_source_kind AS "identitySourceKind", source_root_id::text AS "sourceRootId",
              input_ordinal AS "inputOrdinal", proof_semantic_fingerprint AS "proofSemanticFingerprint",
              proof_user_id::text AS "proofUserId", proof_work_date::text AS "proofWorkDate"
         FROM attendance_result_operations
        WHERE org_id = $1 AND entrypoint IN ('import_batch', 'integration_batch')
          AND batch_command_id = ANY($2::uuid[])
        ORDER BY entrypoint, operation_id`,
      [orgId, batchIds],
    ),
  ])
  return [...batches.rows, ...items.rows].map((row) => rehydrateVerifiedAttendanceOperationIdentityV1(row))
}

async function lockSourceOperationRows(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchIds: readonly string[],
): Promise<void> {
  if (batchIds.length === 0) return
  await trx.query(
    `SELECT batch_command_id
       FROM attendance_result_operation_batches
      WHERE org_id = $1 AND entrypoint IN ('import_batch', 'integration_batch')
        AND batch_command_id = ANY($2::uuid[])
      ORDER BY entrypoint, batch_command_id
      FOR UPDATE`,
    [orgId, batchIds],
  )
  await trx.query(
    `SELECT operation_id
       FROM attendance_result_operations
      WHERE org_id = $1 AND entrypoint IN ('import_batch', 'integration_batch')
        AND batch_command_id = ANY($2::uuid[])
      ORDER BY entrypoint, operation_id
      FOR UPDATE`,
    [orgId, batchIds],
  )
}

async function lockJobsBatchesAndItems(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchIds: readonly string[],
): Promise<void> {
  if (batchIds.length === 0) return
  await trx.query(
    `SELECT id
       FROM attendance_import_jobs
      WHERE org_id = $1 AND w4_contract_version = 1 AND w4_batch_command_id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, batchIds],
  )
  await trx.query(
    `SELECT id
       FROM attendance_import_batches
      WHERE org_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, batchIds],
  )
  await trx.query(
    `SELECT id
       FROM attendance_import_items
      WHERE org_id = $1 AND batch_id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, batchIds],
  )
}

async function loadTargets(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchIds: readonly string[],
): Promise<SourceTarget[]> {
  if (batchIds.length === 0) return []
  const result = await trx.query(
    `SELECT DISTINCT user_id::text AS "userId", work_date::text AS "workDate"
       FROM attendance_import_items
      WHERE org_id = $1 AND batch_id = ANY($2::uuid[])
        AND user_id IS NOT NULL AND work_date IS NOT NULL
      ORDER BY 1, 2`,
    [orgId, batchIds],
  )
  return result.rows.map((row) => ({
    userId: requireUuid(row.userId, 'W4C3A_ROLLOUT_CONTROL_TARGET_INVALID'),
    workDate: requireText(row.workDate, 'W4C3A_ROLLOUT_CONTROL_TARGET_INVALID'),
  }))
}

async function lockTargetsAndParents(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  posture: 'legacy_projection_only' | 'shadow' | 'authoritative',
  targets: readonly SourceTarget[],
): Promise<void> {
  if (targets.length === 0) return
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({ orgId, acceptedWritePosture: posture })
  await acquireAttendanceCalculationTargetLocks(
    trx,
    targets.map((target) => createVerifiedAttendanceCalculationTargetIdentityV1({ org, ...target })),
  )
  await trx.query(
    `WITH target(user_id, work_date) AS (
       SELECT * FROM unnest($2::uuid[], $3::date[])
     )
     SELECT r.id
       FROM attendance_records r
       JOIN target t ON t.user_id::text = r.user_id AND t.work_date = r.work_date
      WHERE r.org_id = $1
      ORDER BY r.org_id, r.user_id, r.work_date, r.id
      FOR UPDATE`,
    [orgId, targets.map((target) => target.userId), targets.map((target) => target.workDate)],
  )
}

/**
 * Amendment section 2.3: missing state may be created ONLY for the exact
 * allowlisted synthetic org and ONLY as part of `legacy -> shadow`. Every
 * other missing-row case fails closed with zero DML — no row is ever
 * materialized for an org this boundary was never authorized to touch.
 */
async function lockRolloutStateForBootstrapOrRead(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  actorId: string,
  engineVersion: string,
  expectedState: AttendanceRolloutStateV1,
  targetState: AttendanceRolloutStateV1,
  orgAllowlisted: boolean,
): Promise<Readonly<{ state: AttendanceRolloutStateV1; version: number }>> {
  const row = await trx.query(
    `SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1 FOR UPDATE`,
    [orgId],
  )
  if (row.rows.length === 1) {
    const state = row.rows[0].state
    const version = row.rows[0].version
    if (typeof state !== 'string' || !TRANSITION_STATES.has(state as AttendanceRolloutStateV1)) {
      fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
    }
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
    }
    return { state: state as AttendanceRolloutStateV1, version }
  }
  if (row.rows.length !== 0) fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
  const canBootstrap = orgAllowlisted && expectedState === 'legacy' && targetState === 'shadow'
  if (!canBootstrap) fail('W4C3A_ROLLOUT_CONTROL_STATE_MISSING')
  await trx.query(
    `INSERT INTO attendance_calculation_rollout_state
     (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
     VALUES ($1, 'legacy', $2, 'rollout_transition', $3, 1, NULL, 'synthetic_staging')`,
    [orgId, engineVersion, actorId],
  )
  return { state: 'legacy', version: 1 }
}

async function loadBatchReferenceState(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchId: string,
): Promise<BatchReferenceState> {
  const result = await trx.query(
    `SELECT
       (SELECT b.status FROM attendance_import_batches b
         WHERE b.org_id = $1 AND b.id = $2::uuid) AS "batchStatus",
       EXISTS(SELECT 1 FROM attendance_import_rollback_closures c WHERE c.org_id = $1 AND c.batch_id = $2::uuid) AS closed,
       EXISTS(SELECT 1 FROM attendance_record_calculations c WHERE c.org_id = $1 AND c.source_batch_id = $2::uuid AND c.parent_preimage_snapshot IS NOT NULL) AS "hasFrozenPreimage",
       (
         EXISTS(SELECT 1 FROM attendance_result_operation_batches b WHERE b.org_id = $1 AND b.entrypoint IN ('import_batch', 'integration_batch') AND b.batch_command_id = $2::uuid)
         OR EXISTS(SELECT 1 FROM attendance_result_operations o WHERE o.org_id = $1 AND o.entrypoint IN ('import_batch', 'integration_batch') AND o.batch_command_id = $2::uuid)
         OR EXISTS(SELECT 1 FROM attendance_import_jobs j WHERE j.org_id = $1 AND j.w4_contract_version = 1 AND j.w4_batch_command_id = $2::uuid)
         OR EXISTS(SELECT 1 FROM attendance_record_calculations c WHERE c.org_id = $1 AND c.source_batch_id = $2::uuid)
         OR EXISTS(
           SELECT 1 FROM attendance_records r
           JOIN attendance_record_calculations c ON c.id = r.current_calculation_id
          WHERE r.org_id = $1 AND c.org_id = $1 AND c.source_batch_id = $2::uuid
         )
       ) AS "hasW4Reference"`,
    [orgId, batchId],
  )
  if (result.rows.length !== 1) fail('W4C3A_ROLLOUT_CONTROL_REFERENCE_INVALID')
  const row = result.rows[0]
  if (
    typeof row.batchStatus !== 'string' ||
    typeof row.closed !== 'boolean' ||
    typeof row.hasFrozenPreimage !== 'boolean' ||
    typeof row.hasW4Reference !== 'boolean'
  ) {
    fail('W4C3A_ROLLOUT_CONTROL_REFERENCE_INVALID')
  }
  return {
    batchStatus: row.batchStatus,
    closed: row.closed,
    hasFrozenPreimage: row.hasFrozenPreimage,
    hasW4Reference: row.hasW4Reference,
  }
}

async function lockControlDomain(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchIds: readonly string[],
): Promise<'legacy_projection_only' | 'shadow' | 'authoritative'> {
  const candidates = await loadSourceOperationIdentities(trx, orgId, batchIds)
  await acquireAttendanceResultOperationLocks(trx, candidates)
  await lockSourceOperationRows(trx, orgId, batchIds)
  const identities = await loadSourceOperationIdentities(trx, orgId, batchIds)
  const candidateShape = candidates.map((identity) => [
    identity.entrypoint,
    identity.id,
    identity.sourceProof.sourceKind,
    identity.sourceProof.sourceRootId,
    identity.sourceProof.ordinal,
    identity.sourceProof.semanticFingerprint,
  ])
  const lockedShape = identities.map((identity) => [
    identity.entrypoint,
    identity.id,
    identity.sourceProof.sourceKind,
    identity.sourceProof.sourceRootId,
    identity.sourceProof.ordinal,
    identity.sourceProof.semanticFingerprint,
  ])
  if (JSON.stringify(candidateShape) !== JSON.stringify(lockedShape)) {
    fail('W4C3A_ROLLOUT_CONTROL_SOURCE_DRIFT')
  }
  await lockJobsBatchesAndItems(trx, orgId, batchIds)
  const targets = await loadTargets(trx, orgId, batchIds)
  // Control commands do not calculate; a durable source row, when present,
  // supplies the accepted posture. Legacy rows carry no W4 operation proof.
  const posture = identities.length === 0 ? 'legacy_projection_only' : identities[0].org.acceptedWritePosture
  if (!identities.every((identity) => identity.org.acceptedWritePosture === posture)) {
    fail('W4C3A_ROLLOUT_CONTROL_POSTURE_DRIFT')
  }
  await lockTargetsAndParents(trx, orgId, posture, targets)
  return posture
}

async function batchFingerprint(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchId: string,
): Promise<string> {
  const result = await trx.query(
    `SELECT encode(digest(jsonb_build_object(
              'batch', jsonb_build_object(
                'id', b.id::text, 'orgId', b.org_id,
                'idempotencyKey', to_jsonb(b)->'idempotency_key',
                'rowCount', b.row_count, 'status', b.status, 'meta', b.meta
              ),
              'items', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', i.id::text, 'userId', i.user_id, 'workDate', i.work_date,
                  'recordId', i.record_id::text, 'preview', i.preview_snapshot
                ) ORDER BY i.id)
                FROM attendance_import_items i
               WHERE i.org_id = b.org_id AND i.batch_id = b.id
              ), '[]'::jsonb)
            )::text, 'sha256'), 'hex') AS fingerprint
       FROM attendance_import_batches b
      WHERE b.org_id = $1 AND b.id = $2::uuid`,
    [orgId, batchId],
  )
  if (result.rows.length !== 1 || typeof result.rows[0].fingerprint !== 'string' || !HEX64.test(result.rows[0].fingerprint)) {
    fail('W4C3A_ROLLOUT_CONTROL_BATCH_NOT_FOUND')
  }
  return result.rows[0].fingerprint
}

async function allOrgBatchIds(trx: AttendanceW4TransactionClientV1, orgId: string): Promise<string[]> {
  const result = await trx.query(
    `SELECT id::text FROM attendance_import_batches WHERE org_id = $1 ORDER BY id`,
    [orgId],
  )
  return result.rows.map((row) => requireUuid(row.id, 'W4C3A_ROLLOUT_CONTROL_BATCH_INVALID'))
}

// ---------------------------------------------------------------------------
// Amendment section 3: additional database-backed transition predicates.
// Each locks (`FOR UPDATE`) the exact rows it inspects so a concurrent writer
// targeting the same rows blocks behind this transaction rather than racing
// its read. Every helper returns a values-free count; the caller decides
// applicability per the requested pair and fails closed with zero rollout DML
// before any predicate short-circuits.
// ---------------------------------------------------------------------------

/** Every rollout transition: every retryable V1 job's frozen posture must equal the pair's. */
async function countRetryableJobPostureMismatches(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  comparisonWritePosture: AttendanceAcceptedWritePostureV1,
): Promise<number> {
  const result = await trx.query(
    `SELECT id, w4_accepted_write_posture AS posture
       FROM attendance_import_jobs
      WHERE org_id = $1 AND w4_contract_version = 1 AND status = ANY($2::text[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, RETRYABLE_JOB_STATUSES],
  )
  return result.rows.filter((row) => row.posture !== comparisonWritePosture).length
}

/** Entry into shadow|eligible|authoritative: zero nonterminal null-version legacy job. */
async function countNonterminalNullVersionLegacyJobs(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<number> {
  const result = await trx.query(
    `SELECT id
       FROM attendance_import_jobs
      WHERE org_id = $1 AND w4_contract_version IS NULL AND status = ANY($2::text[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, NONTERMINAL_LEGACY_JOB_STATUSES],
  )
  return result.rows.length
}

/**
 * Entry into eligible|authoritative: lock section 9 — "Promotion drains or cancels every
 * incomplete org operation before changing posture." `attendance_result_operations`/
 * `attendance_result_operation_batches` `claimed` rows are NOT the target here: a deferred
 * commit-time constraint trigger (`attendance_w4_*_claimed_commit_guard`) makes a persisted
 * `claimed` row provably impossible — no transaction can ever commit while a row it touched is
 * still `claimed`, so that state is same-transaction-transient only and never durably visible to
 * this boundary. The durable incompleteness this bullet targets is the async V1 job layer: any
 * `attendance_import_jobs` row with `w4_contract_version = 1` not yet `completed` (queued,
 * running, or failed-pending-retry) is an incomplete org operation for promotion purposes.
 */
async function countIncompleteOperations(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<number> {
  const result = await trx.query(
    `SELECT id
       FROM attendance_import_jobs
      WHERE org_id = $1 AND w4_contract_version = 1 AND status <> 'completed'
      ORDER BY id
      FOR UPDATE`,
    [orgId],
  )
  return result.rows.length
}

/**
 * Entry into eligible|authoritative: zero unresolved `legacy_time_ingress_not_authoritative`
 * review. A `review_required` calculation is immutable and, by the durable pointer-guard
 * trigger, can never become a record's `current_calculation_id` (the pointer target must be
 * `authoritative` + `completed|reversed`), so "unresolved" cannot be defined against the
 * current pointer. It is instead exact against the append-only calculation history: the review
 * is unresolved while it remains the LATEST calculation appended for its record. A subsequent
 * calculation (any outcome) appended for the same record resolves it by definition — the
 * legacy-resolved instant itself is still never promoted (lock section 9 bullet 8), only
 * strictly zoned replacement evidence produces that later calculation.
 */
async function countUnresolvedIngressReviews(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<number> {
  const result = await trx.query(
    `SELECT r.id
       FROM attendance_records r
      WHERE r.org_id = $1
        AND EXISTS (
          SELECT 1
            FROM attendance_record_calculations c
           WHERE c.org_id = $1 AND c.attendance_record_id = r.id
             AND c.outcome_reason_code = 'legacy_time_ingress_not_authoritative'
             AND c.version = (
               SELECT MAX(c2.version)
                 FROM attendance_record_calculations c2
                WHERE c2.org_id = $1 AND c2.attendance_record_id = r.id
             )
        )
      ORDER BY r.id
      FOR UPDATE`,
    [orgId],
  )
  return result.rows.length
}

/**
 * Entry into eligible|authoritative: zero pending calculation-affecting request whose latest
 * snapshot is missing or `unsupported`. This is a narrower, mechanically-verifiable slice of
 * lock section 9 bullet 5 — it does NOT evaluate the "reversible" (approved-but-cancellable) half
 * or payload-staleness against live per-type request fields; see the amendment tracking note.
 */
async function countDefectivePendingRequestSnapshots(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<number> {
  const requests = await trx.query(
    `SELECT id::text AS id
       FROM attendance_requests
      WHERE org_id = $1 AND status = 'pending' AND request_type = ANY($2::text[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, ATTENDANCE_CALCULATION_AFFECTING_REQUEST_TYPES_V1 as unknown as string[]],
  )
  if (requests.rows.length === 0) return 0
  let defective = 0
  for (const request of requests.rows) {
    const snapshot = await trx.query(
      `SELECT attribution_snapshot AS "attributionSnapshot"
         FROM attendance_request_calculation_snapshots
        WHERE org_id = $1 AND request_id = $2::uuid
        ORDER BY version DESC
        LIMIT 1`,
      [orgId, request.id],
    )
    if (snapshot.rows.length === 0) {
      defective += 1
      continue
    }
    const posture = (snapshot.rows[0].attributionSnapshot as { posture?: unknown } | null)?.posture
    if (posture !== 'resolved_v2') defective += 1
  }
  return defective
}

function isRetryableControlPrecondition(error: unknown): boolean {
  return error instanceof AttendanceW4C3aRolloutControlError && [
    'W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH',
    'W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT',
  ].includes(error.code)
}

/**
 * An advisory-lock waiter can retain a SERIALIZABLE snapshot from before the
 * holder committed. The first post-lock precondition failure therefore gets
 * one whole-transaction retry; a genuinely invalid control action fails again
 * from a fresh snapshot. This is control-plane only and never retries DML.
 */
async function runControlTransaction<T>(
  connection: AttendanceW4TransactionClientV1,
  body: (trx: AttendanceW4TransactionClientV1) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runAttendanceResultOperationTransactionV1(connection, body)
    } catch (error) {
      if (attempt === 0 && isRetryableControlPrecondition(error)) continue
      throw error
    }
  }
}

export async function closeLegacyRollbackWindowV1(
  connection: AttendanceW4TransactionClientV1,
  rawInput: CloseLegacyRollbackWindowInputV1,
): Promise<AttendanceW4C3aRolloutControlResultV1> {
  const input = normalizeCloseInput(rawInput)
  return runControlTransaction(connection, async (trx) => {
    await acquireAttendanceCalculationRolloutLock(trx, parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId), 'exclusive')
    await afterExclusiveRolloutLockForTests?.('close')
    const posture = await lockControlDomain(trx, input.orgId, [input.batchId])
    const state = await loadBatchReferenceState(trx, input.orgId, input.batchId)
    if (
      state.batchStatus !== 'committed' ||
      state.closed ||
      state.hasFrozenPreimage ||
      state.hasW4Reference ||
      posture !== 'legacy_projection_only'
    ) {
      fail('W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT')
    }
    const fingerprint = await batchFingerprint(trx, input.orgId, input.batchId)
    await trx.query(
      `INSERT INTO attendance_import_rollback_closures
       (org_id, batch_id, batch_fingerprint, actor_id, actor_authorization_posture, reason_code, correlation_id)
       VALUES ($1, $2::uuid, $3, $4, 'operator', $5, $6)`,
      [input.orgId, input.batchId, fingerprint, input.actorId, input.reasonCode, input.correlationId],
    )
    await trx.query(
      `INSERT INTO attendance_calculation_rollout_events
       (org_id, prior_state, new_state, reason_code, engine_version, actor_id, evidence)
       VALUES ($1, NULL, 'legacy', $2, $3, $4, jsonb_build_object('batchId', $5::uuid, 'batchFingerprint', $6::text))`,
      [input.orgId, input.reasonCode, input.engineVersion, input.actorId, input.batchId, fingerprint],
    )
    return Object.freeze({ orgId: input.orgId, state: 'legacy' as const, batchId: input.batchId })
  })
}

export async function transitionAttendanceCalculationRolloutV1(
  connection: AttendanceW4TransactionClientV1,
  rawInput: TransitionAttendanceCalculationRolloutInputV1,
): Promise<AttendanceW4C3aRolloutControlResultV1> {
  const input = normalizeTransitionInput(rawInput)
  return runControlTransaction(connection, async (trx) => {
    const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
    await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'exclusive')
    await afterExclusiveRolloutLockForTests?.('transition')

    // Section 3 predicate 1: exact named org (`scope='synthetic_staging'` is enforced by the
    // durable CHECK constraint on every row this boundary can ever write).
    const orgAllowlisted = isAttendanceCalculationOrgAllowlistedV1(input.orgId)
    if (!orgAllowlisted) fail('W4C3A_ROLLOUT_CONTROL_ORG_NOT_ALLOWLISTED')

    const persisted = await lockRolloutStateForBootstrapOrRead(
      trx,
      input.orgId,
      input.actorId,
      input.engineVersion,
      input.expectedState,
      input.targetState,
      orgAllowlisted,
    )

    // Section 2.4 / completion gate 4: a stale caller belief about current state/version is
    // rejected under lock, with zero rollout DML, even though the input-time matrix check
    // already passed against the CLAIMED pair.
    if (persisted.state !== input.expectedState || persisted.version !== input.expectedVersion) {
      fail('W4C3A_ROLLOUT_CONTROL_STALE_EXPECTED_STATE')
    }
    const currentState = persisted.state
    // Re-derive from the authoritative post-lock state (identical to the input-time check by
    // construction once staleness has been ruled out, but never trusts the caller's claim alone).
    const legal = findLegalTransition(currentState, input.targetState)
    if (!legal) fail('W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION')

    const batchIds = await allOrgBatchIds(trx, input.orgId)
    await lockControlDomain(trx, input.orgId, batchIds)
    for (const batchId of batchIds) {
      const state = await loadBatchReferenceState(trx, input.orgId, batchId)
      if (!state.closed && !state.hasFrozenPreimage) fail('W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH')
    }

    const retryableJobMismatches = await countRetryableJobPostureMismatches(
      trx,
      input.orgId,
      legal.comparisonWritePosture,
    )
    if (retryableJobMismatches > 0) fail('W4C3A_ROLLOUT_CONTROL_RETRYABLE_JOB_POSTURE_MISMATCH')

    let nonterminalLegacyJobs = 0
    if (CALCULATION_ENTRY_TARGETS.has(input.targetState)) {
      nonterminalLegacyJobs = await countNonterminalNullVersionLegacyJobs(trx, input.orgId)
      if (nonterminalLegacyJobs > 0) fail('W4C3A_ROLLOUT_CONTROL_LEGACY_JOB_ACTIVE')
    }

    let incompleteOperations = 0
    let unresolvedReviews = 0
    let defectiveRequestSnapshots = 0
    if (ELIGIBILITY_AUTHORITY_TARGETS.has(input.targetState)) {
      incompleteOperations = await countIncompleteOperations(trx, input.orgId)
      if (incompleteOperations > 0) fail('W4C3A_ROLLOUT_CONTROL_INCOMPLETE_OPERATION')
      unresolvedReviews = await countUnresolvedIngressReviews(trx, input.orgId)
      if (unresolvedReviews > 0) fail('W4C3A_ROLLOUT_CONTROL_UNRESOLVED_REVIEW')
      defectiveRequestSnapshots = await countDefectivePendingRequestSnapshots(trx, input.orgId)
      if (defectiveRequestSnapshots > 0) fail('W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE')
    }

    await trx.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = $2, prior_state = state, engine_version = $3, reason_code = $4,
              actor_id = $5, changed_at = now(), version = version + 1
        WHERE org_id = $1`,
      [input.orgId, input.targetState, input.engineVersion, input.reasonCode, input.actorId],
    )
    await beforeEventInsertForTests?.()
    await trx.query(
      `INSERT INTO attendance_calculation_rollout_events
       (org_id, prior_state, new_state, reason_code, engine_version, actor_id, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.orgId,
        currentState,
        input.targetState,
        input.reasonCode,
        input.engineVersion,
        input.actorId,
        JSON.stringify({
          schemaVersion: 1,
          manifestSha256: input.evidenceManifestSha256,
          correlationId: input.correlationId,
          comparisonWritePosture: legal.comparisonWritePosture,
          preconditionCounts: {
            retryableJobPostureMismatches: retryableJobMismatches,
            nonterminalLegacyJobs,
            incompleteOperations,
            unresolvedReviews,
            defectiveRequestSnapshots,
          },
          references: input.evidenceReferences,
        }),
      ],
    )
    return Object.freeze({ orgId: input.orgId, state: input.targetState, batchId: null })
  })
}
