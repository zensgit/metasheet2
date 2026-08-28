import { createHash, randomUUID } from 'node:crypto'

import { acquireCanonicalSheetFence } from './canonical-sheet-fence'
import {
  claimArchiveWriterBlockPrepared,
  prepareArchiveWriterBlockCleanupTransaction,
  prepareArchiveWriterBlockTransaction,
} from './recovery-archive-writer-block'
import {
  assertRecoveryArchiveRestorePlanMatchesClaims,
  compileRecoveryArchiveRestorePlan,
  type RecoveryArchiveRestorePlan,
} from './recovery-archive-restore-plan'
import {
  sealDirectEventOperation,
  sealRestoreAggregateOperation,
} from './recovery-archive-seals'
import {
  verifyExactArchiveRecoveryIdentity,
  type ExactArchiveRecoveryIdentityClaims,
} from './restore-preview-identity'

export type RecoveryArchiveRestoreJobQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecoveryArchiveRestoreJobTransaction = <T>(
  work: (query: RecoveryArchiveRestoreJobQuery) => Promise<T>,
) => Promise<T>

export const RECOVERY_ARCHIVE_RESTORE_JOB_STATES = [
  'planned',
  'applying',
  'paused_retryable',
  'done',
  'abandoned_partial',
  'cancelled_zero_write',
] as const

export type RecoveryArchiveRestoreJobState =
  (typeof RECOVERY_ARCHIVE_RESTORE_JOB_STATES)[number]

export type RecoveryArchiveRestoreJobErrorCode =
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_TOKEN_REPLAYED'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_BLOCK_LOST'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_COMPLETE'
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID'

/** Values-free D5 refusal. Identity and customer values stay in the protected catalog only. */
export class RecoveryArchiveRestoreJobError extends Error {
  readonly code: RecoveryArchiveRestoreJobErrorCode

  constructor(code: RecoveryArchiveRestoreJobErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveRestoreJobError'
    this.code = code
  }
}

export interface RecoveryArchiveRestoreJobSnapshot {
  readonly id: string
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recoveryMode: 'revert' | 'reset'
  readonly scopeKind: 'whole_sheet' | 'selected_records' | 'selected_fields'
  readonly state: RecoveryArchiveRestoreJobState
  readonly totalCount: string
  readonly completedCount: string
  readonly workerFence: string
  readonly resumeDeadline: string
  readonly terminalOperationId: string | null
  readonly terminalAt: string | null
  readonly rowVersion: string
}

export interface RecoveryArchiveRestoreAcceptContext {
  readonly claims: ExactArchiveRecoveryIdentityClaims
  readonly plan: RecoveryArchiveRestorePlan
}

export interface AcceptRecoveryArchiveRestoreJobInput {
  readonly token: string
  readonly plan: RecoveryArchiveRestorePlan
  readonly resumeDeadline: Date | string
  readonly recheckAuthority: (
    query: RecoveryArchiveRestoreJobQuery,
    context: RecoveryArchiveRestoreAcceptContext,
  ) => Promise<boolean>
}

const candidateBrand: unique symbol = Symbol('RecoveryArchiveRestoreJobCandidate')
const candidates = new WeakSet<object>()

export interface RecoveryArchiveRestoreJobCandidate {
  readonly [candidateBrand]: typeof candidateBrand
  readonly jobId: string
  readonly sheetId: string
  readonly keyId: string
  readonly blockFence: string
}

const workerClaimBrand: unique symbol = Symbol('RecoveryArchiveRestoreJobWorkerClaim')
const workerClaims = new WeakSet<object>()

export interface RecoveryArchiveRestoreJobWorkerClaim {
  readonly [workerClaimBrand]: typeof workerClaimBrand
  readonly jobId: string
  readonly sheetId: string
  readonly keyId: string
  readonly blockFence: string
  readonly workerOwnerId: string
  readonly workerFence: string
  readonly leaseUntil: string
}

export interface ClaimRecoveryArchiveRestoreJobInput {
  readonly workerOwnerId: string
  readonly leaseUntil: Date | string
}

export interface RecoveryArchiveRestoreChunkMaterialized {
  readonly chunkIndex: number
  readonly chunkHash: string
  readonly chunkObjectId: string
  readonly chunkObjectVersion: string
  readonly chunkObjectSha256: string
  readonly chunkObjectSize: string
  readonly chunkObjectExpiresAt: string
  readonly recordCount: string
  /** Opaque, already authenticated payload. The D5 host never logs or serializes it. */
  readonly payload: unknown
}

export interface RecoveryArchiveRestoreChunkApplyContext {
  readonly jobId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recoveryMode: 'revert' | 'reset'
  readonly scopeKind: 'whole_sheet' | 'selected_records' | 'selected_fields'
  readonly chunkIndex: number
  readonly operationId: string
  readonly payload: unknown
}

export interface RecoveryArchiveRestoreChunkApplyReceipt {
  readonly endpointSeq: string
  readonly eventCount: number
  readonly committedCount: string
}

export interface RunRecoveryArchiveRestoreChunkInput {
  readonly read: RecoveryArchiveRestoreJobQuery
  readonly materialize: (
    expected: Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'>,
  ) => Promise<RecoveryArchiveRestoreChunkMaterialized>
  readonly recheckAuthority: (
    query: RecoveryArchiveRestoreJobQuery,
    context: Omit<RecoveryArchiveRestoreChunkApplyContext, 'operationId' | 'payload'>,
  ) => Promise<boolean>
  readonly apply: (
    query: RecoveryArchiveRestoreJobQuery,
    context: RecoveryArchiveRestoreChunkApplyContext,
  ) => Promise<RecoveryArchiveRestoreChunkApplyReceipt>
}

export interface RecoveryArchiveRestoreChunkResult {
  readonly kind: 'committed' | 'already_committed' | 'no_pending_chunk'
  readonly chunkIndex?: number
  readonly completedCount?: string
}

export interface TerminalizeRecoveryArchiveRestoreJobInput {
  readonly replayHorizonMs: number
}

export interface SweepExpiredRecoveryArchiveRestoreJobsInput {
  readonly replayHorizonMs: number
  readonly limit?: number
}

export interface RecoveryArchiveRestoreJobOwnerIdentityInput {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly jobId: string
}

export interface RecoveryArchiveRestoreJobOwnerInput
  extends RecoveryArchiveRestoreJobOwnerIdentityInput {
  readonly recheckAuthority: (
    query: RecoveryArchiveRestoreJobQuery,
  ) => Promise<boolean>
}

export interface CancelRecoveryArchiveRestoreJobInput
  extends RecoveryArchiveRestoreJobOwnerInput {
  readonly replayHorizonMs: number
}

export type ResumeRecoveryArchiveRestoreJobInput = RecoveryArchiveRestoreJobOwnerInput
export type ReadRecoveryArchiveRestoreJobStatusInput = RecoveryArchiveRestoreJobOwnerInput

type JobRow = {
  id: unknown
  workspace_id: unknown
  base_id: unknown
  sheet_id: unknown
  actor_id: unknown
  token_sha256?: unknown
  recovery_mode: unknown
  scope_kind: unknown
  scope_hash?: unknown
  archive_generation_id?: unknown
  archive_root_hash?: unknown
  source_vector_hash?: unknown
  key_id: unknown
  plan_hash?: unknown
  state: unknown
  total_count: unknown
  completed_count: unknown
  block_fence: unknown
  worker_owner_id?: unknown
  worker_fence: unknown
  lease_until?: unknown
  lease_live?: unknown
  lease_expired?: unknown
  resume_deadline: unknown
  resume_live?: unknown
  terminal_operation_id: unknown
  terminal_at: unknown
  row_version: unknown
}

type ChunkRow = {
  chunk_index: unknown
  chunk_hash: unknown
  chunk_object_id: unknown
  chunk_object_version: unknown
  chunk_object_sha256: unknown
  chunk_object_size: unknown
  chunk_object_expires_at: unknown
  record_count: unknown
  state: unknown
  operation_id?: unknown
  endpoint_seq?: unknown
  committed_count?: unknown
}

/**
 * Accept one >5000 frozen plan. The canonical fence, active key, verified archive,
 * DB-fresh authority, durable block, immutable job/chunks, and one async burn all
 * commit in the same transaction. The raw token and recovered values are never stored.
 */
export async function acceptRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  input: AcceptRecoveryArchiveRestoreJobInput,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  if (!input || typeof input.recheckAuthority !== 'function') invalidInput()
  const token = opaque(input.token)
  const suppliedPlan = input.plan
  const verified = verifyExactArchiveRecoveryIdentity(token, {
    sheetId: suppliedPlan?.sheetId,
    actorId: suppliedPlan?.actorId,
  })
  if (!verified.valid || !verified.claims || !verified.expiresAt) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
  }
  let plan: RecoveryArchiveRestorePlan
  try {
    plan = compileRecoveryArchiveRestorePlan(suppliedPlan)
    if (
      plan.planHash !== suppliedPlan.planHash ||
      plan.totalCount !== suppliedPlan.totalCount
    ) {
      throw new Error('noncanonical plan')
    }
    assertRecoveryArchiveRestorePlanMatchesClaims(plan, verified.claims)
  } catch {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
  }
  const resumeDeadline = futureTimestamp(input.resumeDeadline)
  const tokenExpiresAt = timestamp(verified.expiresAt)
  const retainUntil = laterTimestamp(tokenExpiresAt, resumeDeadline)
  const tokenSha256 = createHash('sha256').update(token).digest('hex')
  const jobId = randomUUID()

  try {
    return await transaction(async (query) => {
      const prepared = await prepareArchiveWriterBlockTransaction(query, plan.sheetId)
      await lockRecoveryArchiveKey(query, plan.keyId, true)
      await lockRecoveryArchiveBinding(query, plan, true, resumeDeadline)
      if (!(await input.recheckAuthority(query, { claims: verified.claims!, plan }))) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
      }
      const block = await claimArchiveWriterBlockPrepared(prepared, {
        ownerKind: 'restore_job',
        ownerId: jobId,
        leaseUntil: resumeDeadline,
      })
      await query(
        `INSERT INTO public.meta_recovery_archive_jobs (
           id, workspace_id, base_id, sheet_id, actor_id, token_sha256,
           recovery_mode, scope_kind, scope_hash,
           archive_generation_id, archive_root_hash, source_vector_hash, key_id,
           plan_hash, plan_object_id, plan_object_version, plan_object_sha256,
           plan_object_size, plan_object_expires_at,
           total_count, block_fence, resume_deadline
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6,
           $7, $8, $9,
           $10::uuid, $11, $12, $13,
           $14, $15, $16, $17,
           $18::bigint, $19::timestamptz,
           $20::bigint, $21::bigint, $22::timestamptz
         )`,
        [
          jobId,
          plan.workspaceId,
          plan.baseId,
          plan.sheetId,
          plan.actorId,
          tokenSha256,
          plan.recoveryMode,
          plan.scopeKind,
          plan.scopeHash,
          plan.archiveGenerationId,
          plan.archiveRootHash,
          plan.sourceVectorHash,
          plan.keyId,
          plan.planHash,
          plan.planObjectId,
          plan.planObjectVersion,
          plan.planObjectSha256,
          plan.planObjectSize,
          plan.planObjectExpiresAt,
          plan.totalCount,
          block.fence,
          resumeDeadline,
        ],
      )
      for (const chunk of plan.chunks) {
        await query(
          `INSERT INTO public.meta_recovery_archive_job_chunks (
             job_id, sheet_id, chunk_index, chunk_hash,
             chunk_object_id, chunk_object_version, chunk_object_sha256,
             chunk_object_size, chunk_object_expires_at, record_count
           ) VALUES (
             $1::uuid, $2, $3::int, $4, $5, $6, $7,
             $8::bigint, $9::timestamptz, $10::bigint
           )`,
          [
            jobId,
            plan.sheetId,
            chunk.chunkIndex,
            chunk.chunkHash,
            chunk.chunkObjectId,
            chunk.chunkObjectVersion,
            chunk.chunkObjectSha256,
            chunk.chunkObjectSize,
            chunk.chunkObjectExpiresAt,
            chunk.recordCount,
          ],
        )
      }
      await query(
        `INSERT INTO public.meta_recovery_token_burns (
           token_sha256, sheet_id, actor_id, burn_kind, job_id,
           archive_generation_id, archive_root_hash, source_vector_hash,
           token_expires_at, retain_until, row_version
         ) VALUES (
           $1, $2, $3, 'async', $4::uuid,
           $5::uuid, $6, $7,
           $8::timestamptz, $9::timestamptz, 1
         )`,
        [
          tokenSha256,
          plan.sheetId,
          plan.actorId,
          jobId,
          plan.archiveGenerationId,
          plan.archiveRootHash,
          plan.sourceVectorHash,
          tokenExpiresAt,
          retainUntil,
        ],
      )
      return readJobSnapshotInTransaction(query, jobId)
    })
  } catch (error) {
    if (isTokenReplayViolation(error)) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_TOKEN_REPLAYED')
    }
    throw error
  }
}

/** Short work selection only. Its row lock is released before the canonical-fence claim transaction. */
export async function selectRecoveryArchiveRestoreJobCandidate(
  transaction: RecoveryArchiveRestoreJobTransaction,
): Promise<RecoveryArchiveRestoreJobCandidate | null> {
  return transaction(async (query) => {
    const result = await query(
      `SELECT id::text AS id, sheet_id, key_id, block_fence::text AS block_fence
         FROM public.meta_recovery_archive_jobs
        WHERE resume_deadline > clock_timestamp()
          AND (
            state = 'planned' OR
            (state = 'applying' AND lease_until <= clock_timestamp())
          )
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    const candidate: RecoveryArchiveRestoreJobCandidate = {
      [candidateBrand]: candidateBrand,
      jobId: opaque(row.id),
      sheetId: opaque(row.sheet_id),
      keyId: opaque(row.key_id),
      blockFence: positiveDecimal(row.block_fence),
    }
    candidates.add(candidate)
    return Object.freeze(candidate)
  })
}

/** Fence-first worker lease CAS. No request surface receives or chooses the resulting fences. */
export async function claimRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  candidateInput: RecoveryArchiveRestoreJobCandidate,
  input: ClaimRecoveryArchiveRestoreJobInput,
): Promise<RecoveryArchiveRestoreJobWorkerClaim> {
  const candidate = requireCandidate(candidateInput)
  const workerOwnerId = opaque(input?.workerOwnerId)
  const leaseUntil = timestamp(input?.leaseUntil)
  return transaction(async (query) => {
    await prepareArchiveWriterBlockTransaction(query, candidate.sheetId)
    await lockRecoveryArchiveKey(query, candidate.keyId, false)
    await lockRestoreJobBlock(query, candidate)
    const row = await lockJobRow(query, candidate.jobId, candidate.sheetId)
    if (
      row.key_id !== candidate.keyId ||
      decimal(row.block_fence) !== candidate.blockFence ||
      !isClaimableJobRow(row)
    ) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE')
    }
    if (new Date(leaseUntil).getTime() > new Date(timestamp(row.resume_deadline)).getTime()) {
      invalidInput()
    }
    const updated = await query(
      `UPDATE public.meta_recovery_archive_jobs
          SET state = 'applying',
              worker_owner_id = $2,
              worker_fence = worker_fence + 1,
              lease_until = $3::timestamptz,
              row_version = row_version + 1
        WHERE id = $1::uuid
          AND row_version = $4::bigint
          AND $3::timestamptz > clock_timestamp()
          AND $3::timestamptz <= resume_deadline
          AND resume_deadline > clock_timestamp()
        RETURNING worker_fence::text AS worker_fence,
                  lease_until::text AS lease_until`,
      [candidate.jobId, workerOwnerId, leaseUntil, decimal(row.row_version)],
    )
    const claimRow = updated.rows[0] as Record<string, unknown> | undefined
    if (!claimRow) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE')
    }
    const claim: RecoveryArchiveRestoreJobWorkerClaim = {
      [workerClaimBrand]: workerClaimBrand,
      jobId: candidate.jobId,
      sheetId: candidate.sheetId,
      keyId: candidate.keyId,
      blockFence: candidate.blockFence,
      workerOwnerId,
      workerFence: positiveDecimal(claimRow.worker_fence),
      leaseUntil: timestamp(claimRow.lease_until),
    }
    workerClaims.add(claim)
    return Object.freeze(claim)
  })
}

/**
 * Materializes and authenticates one frozen chunk before opening the DB transaction.
 * The transaction then rebinds every identity, rechecks authority, applies, seals, and
 * commits the receipt plus progress atomically.
 */
export async function runRecoveryArchiveRestoreChunk(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
  input: RunRecoveryArchiveRestoreChunkInput,
): Promise<RecoveryArchiveRestoreChunkResult> {
  const claim = requireWorkerClaim(claimInput)
  if (
    !input ||
    typeof input.read !== 'function' ||
    typeof input.materialize !== 'function' ||
    typeof input.recheckAuthority !== 'function' ||
    typeof input.apply !== 'function'
  ) {
    invalidInput()
  }
  const expected = await readNextPendingChunk(input.read, claim.jobId)
  if (!expected) return { kind: 'no_pending_chunk' }
  const materialized = admitMaterializedChunk(await input.materialize(expected))
  assertMaterializedMatches(expected, materialized)

  return transaction(async (query) => {
    await prepareArchiveWriterBlockTransaction(query, claim.sheetId)
    await lockRecoveryArchiveKey(query, claim.keyId, false)
    await lockRestoreJobBlock(query, claim)
    const job = await lockClaimedJob(query, claim)
    const chunk = await lockChunkRow(query, claim.jobId, expected.chunkIndex)
    if (chunk.state === 'committed') {
      return { kind: 'already_committed', chunkIndex: expected.chunkIndex }
    }
    assertChunkMatches(chunk, materialized)
    const contextBase = {
      jobId: claim.jobId,
      sheetId: claim.sheetId,
      actorId: opaque(job.actor_id),
      recoveryMode: recoveryMode(job.recovery_mode),
      scopeKind: scopeKind(job.scope_kind),
      chunkIndex: expected.chunkIndex,
    }
    if (!(await input.recheckAuthority(query, contextBase))) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
    }
    const operationId = randomUUID()
    const receipt = admitApplyReceipt(
      await input.apply(query, {
        ...contextBase,
        operationId,
        payload: materialized.payload,
      }),
    )
    if (receipt.committedCount !== decimal(chunk.record_count)) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID')
    }
    await sealDirectEventOperation(query, {
      sheetId: claim.sheetId,
      operationId,
      endpointSeq: receipt.endpointSeq,
      eventCount: receipt.eventCount,
      operationKind: 'restore_chunk',
    })
    const committed = await query(
      `UPDATE public.meta_recovery_archive_job_chunks
          SET state = 'committed',
              operation_id = $3::uuid,
              endpoint_seq = $4::bigint,
              committed_count = $5::bigint,
              committed_at = clock_timestamp()
        WHERE job_id = $1::uuid AND chunk_index = $2::int AND state = 'pending'`,
      [claim.jobId, expected.chunkIndex, operationId, receipt.endpointSeq, receipt.committedCount],
    )
    if (rowCount(committed) !== 1) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
    }
    const progress = await query(
      `UPDATE public.meta_recovery_archive_jobs
          SET completed_count = completed_count + $2::bigint,
              row_version = row_version + 1
        WHERE id = $1::uuid
          AND state = 'applying'
          AND worker_owner_id = $3
          AND worker_fence = $4::bigint
          AND lease_until = $5::timestamptz
        RETURNING completed_count::text AS completed_count`,
      [claim.jobId, receipt.committedCount, claim.workerOwnerId, claim.workerFence, claim.leaseUntil],
    )
    const row = progress.rows[0] as Record<string, unknown> | undefined
    if (!row) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
    }
    return {
      kind: 'committed',
      chunkIndex: expected.chunkIndex,
      completedCount: decimal(row.completed_count),
    }
  })
}

export async function pauseRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  const claim = requireWorkerClaim(claimInput)
  return transaction(async (query) => {
    await prepareArchiveWriterBlockTransaction(query, claim.sheetId)
    await lockRecoveryArchiveKey(query, claim.keyId, false)
    await lockRestoreJobBlock(query, claim)
    const job = await lockClaimedJob(query, claim)
    const paused = await query(
      `UPDATE public.meta_recovery_archive_jobs
          SET state = 'paused_retryable',
              worker_owner_id = NULL,
              lease_until = NULL,
              row_version = row_version + 1
        WHERE id = $1::uuid AND row_version = $2::bigint`,
      [claim.jobId, decimal(job.row_version)],
    )
    if (rowCount(paused) !== 1) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
    }
    return readJobSnapshotInTransaction(query, claim.jobId)
  })
}

/**
 * Owner-authorized bounded resume. A paused job is never selected automatically: this transition
 * only restores it to `planned`, preserves its immutable plan and original deadline, and leaves
 * worker-fence minting to the later worker claim.
 */
export async function resumeRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  input: ResumeRecoveryArchiveRestoreJobInput,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  if (!input || typeof input.recheckAuthority !== 'function') invalidInput()
  const identity = ownerIdentity(input)
  return transaction(async (query) => {
    const candidate = await readCandidateIdentity(query, identity)
    await prepareArchiveWriterBlockTransaction(query, identity.sheetId)
    await lockRecoveryArchiveKey(query, candidate.keyId, false)
    await lockRestoreJobBlock(query, candidate)
    const job = await lockJobRow(query, identity.jobId, identity.sheetId)
    if (!jobIdentityMatches(job, identity)) notFound()
    if (!(await input.recheckAuthority(query))) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
    }
    if (
      job.state !== 'paused_retryable' || job.resume_live !== true ||
      job.worker_owner_id !== null || job.lease_until !== null
    ) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE')
    }
    const resumed = await query(
      `UPDATE public.meta_recovery_archive_jobs
          SET state = 'planned',
              row_version = row_version + 1
        WHERE id = $1::uuid
          AND state = 'paused_retryable'
          AND worker_owner_id IS NULL
          AND lease_until IS NULL
          AND resume_deadline > clock_timestamp()
          AND row_version = $2::bigint`,
      [identity.jobId, decimal(job.row_version)],
    )
    if (rowCount(resumed) !== 1) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE')
    }
    return readJobSnapshotInTransaction(query, identity.jobId)
  })
}

export async function finalizeRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
  input: TerminalizeRecoveryArchiveRestoreJobInput,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  const claim = requireWorkerClaim(claimInput)
  const horizonMs = nonnegativeInteger(input?.replayHorizonMs)
  return transaction(async (query) => {
    await prepareArchiveWriterBlockTransaction(query, claim.sheetId)
    await lockRecoveryArchiveKey(query, claim.keyId, false)
    await lockRestoreJobBlock(query, claim)
    const job = await lockClaimedJob(query, claim)
    const chunksResult = await query(
      `SELECT chunk_row.chunk_index,
              chunk_row.operation_id::text AS operation_id,
              chunk_row.endpoint_seq::text AS endpoint_seq,
              chunk_row.committed_count::text AS committed_count,
              operation_row.event_count::text AS event_count
         FROM public.meta_recovery_archive_job_chunks chunk_row
         JOIN public.meta_record_history_operations operation_row
           ON operation_row.sheet_id = chunk_row.sheet_id
          AND operation_row.operation_id = chunk_row.operation_id
        WHERE chunk_row.job_id = $1::uuid
        ORDER BY chunk_row.chunk_index
        FOR UPDATE OF chunk_row`,
      [claim.jobId],
    )
    const chunks = chunksResult.rows as Array<Record<string, unknown>>
    if (
      chunks.length < 1 ||
      chunks.some((row, index) =>
        row.chunk_index !== index ||
        typeof row.operation_id !== 'string' ||
        typeof row.endpoint_seq !== 'string' ||
        typeof row.committed_count !== 'string' || typeof row.event_count !== 'string'
      ) ||
      chunks.reduce((sum, row) => sum + BigInt(decimal(row.committed_count)), 0n).toString() !==
        decimal(job.total_count)
    ) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_NOT_COMPLETE')
    }
    const aggregateOperationId = randomUUID()
    const endpointSeq = chunks.reduce(
      (max, row) => BigInt(decimal(row.endpoint_seq)) > max ? BigInt(decimal(row.endpoint_seq)) : max,
      0n,
    ).toString()
    await sealRestoreAggregateOperation(query, {
      sheetId: claim.sheetId,
      operationId: aggregateOperationId,
      endpointSeq,
      members: chunks.map((row, index) => ({
        ordinal: index + 1,
        childOperationId: opaque(row.operation_id),
        childEndpointSeq: positiveDecimal(row.endpoint_seq),
        childEventCount: safePositiveInteger(row.event_count),
      })),
    })
    const terminal = await terminalizeJobAndBurn(query, {
      job,
      state: 'done',
      terminalOperationId: aggregateOperationId,
      replayHorizonMs: horizonMs,
    })
    await releaseRestoreJobBlock(query, claim)
    return terminal
  })
}

export async function abandonRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
  input: TerminalizeRecoveryArchiveRestoreJobInput,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  const claim = requireWorkerClaim(claimInput)
  const horizonMs = nonnegativeInteger(input?.replayHorizonMs)
  return transaction(async (query) => {
    await prepareArchiveWriterBlockTransaction(query, claim.sheetId)
    await lockRecoveryArchiveKey(query, claim.keyId, false)
    await lockRestoreJobBlock(query, claim)
    const job = await lockClaimedJob(query, claim)
    const state = BigInt(decimal(job.completed_count)) === 0n
      ? 'cancelled_zero_write'
      : 'abandoned_partial'
    const terminal = await terminalizeJobAndBurn(query, {
      job,
      state,
      terminalOperationId: null,
      replayHorizonMs: horizonMs,
    })
    await releaseRestoreJobBlock(query, claim)
    return terminal
  })
}

export async function cancelRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  input: CancelRecoveryArchiveRestoreJobInput,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  if (!input || typeof input.recheckAuthority !== 'function') invalidInput()
  const identity = ownerIdentity(input)
  const horizonMs = nonnegativeInteger(input.replayHorizonMs)
  return transaction(async (query) => {
    const candidate = await readCandidateIdentity(query, identity)
    await prepareArchiveWriterBlockCleanupTransaction(query, identity.sheetId)
    await lockRecoveryArchiveKey(query, candidate.keyId, false)
    await lockRestoreJobBlock(query, candidate)
    const job = await lockJobRow(query, identity.jobId, identity.sheetId)
    if (!jobIdentityMatches(job, identity)) notFound()
    if (!(await input.recheckAuthority(query))) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
    }
    if (!['planned', 'applying', 'paused_retryable'].includes(String(job.state))) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE')
    }
    const state = BigInt(decimal(job.completed_count)) === 0n
      ? 'cancelled_zero_write'
      : 'abandoned_partial'
    const terminal = await terminalizeJobAndBurn(query, {
      job,
      state,
      terminalOperationId: null,
      replayHorizonMs: horizonMs,
    })
    await releaseRestoreJobBlock(query, candidate)
    return terminal
  })
}

/**
 * Terminalizes jobs whose resume deadline has elapsed. Selection is lock-free; each candidate is
 * rebound under the canonical fence -> key -> generation -> job prefix before metadata changes.
 * No recovered value is touched by this sweeper.
 */
export async function sweepExpiredRecoveryArchiveRestoreJobs(
  transaction: RecoveryArchiveRestoreJobTransaction,
  input: SweepExpiredRecoveryArchiveRestoreJobsInput,
): Promise<number> {
  const horizonMs = nonnegativeInteger(input?.replayHorizonMs)
  const limit = Math.min(1000, Math.max(1, Math.floor(input?.limit ?? 100)))
  const candidatesResult = await transaction((query) => query(
    `SELECT id::text AS id, sheet_id, key_id,
            archive_generation_id::text AS archive_generation_id,
            block_fence::text AS block_fence
       FROM public.meta_recovery_archive_jobs
      WHERE state IN ('planned', 'applying', 'paused_retryable')
        AND resume_deadline <= clock_timestamp()
      ORDER BY sheet_id, key_id, archive_generation_id, id
      LIMIT $1::int`,
    [limit],
  ))
  let swept = 0
  for (const raw of candidatesResult.rows as Array<Record<string, unknown>>) {
    const candidate = {
      jobId: opaque(raw.id),
      sheetId: opaque(raw.sheet_id),
      keyId: opaque(raw.key_id),
      archiveGenerationId: opaque(raw.archive_generation_id),
      blockFence: positiveDecimal(raw.block_fence),
    }
    const terminalized = await transaction(async (query) => {
      await prepareArchiveWriterBlockCleanupTransaction(query, candidate.sheetId)
      await lockRecoveryArchiveKeyRow(query, candidate.keyId)
      await lockRecoveryArchiveGenerationRow(
        query,
        candidate.archiveGenerationId,
        candidate.sheetId,
        candidate.keyId,
      )
      const job = await lockJobRow(query, candidate.jobId, candidate.sheetId)
      if (!['planned', 'applying', 'paused_retryable'].includes(String(job.state))) return false
      if (job.resume_live === true) return false
      if (
        job.key_id !== candidate.keyId ||
        opaque(job.archive_generation_id) !== candidate.archiveGenerationId ||
        decimal(job.block_fence) !== candidate.blockFence
      ) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID')
      }
      const state = BigInt(decimal(job.completed_count)) === 0n
        ? 'cancelled_zero_write'
        : 'abandoned_partial'
      await terminalizeJobAndBurn(query, {
        job,
        state,
        terminalOperationId: null,
        replayHorizonMs: horizonMs,
      })
      await releaseRestoreJobBlockIfOwned(query, candidate)
      return true
    })
    if (terminalized) swept += 1
  }
  return swept
}

export async function readRecoveryArchiveRestoreJobStatus(
  transaction: RecoveryArchiveRestoreJobTransaction,
  input: ReadRecoveryArchiveRestoreJobStatusInput,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  if (!input || typeof input.recheckAuthority !== 'function') invalidInput()
  const identity = ownerIdentity(input)
  return transaction(async (query) => {
    const result = await query(
      `${JOB_SNAPSHOT_SELECT}
         FROM public.meta_recovery_archive_jobs
        WHERE id = $1::uuid AND workspace_id = $2 AND base_id = $3 AND sheet_id = $4 AND actor_id = $5`,
      [identity.jobId, identity.workspaceId, identity.baseId, identity.sheetId, identity.actorId],
    )
    const row = result.rows[0] as JobRow | undefined
    if (!row) notFound()
    if (!(await input.recheckAuthority(query))) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
    }
    return snapshotFromJobRow(row)
  })
}

/** Provenance-aware sweeper. Legacy NULL-kind burns and every ambiguous row stay forever. */
export async function pruneEligibleRecoveryTokenBurns(
  transaction: RecoveryArchiveRestoreJobTransaction,
  limitInput = 100,
): Promise<number> {
  const limit = Math.min(1000, Math.max(1, Math.floor(limitInput)))
  const candidatesResult = await transaction((query) => query(
      `SELECT burn_row.token_sha256,
              burn_row.row_version::text AS row_version,
              burn_row.sheet_id,
              burn_row.archive_generation_id::text AS archive_generation_id,
              archive_row.key_id
         FROM public.meta_recovery_token_burns burn_row
         JOIN public.meta_recovery_archives archive_row
           ON archive_row.generation_id = burn_row.archive_generation_id
        WHERE burn_row.burn_kind IN ('sync', 'async')
          AND burn_row.terminal_at IS NOT NULL
          AND burn_row.retain_until <= clock_timestamp()
        ORDER BY burn_row.sheet_id, archive_row.key_id,
                 burn_row.archive_generation_id, burn_row.retain_until, burn_row.token_sha256
        LIMIT $1::int`,
      [limit],
    ))
  let deleted = 0
  for (const row of candidatesResult.rows as Array<Record<string, unknown>>) {
    const didDelete = await transaction(async (query) => {
      const sheetId = opaque(row.sheet_id)
      const keyId = opaque(row.key_id)
      const generationId = opaque(row.archive_generation_id)
      await acquireCanonicalSheetFence(query, sheetId)
      await lockRecoveryArchiveKeyRow(query, keyId)
      await lockRecoveryArchiveGenerationRow(query, generationId, sheetId, keyId)
      const result = await query(
        `SELECT public.meta_recovery_token_burn_delete_authorize($1, $2::bigint) AS deleted`,
        [sha(row.token_sha256), positiveDecimal(row.row_version)],
      )
      return (result.rows[0] as { deleted?: unknown } | undefined)?.deleted === true
    })
    if (didDelete) deleted += 1
  }
  return deleted
}

async function lockRecoveryArchiveKey(
  query: RecoveryArchiveRestoreJobQuery,
  keyId: string,
  requireActive: boolean,
): Promise<void> {
  const result = await query(
    `SELECT key_id
       FROM public.meta_recovery_archive_keys
      WHERE key_id = $1
        AND state ${requireActive ? "= 'active'" : "IN ('active', 'retiring')"}
      FOR UPDATE`,
    [keyId],
  )
  if (result.rows.length !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT')
  }
}

async function lockRecoveryArchiveKeyRow(
  query: RecoveryArchiveRestoreJobQuery,
  keyId: string,
): Promise<void> {
  const result = await query(
    `SELECT key_id FROM public.meta_recovery_archive_keys WHERE key_id = $1 FOR UPDATE`,
    [keyId],
  )
  if (result.rows.length !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT')
  }
}

async function lockRecoveryArchiveGenerationRow(
  query: RecoveryArchiveRestoreJobQuery,
  generationId: string,
  sheetId: string,
  keyId: string,
): Promise<void> {
  const result = await query(
    `SELECT generation_id
       FROM public.meta_recovery_archives
      WHERE generation_id = $1::uuid AND sheet_id = $2 AND key_id = $3
      FOR UPDATE`,
    [generationId, sheetId, keyId],
  )
  if (result.rows.length !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT')
  }
}

async function lockRecoveryArchiveBinding(
  query: RecoveryArchiveRestoreJobQuery,
  plan: RecoveryArchiveRestorePlan,
  requireUnexpired: boolean,
  requiredThrough?: string,
): Promise<void> {
  const result = await query(
    `SELECT generation_id
       FROM public.meta_recovery_archives
      WHERE generation_id = $1::uuid
        AND workspace_id = $2 AND base_id = $3 AND sheet_id = $4
        AND root_hash = $5 AND source_vector_hash = $6 AND key_id = $7
        AND state = 'verified' AND build_status = 'finalized' AND coverage_status = 'complete'
        ${requireUnexpired ? 'AND expires_at > clock_timestamp()' : ''}
        ${requiredThrough ? 'AND expires_at >= $8::timestamptz' : ''}
      FOR UPDATE`,
    [
      plan.archiveGenerationId,
      plan.workspaceId,
      plan.baseId,
      plan.sheetId,
      plan.archiveRootHash,
      plan.sourceVectorHash,
      plan.keyId,
      ...(requiredThrough ? [requiredThrough] : []),
    ],
  )
  if (result.rows.length !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT')
  }
}

async function lockRestoreJobBlock(
  query: RecoveryArchiveRestoreJobQuery,
  expected: { jobId: string; sheetId: string; blockFence: string },
): Promise<void> {
  const result = await query(
    `SELECT id
       FROM public.meta_sheets
      WHERE id = $1
        AND recovery_writer_state = 'archiving'
        AND recovery_writer_owner_kind = 'restore_job'
        AND recovery_writer_owner_id = $2
        AND recovery_writer_owner_fence = $3::bigint
        AND recovery_writer_lease_until > clock_timestamp()
      FOR UPDATE`,
    [expected.sheetId, expected.jobId, expected.blockFence],
  )
  if (result.rows.length !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_BLOCK_LOST')
  }
}

async function releaseRestoreJobBlock(
  query: RecoveryArchiveRestoreJobQuery,
  expected: { jobId: string; sheetId: string; blockFence: string },
): Promise<void> {
  if (!(await releaseRestoreJobBlockIfOwned(query, expected))) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_BLOCK_LOST')
  }
}

async function releaseRestoreJobBlockIfOwned(
  query: RecoveryArchiveRestoreJobQuery,
  expected: { jobId: string; sheetId: string; blockFence: string },
): Promise<boolean> {
  const result = await query(
    `UPDATE public.meta_sheets
        SET recovery_writer_state = NULL,
            recovery_writer_owner_kind = NULL,
            recovery_writer_owner_id = NULL,
            recovery_writer_lease_until = NULL,
            recovery_writer_updated_at = NULL
      WHERE id = $1
        AND recovery_writer_state = 'archiving'
        AND recovery_writer_owner_kind = 'restore_job'
        AND recovery_writer_owner_id = $2
        AND recovery_writer_owner_fence = $3::bigint`,
    [expected.sheetId, expected.jobId, expected.blockFence],
  )
  return rowCount(result) === 1
}

async function lockJobRow(
  query: RecoveryArchiveRestoreJobQuery,
  jobId: string,
  sheetId: string,
): Promise<JobRow> {
  const result = await query(
    `${JOB_SNAPSHOT_SELECT}, token_sha256, scope_hash, archive_generation_id::text,
       archive_root_hash, source_vector_hash, plan_hash, key_id,
       worker_owner_id, lease_until::text,
       lease_until > clock_timestamp() AS lease_live,
       lease_until <= clock_timestamp() AS lease_expired,
       resume_deadline > clock_timestamp() AS resume_live
      FROM public.meta_recovery_archive_jobs
      WHERE id = $1::uuid AND sheet_id = $2
      FOR UPDATE`,
    [jobId, sheetId],
  )
  const row = result.rows[0] as JobRow | undefined
  if (!row) notFound()
  return row
}

async function lockClaimedJob(
  query: RecoveryArchiveRestoreJobQuery,
  claim: RecoveryArchiveRestoreJobWorkerClaim,
): Promise<JobRow> {
  const row = await lockJobRow(query, claim.jobId, claim.sheetId)
  if (
    row.state !== 'applying' ||
    row.key_id !== claim.keyId ||
    decimal(row.block_fence) !== claim.blockFence ||
    row.worker_owner_id !== claim.workerOwnerId ||
    decimal(row.worker_fence) !== claim.workerFence ||
    timestamp(row.lease_until) !== claim.leaseUntil ||
    row.lease_live !== true
  ) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
  }
  return row
}

async function lockChunkRow(
  query: RecoveryArchiveRestoreJobQuery,
  jobId: string,
  chunkIndex: number,
): Promise<ChunkRow> {
  const result = await query(
    `SELECT chunk_index, chunk_hash, chunk_object_id, chunk_object_version,
            chunk_object_sha256, chunk_object_size::text AS chunk_object_size,
            chunk_object_expires_at::text AS chunk_object_expires_at,
            record_count::text AS record_count, state,
            operation_id::text AS operation_id,
            endpoint_seq::text AS endpoint_seq,
            committed_count::text AS committed_count
       FROM public.meta_recovery_archive_job_chunks
      WHERE job_id = $1::uuid AND chunk_index = $2::int
      FOR UPDATE`,
    [jobId, chunkIndex],
  )
  const row = result.rows[0] as ChunkRow | undefined
  if (!row) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
  }
  return row
}

async function readNextPendingChunk(
  query: RecoveryArchiveRestoreJobQuery,
  jobId: string,
): Promise<Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'> | null> {
  const result = await query(
    `SELECT chunk_index, chunk_hash, chunk_object_id, chunk_object_version,
            chunk_object_sha256, chunk_object_size::text AS chunk_object_size,
            chunk_object_expires_at::text AS chunk_object_expires_at,
            record_count::text AS record_count
       FROM public.meta_recovery_archive_job_chunks
      WHERE job_id = $1::uuid AND state = 'pending'
      ORDER BY chunk_index
      LIMIT 1`,
    [jobId],
  )
  const row = result.rows[0] as ChunkRow | undefined
  if (!row) return null
  return Object.freeze({
    chunkIndex: nonnegativeInteger(row.chunk_index),
    chunkHash: sha(row.chunk_hash),
    chunkObjectId: opaque(row.chunk_object_id),
    chunkObjectVersion: opaque(row.chunk_object_version),
    chunkObjectSha256: sha(row.chunk_object_sha256),
    chunkObjectSize: positiveDecimal(row.chunk_object_size),
    chunkObjectExpiresAt: timestamp(row.chunk_object_expires_at),
    recordCount: positiveDecimal(row.record_count),
  })
}

async function terminalizeJobAndBurn(
  query: RecoveryArchiveRestoreJobQuery,
  input: {
    job: JobRow
    state: 'done' | 'abandoned_partial' | 'cancelled_zero_write'
    terminalOperationId: string | null
    replayHorizonMs: number
  },
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  const jobId = opaque(input.job.id)
  const updated = await query(
    `UPDATE public.meta_recovery_archive_jobs
        SET state = $2,
            worker_owner_id = NULL,
            lease_until = NULL,
            terminal_operation_id = $3::uuid,
            terminal_at = clock_timestamp(),
            row_version = row_version + 1
      WHERE id = $1::uuid AND row_version = $4::bigint
      RETURNING terminal_at::text AS terminal_at`,
    [jobId, input.state, input.terminalOperationId, decimal(input.job.row_version)],
  )
  if (rowCount(updated) !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
  }
  const terminalAt = timestamp((updated.rows[0] as Record<string, unknown>).terminal_at)
  const burn = await query(
    `UPDATE public.meta_recovery_token_burns
        SET terminal_at = $2::timestamptz,
            retain_until = GREATEST(
              retain_until,
              $2::timestamptz + ($3::bigint * interval '1 millisecond')
            ),
            row_version = row_version + 1
      WHERE job_id = $1::uuid AND burn_kind = 'async' AND terminal_at IS NULL`,
    [jobId, terminalAt, String(input.replayHorizonMs)],
  )
  if (rowCount(burn) !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID')
  }
  return readJobSnapshotInTransaction(query, jobId)
}

async function readJobSnapshotInTransaction(
  query: RecoveryArchiveRestoreJobQuery,
  jobId: string,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  const result = await query(
    `${JOB_SNAPSHOT_SELECT} FROM public.meta_recovery_archive_jobs WHERE id = $1::uuid`,
    [jobId],
  )
  const row = result.rows[0] as JobRow | undefined
  if (!row) notFound()
  return snapshotFromJobRow(row)
}

const JOB_SNAPSHOT_SELECT = `SELECT id::text AS id, workspace_id, base_id, sheet_id, actor_id,
  recovery_mode, scope_kind, state,
  total_count::text AS total_count, completed_count::text AS completed_count,
  block_fence::text AS block_fence, worker_fence::text AS worker_fence,
  resume_deadline::text AS resume_deadline,
  terminal_operation_id::text AS terminal_operation_id,
  terminal_at::text AS terminal_at, row_version::text AS row_version`

function snapshotFromJobRow(row: JobRow): RecoveryArchiveRestoreJobSnapshot {
  if (!isJobState(row.state)) invalidInput()
  return Object.freeze({
    id: opaque(row.id),
    workspaceId: opaque(row.workspace_id),
    baseId: opaque(row.base_id),
    sheetId: opaque(row.sheet_id),
    actorId: opaque(row.actor_id),
    recoveryMode: recoveryMode(row.recovery_mode),
    scopeKind: scopeKind(row.scope_kind),
    state: row.state,
    totalCount: positiveDecimal(row.total_count),
    completedCount: decimal(row.completed_count),
    workerFence: decimal(row.worker_fence),
    resumeDeadline: timestamp(row.resume_deadline),
    terminalOperationId: row.terminal_operation_id === null ? null : opaque(row.terminal_operation_id),
    terminalAt: row.terminal_at === null ? null : timestamp(row.terminal_at),
    rowVersion: positiveDecimal(row.row_version),
  })
}

function requireCandidate(value: unknown): RecoveryArchiveRestoreJobCandidate {
  if (
    typeof value !== 'object' || value === null || !candidates.has(value) ||
    (value as RecoveryArchiveRestoreJobCandidate)[candidateBrand] !== candidateBrand
  ) {
    invalidInput()
  }
  return value as RecoveryArchiveRestoreJobCandidate
}

function requireWorkerClaim(value: unknown): RecoveryArchiveRestoreJobWorkerClaim {
  if (
    typeof value !== 'object' || value === null || !workerClaims.has(value) ||
    (value as RecoveryArchiveRestoreJobWorkerClaim)[workerClaimBrand] !== workerClaimBrand
  ) {
    invalidInput()
  }
  return value as RecoveryArchiveRestoreJobWorkerClaim
}

function ownerIdentity(
  input: RecoveryArchiveRestoreJobOwnerIdentityInput,
): RecoveryArchiveRestoreJobOwnerIdentityInput {
  return Object.freeze({
    workspaceId: opaque(input.workspaceId),
    baseId: opaque(input.baseId),
    sheetId: opaque(input.sheetId),
    actorId: opaque(input.actorId),
    jobId: opaque(input.jobId),
  })
}

async function readCandidateIdentity(
  query: RecoveryArchiveRestoreJobQuery,
  identity: { workspaceId: string; baseId: string; sheetId: string; actorId: string; jobId: string },
): Promise<RecoveryArchiveRestoreJobCandidate> {
  const result = await query(
    `SELECT id::text AS id, sheet_id, key_id, block_fence::text AS block_fence
       FROM public.meta_recovery_archive_jobs
      WHERE id = $1::uuid AND workspace_id = $2 AND base_id = $3 AND sheet_id = $4 AND actor_id = $5`,
    [identity.jobId, identity.workspaceId, identity.baseId, identity.sheetId, identity.actorId],
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) notFound()
  return {
    [candidateBrand]: candidateBrand,
    jobId: opaque(row.id),
    sheetId: opaque(row.sheet_id),
    keyId: opaque(row.key_id),
    blockFence: positiveDecimal(row.block_fence),
  }
}

function jobIdentityMatches(
  row: JobRow,
  identity: { workspaceId: string; baseId: string; sheetId: string; actorId: string; jobId: string },
): boolean {
  return row.id === identity.jobId && row.workspace_id === identity.workspaceId &&
    row.base_id === identity.baseId && row.sheet_id === identity.sheetId && row.actor_id === identity.actorId
}

function isClaimableJobRow(row: JobRow): boolean {
  if (row.resume_live !== true) return false
  if (row.state === 'planned') return true
  return row.state === 'applying' && row.lease_until !== null && row.lease_expired === true
}

function admitMaterializedChunk(value: unknown): RecoveryArchiveRestoreChunkMaterialized {
  if (!value || typeof value !== 'object') invalidInput()
  const row = value as Record<string, unknown>
  return Object.freeze({
    chunkIndex: nonnegativeInteger(row.chunkIndex),
    chunkHash: sha(row.chunkHash),
    chunkObjectId: opaque(row.chunkObjectId),
    chunkObjectVersion: opaque(row.chunkObjectVersion),
    chunkObjectSha256: sha(row.chunkObjectSha256),
    chunkObjectSize: positiveDecimal(row.chunkObjectSize),
    chunkObjectExpiresAt: timestamp(row.chunkObjectExpiresAt),
    recordCount: positiveDecimal(row.recordCount),
    payload: row.payload,
  })
}

function assertMaterializedMatches(
  expected: Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'>,
  actual: RecoveryArchiveRestoreChunkMaterialized,
): void {
  if (
    expected.chunkIndex !== actual.chunkIndex || expected.chunkHash !== actual.chunkHash ||
    expected.chunkObjectId !== actual.chunkObjectId ||
    expected.chunkObjectVersion !== actual.chunkObjectVersion ||
    expected.chunkObjectSha256 !== actual.chunkObjectSha256 ||
    expected.chunkObjectSize !== actual.chunkObjectSize ||
    expected.chunkObjectExpiresAt !== actual.chunkObjectExpiresAt ||
    expected.recordCount !== actual.recordCount
  ) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
  }
}

function assertChunkMatches(row: ChunkRow, actual: RecoveryArchiveRestoreChunkMaterialized): void {
  if (
    row.chunk_index !== actual.chunkIndex || row.chunk_hash !== actual.chunkHash ||
    row.chunk_object_id !== actual.chunkObjectId ||
    row.chunk_object_version !== actual.chunkObjectVersion ||
    row.chunk_object_sha256 !== actual.chunkObjectSha256 ||
    decimal(row.chunk_object_size) !== actual.chunkObjectSize ||
    timestamp(row.chunk_object_expires_at) !== actual.chunkObjectExpiresAt ||
    decimal(row.record_count) !== actual.recordCount || row.state !== 'pending'
  ) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
  }
}

function admitApplyReceipt(value: unknown): RecoveryArchiveRestoreChunkApplyReceipt {
  if (!value || typeof value !== 'object') {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID')
  }
  const row = value as Record<string, unknown>
  return {
    endpointSeq: positiveDecimal(row.endpointSeq),
    eventCount: safePositiveInteger(row.eventCount),
    committedCount: positiveDecimal(row.committedCount),
  }
}

function isJobState(value: unknown): value is RecoveryArchiveRestoreJobState {
  return typeof value === 'string' &&
    (RECOVERY_ARCHIVE_RESTORE_JOB_STATES as readonly string[]).includes(value)
}

function recoveryMode(value: unknown): 'revert' | 'reset' {
  if (value !== 'revert' && value !== 'reset') invalidInput()
  return value
}

function scopeKind(value: unknown): 'whole_sheet' | 'selected_records' | 'selected_fields' {
  if (value !== 'whole_sheet' && value !== 'selected_records' && value !== 'selected_fields') invalidInput()
  return value
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) invalidInput()
  return value
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalidInput()
  return value
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) invalidInput()
  return value
}

function positiveDecimal(value: unknown): string {
  const result = decimal(value)
  if (result === '0') invalidInput()
  return result
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidInput()
  return value
}

function safePositiveInteger(value: unknown): number {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalidInput()
  return value as number
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) invalidInput()
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) invalidInput()
  return value instanceof Date ? value.toISOString() : value
}

function futureTimestamp(value: unknown): string {
  const result = timestamp(value)
  if (new Date(result).getTime() <= Date.now()) invalidInput()
  return result
}

function laterTimestamp(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right
}

function rowCount(result: { rows: unknown[]; rowCount?: number | null }): number {
  return typeof result.rowCount === 'number' ? result.rowCount : result.rows.length
}

function isTokenReplayViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const postgres = error as { code?: unknown; constraint?: unknown }
  return postgres.code === '23505' && (
    postgres.constraint === 'uq_meta_recovery_archive_jobs_token' ||
    postgres.constraint === 'meta_recovery_token_burns_pkey'
  )
}

function invalidInput(): never {
  throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT')
}

function notFound(): never {
  throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND')
}
