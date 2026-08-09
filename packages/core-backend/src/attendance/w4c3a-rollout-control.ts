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
 *
 * NIT-4 (PR #4773 exact-head independent gate, 20260805): "ONLY transition DML path" is exact
 * for `attendance_calculation_rollout_state` (`transitionAttendanceCalculationRolloutV1` is its
 * one writer). `closeLegacyRollbackWindowV1` in this same module is a SECOND writer of
 * `attendance_calculation_rollout_events` (never of rollout STATE) — a distinct, pre-existing,
 * unchanged-by-this-amendment operation. Precisely: this module is the only rollout-state DML
 * path, and the only place either rollout table may ever be written from.
 */
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationRolloutLockSessionExclusiveV1,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceResultOperationLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  isAttendanceCalculationOrgAllowlistedV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOperationIdentityV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  releaseAttendanceCalculationRolloutLockSessionExclusiveV1,
  type AttendanceAcceptedWritePostureV1,
  type AttendanceRolloutStateV1,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import { W4_TRANSACTION_STATEMENT_TIMEOUT_MS } from './w4c0-operation-contract'
import {
  ATTENDANCE_CALCULATION_AFFECTING_REQUEST_TYPES_V1,
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  extractAttendanceRequestPayloadMetadataFieldsV1,
  type AttendanceRequestCalculationPayloadV1,
} from './w4c3b-request-snapshots'

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
let beforeStateUpdateForTests: (() => Promise<void>) | null = null

/** Test-only deterministic barrier. It is not imported by production wiring. */
export function __setW4C3aRolloutControlAfterExclusiveLockForTests(
  hook: ((kind: 'close' | 'transition') => Promise<void>) | null,
): void {
  afterExclusiveRolloutLockForTests = hook
}

/**
 * Test-only atomicity seam (amendment completion gate 7, clause "a failed event insert leaves
 * state/version unchanged"): fires immediately before the rollout-event INSERT (the first DML of
 * the pair). It is not imported by production wiring.
 */
export function __setW4C3aRolloutControlBeforeEventInsertForTests(
  hook: (() => Promise<void>) | null,
): void {
  beforeEventInsertForTests = hook
}

/**
 * Test-only atomicity seam (amendment completion gate 7, clause "a failed state update leaves no
 * event"): fires after the rollout-event INSERT succeeds but before the rollout-state UPDATE (the
 * second DML of the pair). It is not imported by production wiring.
 */
export function __setW4C3aRolloutControlBeforeStateUpdateForTests(
  hook: (() => Promise<void>) | null,
): void {
  beforeStateUpdateForTests = hook
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
//
// RETRACTION (W4C-5 P1-2, PR #4773 exact-head independent gate, 20260805): this block
// previously asserted "each locks (`FOR UPDATE`) the exact rows it inspects so a concurrent
// writer targeting the same rows blocks behind this transaction rather than racing its read."
// That is false for every predicate here: each is INSERT-shaped (a brand-new
// attendance_import_jobs/attendance_records/attendance_record_calculations/attendance_requests
// row that did not exist in the snapshot), and `FOR UPDATE` only re-fetches the latest committed
// version of rows ALREADY visible to the transaction's snapshot — it cannot retroactively admit,
// or block the creation of, a row inserted after that snapshot was taken. What actually makes
// these reads trustworthy is `transitionAttendanceCalculationRolloutV1` acquiring the org
// rollout lock EXCLUSIVE at SESSION level, in its own statement, strictly before
// `BEGIN ISOLATION LEVEL SERIALIZABLE` is issued (see
// `acquireAttendanceCalculationRolloutLockSessionExclusiveV1` in w4c0-identity.ts) — this
// guarantees the SERIALIZABLE snapshot these predicates read under is taken strictly after every
// previous SHARED-lock holder (every legitimate job/record/request writer, lock section 9)
// released, so their commits are visible here. `FOR UPDATE` remains correct and load-bearing for
// its original purpose (re-evaluating UPDATE-shaped drift on rows already in scope), just not for
// admitting new rows.
//
// Every helper returns a values-free count; the caller decides applicability per the requested
// pair and fails closed with zero rollout DML before any predicate short-circuits.
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

/**
 * Resume only (`suspended -> authoritative`): amendment section 3 bullet 9 — "preserved
 * authoritative jobs remain retryable WITHOUT operation rows". A retryable V1 job
 * (`status IN ('queued','failed')`) that already has a durable `attendance_result_operations`
 * row for the SAME batch (`org_id` + `entrypoint` + `batch_command_id`/`w4_batch_command_id`)
 * already went through the async result-operation path at least once for that batch — per
 * "Correction 1" (`OPERATION_STATES = ['claimed','completed','canceled']`, deferred
 * commit-time constraint trigger), any such PERSISTED row is necessarily `completed` or
 * `canceled` (never `claimed`), so this is not a race with an in-flight claim; it is a durable
 * signal that this "retryable" job is not the untouched, purely-retryable job resume's
 * "remain retryable without operation rows" language requires. `FOR UPDATE OF j` locks only the
 * candidate job rows (the operation rows are immutable history once persisted, per the same
 * correction, so there is nothing on that side for a concurrent writer to race).
 */
async function countRetryableJobsWithOperationRows(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<number> {
  const result = await trx.query(
    `SELECT j.id
       FROM attendance_import_jobs j
       JOIN attendance_result_operations o
         ON o.org_id = j.org_id
        AND o.entrypoint = j.w4_entrypoint
        AND o.batch_command_id = j.w4_batch_command_id
      WHERE j.org_id = $1 AND j.w4_contract_version = 1 AND j.status = ANY($2::text[])
      ORDER BY j.id
      FOR UPDATE OF j`,
    [orgId, RETRYABLE_JOB_STATUSES],
  )
  return result.rows.length
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
 *
 * P3-1 (PR #4773 exact-head independent gate, 20260805): "resolves it by definition" is
 * deliberately outcome-agnostic — a later `review_required` calculation appended for a
 * DIFFERENT reason (e.g. `duplicate_check_in`, not `legacy_time_ingress_not_authoritative`)
 * still clears THIS predicate, because that later row is now the MAX(version) row and the
 * original `legacy_time_ingress_not_authoritative` row is no longer it. The record remains
 * unadjudicated in that case; this predicate is not the sole gate on record-level
 * adjudication, only on the specific legacy-ingress review this bullet names.
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

// ---------------------------------------------------------------------------
// W4C-5 §3 request-snapshot precondition — closed 8-cell set (issue #4775).
//
// The amendment (`docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-
// 20260804.md:96-98`) requires: "eligibility/authority has zero pending or reversible
// calculation-affecting request whose latest snapshot is missing, unsupported, payload-stale, or
// reversal-incomplete" = (pending | reversible) x (missing | unsupported | payload-stale |
// reversal-incomplete). PR #4773 implemented 2 of 8 cells (pending x {missing, unsupported}) and
// self-reported the remaining 6 as a verified, not-guessed, blocking gap (see that PR's "Weak
// spots" §1). This section closes all 8.
// ---------------------------------------------------------------------------

export const ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1 = Object.freeze([
  'pendingMissing',
  'pendingUnsupported',
  'pendingPayloadStale',
  'pendingReversalIncomplete',
  'reversibleMissing',
  'reversibleUnsupported',
  'reversiblePayloadStale',
  'reversibleReversalIncomplete',
] as const)

export type AttendanceRequestSnapshotDefectCellV1 =
  (typeof ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1)[number]

export type AttendanceRequestSnapshotDefectCountsV1 =
  Readonly<Record<AttendanceRequestSnapshotDefectCellV1, number>>

/**
 * `byCell` counts (request, defect-kind) PAIRS — a single request row can independently land in
 * more than one cell (e.g. `unsupported` and `reversal-incomplete` at once), since the four defect
 * checks are evaluated independently, not as a priority chain (see
 * `classifyAttendanceRequestSnapshotDefectsV1` below). `totalDefectiveRequests` counts DISTINCT
 * defective requests (0 or 1 per row) — the pre-existing `defectiveRequestSnapshots` evidence
 * field's semantic, preserved unchanged so the exact-shape evidence test's meaning does not shift
 * under an unrelated rename.
 */
export type AttendanceRequestSnapshotDefectReportV1 = Readonly<{
  totalDefectiveRequests: number
  byCell: AttendanceRequestSnapshotDefectCountsV1
}>

function emptyAttendanceRequestSnapshotDefectCounts(): Record<AttendanceRequestSnapshotDefectCellV1, number> {
  const out = {} as Record<AttendanceRequestSnapshotDefectCellV1, number>
  for (const cell of ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1) out[cell] = 0
  return out
}

/**
 * Recomputes the fingerprint the STORED snapshot `payload` column would produce under the exact
 * same domain-separated canonical-JSON hash the writers use
 * (`computeAttendanceRequestPayloadFingerprintV1`), rather than trusting the stored
 * `payload_fingerprint` column as a truthful proxy for the stored payload's own content (W4C-5 §3
 * owner-review P2, PR #4780). Returns `null` when the stored payload does not decode under the
 * writers' own closed-shape validator (`normalizeAttendanceRequestCalculationPayloadV1`, reached
 * through `computeAttendanceRequestPayloadFingerprintV1`) — a payload that cannot even be
 * re-hashed is itself proof the row is inconsistent, not something the caller should treat as a
 * pass. Every writer-produced row (append-boundary create/edit) always re-hashes successfully;
 * only a payload written or altered outside that boundary can fail here.
 */
function computeStoredRequestSnapshotPayloadFingerprintV1(rawPayload: unknown): string | null {
  try {
    return computeAttendanceRequestPayloadFingerprintV1(
      rawPayload as AttendanceRequestCalculationPayloadV1,
    )
  } catch {
    return null
  }
}

/**
 * Entry into eligible|authoritative: zero pending or reversible calculation-affecting request
 * whose latest snapshot is missing, unsupported, payload-stale, or reversal-incomplete.
 *
 * Bucket definitions (mechanically verified against the plugin, not assumed):
 *  - pending: `status = 'pending'`. Every calculation-affecting type can reach this state and can
 *    be cancelled from it through the shared cancel adapter.
 *  - reversible: `status = 'approved' AND request_type = 'leave'` — the ONLY combination the
 *    plugin's shared cancel adapter (`plugins/plugin-attendance/index.cjs`, `requestCancelAdapter`)
 *    permits to cancel an ALREADY-terminal (already-decided) request. `:34091` sets
 *    `approvedLeave = requestRow.status === 'approved' && requestRow.request_type === 'leave'`;
 *    `:34174` hard-blocks every other already-resolved request from reaching cancellation
 *    (`if (requestRow.status !== 'pending' && !approvedLeave) throw HttpError(400, ...)`). No
 *    other writer in `plugins/` or `packages/` sets `attendance_requests.status = 'cancelled'`
 *    (swept both raw-SQL and Kysely-builder syntax against current `origin/main`) — a request
 *    reaching `status = 'approved'` for a non-`leave` type is, today, terminal and never
 *    reversible. A future request type gaining a post-approval cancel path would need this bucket
 *    definition revisited explicitly, not silently inherited.
 *
 * Defect kinds:
 *  - missing: no snapshot row exists for the request.
 *  - unsupported: the latest snapshot's attribution posture is not `resolved_v2`.
 *  - payload-stale: a THREE-WAY hash join, not a one-sided fingerprint compare (W4C-5 §3
 *    owner-review P2, PR #4780). The pre-#4780 check only compared the recomputed live
 *    fingerprint against the STORED `payload_fingerprint` column — it never re-hashed the stored
 *    `payload` column itself. `chk_arcs_payload_fp` only shape-checks that column (`^[0-9a-f]
 *    {64}$`); nothing in the database binds it to the stored payload's actual content. A stored
 *    row whose `payload` is genuinely stale but whose `payload_fingerprint` field was written (by
 *    a bug, a direct write outside the append boundary, or tampering) to equal the LIVE row's
 *    fingerprint instead of a hash of the stale payload actually stored would satisfy that
 *    one-sided compare and pass through undetected — the whole point of a payload/fingerprint
 *    PAIR is defeated if only one side of the pair is ever independently verified. The fixed
 *    predicate instead requires `hash(storedPayload) == storedFingerprint == hash(livePayload)`;
 *    any of the three being unequal (including the stored payload failing to decode under the
 *    writers' own closed-shape validator at all) is `payload-stale`. Both hashes are computed via
 *    the same closed-payload/fingerprint functions the create/edit snapshot writers use
 *    (`buildAttendanceRequestCalculationPayloadFromRequestRowV1` +
 *    `computeAttendanceRequestPayloadFingerprintV1`) fed by
 *    `extractAttendanceRequestPayloadMetadataFieldsV1` for the type-specific
 *    `minutes`/`leaveTypeCode`/`outdoorPunch` fields (that function's own doc comment records why
 *    this is a full, not narrowed, live-payload reconstruction, and its one known weak spot: a
 *    second, non-shared copy of the plugin's identical field-extraction logic). A break anywhere
 *    in the three-way join means some writer mutated the request's calculation-affecting fields
 *    without appending a new snapshot version, or the stored pair itself is internally
 *    inconsistent — either way the OCC contract `appendAttendanceRequestEditSnapshotV1` requires
 *    of every in-boundary edit has been violated.
 *  - reversal-incomplete: the request's linked `approval_instances` row has been revoked
 *    (`status = 'cancelled'`) while the request itself is still `pending`/`approved` (bucket
 *    membership already guarantees "not yet cancelled/rejected"). This is the exact torn state a
 *    crash between the approval-revoke UPDATE and the request-status UPDATE inside the shared
 *    cancel adapter's single transaction (`index.cjs` `executeRequestCancel`, `:34208`-`:34250`)
 *    would leave, if that transaction's atomicity were ever violated by something outside normal
 *    PostgreSQL commit/rollback semantics (e.g. a legacy direct write). It is a data-consistency
 *    detector over the two tables, not a claim that the shared adapter itself is non-atomic — see
 *    this predicate-completion PR's body for the mechanical atomicity proof of that one adapter,
 *    and the closed-bucket note above for why no OTHER calculation-affecting type has a reversal
 *    path to prove atomic in the first place.
 */
async function classifyAttendanceRequestSnapshotDefectsV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<AttendanceRequestSnapshotDefectReportV1> {
  const byCell = emptyAttendanceRequestSnapshotDefectCounts()
  const requests = await trx.query(
    `SELECT id::text AS id,
            status::text AS status,
            work_date::text AS work_date,
            requested_in_at,
            requested_out_at,
            reason,
            metadata,
            approval_instance_id::text AS approval_instance_id
       FROM attendance_requests
      WHERE org_id = $1
        AND request_type = ANY($2::text[])
        AND (status = 'pending' OR (status = 'approved' AND request_type = 'leave'))
      ORDER BY id
      FOR UPDATE`,
    [orgId, ATTENDANCE_CALCULATION_AFFECTING_REQUEST_TYPES_V1 as unknown as string[]],
  )
  let totalDefectiveRequests = 0
  for (const request of requests.rows) {
    const bucket: 'pending' | 'reversible' = request.status === 'pending' ? 'pending' : 'reversible'
    let requestDefective = false

    const snapshot = await trx.query(
      `SELECT attribution_snapshot AS "attributionSnapshot",
              payload AS "payload",
              payload_fingerprint AS "payloadFingerprint"
         FROM attendance_request_calculation_snapshots
        WHERE org_id = $1 AND request_id = $2::uuid
        ORDER BY version DESC
        LIMIT 1`,
      [orgId, request.id],
    )
    if (snapshot.rows.length === 0) {
      byCell[`${bucket}Missing`] += 1
      requestDefective = true
    } else {
      const snapshotRow = snapshot.rows[0]
      const posture = (snapshotRow.attributionSnapshot as { posture?: unknown } | null)?.posture
      if (posture !== 'resolved_v2') {
        byCell[`${bucket}Unsupported`] += 1
        requestDefective = true
      }
      const liveMetadataFields = extractAttendanceRequestPayloadMetadataFieldsV1(request.metadata)
      const livePayload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
        workDate: request.work_date,
        requestedInAt: request.requested_in_at,
        requestedOutAt: request.requested_out_at,
        reason: request.reason,
        minutes: liveMetadataFields.minutes,
        leaveTypeCode: liveMetadataFields.leaveTypeCode,
        outdoorPunch: liveMetadataFields.outdoorPunch,
      })
      const liveFingerprint = computeAttendanceRequestPayloadFingerprintV1(livePayload)
      const storedFingerprint = String(snapshotRow.payloadFingerprint ?? '')
      const recomputedStoredFingerprint = computeStoredRequestSnapshotPayloadFingerprintV1(
        snapshotRow.payload,
      )
      // Three-way join (W4C-5 §3 owner-review P2, PR #4780): hash(storedPayload) ==
      // storedFingerprint == hash(livePayload). The pre-#4780 predicate compared only
      // `liveFingerprint === storedFingerprint` — a stored `payload_fingerprint` forged (or
      // corrupted) to equal the live value, while the stored `payload` itself stayed stale,
      // passed that one-sided compare undetected. Recomputing the stored side closes that gap:
      // it can no longer differ from what the row's OWN payload actually hashes to.
      //
      // Two conjuncts, not three: `recomputedStoredFingerprint !== null` is NOT a separate
      // discriminating check — `storedFingerprint` is always a string (`String(x ?? '')` below
      // never produces `null`), so `null === storedFingerprint` is already `false` without an
      // explicit guard. A stored payload that fails to decode (the `computeStoredRequest
      // SnapshotPayloadFingerprintV1` catch path) is caught by the FIRST conjunct failing to
      // match, not by a dedicated null branch — self-review round 2 (owner-review P2, PR #4780)
      // removed the redundant guard after a mutation leg showed no test could tell it apart from
      // simply deleting it.
      const storedPayloadSelfConsistent = recomputedStoredFingerprint === storedFingerprint
      const storedMatchesLive = storedFingerprint === liveFingerprint
      if (!storedPayloadSelfConsistent || !storedMatchesLive) {
        byCell[`${bucket}PayloadStale`] += 1
        requestDefective = true
      }
    }

    const approvalInstanceId =
      typeof request.approval_instance_id === 'string' && request.approval_instance_id.length > 0
        ? request.approval_instance_id
        : null
    if (approvalInstanceId) {
      const approval = await trx.query(
        `SELECT status::text AS status FROM approval_instances WHERE id = $1 FOR UPDATE`,
        [approvalInstanceId],
      )
      if (approval.rows.length === 1 && approval.rows[0].status === 'cancelled') {
        byCell[`${bucket}ReversalIncomplete`] += 1
        requestDefective = true
      }
    }

    if (requestDefective) totalDefectiveRequests += 1
  }
  return Object.freeze({ totalDefectiveRequests, byCell: Object.freeze(byCell) })
}

/**
 * §5-sanctioned read-only reporter shape ("a read-only `status`/`plan` command that emits
 * `PASS|BLOCKED` per predicate"): exposes the exact same classification the transition boundary
 * enforces, for direct per-cell assertion without needing to observe it indirectly through a
 * blocked-transition error. Performs zero DML. Callers own the transaction/locking; a caller that
 * wants a point-in-time read without contending the row locks below may run it in its own
 * short-lived transaction and roll back.
 */
export async function readAttendanceRequestSnapshotDefectReportV1(
  connection: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<AttendanceRequestSnapshotDefectReportV1> {
  return classifyAttendanceRequestSnapshotDefectsV1(connection, orgId)
}

// ---------------------------------------------------------------------------
// W4C-5 §5 tooling contract: "a read-only `status`/`plan` command that emits
// `PASS|BLOCKED` per predicate". This is the SOLE plan-report shape — the
// separately-gated operator tool (scripts/ops/) must call this rather than
// re-deriving any of section 1/3's logic itself (amendment section 2: "two
// competing transition implementations are forbidden"). It reuses the exact
// same private matrix/predicate helpers `transitionAttendanceCalculationRolloutV1`
// enforces, wrapped in a transaction this function ALWAYS rolls back — never
// commits, regardless of outcome — so it is mechanically zero-write even
// though several reused helpers issue `SELECT ... FOR UPDATE` (a lock taken
// and released within this function's own short-lived transaction, never a
// persisted change). Completion gate 4 applies unchanged: this report is
// advisory only and can go stale the instant it returns; only the boundary
// transaction's own re-evaluation under the exclusive rollout lock is ever
// authoritative.
// ---------------------------------------------------------------------------

export const ATTENDANCE_ROLLOUT_TRANSITION_PREDICATE_CODES_V1 = Object.freeze([
  'ORG_ALLOWLISTED',
  'ROLLOUT_ROW_RESOLVABLE',
  'LEGAL_TRANSITION_PAIR',
  'UNCLOSED_LEGACY_BATCH',
  'RETRYABLE_JOB_POSTURE_MISMATCH',
  'RETRYABLE_JOB_HAS_OPERATION_ROWS',
  'NONTERMINAL_LEGACY_JOB',
  'INCOMPLETE_OPERATION',
  'UNRESOLVED_INGRESS_REVIEW',
  'DEFECTIVE_REQUEST_SNAPSHOT',
] as const)

export type AttendanceRolloutTransitionPredicateCodeV1 =
  (typeof ATTENDANCE_ROLLOUT_TRANSITION_PREDICATE_CODES_V1)[number]

export type AttendanceRolloutTransitionPredicateV1 = Readonly<{
  code: AttendanceRolloutTransitionPredicateCodeV1
  applicable: boolean
  pass: boolean
  count: number | null
}>

export type AttendanceRolloutTransitionPlanInputV1 = Readonly<{
  orgId: string
  targetState: AttendanceRolloutStateV1
}>

export type AttendanceRolloutTransitionPlanV1 = Readonly<{
  orgId: string
  orgAllowlisted: boolean
  rowExists: boolean
  currentState: AttendanceRolloutStateV1
  currentVersion: number | null
  /**
   * The state the row transitioned FROM to reach `currentState` — i.e. the persisted
   * `attendance_calculation_rollout_state.prior_state` column, read (never written) by this
   * read-only reporter. `null` exactly when `currentState === 'legacy'` with no prior
   * transition ever recorded (a missing row, or a bootstrap row that has never transitioned) —
   * every other state always has a non-null `priorState`, enforced by the DB trigger
   * `attendance_w4_rollout_state_guard` (`prior_state must record the previous state`).
   * W4C-5 P2-1 (PR #4839 gate, 20260809): surfaced so the operator tool's idempotency
   * short-circuit can require the CALLER's asserted `--expected-state` to match the state the
   * row actually transitioned from, not just its current state/version — see that module's
   * `runAttendanceW4C5ApplyOrchestrationV1` for why current-state/version alone under-constrains
   * the no-op path (an illegal pair or a weaker manifest key set can both slip through a
   * state/version-only check).
   */
  priorState: AttendanceRolloutStateV1 | null
  targetState: AttendanceRolloutStateV1
  legalPair: boolean
  comparisonWritePosture: AttendanceAcceptedWritePostureV1 | null
  canBootstrap: boolean
  predicates: readonly AttendanceRolloutTransitionPredicateV1[]
  blocked: boolean
}>

function passVerdict(
  code: AttendanceRolloutTransitionPredicateCodeV1,
  applicable: boolean,
  pass: boolean,
  count: number | null,
): AttendanceRolloutTransitionPredicateV1 {
  return Object.freeze({ code, applicable, pass, count })
}

/**
 * Read-only sibling of `lockRolloutStateForBootstrapOrRead` used ONLY for planning: no `FOR
 * UPDATE`, and it never inserts a bootstrap row (a real bootstrap INSERT belongs exclusively to
 * the transactional boundary, never to a plan report that is always rolled back — issuing one
 * here even inside a rolled-back transaction would defeat the point of a dynamic zero-write
 * proof over the statements this function sends). A missing row is reported as `rowExists:
 * false` with the effective current state assumed `legacy` (the only state a missing row can
 * ever mean, matching the boundary's own bootstrap precondition), never fabricated.
 */
async function readRolloutStateForPlan(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<
  Readonly<{
    rowExists: boolean
    state: AttendanceRolloutStateV1
    version: number | null
    priorState: AttendanceRolloutStateV1 | null
  }>
> {
  const row = await trx.query(
    `SELECT state, version, prior_state FROM attendance_calculation_rollout_state WHERE org_id = $1`,
    [orgId],
  )
  if (row.rows.length === 0) return { rowExists: false, state: 'legacy', version: null, priorState: null }
  if (row.rows.length !== 1) fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
  const state = row.rows[0].state
  const version = row.rows[0].version
  const priorStateRaw = row.rows[0].prior_state
  if (typeof state !== 'string' || !TRANSITION_STATES.has(state as AttendanceRolloutStateV1)) {
    fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
  }
  // Enum-strict, matching `state` above: NULL is the only legal absence (see the type's doc
  // comment); any non-null value that is not one of the five ratified states fails closed rather
  // than being silently coerced to `null` or to `state`. Honest self-disclosure (same discipline
  // as the second `findLegalTransition` call this file already documents as unreachable-but-kept):
  // the DDL CHECK constraint `chk_acrs_prior_state`
  // (`CHECK (prior_state IS NULL OR prior_state IN (...ROLLOUT_STATES...))`,
  // zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts) already makes an
  // out-of-enum non-null value impossible to durably write on any live path today — mutating this
  // branch away leaves every test green. Kept as defense-in-depth against a future DDL widening
  // that removes the CHECK, never trusting the DB shape alone for a value this reporter surfaces
  // to a caller.
  if (priorStateRaw !== null && (typeof priorStateRaw !== 'string' || !TRANSITION_STATES.has(priorStateRaw as AttendanceRolloutStateV1))) {
    fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
  }
  return {
    rowExists: true,
    state: state as AttendanceRolloutStateV1,
    version,
    priorState: priorStateRaw === null ? null : (priorStateRaw as AttendanceRolloutStateV1),
  }
}

async function buildAttendanceRolloutTransitionPlanV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  targetState: AttendanceRolloutStateV1,
): Promise<AttendanceRolloutTransitionPlanV1> {
  const orgAllowlisted = isAttendanceCalculationOrgAllowlistedV1(orgId)
  const persisted = await readRolloutStateForPlan(trx, orgId)
  const currentState = persisted.state
  const legal = findLegalTransition(currentState, targetState)
  const canBootstrap = !persisted.rowExists && orgAllowlisted && currentState === 'legacy' && targetState === 'shadow'
  const rowResolvable = persisted.rowExists || canBootstrap

  const predicates: AttendanceRolloutTransitionPredicateV1[] = [
    passVerdict('ORG_ALLOWLISTED', true, orgAllowlisted, null),
    passVerdict('ROLLOUT_ROW_RESOLVABLE', true, rowResolvable, null),
    passVerdict('LEGAL_TRANSITION_PAIR', true, legal !== undefined, null),
  ]

  // The remaining predicates all require database reads against a real org; without an
  // allowlisted, resolvable row and a legal pair there is nothing further to safely evaluate —
  // matches the boundary's own fail-fast ordering (org allowlist, then row, then matrix, all
  // BEFORE any predicate in section 3 ever runs).
  if (orgAllowlisted && rowResolvable && legal) {
    const batchIds = await allOrgBatchIds(trx, orgId)
    let unclosedBatches = 0
    for (const batchId of batchIds) {
      const state = await loadBatchReferenceState(trx, orgId, batchId)
      if (!state.closed && !state.hasFrozenPreimage) unclosedBatches += 1
    }
    predicates.push(passVerdict('UNCLOSED_LEGACY_BATCH', true, unclosedBatches === 0, unclosedBatches))

    const retryableJobMismatches = await countRetryableJobPostureMismatches(trx, orgId, legal.comparisonWritePosture)
    predicates.push(
      passVerdict('RETRYABLE_JOB_POSTURE_MISMATCH', true, retryableJobMismatches === 0, retryableJobMismatches),
    )

    const resumePair = isResumePair(currentState, targetState)
    if (resumePair) {
      const retryableJobsWithOperationRows = await countRetryableJobsWithOperationRows(trx, orgId)
      predicates.push(
        passVerdict(
          'RETRYABLE_JOB_HAS_OPERATION_ROWS',
          true,
          retryableJobsWithOperationRows === 0,
          retryableJobsWithOperationRows,
        ),
      )
    } else {
      predicates.push(passVerdict('RETRYABLE_JOB_HAS_OPERATION_ROWS', false, true, null))
    }

    if (CALCULATION_ENTRY_TARGETS.has(targetState)) {
      const nonterminalLegacyJobs = await countNonterminalNullVersionLegacyJobs(trx, orgId)
      predicates.push(
        passVerdict('NONTERMINAL_LEGACY_JOB', true, nonterminalLegacyJobs === 0, nonterminalLegacyJobs),
      )
    } else {
      predicates.push(passVerdict('NONTERMINAL_LEGACY_JOB', false, true, null))
    }

    if (ELIGIBILITY_AUTHORITY_TARGETS.has(targetState)) {
      const incompleteOperations = await countIncompleteOperations(trx, orgId)
      predicates.push(
        passVerdict('INCOMPLETE_OPERATION', true, incompleteOperations === 0, incompleteOperations),
      )
      const unresolvedReviews = await countUnresolvedIngressReviews(trx, orgId)
      predicates.push(
        passVerdict('UNRESOLVED_INGRESS_REVIEW', true, unresolvedReviews === 0, unresolvedReviews),
      )
      const snapshotDefects = await classifyAttendanceRequestSnapshotDefectsV1(trx, orgId)
      predicates.push(
        passVerdict(
          'DEFECTIVE_REQUEST_SNAPSHOT',
          true,
          snapshotDefects.totalDefectiveRequests === 0,
          snapshotDefects.totalDefectiveRequests,
        ),
      )
    } else {
      predicates.push(passVerdict('INCOMPLETE_OPERATION', false, true, null))
      predicates.push(passVerdict('UNRESOLVED_INGRESS_REVIEW', false, true, null))
      predicates.push(passVerdict('DEFECTIVE_REQUEST_SNAPSHOT', false, true, null))
    }
  } else {
    for (const code of ATTENDANCE_ROLLOUT_TRANSITION_PREDICATE_CODES_V1) {
      if (code === 'ORG_ALLOWLISTED' || code === 'ROLLOUT_ROW_RESOLVABLE' || code === 'LEGAL_TRANSITION_PAIR') continue
      predicates.push(passVerdict(code, false, true, null))
    }
  }

  const blocked = predicates.some((predicate) => predicate.applicable && !predicate.pass)

  return Object.freeze({
    orgId,
    orgAllowlisted,
    rowExists: persisted.rowExists,
    currentState,
    currentVersion: persisted.version,
    priorState: persisted.priorState,
    targetState,
    legalPair: legal !== undefined,
    comparisonWritePosture: legal ? legal.comparisonWritePosture : null,
    canBootstrap,
    predicates: Object.freeze(predicates),
    blocked,
  })
}

/**
 * The tooling contract's read-only `plan` reporter. Performs ZERO persisted writes: the whole
 * body runs inside a transaction this function unconditionally rolls back in its `finally`
 * block — it NEVER issues `COMMIT`, on any path, including a thrown error. `connection` must be
 * idle (no already-open transaction) — the same discipline as every other multi-statement
 * boundary in this file.
 */
export async function planAttendanceCalculationRolloutTransitionV1(
  connection: AttendanceW4TransactionClientV1,
  rawInput: AttendanceRolloutTransitionPlanInputV1,
): Promise<AttendanceRolloutTransitionPlanV1> {
  if (typeof rawInput !== 'object' || rawInput === null) fail('W4C3A_ROLLOUT_CONTROL_INPUT_INVALID')
  const orgId = String(parseCanonicalAttendanceRolloutOrgKeyV1(rawInput.orgId))
  const targetState = requireRolloutState(rawInput.targetState, 'W4C3A_ROLLOUT_CONTROL_INPUT_INVALID')
  await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await connection.query("SELECT set_config('statement_timeout', $1, true)", [
      String(W4_TRANSACTION_STATEMENT_TIMEOUT_MS),
    ])
    return await buildAttendanceRolloutTransitionPlanV1(connection, orgId, targetState)
  } finally {
    // Unconditional ROLLBACK — never COMMIT — on every path, success or failure. This is what
    // turns "this function does not issue INSERT/UPDATE/DELETE" from a claim about the code
    // above into a mechanically enforced invariant about what the database ever durably
    // observes, even against a future edit inside `buildAttendanceRolloutTransitionPlanV1`
    // that accidentally added a write.
    await connection.query('ROLLBACK').catch(() => undefined)
  }
}

function isRetryableControlPrecondition(error: unknown): boolean {
  return error instanceof AttendanceW4C3aRolloutControlError && [
    'W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH',
    'W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT',
  ].includes(error.code)
}

/**
 * A caller that acquires its exclusive rollout lock with `pg_advisory_xact_lock` INSIDE an
 * already-BEGUN SERIALIZABLE transaction (`closeLegacyRollbackWindowV1`, unchanged by W4C-5 —
 * its lock section 9 predicates are the batch-closure ones, out of this amendment's scope) can
 * retain a snapshot from before the previous holder committed, because PostgreSQL fixes a
 * SERIALIZABLE snapshot at the START of the first statement executed — including one that
 * itself blocks. The first post-lock precondition failure therefore gets one whole-transaction
 * retry for that caller; a genuinely invalid control action fails again from a fresh snapshot.
 *
 * `transitionAttendanceCalculationRolloutV1` no longer depends on this retry for that purpose
 * (W4C-5 P1-2 fix): it acquires its exclusive lock at SESSION level, in its own statement,
 * strictly before this function is ever called — see
 * `acquireAttendanceCalculationRolloutLockSessionExclusiveV1` in w4c0-identity.ts — so the
 * transaction `runAttendanceResultOperationTransactionV1` opens here always has a snapshot that
 * postdates the wait. The retry remains in place for it too, as defense-in-depth against any
 * other transient SQLSTATE 40001/40P01-adjacent precondition race, never for DML.
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
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
  // W4C-5 P1-2 fix: the exclusive rollout lock is acquired at SESSION level, as its own
  // standalone statement, strictly BEFORE `BEGIN ISOLATION LEVEL SERIALIZABLE` is ever issued
  // on this connection (`runControlTransaction` -> `runAttendanceResultOperationTransactionV1`
  // opens that transaction). `connection` must therefore be idle (no open transaction) on
  // entry — the same precondition the function already had, since it always opened its own
  // transaction. See `acquireAttendanceCalculationRolloutLockSessionExclusiveV1`'s doc comment
  // for why this — and not any transaction-scoped acquisition, no matter how early inside the
  // transaction — is what makes every section 3 predicate below actually re-evaluate a snapshot
  // that postdates the wait. W4C-5 NEW-B hardening (PR #4773 gate, 20260805): that idle
  // precondition is no longer a comment-only claim — `acquireAttendanceCalculationRolloutLockSessionExclusiveV1`
  // now proves it (a `SAVEPOINT` probe) as its own first statement and fails closed with
  // `W4C0_ROLLOUT_LOCK_CONNECTION_NOT_IDLE` rather than silently running inside the caller's
  // pre-fixed snapshot.
  await acquireAttendanceCalculationRolloutLockSessionExclusiveV1(connection, orgKey)
  try {
    // Inside the try (not before it): a throwing test hook must still release the lock via the
    // `finally` below, not leak it.
    await afterExclusiveRolloutLockForTests?.('transition')
    return await runControlTransaction(connection, async (trx) => {
      // Section 3 predicate 1: exact named org (`scope='synthetic_staging'` is enforced by the
      // durable CHECK constraint on every row this boundary can ever write). P3-2 (PR #4773
      // exact-head independent gate, 20260805): this boundary itself only ever writes the
      // hardcoded literal 'synthetic_staging' (see `lockRolloutStateForBootstrapOrRead`'s
      // bootstrap INSERT below) — it never reads or application-validates `scope` the way the
      // canonical posture resolver does (`w4c0-identity.ts`, `fail('W4C0_ROLLOUT_SCOPE_INVALID')`).
      // That is asymmetric, not currently unsafe: a future widening of the DDL CHECK constraint
      // (`chk_acrs_scope`) would silently remove the ONLY thing standing between this write path
      // and a non-synthetic-staging row, since there is no independent application-level check
      // here to catch it. Flagged, not fixed here — adding a check against the current hardcoded
      // literal would be tautological; a real fix needs `scope` to become a live input this
      // boundary actually validates, which is a larger change than this amendment's scope.
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
      // Re-derive from the authoritative post-lock state. NIT-1 (PR #4773 exact-head independent
      // gate, 20260805): once the staleness check above has passed, `currentState` is provably
      // identical to `input.expectedState` (the pair already matrix-validated at input time in
      // `normalizeTransitionInput`), so this second `findLegalTransition` call is unreachable
      // dead code on any live path today — mutating it away leaves every test green. It is kept
      // deliberately as defense-in-depth against a future refactor that decouples `currentState`
      // from the staleness check above (e.g. reordering, or a new code path that reaches here
      // without going through `lockRolloutStateForBootstrapOrRead`'s exact-match guard) — never
      // trusts the caller's claim alone, only currently redundant with it.
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

      // Resume only (suspended -> authoritative), section 3 bullet 9 (P2-4, PR #4773 gate):
      // "preserved authoritative jobs remain retryable WITHOUT operation rows."
      let retryableJobsWithOperationRows = 0
      if (isResumePair(currentState, input.targetState)) {
        retryableJobsWithOperationRows = await countRetryableJobsWithOperationRows(trx, input.orgId)
        if (retryableJobsWithOperationRows > 0) fail('W4C3A_ROLLOUT_CONTROL_RETRYABLE_JOB_HAS_OPERATION_ROWS')
      }

      let nonterminalLegacyJobs = 0
      if (CALCULATION_ENTRY_TARGETS.has(input.targetState)) {
        nonterminalLegacyJobs = await countNonterminalNullVersionLegacyJobs(trx, input.orgId)
        if (nonterminalLegacyJobs > 0) fail('W4C3A_ROLLOUT_CONTROL_LEGACY_JOB_ACTIVE')
      }

      let incompleteOperations = 0
      let unresolvedReviews = 0
      let defectiveRequestSnapshots = 0
      let defectiveRequestSnapshotsByCell: AttendanceRequestSnapshotDefectCountsV1 =
        emptyAttendanceRequestSnapshotDefectCounts()
      if (ELIGIBILITY_AUTHORITY_TARGETS.has(input.targetState)) {
        incompleteOperations = await countIncompleteOperations(trx, input.orgId)
        if (incompleteOperations > 0) fail('W4C3A_ROLLOUT_CONTROL_INCOMPLETE_OPERATION')
        unresolvedReviews = await countUnresolvedIngressReviews(trx, input.orgId)
        if (unresolvedReviews > 0) fail('W4C3A_ROLLOUT_CONTROL_UNRESOLVED_REVIEW')
        const snapshotDefects = await classifyAttendanceRequestSnapshotDefectsV1(trx, input.orgId)
        defectiveRequestSnapshots = snapshotDefects.totalDefectiveRequests
        defectiveRequestSnapshotsByCell = snapshotDefects.byCell
        if (defectiveRequestSnapshots > 0) fail('W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE')
      }

      // Section 2.8 literal order: the event insert is attempted FIRST; the rollout-state UPDATE
      // happens only after it succeeds. Both share one transaction, so either order is atomic —
      // a failure at any point rolls back both — but this ordering also lets a same-transaction
      // failure-injection hook independently exercise each of gate 7's two clauses.
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
              retryableJobsWithOperationRows,
              nonterminalLegacyJobs,
              incompleteOperations,
              unresolvedReviews,
              defectiveRequestSnapshots,
              defectiveRequestSnapshotsByCell,
            },
            references: input.evidenceReferences,
          }),
        ],
      )
      await beforeStateUpdateForTests?.()
      await trx.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = $2, prior_state = state, engine_version = $3, reason_code = $4,
                actor_id = $5, changed_at = now(), version = version + 1
          WHERE org_id = $1`,
        [input.orgId, input.targetState, input.engineVersion, input.reasonCode, input.actorId],
      )
      return Object.freeze({ orgId: input.orgId, state: input.targetState, batchId: null })
    })
  } finally {
    // Released unconditionally, including on the input-validation/staleness/predicate-failure
    // paths above (all of which throw): a normal success or precondition rejection must never
    // leave the session holding this lock for the next checkout of this pooled connection.
    //
    // The `.catch(() => undefined)` is deliberate, not sloppy: a `finally` block that itself
    // throws REPLACES whatever the `try` block returned or threw — so an unguarded release
    // failure here (e.g. a dropped connection) would turn an already-COMMITTED transition into
    // a thrown exception, or replace a typed `W4C3A_ROLLOUT_CONTROL_*` predicate rejection with
    // an opaque connection error. Both are strictly worse than a lock outliving this call by one
    // dropped-connection's remaining lifetime — and PostgreSQL still releases every session-level
    // advisory lock automatically once the server observes that connection close (see
    // `acquireAttendanceCalculationRolloutLockSessionExclusiveV1`'s doc comment), so nothing here
    // is a permanent leak even when the release call itself fails.
    await releaseAttendanceCalculationRolloutLockSessionExclusiveV1(connection, orgKey).catch(() => undefined)
  }
}
