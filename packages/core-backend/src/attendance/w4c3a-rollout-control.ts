/**
 * W4C-3a internal rollout-control commands.
 *
 * These commands deliberately have no PluginServices, route, flag, or index
 * surface. They are the control-side half of the §7.9/§8.2 protocol only.
 * The current rollback route does not expose a transaction-bound coordinator
 * that can supply its direct-import class-10 identities to this module. Until
 * that interface exists, this module locks the complete durable *source* set
 * and refuses to claim rollback-versus-control race coverage.
 */
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceResultOperationLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOperationIdentityV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  type AttendanceRolloutStateV1,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'

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
const TRANSITION_STATES = new Set<AttendanceRolloutStateV1>([
  'legacy',
  'shadow',
  'eligible',
  'authoritative',
  'suspended',
])

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
  reasonCode: 'rollout_transition'
}>

export type AttendanceW4C3aRolloutControlResultV1 = Readonly<{
  orgId: string
  state: AttendanceRolloutStateV1
  batchId: string | null
}>

type SourceTarget = Readonly<{ userId: string; workDate: string }>
type BatchReferenceState = Readonly<{
  closed: boolean
  hasFrozenPreimage: boolean
  hasW4Reference: boolean
}>

let afterExclusiveRolloutLockForTests: ((kind: 'close' | 'transition') => Promise<void>) | null = null

/** Test-only deterministic barrier. It is not imported by production wiring. */
export function __setW4C3aRolloutControlAfterExclusiveLockForTests(
  hook: ((kind: 'close' | 'transition') => Promise<void>) | null,
): void {
  afterExclusiveRolloutLockForTests = hook
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) fail(code)
  return value
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) fail(code)
  return value
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

function normalizeTransitionInput(
  input: TransitionAttendanceCalculationRolloutInputV1,
): TransitionAttendanceCalculationRolloutInputV1 {
  if (!input || input.reasonCode !== 'rollout_transition' || !TRANSITION_STATES.has(input.targetState)) {
    fail('W4C3A_ROLLOUT_CONTROL_INPUT_INVALID')
  }
  return Object.freeze({
    orgId: String(parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)),
    actorId: requireText(input.actorId, 'W4C3A_ROLLOUT_CONTROL_ACTOR_INVALID'),
    correlationId: requireUuid(input.correlationId, 'W4C3A_ROLLOUT_CONTROL_CORRELATION_INVALID'),
    engineVersion: requireText(input.engineVersion, 'W4C3A_ROLLOUT_CONTROL_ENGINE_INVALID'),
    targetState: input.targetState,
    reasonCode: input.reasonCode,
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
        WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = ANY($2::uuid[])
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
        WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = ANY($2::uuid[])
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
      WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = ANY($2::uuid[])
      ORDER BY entrypoint, batch_command_id
      FOR UPDATE`,
    [orgId, batchIds],
  )
  await trx.query(
    `SELECT operation_id
       FROM attendance_result_operations
      WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = ANY($2::uuid[])
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

async function lockRolloutStateForTransition(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  actorId: string,
  engineVersion: string,
): Promise<AttendanceRolloutStateV1> {
  let row = await trx.query(
    `SELECT state FROM attendance_calculation_rollout_state WHERE org_id = $1 FOR UPDATE`,
    [orgId],
  )
  if (row.rows.length === 0) {
    await trx.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', $2, 'rollout_transition', $3, 1, NULL, 'synthetic_staging')
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, engineVersion, actorId],
    )
    row = await trx.query(
      `SELECT state FROM attendance_calculation_rollout_state WHERE org_id = $1 FOR UPDATE`,
      [orgId],
    )
  }
  if (row.rows.length !== 1 || !TRANSITION_STATES.has(row.rows[0].state as AttendanceRolloutStateV1)) {
    fail('W4C3A_ROLLOUT_CONTROL_STATE_INVALID')
  }
  return row.rows[0].state as AttendanceRolloutStateV1
}

async function loadBatchReferenceState(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchId: string,
): Promise<BatchReferenceState> {
  const result = await trx.query(
    `SELECT
       EXISTS(SELECT 1 FROM attendance_import_rollback_closures c WHERE c.org_id = $1 AND c.batch_id = $2::uuid) AS closed,
       EXISTS(SELECT 1 FROM attendance_record_calculations c WHERE c.org_id = $1 AND c.source_batch_id = $2::uuid AND c.parent_preimage_snapshot IS NOT NULL) AS "hasFrozenPreimage",
       (
         EXISTS(SELECT 1 FROM attendance_result_operation_batches b WHERE b.org_id = $1 AND b.entrypoint = 'import_batch' AND b.batch_command_id = $2::uuid)
         OR EXISTS(SELECT 1 FROM attendance_result_operations o WHERE o.org_id = $1 AND o.entrypoint = 'import_batch' AND o.batch_command_id = $2::uuid)
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
  if (typeof row.closed !== 'boolean' || typeof row.hasFrozenPreimage !== 'boolean' || typeof row.hasW4Reference !== 'boolean') {
    fail('W4C3A_ROLLOUT_CONTROL_REFERENCE_INVALID')
  }
  return { closed: row.closed, hasFrozenPreimage: row.hasFrozenPreimage, hasW4Reference: row.hasW4Reference }
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
                'id', b.id::text, 'orgId', b.org_id, 'idempotencyKey', b.idempotency_key,
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
  if (result.rows.length !== 1 || typeof result.rows[0].fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(result.rows[0].fingerprint)) {
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
    if (state.closed || state.hasFrozenPreimage || state.hasW4Reference || posture !== 'legacy_projection_only') {
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
    await acquireAttendanceCalculationRolloutLock(trx, parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId), 'exclusive')
    await afterExclusiveRolloutLockForTests?.('transition')
    const currentState = await lockRolloutStateForTransition(trx, input.orgId, input.actorId, input.engineVersion)
    const batchIds = await allOrgBatchIds(trx, input.orgId)
    await lockControlDomain(trx, input.orgId, batchIds)
    for (const batchId of batchIds) {
      const state = await loadBatchReferenceState(trx, input.orgId, batchId)
      if (!state.closed && !state.hasFrozenPreimage) fail('W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH')
    }
    if (currentState === input.targetState) fail('W4C3A_ROLLOUT_CONTROL_TRANSITION_CONFLICT')
    await trx.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = $2, prior_state = state, engine_version = $3, reason_code = $4,
              actor_id = $5, changed_at = now(), version = version + 1
        WHERE org_id = $1`,
      [input.orgId, input.targetState, input.engineVersion, input.reasonCode, input.actorId],
    )
    await trx.query(
      `INSERT INTO attendance_calculation_rollout_events
       (org_id, prior_state, new_state, reason_code, engine_version, actor_id, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
      [input.orgId, currentState, input.targetState, input.reasonCode, input.engineVersion, input.actorId],
    )
    return Object.freeze({ orgId: input.orgId, state: input.targetState, batchId: null })
  })
}
