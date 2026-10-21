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
import {
  consumeMaterializedArchiveAsyncChunkReceiptInternal,
  type MaterializedArchiveAsyncChunkReceipt,
} from './exact-anchor-recovery-execute'
import {
  consumeRecoveryArchiveAsyncRestoreFacadeLeaseInternal,
  type RecoveryArchiveAsyncRestoreFacadeLease,
} from './recovery-archive-async-restore'
import { isMultitableRecoveryArchiveEnabled } from './recovery-archive-contract'

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
  | 'RECOVERY_ARCHIVE_RESTORE_JOB_DISABLED'
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

export interface RecoveryArchiveRestoreRequestIdentity {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
}

export interface PrepareRecoveryArchiveRestorePlanInput {
  readonly token: string
  readonly plan: RecoveryArchiveRestorePlan
  readonly identity: RecoveryArchiveRestoreRequestIdentity
}

export interface AcceptRecoveryArchiveRestoreJobInput {
  readonly token: string
  readonly plan: RecoveryArchiveRestorePlan
  readonly identity: RecoveryArchiveRestoreRequestIdentity
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
  readonly archiveGenerationId: string
  readonly blockFence: string
  readonly resumeDeadline: string
}

const workerClaimBrand: unique symbol = Symbol('RecoveryArchiveRestoreJobWorkerClaim')
const workerClaims = new WeakSet<object>()

export interface RecoveryArchiveRestoreJobWorkerClaim {
  readonly [workerClaimBrand]: typeof workerClaimBrand
  readonly jobId: string
  readonly sheetId: string
  readonly keyId: string
  readonly archiveGenerationId: string
  readonly blockFence: string
  readonly workerOwnerId: string
  readonly workerFence: string
  readonly leaseUntil: string
  readonly resumeDeadline: string
}

const chunkExecutionLeaseBrand: unique symbol = Symbol(
  'RecoveryArchiveRestoreChunkExecutionLease',
)
const chunkExecutionLeases = new WeakMap<
  object,
  {
    readonly query: RecoveryArchiveRestoreJobQuery
    readonly jobId: string
    readonly sheetId: string
    readonly archiveGenerationId: string
    readonly chunkIndex: number
  }
>()

export interface RecoveryArchiveRestoreChunkExecutionLease {
  readonly [chunkExecutionLeaseBrand]: typeof chunkExecutionLeaseBrand
}

/**
 * One-shot proof that L8 is executing inside the durable runner after the exact generation, job, and chunk
 * rows were locked. The runner is the only minting site; direct imports of the L8 kernel cannot forge it.
 */
export function consumeRecoveryArchiveRestoreChunkExecutionLeaseInternal(
  query: RecoveryArchiveRestoreJobQuery,
  lease: RecoveryArchiveRestoreChunkExecutionLease,
  expected: {
    readonly jobId: string
    readonly sheetId: string
    readonly archiveGenerationId: string
    readonly chunkIndex: number
  },
): boolean {
  const binding = chunkExecutionLeases.get(lease)
  if (
    !binding || binding.query !== query || binding.jobId !== expected.jobId ||
    binding.sheetId !== expected.sheetId ||
    binding.archiveGenerationId !== expected.archiveGenerationId ||
    binding.chunkIndex !== expected.chunkIndex
  ) {
    return false
  }
  chunkExecutionLeases.delete(lease)
  return true
}

function mintRecoveryArchiveRestoreChunkExecutionLease(
  query: RecoveryArchiveRestoreJobQuery,
  binding: {
    readonly jobId: string
    readonly sheetId: string
    readonly archiveGenerationId: string
    readonly chunkIndex: number
  },
): RecoveryArchiveRestoreChunkExecutionLease {
  const lease = Object.freeze({
    [chunkExecutionLeaseBrand]: chunkExecutionLeaseBrand,
  }) as RecoveryArchiveRestoreChunkExecutionLease
  chunkExecutionLeases.set(lease, { query, ...binding })
  return lease
}

export interface RecoveryArchiveRestoreWorkerBinding {
  readonly jobId: string
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recoveryMode: 'revert' | 'reset'
  readonly scopeKind: 'whole_sheet' | 'selected_records' | 'selected_fields'
  readonly scopeHash: string
  readonly archiveGenerationId: string
  readonly archiveRootHash: string
  readonly sourceVectorHash: string
  readonly keyId: string
  readonly planHash: string
  readonly planObjectId: string
  readonly planObjectVersion: string
  readonly planObjectSha256: string
  readonly planObjectSize: string
  readonly planObjectExpiresAt: string
}

export interface ClaimRecoveryArchiveRestoreJobInput {
  readonly workerOwnerId: string
  readonly leaseUntil: Date | string
}

export interface RenewRecoveryArchiveRestoreJobLeaseInput {
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
  readonly executionLease: RecoveryArchiveRestoreChunkExecutionLease
}

interface RecoveryArchiveRestoreChunkApplyReceiptTestOnly {
  readonly operationId?: string
  readonly endpointSeq: string
  readonly eventCount: number
  readonly committedCount: string
}

export interface RunRecoveryArchiveRestoreChunkInput {
  readonly facadeLease: RecoveryArchiveAsyncRestoreFacadeLease
  readonly read: RecoveryArchiveRestoreJobQuery
  readonly materialize: (
    expected: Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'>,
  ) => Promise<RecoveryArchiveRestoreChunkMaterialized>
  readonly recheckAuthority: (
    query: RecoveryArchiveRestoreJobQuery,
    context: Omit<
      RecoveryArchiveRestoreChunkApplyContext,
      'operationId' | 'payload' | 'executionLease'
    >,
  ) => Promise<boolean>
  /** The FIRST statement group in the apply transaction. */
  readonly prelock: (
    query: RecoveryArchiveRestoreJobQuery,
    context: { readonly jobId: string; readonly sheetId: string },
  ) => Promise<void>
  readonly apply: (
    query: RecoveryArchiveRestoreJobQuery,
    context: RecoveryArchiveRestoreChunkApplyContext,
  ) => Promise<MaterializedArchiveAsyncChunkReceipt>
}

interface RunRecoveryArchiveRestoreChunkTestInput {
  readonly read: RecoveryArchiveRestoreJobQuery
  readonly materialize: RunRecoveryArchiveRestoreChunkInput['materialize']
  readonly recheckAuthority: RunRecoveryArchiveRestoreChunkInput['recheckAuthority']
  readonly prelock?: RunRecoveryArchiveRestoreChunkInput['prelock']
  readonly apply: (
    query: RecoveryArchiveRestoreJobQuery,
    context: RecoveryArchiveRestoreChunkApplyContext,
  ) => Promise<RecoveryArchiveRestoreChunkApplyReceiptTestOnly>
}

type RunRecoveryArchiveRestoreChunkCoreInput = Omit<
  RunRecoveryArchiveRestoreChunkInput,
  'apply' | 'prelock' | 'facadeLease'
> & {
  readonly prelock?: RunRecoveryArchiveRestoreChunkInput['prelock']
  readonly apply: (
    query: RecoveryArchiveRestoreJobQuery,
    context: RecoveryArchiveRestoreChunkApplyContext,
  ) => Promise<unknown>
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

export interface ListRecoveryArchiveRestoreJobsInput {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recheckAuthority: (
    query: RecoveryArchiveRestoreJobQuery,
  ) => Promise<boolean>
  readonly cursor?: string
  readonly limit?: number
  readonly env?: NodeJS.ProcessEnv
}

export interface RecoveryArchiveRestoreJobPage {
  readonly entries: readonly RecoveryArchiveRestoreJobSnapshot[]
  readonly nextCursor: string | null
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
  created_at?: unknown
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

type AdmittedPreparedRestorePlan = {
  tokenSha256: string
  tokenExpiresAt: string
  identity: RecoveryArchiveRestoreRequestIdentity
  claims: ExactArchiveRecoveryIdentityClaims
  plan: RecoveryArchiveRestorePlan
}

function admitPreparedRestorePlan(
  input: PrepareRecoveryArchiveRestorePlanInput | AcceptRecoveryArchiveRestoreJobInput,
): AdmittedPreparedRestorePlan {
  if (!input || typeof input !== 'object') invalidInput()
  const identity = Object.freeze({
    workspaceId: opaque(input.identity?.workspaceId),
    baseId: opaque(input.identity?.baseId),
    sheetId: opaque(input.identity?.sheetId),
    actorId: opaque(input.identity?.actorId),
  })
  const token = opaque(input.token)
  const verified = verifyExactArchiveRecoveryIdentity(token, {
    sheetId: identity.sheetId,
    actorId: identity.actorId,
  })
  if (
    !verified.valid || !verified.claims || !verified.expiresAt ||
    !verified.claims.archivePlanObject
  ) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
  }
  try {
    const suppliedPlan = input.plan
    const plan = compileRecoveryArchiveRestorePlan(suppliedPlan)
    if (
      plan.planHash !== suppliedPlan.planHash ||
      plan.totalCount !== suppliedPlan.totalCount ||
      plan.workspaceId !== identity.workspaceId ||
      plan.baseId !== identity.baseId ||
      plan.sheetId !== identity.sheetId ||
      plan.actorId !== identity.actorId
    ) {
      throw new Error('noncanonical plan')
    }
    assertRecoveryArchiveRestorePlanMatchesClaims(plan, verified.claims)
    const tokenExpiresAt = timestamp(verified.expiresAt)
    if (new Date(plan.planObjectExpiresAt).getTime() < new Date(tokenExpiresAt).getTime()) {
      throw new Error('plan object expires before token')
    }
    return {
      tokenSha256: createHash('sha256').update(token).digest('hex'),
      tokenExpiresAt,
      identity,
      claims: verified.claims,
      plan,
    }
  } catch (error) {
    if (error instanceof RecoveryArchiveRestoreJobError) throw error
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
  }
}

async function lockPreparedRestorePlan(
  query: RecoveryArchiveRestoreJobQuery,
  admitted: AdmittedPreparedRestorePlan,
): Promise<'prepared' | 'accepted' | 'invalid'> {
  const result = await query(
    `SELECT state,
            (
              workspace_id=$2 AND base_id=$3 AND sheet_id=$4 AND actor_id=$5 AND
              archive_generation_id=$6::uuid AND archive_root_hash=$7 AND
              source_vector_hash=$8 AND key_id=$9 AND plan_hash=$10 AND
              plan_object_id=$11 AND plan_object_version=$12 AND
              plan_object_sha256=$13 AND plan_object_size=$14::bigint AND
              plan_object_expires_at=$15::timestamptz AND
              token_expires_at=$16::timestamptz
            ) AS exact_binding,
            token_expires_at > clock_timestamp() AS token_live,
            row_version::text AS row_version
       FROM public.meta_recovery_archive_restore_plans
      WHERE token_sha256=$1
      FOR UPDATE`,
    [
      admitted.tokenSha256,
      admitted.identity.workspaceId,
      admitted.identity.baseId,
      admitted.identity.sheetId,
      admitted.identity.actorId,
      admitted.plan.archiveGenerationId,
      admitted.plan.archiveRootHash,
      admitted.plan.sourceVectorHash,
      admitted.plan.keyId,
      admitted.plan.planHash,
      admitted.plan.planObjectId,
      admitted.plan.planObjectVersion,
      admitted.plan.planObjectSha256,
      admitted.plan.planObjectSize,
      admitted.plan.planObjectExpiresAt,
      admitted.tokenExpiresAt,
    ],
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row || row.exact_binding !== true) return 'invalid'
  if (row.state === 'prepared' && row.token_live === true && row.row_version === '1') {
    return 'prepared'
  }
  if (row.state === 'accepted' && row.row_version === '2') return 'accepted'
  return 'invalid'
}

/**
 * Persist the exact server-frozen plan identity before it is returned to the caller. The raw token
 * and recovered values are not stored. Repeating the same prepared token is idempotent; an accepted
 * or differently-bound token is refused.
 */
export async function prepareRecoveryArchiveRestorePlan(
  transaction: RecoveryArchiveRestoreJobTransaction,
  input: PrepareRecoveryArchiveRestorePlanInput,
): Promise<void> {
  const admitted = admitPreparedRestorePlan(input)
  await transaction(async (query) => {
    await acquireCanonicalSheetFence(query, admitted.plan.sheetId)
    await lockRecoveryArchiveKey(query, admitted.plan.keyId, true)
    await lockRecoveryArchiveBinding(
      query,
      admitted.plan,
      true,
      admitted.plan.planObjectExpiresAt,
    )
    await query(
      `INSERT INTO public.meta_recovery_archive_restore_plans (
         token_sha256, workspace_id, base_id, sheet_id, actor_id,
         archive_generation_id, archive_root_hash, source_vector_hash, key_id,
         plan_hash, plan_object_id, plan_object_version, plan_object_sha256,
         plan_object_size, plan_object_expires_at, token_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::uuid, $7, $8, $9,
         $10, $11, $12, $13,
         $14::bigint, $15::timestamptz, $16::timestamptz
       )
       ON CONFLICT (token_sha256) DO NOTHING`,
      [
        admitted.tokenSha256,
        admitted.identity.workspaceId,
        admitted.identity.baseId,
        admitted.identity.sheetId,
        admitted.identity.actorId,
        admitted.plan.archiveGenerationId,
        admitted.plan.archiveRootHash,
        admitted.plan.sourceVectorHash,
        admitted.plan.keyId,
        admitted.plan.planHash,
        admitted.plan.planObjectId,
        admitted.plan.planObjectVersion,
        admitted.plan.planObjectSha256,
        admitted.plan.planObjectSize,
        admitted.plan.planObjectExpiresAt,
        admitted.tokenExpiresAt,
      ],
    )
    const exact = await lockPreparedRestorePlan(query, admitted)
    if (exact === 'accepted') {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_TOKEN_REPLAYED')
    }
    if (exact !== 'prepared') {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
    }
  })
}

export async function sweepExpiredRecoveryArchiveRestorePlans(
  transaction: RecoveryArchiveRestoreJobTransaction,
  limitInput = 100,
): Promise<number> {
  const limit = Math.min(1000, safePositiveInteger(limitInput))
  return transaction(async (query) => {
    const result = await query(
      `WITH candidates AS (
         SELECT token_sha256
           FROM public.meta_recovery_archive_restore_plans
          WHERE state='prepared' AND token_expires_at <= clock_timestamp()
          ORDER BY token_expires_at, token_sha256
          FOR UPDATE SKIP LOCKED
          LIMIT $1::int
       )
       UPDATE public.meta_recovery_archive_restore_plans plan_row
          SET state='expired', row_version=plan_row.row_version+1
         FROM candidates
        WHERE plan_row.token_sha256=candidates.token_sha256
          AND plan_row.state='prepared'
          AND plan_row.token_expires_at <= clock_timestamp()
       RETURNING plan_row.token_sha256`,
      [limit],
    )
    return result.rows.length
  })
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
  const admitted = admitPreparedRestorePlan(input)
  const { claims, identity, plan, tokenExpiresAt, tokenSha256 } = admitted
  const resumeDeadline = futureTimestamp(input.resumeDeadline)
  const retainUntil = laterTimestamp(tokenExpiresAt, resumeDeadline)
  const jobId = randomUUID()

  try {
    return await transaction(async (query) => {
      const prepared = await prepareArchiveWriterBlockTransaction(query, plan.sheetId)
      await lockRecoveryArchiveKey(query, plan.keyId, true)
      await lockRecoveryArchiveBinding(query, plan, true, resumeDeadline)
      const preparedState = await lockPreparedRestorePlan(query, admitted)
      if (preparedState === 'accepted') {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_TOKEN_REPLAYED')
      }
      if (preparedState !== 'prepared') {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
      }
      if (!(await input.recheckAuthority(query, { claims, plan }))) {
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
          identity.workspaceId,
          identity.baseId,
          identity.sheetId,
          identity.actorId,
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
      const acceptedPlan = await query(
        `UPDATE public.meta_recovery_archive_restore_plans
            SET state='accepted', accepted_job_id=$2::uuid,
                accepted_at=clock_timestamp(), row_version=row_version+1
          WHERE token_sha256=$1 AND state='prepared' AND row_version=1
          RETURNING token_sha256`,
        [tokenSha256, jobId],
      )
      if (acceptedPlan.rows.length !== 1) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID')
      }
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
      `SELECT id::text AS id, sheet_id, key_id,
              archive_generation_id::text AS archive_generation_id,
              block_fence::text AS block_fence,
              resume_deadline::text AS resume_deadline
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
      archiveGenerationId: opaque(row.archive_generation_id),
      blockFence: positiveDecimal(row.block_fence),
      resumeDeadline: timestamp(row.resume_deadline),
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
    await lockRecoveryArchiveGenerationRow(
      query,
      candidate.archiveGenerationId,
      candidate.sheetId,
      candidate.keyId,
    )
    await lockRestoreJobBlock(query, candidate)
    const row = await lockJobRow(query, candidate.jobId, candidate.sheetId)
    if (
      row.key_id !== candidate.keyId ||
      opaque(row.archive_generation_id) !== candidate.archiveGenerationId ||
      decimal(row.block_fence) !== candidate.blockFence ||
      timestamp(row.resume_deadline) !== candidate.resumeDeadline ||
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
      archiveGenerationId: candidate.archiveGenerationId,
      blockFence: candidate.blockFence,
      workerOwnerId,
      workerFence: positiveDecimal(claimRow.worker_fence),
      leaseUntil: timestamp(claimRow.lease_until),
      resumeDeadline: candidate.resumeDeadline,
    }
    workerClaims.add(claim)
    return Object.freeze(claim)
  })
}

/** Extend the current worker lease without changing its fence. The old branded claim becomes invalid. */
export async function renewRecoveryArchiveRestoreJobLease(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
  input: RenewRecoveryArchiveRestoreJobLeaseInput,
): Promise<RecoveryArchiveRestoreJobWorkerClaim> {
  const claim = requireWorkerClaim(claimInput)
  const leaseUntil = timestamp(input?.leaseUntil)
  const renewedLeaseUntil = await transaction(async (query) => {
    await prepareArchiveWriterBlockTransaction(query, claim.sheetId)
    await lockRecoveryArchiveKey(query, claim.keyId, false)
    await lockRecoveryArchiveGenerationRow(
      query,
      claim.archiveGenerationId,
      claim.sheetId,
      claim.keyId,
    )
    await lockRestoreJobBlock(query, claim)
    const job = await lockClaimedJob(query, claim)
    if (
      timestamp(job.resume_deadline) !== claim.resumeDeadline ||
      new Date(leaseUntil).getTime() > new Date(claim.resumeDeadline).getTime()
    ) {
      invalidInput()
    }
    const renewed = await query(
      `UPDATE public.meta_recovery_archive_jobs
          SET lease_until = $2::timestamptz,
              row_version = row_version + 1
        WHERE id = $1::uuid
          AND row_version = $3::bigint
          AND worker_owner_id = $4
          AND worker_fence = $5::bigint
          AND lease_until = $6::timestamptz
          AND $2::timestamptz > clock_timestamp()
          AND $2::timestamptz <= resume_deadline
          AND resume_deadline > clock_timestamp()
        RETURNING lease_until::text AS lease_until`,
      [
        claim.jobId,
        leaseUntil,
        decimal(job.row_version),
        claim.workerOwnerId,
        claim.workerFence,
        claim.leaseUntil,
      ],
    )
    const row = renewed.rows[0] as Record<string, unknown> | undefined
    if (!row) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
    }
    return timestamp(row.lease_until)
  })
  workerClaims.delete(claim)
  const renewedClaim: RecoveryArchiveRestoreJobWorkerClaim = Object.freeze({
    ...claim,
    leaseUntil: renewedLeaseUntil,
  })
  workerClaims.add(renewedClaim)
  return renewedClaim
}

/**
 * Read the immutable worker/plan object binding outside the destructive transaction. Every mutable lease and
 * durable block field is rebound to the branded claim; the later apply transaction checks the same tuple again.
 */
export async function readRecoveryArchiveRestoreWorkerBinding(
  query: RecoveryArchiveRestoreJobQuery,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
): Promise<RecoveryArchiveRestoreWorkerBinding> {
  const claim = requireWorkerClaim(claimInput)
  const result = await query(
    `SELECT job_row.workspace_id, job_row.base_id, job_row.sheet_id, job_row.actor_id,
            job_row.recovery_mode, job_row.scope_kind, job_row.scope_hash,
            job_row.archive_generation_id::text AS archive_generation_id,
            job_row.archive_root_hash, job_row.source_vector_hash, job_row.key_id,
            job_row.plan_hash, job_row.plan_object_id, job_row.plan_object_version,
            job_row.plan_object_sha256,
            job_row.plan_object_size::text AS plan_object_size,
            job_row.plan_object_expires_at::text AS plan_object_expires_at
       FROM public.meta_recovery_archive_jobs job_row
       JOIN public.meta_sheets sheet_row ON sheet_row.id=job_row.sheet_id
      WHERE job_row.id=$1::uuid
        AND job_row.sheet_id=$2
        AND job_row.key_id=$3
        AND job_row.block_fence=$4::bigint
        AND job_row.state='applying'
        AND job_row.worker_owner_id=$5
        AND job_row.worker_fence=$6::bigint
        AND job_row.lease_until=$7::timestamptz
        AND job_row.archive_generation_id=$8::uuid
        AND job_row.lease_until > clock_timestamp()
        AND job_row.resume_deadline > clock_timestamp()
        AND sheet_row.recovery_writer_state='archiving'
        AND sheet_row.recovery_writer_owner_kind='restore_job'
        AND sheet_row.recovery_writer_owner_id=job_row.id::text
        AND sheet_row.recovery_writer_owner_fence=job_row.block_fence
        AND sheet_row.recovery_writer_lease_until > clock_timestamp()`,
    [
      claim.jobId,
      claim.sheetId,
      claim.keyId,
      claim.blockFence,
      claim.workerOwnerId,
      claim.workerFence,
      claim.leaseUntil,
      claim.archiveGenerationId,
    ],
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row || result.rows.length !== 1) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
  }
  return Object.freeze({
    jobId: claim.jobId,
    workspaceId: opaque(row.workspace_id),
    baseId: opaque(row.base_id),
    sheetId: opaque(row.sheet_id),
    actorId: opaque(row.actor_id),
    recoveryMode: recoveryMode(row.recovery_mode),
    scopeKind: scopeKind(row.scope_kind),
    scopeHash: sha(row.scope_hash),
    archiveGenerationId: opaque(row.archive_generation_id),
    archiveRootHash: sha(row.archive_root_hash),
    sourceVectorHash: sha(row.source_vector_hash),
    keyId: opaque(row.key_id),
    planHash: sha(row.plan_hash),
    planObjectId: opaque(row.plan_object_id),
    planObjectVersion: opaque(row.plan_object_version),
    planObjectSha256: sha(row.plan_object_sha256),
    planObjectSize: positiveDecimal(row.plan_object_size),
    planObjectExpiresAt: canonicalTimestamp(row.plan_object_expires_at),
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
  if (!input || typeof input.prelock !== 'function') invalidInput()
  const claim = requireWorkerClaim(claimInput)
  if (!consumeRecoveryArchiveAsyncRestoreFacadeLeaseInternal(input.facadeLease, claim)) invalidInput()
  return runRecoveryArchiveRestoreChunkCore(transaction, claim, input, 'l8')
}

async function runRecoveryArchiveRestoreChunkCore(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
  input: RunRecoveryArchiveRestoreChunkCoreInput,
  receiptMode: 'l8' | 'test',
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
    if (input.prelock) {
      await input.prelock(query, { jobId: claim.jobId, sheetId: claim.sheetId })
    }
    await prepareArchiveWriterBlockTransaction(query, claim.sheetId)
    await lockRecoveryArchiveKey(query, claim.keyId, false)
    await lockRecoveryArchiveGenerationRow(
      query,
      claim.archiveGenerationId,
      claim.sheetId,
      claim.keyId,
    )
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
    const provisionalOperationId = randomUUID()
    const executionLease = mintRecoveryArchiveRestoreChunkExecutionLease(query, {
      jobId: claim.jobId,
      sheetId: claim.sheetId,
      archiveGenerationId: claim.archiveGenerationId,
      chunkIndex: expected.chunkIndex,
    })
    const rawReceipt = await input.apply(query, {
      ...contextBase,
      operationId: provisionalOperationId,
      payload: materialized.payload,
      executionLease,
    })
    const receipt = receiptMode === 'l8'
      ? consumeMaterializedArchiveAsyncChunkReceiptInternal(
          query,
          rawReceipt as MaterializedArchiveAsyncChunkReceipt,
          {
            jobId: claim.jobId,
            sheetId: claim.sheetId,
            chunkIndex: expected.chunkIndex,
          },
        )
      : admitApplyReceiptTestOnly(rawReceipt)
    if (!receipt) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID')
    }
    if (receipt.committedCount !== decimal(chunk.record_count)) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID')
    }
    const operationId = receipt.operationId ?? provisionalOperationId
    if (receipt.operationId === undefined) {
      await sealDirectEventOperation(query, {
        sheetId: claim.sheetId,
        operationId,
        endpointSeq: receipt.endpointSeq,
        eventCount: receipt.eventCount,
        operationKind: 'restore_chunk',
      })
    }
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
          AND lease_until > clock_timestamp()
          AND resume_deadline > clock_timestamp()
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

async function runRecoveryArchiveRestoreChunkTestOnly(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
  input: RunRecoveryArchiveRestoreChunkTestInput,
): Promise<RecoveryArchiveRestoreChunkResult> {
  return runRecoveryArchiveRestoreChunkCore(transaction, claimInput, input, 'test')
}

async function runRecoveryArchiveRestoreL8ChunkTestOnly(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
  input: Omit<RunRecoveryArchiveRestoreChunkInput, 'facadeLease'>,
): Promise<RecoveryArchiveRestoreChunkResult> {
  return runRecoveryArchiveRestoreChunkCore(transaction, claimInput, input, 'l8')
}

/** Test-only compatibility seam for state-machine fixtures. It is absent from production module instances. */
export const recoveryArchiveRestoreJobTestHooks = process.env.NODE_ENV === 'test'
  ? Object.freeze({
      runChunk: runRecoveryArchiveRestoreChunkTestOnly,
      runL8Chunk: runRecoveryArchiveRestoreL8ChunkTestOnly,
    })
  : undefined

export async function pauseRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  claimInput: RecoveryArchiveRestoreJobWorkerClaim,
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  const claim = requireWorkerClaim(claimInput)
  return transaction(async (query) => {
    await prepareArchiveWriterBlockTransaction(query, claim.sheetId)
    await lockRecoveryArchiveKey(query, claim.keyId, false)
    await lockRecoveryArchiveGenerationRow(
      query,
      claim.archiveGenerationId,
      claim.sheetId,
      claim.keyId,
    )
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
    await lockRecoveryArchiveGenerationRow(
      query,
      candidate.archiveGenerationId,
      candidate.sheetId,
      candidate.keyId,
    )
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
    await lockRecoveryArchiveGenerationRow(
      query,
      claim.archiveGenerationId,
      claim.sheetId,
      claim.keyId,
    )
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
    await lockRecoveryArchiveGenerationRow(
      query,
      claim.archiveGenerationId,
      claim.sheetId,
      claim.keyId,
    )
    await lockRestoreJobBlock(query, claim)
    const job = await lockClaimedJob(query, claim)
    const terminal = await terminalizeJobAndBurn(query, {
      job,
      state: 'abandoned_partial',
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
    await lockRecoveryArchiveGenerationRow(
      query,
      candidate.archiveGenerationId,
      candidate.sheetId,
      candidate.keyId,
    )
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
      await terminalizeJobAndBurn(query, {
        job,
        state: 'abandoned_partial',
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

const RESTORE_JOB_LIST_DEFAULT_LIMIT = 20
const RESTORE_JOB_LIST_MAX_LIMIT = 50
const RESTORE_JOB_LIST_MAX_CURSOR_LENGTH = 512

type RestoreJobListCursor = {
  readonly createdAt: string
  readonly jobId: string
}

export async function listRecoveryArchiveRestoreJobs(
  transaction: RecoveryArchiveRestoreJobTransaction,
  input: ListRecoveryArchiveRestoreJobsInput,
): Promise<RecoveryArchiveRestoreJobPage> {
  if (!input || typeof input.recheckAuthority !== 'function') invalidInput()
  if (!isMultitableRecoveryArchiveEnabled(input.env ?? process.env)) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_DISABLED')
  }
  const identity = ownerScope(input)
  const limit = normalizeRestoreJobListLimit(input.limit)
  const cursor = input.cursor === undefined ? null : decodeRestoreJobListCursor(input.cursor)

  return transaction(async (query) => {
    if (!(await input.recheckAuthority(query))) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
    }
    const values: unknown[] = [
      identity.workspaceId,
      identity.baseId,
      identity.sheetId,
      identity.actorId,
    ]
    const cursorSql = cursor
      ? 'AND (created_at, id) < ($5::timestamptz, $6::uuid)'
      : ''
    if (cursor) values.push(cursor.createdAt, cursor.jobId)
    values.push(limit + 1)
    const result = await query(
      `${JOB_SNAPSHOT_SELECT}, created_at::text AS created_at
         FROM public.meta_recovery_archive_jobs
        WHERE workspace_id = $1
          AND base_id = $2
          AND sheet_id = $3
          AND actor_id = $4
          ${cursorSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length}::integer`,
      values,
    )
    if (!Array.isArray(result.rows)) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID')
    }
    const rows = result.rows.map((row) => normalizeListedJobRow(row))
    const hasMore = rows.length > limit
    const entries = Object.freeze(rows.slice(0, limit).map((row) => row.snapshot))
    return Object.freeze({
      entries,
      nextCursor: hasMore && entries.length > 0
        ? encodeRestoreJobListCursor(rows[limit - 1]!)
        : null,
    })
  })
}

function normalizeListedJobRow(value: unknown): {
  readonly snapshot: RecoveryArchiveRestoreJobSnapshot
  readonly createdAt: string
} {
  try {
    const row = value as JobRow
    return Object.freeze({
      snapshot: snapshotFromJobRow(row),
      createdAt: timestamp(row.created_at),
    })
  } catch {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID')
  }
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
    opaque(row.archive_generation_id) !== claim.archiveGenerationId ||
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
    chunkObjectExpiresAt: canonicalTimestamp(row.chunk_object_expires_at),
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

function ownerScope(input: ListRecoveryArchiveRestoreJobsInput) {
  return Object.freeze({
    workspaceId: opaque(input.workspaceId),
    baseId: opaque(input.baseId),
    sheetId: opaque(input.sheetId),
    actorId: opaque(input.actorId),
  })
}

function normalizeRestoreJobListLimit(value: number | undefined): number {
  if (value === undefined) return RESTORE_JOB_LIST_DEFAULT_LIMIT
  if (!Number.isSafeInteger(value) || value < 1 || value > RESTORE_JOB_LIST_MAX_LIMIT) invalidInput()
  return value
}

function encodeRestoreJobListCursor(row: { readonly snapshot: RecoveryArchiveRestoreJobSnapshot; readonly createdAt: string }): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.snapshot.id])).toString('base64url')
}

function decodeRestoreJobListCursor(value: string): RestoreJobListCursor {
  if (typeof value !== 'string' || value.length < 1 || value.length > RESTORE_JOB_LIST_MAX_CURSOR_LENGTH) {
    invalidInput()
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(decoded) || decoded.length !== 2) invalidInput()
    return Object.freeze({
      createdAt: timestamp(decoded[0]),
      jobId: uuid(decoded[1]),
    })
  } catch (error) {
    if (error instanceof RecoveryArchiveRestoreJobError) throw error
    invalidInput()
  }
}

async function readCandidateIdentity(
  query: RecoveryArchiveRestoreJobQuery,
  identity: { workspaceId: string; baseId: string; sheetId: string; actorId: string; jobId: string },
): Promise<RecoveryArchiveRestoreJobCandidate> {
  const result = await query(
    `SELECT id::text AS id, sheet_id, key_id,
            archive_generation_id::text AS archive_generation_id,
            block_fence::text AS block_fence,
            resume_deadline::text AS resume_deadline
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
    archiveGenerationId: opaque(row.archive_generation_id),
    blockFence: positiveDecimal(row.block_fence),
    resumeDeadline: timestamp(row.resume_deadline),
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
    chunkObjectExpiresAt: canonicalTimestamp(row.chunkObjectExpiresAt),
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
    canonicalTimestamp(row.chunk_object_expires_at) !== actual.chunkObjectExpiresAt ||
    decimal(row.record_count) !== actual.recordCount || row.state !== 'pending'
  ) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
  }
}

function admitApplyReceiptTestOnly(value: unknown): RecoveryArchiveRestoreChunkApplyReceiptTestOnly {
  if (!value || typeof value !== 'object') {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID')
  }
  const row = value as Record<string, unknown>
  return {
    ...(row.operationId === undefined ? {} : { operationId: uuid(row.operationId) }),
    endpointSeq: positiveDecimal(row.endpointSeq),
    eventCount: safePositiveInteger(row.eventCount),
    committedCount: positiveDecimal(row.committedCount),
  }
}

function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    invalidInput()
  }
  return value
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

function canonicalTimestamp(value: unknown): string {
  return new Date(timestamp(value)).toISOString()
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
