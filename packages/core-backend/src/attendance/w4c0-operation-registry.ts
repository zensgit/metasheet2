/**
 * W4C-0 (#4556) Stage C — canonical operation-registry service layer:
 * claim / seal / cancel / replay / congruence over the durable batch/item
 * registries, the transaction-bound outbox enqueue, and the P07 V1 job
 * reservation enqueue (lock sections 4.1, 7.1, 7.1a, 8.1, 8.2; amendment 1.3).
 *
 * ZERO caller cutover: no production route/worker imports this module in W4C-0.
 * Every function is transaction-bound — it accepts the canonical `trx` and never
 * opens, owns, commits, or retries another transaction. The only transaction
 * owner is `runAttendanceResultOperationTransactionV1`, the section 8.2
 * SERIALIZABLE wrapper (also un-imported by production code in this slice).
 *
 * Protocol summary (section 8.2 steps 1-2, implemented by
 * `attendanceResultOperationPreflightV1`):
 *  1. verify the branded authorization witness (+capability/entrypoint matrix,
 *     org binding) and recheck membership in SQL;
 *  2. non-locking-read existing exact batch/item operation keys in stable order:
 *     an all-completed congruent state returns the stored responses with zero
 *     DML — even while currently suspended;
 *  3. otherwise acquire the org rollout SHARED advisory lock, resolve posture:
 *     suspended returns the closed synchronous outcome with zero DML;
 *  4. otherwise mint the verified org/operation identities, acquire the
 *     canonical exclusive class-`10` identity locks, re-read under those locks:
 *     all-completed congruent replays, all-new claims `claimed` rows in stable
 *     order, and every mixed/incomplete/non-congruent state fails closed 409;
 *  5. the caller (a later slice's private adapter path) seals or cancels every
 *     claimed row in the same transaction — the Stage A deferred constraint
 *     rejects any committed `claimed` row.
 *
 * Values-free discipline: closed codes only; no caller value is echoed.
 */
import type {
  AttendanceSourceEntrypointV1,
  AttendanceW4TransactionClientV1,
  VerifiedAttendanceOperationIdentityV1,
  VerifiedAttendanceOrgIdentityV1,
} from './w4c0-identity'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceResultOperationLocks,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  deriveAttendanceOperationCandidateIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  requireVerifiedAttendanceOperationIdentityV1,
  requireVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
} from './w4c0-identity'
import {
  requireAuthorizedCapabilityForEntrypointV1,
  recheckAttendanceAuthorizationInTransactionV1,
  type AuthorizedAttendanceWriteContextV1,
} from './w4c0-authorization'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
  type AttendanceOperationItemFingerprintEntryV1,
} from './w4c0-fingerprints'
import {
  ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1,
  AttendanceW4OperationError,
  W4_MAX_BATCH_ITEMS,
  W4_TRANSACTION_LOCK_TIMEOUT_MS,
  W4_TRANSACTION_MAX_RETRIES,
  W4_TRANSACTION_STATEMENT_TIMEOUT_MS,
  type AttendanceW4OutboxEventKindV1,
} from './w4c0-operation-contract'

export class AttendanceW4RegistryError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4RegistryError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4RegistryError(code)
}

function conflict(code: 'ATTENDANCE_OPERATION_CONFLICT' | 'ATTENDANCE_OPERATION_BATCH_CONFLICT'): never {
  throw new AttendanceW4OperationError(code)
}

const LOWER_HEX_64 = /^[0-9a-f]{64}$/

function requireHex64(value: unknown, code: string): string {
  if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) fail(code)
  return value
}

// ---------------------------------------------------------------------------
// Envelope-side inputs (normalized by the strict boundary before this layer).
// ---------------------------------------------------------------------------

export interface AttendanceOperationCommandInputV1 {
  /** Closed source tuple for the identity factory; null = legacy null-ID command. */
  readonly source: unknown | null
  /** Exact pre-source command fingerprint (64 lowercase hex). */
  readonly commandFingerprint: string
  /** Import/integration items only: closed immutable business-input snapshot. */
  readonly normalizedBusinessInputSnapshot?: unknown
}

export interface AttendanceOperationBatchInputV1 {
  readonly source: unknown
  readonly commandFingerprint: string
  /** Canonical input order; item ordinals must be exactly 0..n-1 in this order. */
  readonly items: readonly AttendanceOperationCommandInputV1[]
}

export interface AttendanceResultOperationEnvelopeInputV1 {
  readonly orgId: unknown
  readonly entrypoint: AttendanceSourceEntrypointV1
  readonly batch: AttendanceOperationBatchInputV1 | null
  /** Single commands (exactly one in W4C-0's synchronous shape) when batch is null. */
  readonly commands: readonly AttendanceOperationCommandInputV1[]
}

// ---------------------------------------------------------------------------
// Stored-row congruence (lock 7.1 replay rules).
// ---------------------------------------------------------------------------

interface StoredOperationRow {
  operation_id: string
  batch_command_id: string | null
  identity_source_kind: string
  source_ref: string
  actor_id: string
  actor_posture: string
  token_subject_user_id: string | null
  capability: string
  subject_scope: unknown
  command_fingerprint: string
  accepted_write_posture: string
  state: string
  response_snapshot: unknown
}

interface StoredBatchRow {
  batch_command_id: string
  identity_source_kind: string
  source_ref: string
  actor_id: string
  actor_posture: string
  token_subject_user_id: string | null
  capability: string
  subject_scope: unknown
  command_fingerprint: string
  accepted_write_posture: string
  item_count: number
  item_sequence_fingerprint: string
  item_set_fingerprint: string
  state: string
  response_snapshot: unknown
}

function subjectScopeCongruent(stored: unknown, expected: unknown): boolean {
  try {
    return canonicalAttendanceJsonV1(stored) === canonicalAttendanceJsonV1(expected)
  } catch {
    return false
  }
}

/**
 * Same key plus byte-equal actor ID, actor posture, token subject, source ref,
 * subject scope, capability, and command payload fingerprint is congruent. The
 * accepted rollout posture is deliberately NOT compared: a retry after a rollout
 * transition returns the stored result rather than re-executing (lock 7.1).
 */
function operationRowCongruent(
  row: StoredOperationRow,
  auth: AuthorizedAttendanceWriteContextV1,
  sourceKind: string,
  commandFingerprint: string,
): boolean {
  return (
    row.identity_source_kind === sourceKind &&
    row.actor_id === auth.actorId &&
    row.actor_posture === auth.actorPosture &&
    (row.token_subject_user_id ?? null) === auth.tokenSubjectUserId &&
    row.capability === auth.capability &&
    row.source_ref === auth.sourceRef &&
    subjectScopeCongruent(row.subject_scope, auth.subjectScope) &&
    row.command_fingerprint === commandFingerprint
  )
}

function batchRowCongruent(
  row: StoredBatchRow,
  auth: AuthorizedAttendanceWriteContextV1,
  sourceKind: string,
  commandFingerprint: string,
  itemCount: number,
  itemSequenceFingerprint: string,
  itemSetFingerprint: string,
): boolean {
  return (
    row.identity_source_kind === sourceKind &&
    row.actor_id === auth.actorId &&
    row.actor_posture === auth.actorPosture &&
    (row.token_subject_user_id ?? null) === auth.tokenSubjectUserId &&
    row.capability === auth.capability &&
    row.source_ref === auth.sourceRef &&
    subjectScopeCongruent(row.subject_scope, auth.subjectScope) &&
    row.command_fingerprint === commandFingerprint &&
    row.item_count === itemCount &&
    row.item_sequence_fingerprint === itemSequenceFingerprint &&
    row.item_set_fingerprint === itemSetFingerprint
  )
}

const OPERATION_ROW_COLUMNS =
  'operation_id::text AS operation_id, batch_command_id::text AS batch_command_id, identity_source_kind, source_ref, actor_id, actor_posture, token_subject_user_id, capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot'

const BATCH_ROW_COLUMNS =
  'batch_command_id::text AS batch_command_id, identity_source_kind, source_ref, actor_id, actor_posture, token_subject_user_id, capability, subject_scope, command_fingerprint, accepted_write_posture, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot'

async function readOperationRows(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  entrypoint: string,
  operationIds: readonly string[],
): Promise<Map<string, StoredOperationRow>> {
  if (operationIds.length === 0) return new Map()
  // Stable order (lock 8.2 step 1: read exact keys in stable order).
  const result = await trx.query(
    `SELECT ${OPERATION_ROW_COLUMNS}
       FROM attendance_result_operations
      WHERE org_id = $1 AND entrypoint = $2 AND operation_id = ANY($3::uuid[])
      ORDER BY operation_id`,
    [orgId, entrypoint, operationIds],
  )
  const map = new Map<string, StoredOperationRow>()
  for (const row of result.rows) {
    map.set((row as unknown as StoredOperationRow).operation_id, row as unknown as StoredOperationRow)
  }
  return map
}

async function readBatchRow(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  entrypoint: string,
  batchCommandId: string,
): Promise<StoredBatchRow | null> {
  const result = await trx.query(
    `SELECT ${BATCH_ROW_COLUMNS}
       FROM attendance_result_operation_batches
      WHERE org_id = $1 AND entrypoint = $2 AND batch_command_id = $3::uuid`,
    [orgId, entrypoint, batchCommandId],
  )
  if (result.rows.length === 0) return null
  return result.rows[0] as unknown as StoredBatchRow
}

// ---------------------------------------------------------------------------
// Normalized envelope plan (candidate identities + fingerprints).
// ---------------------------------------------------------------------------

interface EnvelopePlan {
  readonly orgKey: string
  readonly entrypoint: AttendanceSourceEntrypointV1
  readonly batch: {
    readonly batchCommandId: string
    readonly sourceKind: string
    readonly commandFingerprint: string
    readonly itemCount: number
    readonly itemSequenceFingerprint: string
    readonly itemSetFingerprint: string
  } | null
  /** Sourced commands (identity-bearing), in canonical input order. */
  readonly sourced: Array<{
    readonly input: AttendanceOperationCommandInputV1
    readonly candidateOperationId: string
    readonly sourceKind: string
    readonly ordinal: string | null
  }>
  readonly legacyNullIdCount: number
}

function planEnvelope(envelope: AttendanceResultOperationEnvelopeInputV1): EnvelopePlan {
  const code = 'W4C0_ENVELOPE_INVALID'
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(envelope.orgId) as string
  const entrypoint = envelope.entrypoint
  const hasBatch = envelope.batch !== null
  const commands = envelope.commands
  if (hasBatch && commands.length > 0) fail(code)
  if (!hasBatch && commands.length === 0) fail(code)

  const sourced: EnvelopePlan['sourced'] = []
  let legacyNullIdCount = 0
  let batchPlan: EnvelopePlan['batch'] = null

  if (hasBatch) {
    const batch = envelope.batch as AttendanceOperationBatchInputV1
    if (!Array.isArray(batch.items) || batch.items.length === 0) fail(code)
    // Bounded atomicity validated before batch/source DML (lock 7.1).
    if (batch.items.length > W4_MAX_BATCH_ITEMS) {
      throw new AttendanceW4OperationError('W4_BATCH_LIMIT_EXCEEDED')
    }
    const batchCandidate = deriveAttendanceOperationCandidateIdentityV1(batch.source)
    if (batchCandidate.kind !== 'batch' || batchCandidate.entrypoint !== entrypoint) fail(code)
    const batchFingerprint = requireHex64(batch.commandFingerprint, code)
    const entries: AttendanceOperationItemFingerprintEntryV1[] = []
    batch.items.forEach((item, index) => {
      if (item.source === null) fail('W4C0_BATCH_ITEM_SOURCE_REQUIRED')
      const candidate = deriveAttendanceOperationCandidateIdentityV1(item.source)
      if (candidate.kind !== 'item' || candidate.entrypoint !== entrypoint) fail(code)
      // Amendment 1.3: the persisted proof vector requires ordinal === array index.
      if (candidate.ordinal === null || candidate.ordinal !== String(index)) {
        fail('W4C0_BATCH_ITEM_ORDINAL_MISMATCH')
      }
      const fingerprint = requireHex64(item.commandFingerprint, code)
      entries.push({ ordinal: candidate.ordinal, operationId: candidate.operationId, commandFingerprint: fingerprint })
      sourced.push({
        input: item,
        candidateOperationId: candidate.operationId,
        sourceKind: candidate.sourceKind,
        ordinal: candidate.ordinal,
      })
    })
    // One batch ID reused as an item calculation-operation ID is a conflict shape.
    if (sourced.some((item) => item.candidateOperationId === batchCandidate.operationId)) {
      conflict('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    }
    // Duplicate derived item IDs inside one batch fail before DML.
    if (new Set(sourced.map((item) => item.candidateOperationId)).size !== sourced.length) {
      conflict('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    }
    batchPlan = {
      batchCommandId: batchCandidate.operationId,
      sourceKind: batchCandidate.sourceKind,
      commandFingerprint: batchFingerprint,
      itemCount: batch.items.length,
      itemSequenceFingerprint: computeAttendanceItemSequenceFingerprintV1(entries),
      itemSetFingerprint: computeAttendanceItemSetFingerprintV1(entries),
    }
  } else {
    for (const command of commands) {
      requireHex64(command.commandFingerprint, code)
      if (command.source === null) {
        legacyNullIdCount += 1
        continue
      }
      const candidate = deriveAttendanceOperationCandidateIdentityV1(command.source)
      if (candidate.kind !== 'item' || candidate.entrypoint !== entrypoint) fail(code)
      sourced.push({
        input: command,
        candidateOperationId: candidate.operationId,
        sourceKind: candidate.sourceKind,
        ordinal: null,
      })
    }
    if (new Set(sourced.map((item) => item.candidateOperationId)).size !== sourced.length) {
      conflict('ATTENDANCE_OPERATION_CONFLICT')
    }
  }

  return { orgKey, entrypoint, batch: batchPlan, sourced, legacyNullIdCount }
}

// ---------------------------------------------------------------------------
// Replay classification (shared by the pre-lock and under-lock reads).
// ---------------------------------------------------------------------------

export interface AttendanceOperationReplayResponsesV1 {
  readonly batchResponse: unknown | null
  readonly itemResponses: Readonly<Record<string, unknown>>
}

type Classification =
  | { readonly kind: 'all_new' }
  | { readonly kind: 'all_completed_congruent'; readonly responses: AttendanceOperationReplayResponsesV1 }
  | { readonly kind: 'inconclusive' }

function classify(
  plan: EnvelopePlan,
  auth: AuthorizedAttendanceWriteContextV1,
  batchRow: StoredBatchRow | null,
  operationRows: Map<string, StoredOperationRow>,
  strict: boolean,
): Classification {
  const anyExisting = batchRow !== null || operationRows.size > 0
  if (!anyExisting) return { kind: 'all_new' }

  const inconclusive = (
    code: 'ATTENDANCE_OPERATION_CONFLICT' | 'ATTENDANCE_OPERATION_BATCH_CONFLICT',
  ): Classification => {
    // Pre-lock (non-strict): a missing/incomplete/mixed/non-congruent state is
    // "not a completed replay" — the caller continues to the locked protocol.
    // Under locks (strict): the same state is a closed 409 conflict.
    if (strict) conflict(code)
    return { kind: 'inconclusive' }
  }

  if (plan.batch !== null) {
    if (batchRow === null) return inconclusive('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    if (batchRow.state !== 'completed') return inconclusive('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    if (
      !batchRowCongruent(
        batchRow,
        auth,
        plan.batch.sourceKind,
        plan.batch.commandFingerprint,
        plan.batch.itemCount,
        plan.batch.itemSequenceFingerprint,
        plan.batch.itemSetFingerprint,
      )
    ) {
      return inconclusive('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    }
    if (operationRows.size !== plan.sourced.length) return inconclusive('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    const itemResponses: Record<string, unknown> = {}
    for (const item of plan.sourced) {
      const row = operationRows.get(item.candidateOperationId)
      if (!row) return inconclusive('ATTENDANCE_OPERATION_BATCH_CONFLICT')
      if (row.state !== 'completed') return inconclusive('ATTENDANCE_OPERATION_BATCH_CONFLICT')
      // An item attached to another batch (or detached) fails closed.
      if (row.batch_command_id !== plan.batch.batchCommandId) {
        return inconclusive('ATTENDANCE_OPERATION_BATCH_CONFLICT')
      }
      if (!operationRowCongruent(row, auth, item.sourceKind, item.input.commandFingerprint)) {
        return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
      }
      itemResponses[item.candidateOperationId] = row.response_snapshot
    }
    return {
      kind: 'all_completed_congruent',
      responses: { batchResponse: batchRow.response_snapshot, itemResponses: Object.freeze(itemResponses) },
    }
  }

  // Single-command envelope.
  if (batchRow !== null) return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
  if (plan.legacyNullIdCount > 0 && operationRows.size > 0) {
    // A null-ID command cannot be part of a replayable set.
    return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
  }
  if (operationRows.size !== plan.sourced.length) return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
  const itemResponses: Record<string, unknown> = {}
  for (const item of plan.sourced) {
    const row = operationRows.get(item.candidateOperationId)
    if (!row) return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
    // A canceled or claimed row is never a completed replay (two-read note in
    // HANDOFF-W4C0.md: a canceled key requires a new command identity).
    if (row.state !== 'completed') return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
    if (row.batch_command_id !== null) return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
    if (!operationRowCongruent(row, auth, item.sourceKind, item.input.commandFingerprint)) {
      return inconclusive('ATTENDANCE_OPERATION_CONFLICT')
    }
    itemResponses[item.candidateOperationId] = row.response_snapshot
  }
  return {
    kind: 'all_completed_congruent',
    responses: { batchResponse: null, itemResponses: Object.freeze(itemResponses) },
  }
}

// ---------------------------------------------------------------------------
// Claim (all-new; stable order; state='claimed').
// ---------------------------------------------------------------------------

async function insertClaimedBatchRow(
  trx: AttendanceW4TransactionClientV1,
  org: VerifiedAttendanceOrgIdentityV1,
  identity: VerifiedAttendanceOperationIdentityV1,
  auth: AuthorizedAttendanceWriteContextV1,
  plan: NonNullable<EnvelopePlan['batch']>,
): Promise<void> {
  await trx.query(
    `INSERT INTO attendance_result_operation_batches (
        org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id,
        source_ref, actor_id, actor_posture, token_subject_user_id, capability,
        subject_scope, accepted_write_posture, command_fingerprint,
        item_count, item_sequence_fingerprint, item_set_fingerprint, state
      ) VALUES ($1,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,'claimed')`,
    [
      org.orgId,
      identity.entrypoint,
      identity.id,
      identity.sourceProof.sourceKind,
      identity.sourceProof.sourceRootId,
      auth.sourceRef,
      auth.actorId,
      auth.actorPosture,
      auth.tokenSubjectUserId,
      auth.capability,
      canonicalAttendanceJsonV1(auth.subjectScope),
      org.acceptedWritePosture,
      plan.commandFingerprint,
      plan.itemCount,
      plan.itemSequenceFingerprint,
      plan.itemSetFingerprint,
    ],
  )
}

async function insertClaimedItemRow(
  trx: AttendanceW4TransactionClientV1,
  org: VerifiedAttendanceOrgIdentityV1,
  identity: VerifiedAttendanceOperationIdentityV1,
  auth: AuthorizedAttendanceWriteContextV1,
  commandFingerprint: string,
  batchCommandId: string | null,
  ordinal: string | null,
  normalizedBusinessInputSnapshot: unknown,
): Promise<void> {
  const proof = identity.sourceProof
  const snapshotJson =
    normalizedBusinessInputSnapshot === undefined || normalizedBusinessInputSnapshot === null
      ? null
      : canonicalAttendanceJsonV1(normalizedBusinessInputSnapshot)
  await trx.query(
    `INSERT INTO attendance_result_operations (
        org_id, entrypoint, operation_id, batch_command_id, input_ordinal,
        identity_source_kind, source_root_id, proof_semantic_fingerprint,
        proof_user_id, proof_work_date, source_ref, actor_id, actor_posture,
        token_subject_user_id, capability, subject_scope, command_fingerprint,
        accepted_write_posture, state, normalized_business_input_snapshot
      ) VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8,$9::uuid,$10::date,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,'claimed',$19::jsonb)`,
    [
      org.orgId,
      identity.entrypoint,
      identity.id,
      batchCommandId,
      ordinal === null ? null : Number(ordinal),
      proof.sourceKind,
      proof.sourceRootId,
      proof.semanticFingerprint,
      proof.userId,
      proof.workDate,
      auth.sourceRef,
      auth.actorId,
      auth.actorPosture,
      auth.tokenSubjectUserId,
      auth.capability,
      canonicalAttendanceJsonV1(auth.subjectScope),
      commandFingerprint,
      org.acceptedWritePosture,
      snapshotJson,
    ],
  )
}

// ---------------------------------------------------------------------------
// Preflight (section 8.2 steps 1-2).
// ---------------------------------------------------------------------------

export type AttendanceResultOperationPreflightResultV1 =
  | { readonly kind: 'replay'; readonly responses: AttendanceOperationReplayResponsesV1 }
  | { readonly kind: 'suspended' }
  | {
      readonly kind: 'claimed'
      readonly org: VerifiedAttendanceOrgIdentityV1
      readonly batchIdentity: VerifiedAttendanceOperationIdentityV1 | null
      readonly itemIdentities: readonly VerifiedAttendanceOperationIdentityV1[]
      readonly legacyNullIdCount: number
    }
  | {
      /** legacy_projection_only with ONLY null-ID commands: no operation row at all. */
      readonly kind: 'legacy_no_operation'
      readonly org: VerifiedAttendanceOrgIdentityV1
      readonly legacyNullIdCount: number
    }

export async function attendanceResultOperationPreflightV1(
  trx: AttendanceW4TransactionClientV1,
  authorization: unknown,
  envelope: AttendanceResultOperationEnvelopeInputV1,
): Promise<AttendanceResultOperationPreflightResultV1> {
  const plan = planEnvelope(envelope)
  // Step 1: branded authorization covers every envelope item; org binding; SQL recheck.
  const auth = requireAuthorizedCapabilityForEntrypointV1(authorization, plan.entrypoint)
  if (auth.orgId !== plan.orgKey) {
    throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  await recheckAttendanceAuthorizationInTransactionV1(trx, auth)

  // Step 1 (cont.): non-locking read of exact keys in stable order — an
  // all-completed congruent replay returns with zero DML even under suspension.
  const candidateIds = plan.sourced.map((item) => item.candidateOperationId).sort()
  const preBatchRow = plan.batch ? await readBatchRow(trx, plan.orgKey, plan.entrypoint, plan.batch.batchCommandId) : null
  const preRows = await readOperationRows(trx, plan.orgKey, plan.entrypoint, candidateIds)
  const preClassification = classify(plan, auth, preBatchRow, preRows, false)
  if (preClassification.kind === 'all_completed_congruent') {
    return { kind: 'replay', responses: preClassification.responses }
  }

  // Step 2: org rollout shared advisory lock, resolve posture under it.
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(plan.orgKey)
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, plan.orgKey)
  if (posture.writePosture === 'blocked') {
    // Suspended synchronous branch: zero DML, closed outcome.
    return { kind: 'suspended' }
  }
  const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: plan.orgKey, posture })

  const isLegacy = org.acceptedWritePosture === 'legacy_projection_only'
  if (isLegacy && plan.sourced.length === 0 && plan.batch === null) {
    // Null-ID legacy commands create no operation row (lock 4.1/8.2).
    return { kind: 'legacy_no_operation', org, legacyNullIdCount: plan.legacyNullIdCount }
  }
  if (!isLegacy && plan.legacyNullIdCount > 0) {
    // W4-enabled clients that cannot supply a stable identity fail before source DML.
    fail('W4C0_OPERATION_ID_REQUIRED')
  }

  // Mint verified identities (post-lock factory output only).
  const batchIdentity = plan.batch
    ? createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'batch',
        entrypoint: plan.entrypoint,
        source: (envelope.batch as AttendanceOperationBatchInputV1).source,
      })
    : null
  const itemIdentities = plan.sourced.map((item) =>
    createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: plan.entrypoint,
      source: item.input.source,
    }),
  )

  // Canonical exclusive identity advisory locks for ALL supplied identities.
  const allIdentities = batchIdentity ? [batchIdentity, ...itemIdentities] : [...itemIdentities]
  await acquireAttendanceResultOperationLocks(trx, allIdentities)

  // Re-read under locks; now strict: mixed/incomplete/non-congruent conflicts.
  const lockedBatchRow = plan.batch
    ? await readBatchRow(trx, plan.orgKey, plan.entrypoint, plan.batch.batchCommandId)
    : null
  const lockedRows = await readOperationRows(trx, plan.orgKey, plan.entrypoint, candidateIds)
  const lockedClassification = classify(plan, auth, lockedBatchRow, lockedRows, true)
  if (lockedClassification.kind === 'all_completed_congruent') {
    return { kind: 'replay', responses: lockedClassification.responses }
  }

  // Section 8.2 step 2 (P07/P08): after the operation rows, lock and re-read the
  // V1 operational-job reservation for this batch tuple. A W4C-0 synchronous
  // caller has no worker adapter that could execute-and-terminalize a reserved
  // job, so ANY existing reservation is closed conflict/remediation here —
  // exactly one side reserves the tuple, and the waiter that re-reads under the
  // class-`10` locks fails with zero conflicting DML (section 12.1). The
  // `(queued, all-new)` admit-for-execution branch (resolved posture equal to
  // the frozen `accepted_write_posture`) belongs to the P07 cutover slice.
  if (plan.batch !== null && (plan.entrypoint === 'import_batch' || plan.entrypoint === 'integration_batch')) {
    const reservedJob = await trx.query(
      `SELECT 1 FROM attendance_import_jobs
        WHERE org_id = $1 AND w4_entrypoint = $2 AND w4_batch_command_id = $3::uuid
          AND w4_contract_version IS NOT NULL
        FOR UPDATE`,
      [plan.orgKey, plan.entrypoint, plan.batch.batchCommandId],
    )
    if (reservedJob.rows.length > 0) {
      conflict('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    }
  }

  // All-new: claim batch first (FK), then item rows in stable key order.
  if (batchIdentity && plan.batch) {
    await insertClaimedBatchRow(trx, org, batchIdentity, auth, plan.batch)
  }
  const orderedForInsert = plan.sourced
    .map((item, index) => ({ item, identity: itemIdentities[index] }))
    .sort((a, b) => (a.identity.id < b.identity.id ? -1 : a.identity.id > b.identity.id ? 1 : 0))
  for (const { item, identity } of orderedForInsert) {
    await insertClaimedItemRow(
      trx,
      org,
      identity,
      auth,
      item.input.commandFingerprint,
      plan.batch ? plan.batch.batchCommandId : null,
      item.ordinal,
      item.input.normalizedBusinessInputSnapshot,
    )
  }
  return {
    kind: 'claimed',
    org,
    batchIdentity,
    itemIdentities,
    legacyNullIdCount: plan.legacyNullIdCount,
  }
}

// ---------------------------------------------------------------------------
// Seal / cancel (same transaction as the claim; deferred constraints enforce it).
// ---------------------------------------------------------------------------

export interface AttendanceOperationSealInputV1 {
  readonly responseSnapshot: unknown
  readonly resolvedRecordId?: string | null
  readonly resolvedCalculationId?: string | null
  readonly resolvedRequestId?: string | null
  readonly resultSemanticFingerprint?: string | null
  readonly resultProvenanceFingerprint?: string | null
}

export async function sealAttendanceResultOperationV1(
  trx: AttendanceW4TransactionClientV1,
  identity: unknown,
  seal: AttendanceOperationSealInputV1,
): Promise<void> {
  const verified = requireVerifiedAttendanceOperationIdentityV1(identity)
  if (verified.kind !== 'item') fail('W4C0_SEAL_KIND_INVALID')
  if (seal.responseSnapshot === undefined || seal.responseSnapshot === null) fail('W4C0_SEAL_RESPONSE_REQUIRED')
  const result = await trx.query(
    `UPDATE attendance_result_operations
        SET state = 'completed',
            response_snapshot = $4::jsonb,
            resolved_record_id = $5::uuid,
            resolved_calculation_id = $6::uuid,
            resolved_request_id = $7::uuid,
            result_semantic_fingerprint = $8,
            result_provenance_fingerprint = $9,
            version = version + 1,
            updated_at = now()
      WHERE org_id = $1 AND entrypoint = $2 AND operation_id = $3::uuid AND state = 'claimed'
      RETURNING operation_id`,
    [
      verified.org.orgId,
      verified.entrypoint,
      verified.id,
      canonicalAttendanceJsonV1(seal.responseSnapshot),
      seal.resolvedRecordId ?? null,
      seal.resolvedCalculationId ?? null,
      seal.resolvedRequestId ?? null,
      seal.resultSemanticFingerprint ?? null,
      seal.resultProvenanceFingerprint ?? null,
    ],
  )
  if (result.rows.length !== 1) fail('W4C0_SEAL_STATE_INVALID')
}

/**
 * Batch response is stored as an order vector plus an object keyed by item
 * operation ID (lock 7.1), so positional output cannot be replayed against a
 * reordered request. The vector must name exactly the batch's item operations.
 */
export async function sealAttendanceResultOperationBatchV1(
  trx: AttendanceW4TransactionClientV1,
  identity: unknown,
  response: { readonly order: readonly string[]; readonly byItem: Readonly<Record<string, unknown>> },
): Promise<void> {
  const verified = requireVerifiedAttendanceOperationIdentityV1(identity)
  if (verified.kind !== 'batch') fail('W4C0_SEAL_KIND_INVALID')
  const code = 'W4C0_BATCH_RESPONSE_SHAPE_INVALID'
  if (typeof response !== 'object' || response === null) fail(code)
  const { order, byItem } = response
  if (!Array.isArray(order) || order.length === 0) fail(code)
  if (typeof byItem !== 'object' || byItem === null) fail(code)
  if (new Set(order).size !== order.length) fail(code)
  const byItemKeys = Object.keys(byItem).sort()
  if (canonicalAttendanceJsonV1(byItemKeys) !== canonicalAttendanceJsonV1([...order].sort())) fail(code)
  const itemRows = await trx.query(
    `SELECT operation_id::text AS operation_id FROM attendance_result_operations
      WHERE org_id = $1 AND entrypoint = $2 AND batch_command_id = $3::uuid
      ORDER BY operation_id`,
    [verified.org.orgId, verified.entrypoint, verified.id],
  )
  const attached = itemRows.rows.map((row) => String(row.operation_id)).sort()
  if (canonicalAttendanceJsonV1(attached) !== canonicalAttendanceJsonV1([...order].sort())) fail(code)
  const result = await trx.query(
    `UPDATE attendance_result_operation_batches
        SET state = 'completed',
            response_snapshot = $4::jsonb,
            version = version + 1,
            updated_at = now()
      WHERE org_id = $1 AND entrypoint = $2 AND batch_command_id = $3::uuid AND state = 'claimed'
      RETURNING batch_command_id`,
    [
      verified.org.orgId,
      verified.entrypoint,
      verified.id,
      canonicalAttendanceJsonV1({ order: [...order], byItem }),
    ],
  )
  if (result.rows.length !== 1) fail('W4C0_SEAL_STATE_INVALID')
}

/** Source-free cancel: allowed only before source DML (lock 7.1); response stays null. */
export async function cancelAttendanceResultOperationV1(
  trx: AttendanceW4TransactionClientV1,
  identity: unknown,
): Promise<void> {
  const verified = requireVerifiedAttendanceOperationIdentityV1(identity)
  const table =
    verified.kind === 'batch' ? 'attendance_result_operation_batches' : 'attendance_result_operations'
  const keyColumn = verified.kind === 'batch' ? 'batch_command_id' : 'operation_id'
  const result = await trx.query(
    `UPDATE ${table}
        SET state = 'canceled', version = version + 1, updated_at = now()
      WHERE org_id = $1 AND entrypoint = $2 AND ${keyColumn} = $3::uuid AND state = 'claimed'
      RETURNING ${keyColumn}`,
    [verified.org.orgId, verified.entrypoint, verified.id],
  )
  if (result.rows.length !== 1) fail('W4C0_CANCEL_STATE_INVALID')
}

// ---------------------------------------------------------------------------
// Transaction-bound outbox enqueue (lock 7.1a) — schema + interface only in
// W4C-0; the dispatcher is W4C-2.
// ---------------------------------------------------------------------------

export interface AttendanceOutboxEventInputV1 {
  readonly eventKind: AttendanceW4OutboxEventKindV1
  readonly payload: unknown
  readonly payloadSchemaVersion: number
  readonly businessKeyFingerprint: string
}

export async function enqueueAttendanceResultEventOutboxV1(
  trx: AttendanceW4TransactionClientV1,
  identity: unknown,
  events: readonly AttendanceOutboxEventInputV1[],
): Promise<void> {
  const verified = requireVerifiedAttendanceOperationIdentityV1(identity)
  // The durability contract does not apply to legacy_projection_only: that
  // branch keeps its existing emit behavior and NEVER creates an outbox row.
  if (verified.org.acceptedWritePosture === 'legacy_projection_only') {
    fail('W4C0_OUTBOX_LEGACY_FORBIDDEN')
  }
  if (!Array.isArray(events) || events.length === 0) fail('W4C0_OUTBOX_EVENTS_INVALID')
  for (const event of events) {
    if (!(ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1 as readonly string[]).includes(event.eventKind)) {
      fail('W4C0_OUTBOX_EVENT_KIND_INVALID')
    }
    if (!Number.isInteger(event.payloadSchemaVersion) || event.payloadSchemaVersion < 1) {
      fail('W4C0_OUTBOX_EVENTS_INVALID')
    }
    requireHex64(event.businessKeyFingerprint, 'W4C0_OUTBOX_EVENTS_INVALID')
    await trx.query(
      `INSERT INTO attendance_result_event_outbox (
          org_id, entrypoint, operation_id, event_kind, payload,
          payload_schema_version, business_key_fingerprint, delivery_state
        ) VALUES ($1,$2,$3::uuid,$4,$5::jsonb,$6,$7,'pending')`,
      [
        verified.org.orgId,
        verified.entrypoint,
        verified.id,
        event.eventKind,
        canonicalAttendanceJsonV1(event.payload),
        event.payloadSchemaVersion,
        event.businessKeyFingerprint,
      ],
    )
  }
}

// ---------------------------------------------------------------------------
// P07 V1 job reservation enqueue (lock 7.1; amendment 1.3). Creates NO
// operation row; the caller must already hold the org rollout SHARED lock and
// have resolved posture (the verified org witness is the proof of that order).
// ---------------------------------------------------------------------------

export interface AttendanceImportJobReservationInputV1 {
  readonly batchIdentity: unknown
  /** Canonical input order; ordinals must be exactly 0..n-1. */
  readonly items: ReadonlyArray<{ readonly identity: unknown; readonly commandFingerprint: string }>
  readonly batchCommandFingerprint: string
  readonly legacyJob: {
    readonly batchId: string
    readonly createdBy: string
    readonly payload: unknown
    readonly total: number
    readonly idempotencyKey?: string | null
  }
}

export type AttendanceImportJobReservationResultV1 =
  | { readonly kind: 'created'; readonly jobId: string }
  | { readonly kind: 'existing'; readonly jobId: string; readonly status: string }

export async function reserveAttendanceImportJobW4V1(
  trx: AttendanceW4TransactionClientV1,
  authorization: unknown,
  input: AttendanceImportJobReservationInputV1,
): Promise<AttendanceImportJobReservationResultV1> {
  const batchIdentity = requireVerifiedAttendanceOperationIdentityV1(input.batchIdentity)
  if (batchIdentity.kind !== 'batch') fail('W4C0_RESERVATION_IDENTITY_INVALID')
  const org = requireVerifiedAttendanceOrgIdentityV1(batchIdentity.org)
  const auth = requireAuthorizedCapabilityForEntrypointV1(authorization, batchIdentity.entrypoint)
  if (auth.orgId !== org.orgId) throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  if (!Array.isArray(input.items) || input.items.length === 0) fail('W4C0_RESERVATION_ITEMS_INVALID')
  if (input.items.length > W4_MAX_BATCH_ITEMS) {
    throw new AttendanceW4OperationError('W4_BATCH_LIMIT_EXCEEDED')
  }
  const batchFingerprint = requireHex64(input.batchCommandFingerprint, 'W4C0_RESERVATION_ITEMS_INVALID')

  const itemIdentities = input.items.map((item) => requireVerifiedAttendanceOperationIdentityV1(item.identity))
  const entries: AttendanceOperationItemFingerprintEntryV1[] = []
  const proofVector: Array<Record<string, unknown>> = []
  itemIdentities.forEach((identity, index) => {
    if (identity.kind !== 'item' || identity.entrypoint !== batchIdentity.entrypoint) {
      fail('W4C0_RESERVATION_IDENTITY_INVALID')
    }
    if (identity.org !== batchIdentity.org) fail('W4C0_RESERVATION_IDENTITY_INVALID')
    const proof = identity.sourceProof
    if (proof.sourceRootId !== batchIdentity.id || proof.ordinal !== String(index) || proof.semanticFingerprint === null) {
      fail('W4C0_RESERVATION_IDENTITY_INVALID')
    }
    const commandFingerprint = requireHex64(input.items[index].commandFingerprint, 'W4C0_RESERVATION_ITEMS_INVALID')
    entries.push({ ordinal: proof.ordinal, operationId: identity.id, commandFingerprint })
    proofVector.push({
      ordinal: index,
      semanticFingerprint: proof.semanticFingerprint,
      derivedOperationId: identity.id,
      commandFingerprint,
    })
  })
  const itemSequenceFingerprint = computeAttendanceItemSequenceFingerprintV1(entries)
  const itemSetFingerprint = computeAttendanceItemSetFingerprintV1(entries)

  // Class-`10` locks for the batch command and every item identity, held
  // through the insert commit (transaction advisory locks).
  await acquireAttendanceResultOperationLocks(trx, [batchIdentity, ...itemIdentities])

  // Recheck OPERATION reservations under the locks: any existing operation row
  // for this tuple means it was (or is being) executed outside this job.
  const existingOps = await trx.query(
    `SELECT 1 FROM attendance_result_operations
      WHERE org_id = $1 AND entrypoint = $2
        AND (batch_command_id = $3::uuid OR operation_id = ANY($4::uuid[]))
      LIMIT 1`,
    [org.orgId, batchIdentity.entrypoint, batchIdentity.id, itemIdentities.map((identity) => identity.id)],
  )
  const existingBatch = await trx.query(
    'SELECT 1 FROM attendance_result_operation_batches WHERE org_id = $1 AND entrypoint = $2 AND batch_command_id = $3::uuid LIMIT 1',
    [org.orgId, batchIdentity.entrypoint, batchIdentity.id],
  )
  if (existingOps.rows.length > 0 || existingBatch.rows.length > 0) {
    conflict('ATTENDANCE_OPERATION_BATCH_CONFLICT')
  }

  // Recheck the retryable-job reservation under the locks.
  const existingJob = await trx.query(
    `SELECT id::text AS id, status,
            w4_actor_id, w4_actor_posture, w4_token_subject_user_id, w4_source_ref,
            w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
            w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector
       FROM attendance_import_jobs
      WHERE org_id = $1 AND w4_entrypoint = $2 AND w4_batch_command_id = $3::uuid
        AND w4_contract_version IS NOT NULL
      FOR UPDATE`,
    [org.orgId, batchIdentity.entrypoint, batchIdentity.id],
  )
  if (existingJob.rows.length > 0) {
    const row = existingJob.rows[0] as Record<string, unknown>
    const congruent =
      row.w4_actor_id === auth.actorId &&
      row.w4_actor_posture === auth.actorPosture &&
      ((row.w4_token_subject_user_id as string | null) ?? null) === auth.tokenSubjectUserId &&
      row.w4_source_ref === auth.sourceRef &&
      row.w4_command_fingerprint === batchFingerprint &&
      row.w4_item_count === input.items.length &&
      row.w4_item_sequence_fingerprint === itemSequenceFingerprint &&
      row.w4_item_set_fingerprint === itemSetFingerprint &&
      canonicalAttendanceJsonV1(row.w4_identity_proof_vector) === canonicalAttendanceJsonV1(proofVector)
    if (!congruent) conflict('ATTENDANCE_OPERATION_CONFLICT')
    // Congruent retry returns the one existing durable job (no raw 23505 path).
    return { kind: 'existing', jobId: String(row.id), status: String(row.status) }
  }

  if (!Number.isInteger(input.legacyJob.total) || input.legacyJob.total < 0) {
    fail('W4C0_RESERVATION_ITEMS_INVALID')
  }
  const inserted = await trx.query(
    `INSERT INTO attendance_import_jobs (
        org_id, batch_id, created_by, idempotency_key, status, progress, total, payload,
        w4_contract_version, w4_entrypoint, w4_batch_command_id, w4_source_kind,
        w4_source_ref, w4_actor_id, w4_actor_posture, w4_token_subject_user_id,
        w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
        w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector
      ) VALUES (
        $1, $2::uuid, $3, $4, 'queued', 0, $5, $6::jsonb,
        1, $7, $8::uuid, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb
      )
      RETURNING id::text AS id`,
    [
      org.orgId,
      input.legacyJob.batchId,
      input.legacyJob.createdBy,
      input.legacyJob.idempotencyKey ?? null,
      input.legacyJob.total,
      canonicalAttendanceJsonV1(input.legacyJob.payload),
      batchIdentity.entrypoint,
      batchIdentity.id,
      batchIdentity.sourceProof.sourceKind,
      auth.sourceRef,
      auth.actorId,
      auth.actorPosture,
      auth.tokenSubjectUserId,
      batchFingerprint,
      org.acceptedWritePosture,
      input.items.length,
      itemSequenceFingerprint,
      itemSetFingerprint,
      JSON.stringify(proofVector),
    ],
  )
  return { kind: 'created', jobId: String((inserted.rows[0] as Record<string, unknown>).id) }
}

// ---------------------------------------------------------------------------
// Canonical SERIALIZABLE transaction wrapper (lock 8.2): statement/lock
// timeouts from the exported contract; bounded whole-transaction retry ONLY on
// SQLSTATE 40001/40P01.
// ---------------------------------------------------------------------------

function isRetryableSqlState(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === '40001' || code === '40P01'
}

export async function runAttendanceResultOperationTransactionV1<T>(
  connection: AttendanceW4TransactionClientV1,
  body: (trx: AttendanceW4TransactionClientV1) => Promise<T>,
): Promise<T> {
  let attempt = 0
  // W4_TRANSACTION_MAX_RETRIES retries => up to (1 + retries) attempts.
  for (;;) {
    try {
      await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE', [])
      await connection.query("SELECT set_config('statement_timeout', $1, true)", [
        String(W4_TRANSACTION_STATEMENT_TIMEOUT_MS),
      ])
      await connection.query("SELECT set_config('lock_timeout', $1, true)", [
        String(W4_TRANSACTION_LOCK_TIMEOUT_MS),
      ])
      const result = await body(connection)
      await connection.query('COMMIT', [])
      return result
    } catch (error) {
      await connection.query('ROLLBACK', []).catch(() => undefined)
      if (isRetryableSqlState(error) && attempt < W4_TRANSACTION_MAX_RETRIES) {
        attempt += 1
        continue
      }
      throw error
    }
  }
}
