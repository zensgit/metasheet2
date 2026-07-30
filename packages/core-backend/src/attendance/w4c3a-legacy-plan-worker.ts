/**
 * Private P07/P08 processor for a persisted LegacyImportExecutionPlanV1.
 *
 * This module is intentionally not wired into routes or the plugin. Its callback
 * surface carries only locked durable rows and closed effect adapters: no request,
 * upload, rule, settings, profile, or source-reader input can reach the worker.
 */
import {
  computeLegacyImportChunkVectorDigestV1,
  computeLegacyImportAsyncJobSummaryDigestV1,
  computeLegacyImportPlanDigestV1,
  computeLegacyImportSourceOrdinalDigestV1,
  parseLegacyImportExecutionPlanChunkBodyV1,
  parseLegacyImportExecutionPlanManifestV1,
  parseLegacyImportAsyncJobSummaryV1,
  reassembleLegacyImportPlanChunksV1,
  type AttendanceLegacyPlanFailureReasonCodeV1,
  type LegacyImportExecutionPlanChunkV1,
  type LegacyImportExecutionPlanManifestV1,
  type LegacyImportAsyncJobSummaryV1,
} from './w4c3a-legacy-execution-plan'
import {
  requireVerifiedAttendanceCalculationTargetIdentityV1,
  requireVerifiedAttendanceOperationIdentityV1,
  type VerifiedAttendanceCalculationTargetIdentityV1,
  type VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'

export type AttendanceLegacyPlanWorkerJobV1 = Readonly<{
  jobId: string
  orgId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  w4ContractVersion: 1
  batchId: string
  sourceKind: 'import_batch'
  sourceRef: string
  createdBy: string
  actorId: string
  actorPosture: string
  tokenSubjectUserId: string | null
  acceptedWritePosture: 'legacy_projection_only' | 'shadow' | 'authoritative'
  commandFingerprint: string
  legacyInputFingerprint: string
  operationalBranch: string
  identityProofVector: unknown
  identityProofVectorDigest: string
  itemCount: number
  distinctTargetCount: number
  itemSequenceFingerprint: string
  itemSetFingerprint: string
  planDigest: string
}>

export type AttendanceLegacyPlanWorkerCandidateV1 = Readonly<{
  jobId: string
  orgId: string
}>

export type AttendanceLegacyPlanWorkerStoredPlanV1 = Readonly<{
  planDigest: string
  chunkVectorDigest: string
  chunkCount: number
  manifest: unknown
  chunks: readonly unknown[]
}>

export type VerifiedAttendanceLegacyPlanV1 = Readonly<{
  manifest: LegacyImportExecutionPlanManifestV1
  chunks: readonly LegacyImportExecutionPlanChunkV1[]
  items: ReturnType<typeof reassembleLegacyImportPlanChunksV1>['items']
  recordWrites: ReturnType<typeof reassembleLegacyImportPlanChunksV1>['recordWrites']
  groupEffects: ReturnType<typeof reassembleLegacyImportPlanChunksV1>['groupEffects']
}>

export type AttendanceLegacyPlanWorkerResultV1 =
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'suspended' }>
  | Readonly<{ kind: 'failed'; reason: AttendanceLegacyPlanFailureReasonCodeV1 }>
  | Readonly<{ kind: 'completed'; response: LegacyImportAsyncJobSummaryV1 }>

export type AttendanceLegacyPlanWorkerCallbacksV1<TTransaction> = Readonly<{
  readCandidateJob(jobId: string): Promise<AttendanceLegacyPlanWorkerCandidateV1 | null>
  runSerializable<T>(work: (trx: TTransaction) => Promise<T>): Promise<T>
  acquireClass00(trx: TTransaction, orgId: string): Promise<void>
  resolveWritePosture(
    trx: TTransaction,
    orgId: string,
  ): Promise<'suspended' | AttendanceLegacyPlanWorkerJobV1['acceptedWritePosture']>
  readAuthorizationJob(
    trx: TTransaction,
    jobId: string,
  ): Promise<AttendanceLegacyPlanWorkerJobV1 | null>
  lockJob(
    trx: TTransaction,
    jobId: string,
  ): Promise<AttendanceLegacyPlanWorkerJobV1 | null>
  authorizeFullImport(
    trx: TTransaction,
    job: AttendanceLegacyPlanWorkerJobV1,
  ): Promise<boolean>
  reservationIdentities(
    job: AttendanceLegacyPlanWorkerJobV1,
  ): readonly VerifiedAttendanceOperationIdentityV1[]
  acquireClass10(
    trx: TTransaction,
    identities: readonly VerifiedAttendanceOperationIdentityV1[],
  ): Promise<void>
  loadPlan(
    trx: TTransaction,
    jobId: string,
  ): Promise<AttendanceLegacyPlanWorkerStoredPlanV1 | null>
  targetIdentities(
    plan: VerifiedAttendanceLegacyPlanV1,
  ): readonly VerifiedAttendanceCalculationTargetIdentityV1[]
  acquireClass11(
    trx: TTransaction,
    plan: VerifiedAttendanceLegacyPlanV1,
    identities: readonly VerifiedAttendanceCalculationTargetIdentityV1[],
  ): Promise<void>
  recheckPreconditions(
    trx: TTransaction,
    plan: VerifiedAttendanceLegacyPlanV1,
  ): Promise<boolean>
  executeVerifiedPlan(
    trx: TTransaction,
    job: AttendanceLegacyPlanWorkerJobV1,
    plan: VerifiedAttendanceLegacyPlanV1,
  ): Promise<unknown>
  storeCompletedResponseAndTerminalize(
    trx: TTransaction,
    job: AttendanceLegacyPlanWorkerJobV1,
    response: LegacyImportAsyncJobSummaryV1,
    responseDigest: string,
  ): Promise<void>
  loadCompletedResponse(
    trx: TTransaction,
    jobId: string,
  ): Promise<Readonly<{ response: unknown; responseDigest: string }>>
  markSuspendedQueued(trx: TTransaction, jobId: string): Promise<void>
  markPlanFailed(
    trx: TTransaction,
    jobId: string,
    reason: AttendanceLegacyPlanFailureReasonCodeV1,
  ): Promise<void>
}>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(reason: AttendanceLegacyPlanFailureReasonCodeV1): never {
  throw new AttendanceLegacyPlanWorkerFailure(reason)
}

class AttendanceLegacyPlanWorkerFailure extends Error {
  constructor(readonly reason: AttendanceLegacyPlanFailureReasonCodeV1) {
    super(reason)
  }
}

function parseChunk(value: unknown): LegacyImportExecutionPlanChunkV1 {
  if (!isPlainObject(value)) fail('ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING')
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'chunk,chunkDigest,chunkIndex,firstSourceOrdinal,sourceRowCount') {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  }
  const chunkIndex = value.chunkIndex
  const firstSourceOrdinal = value.firstSourceOrdinal
  const sourceRowCount = value.sourceRowCount
  if (
    typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0 ||
    typeof firstSourceOrdinal !== 'number' || !Number.isInteger(firstSourceOrdinal) || firstSourceOrdinal < 0 ||
    typeof sourceRowCount !== 'number' || !Number.isInteger(sourceRowCount) || sourceRowCount < 1 ||
    typeof value.chunkDigest !== 'string'
  ) {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  }
  try {
    return Object.freeze({
      chunkIndex,
      firstSourceOrdinal,
      sourceRowCount,
      chunkDigest: value.chunkDigest,
      body: parseLegacyImportExecutionPlanChunkBodyV1(value.chunk),
    })
  } catch {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  }
}

function verifyPlan(
  job: AttendanceLegacyPlanWorkerJobV1,
  stored: AttendanceLegacyPlanWorkerStoredPlanV1 | null,
): VerifiedAttendanceLegacyPlanV1 {
  if (stored === null) fail('ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING')
  if (!Number.isInteger(stored.chunkCount) || stored.chunkCount < 0 || stored.chunks.length !== stored.chunkCount) {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING')
  }

  let manifest: LegacyImportExecutionPlanManifestV1
  try {
    manifest = parseLegacyImportExecutionPlanManifestV1(stored.manifest)
  } catch (error) {
    if (error instanceof Error && error.message === 'W4C3A_PLAN_VERSION_UNSUPPORTED') {
      fail('ATTENDANCE_IMPORT_LEGACY_PLAN_VERSION_UNSUPPORTED')
    }
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  }
  const chunks = stored.chunks.map(parseChunk)
  const chunkVectorDigest = computeLegacyImportChunkVectorDigestV1(chunks)
  if (chunkVectorDigest !== stored.chunkVectorDigest || chunkVectorDigest !== manifest.chunkVectorDigest) {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  }

  let assembled: ReturnType<typeof reassembleLegacyImportPlanChunksV1>
  try {
    assembled = reassembleLegacyImportPlanChunksV1(chunks, manifest.sourceRowCount)
  } catch (error) {
    if (error instanceof Error && error.message === 'W4C3A_CHUNK_DIGEST_MISMATCH') {
      fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
    }
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING')
  }
  const planDigest = computeLegacyImportPlanDigestV1({ manifest, ...assembled })
  if (planDigest !== stored.planDigest || planDigest !== job.planDigest) {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  }
  if (computeLegacyImportSourceOrdinalDigestV1(assembled.items) !== manifest.sourceOrdinalDigest) {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  }
  if (
    manifest.orgId !== job.orgId ||
    manifest.jobId !== job.jobId ||
    manifest.batchId !== job.batchId ||
    manifest.sourceKind !== job.sourceKind ||
    manifest.sourceRef !== job.sourceRef ||
    manifest.createdBy !== job.createdBy ||
    manifest.actorId !== job.actorId ||
    manifest.actorPosture !== job.actorPosture ||
    manifest.tokenSubjectUserId !== job.tokenSubjectUserId ||
    manifest.acceptedWritePosture !== job.acceptedWritePosture ||
    manifest.commandFingerprint !== job.commandFingerprint ||
    manifest.legacyInputFingerprint !== job.legacyInputFingerprint ||
    manifest.operationalBranch !== job.operationalBranch ||
    manifest.w4ItemCount !== job.itemCount ||
    manifest.w4DistinctTargetCount !== job.distinctTargetCount ||
    manifest.w4ItemSequenceFingerprint !== job.itemSequenceFingerprint ||
    manifest.w4ItemSetFingerprint !== job.itemSetFingerprint ||
    manifest.identityProofVectorDigest !== job.identityProofVectorDigest
  ) {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH')
  }
  return Object.freeze({ manifest, chunks: Object.freeze(chunks), ...assembled })
}

function verifiedReservationIdentities(
  callbacks: AttendanceLegacyPlanWorkerCallbacksV1<unknown>,
  job: AttendanceLegacyPlanWorkerJobV1,
): readonly VerifiedAttendanceOperationIdentityV1[] {
  try {
    return Object.freeze(callbacks.reservationIdentities(job).map(requireVerifiedAttendanceOperationIdentityV1))
  } catch {
    fail('ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH')
  }
}

export function createAttendanceLegacyPlanWorkerV1<TTransaction>(
  callbacks: AttendanceLegacyPlanWorkerCallbacksV1<TTransaction>,
): Readonly<{ process(jobId: string): Promise<AttendanceLegacyPlanWorkerResultV1> }> {
  const failClosed = async (
    trx: TTransaction,
    job: AttendanceLegacyPlanWorkerJobV1,
    reason: AttendanceLegacyPlanFailureReasonCodeV1,
  ): Promise<AttendanceLegacyPlanWorkerResultV1> => {
    if (job.status === 'queued' || job.status === 'running') {
      await callbacks.markPlanFailed(trx, job.jobId, reason)
      return { kind: 'failed', reason }
    }
    return { kind: 'not_found' }
  }

  return Object.freeze({
    async process(jobId: string): Promise<AttendanceLegacyPlanWorkerResultV1> {
      const candidate = await callbacks.readCandidateJob(jobId)
      if (candidate === null) return { kind: 'not_found' }
      return callbacks.runSerializable(async (trx) => {
        await callbacks.acquireClass00(trx, candidate.orgId)
        const posture = await callbacks.resolveWritePosture(trx, candidate.orgId)
        if (posture === 'suspended') {
          const locked = await callbacks.lockJob(trx, candidate.jobId)
          if (locked === null || locked.w4ContractVersion !== 1) return { kind: 'not_found' }
          if (locked.jobId !== candidate.jobId || locked.orgId !== candidate.orgId) {
            return { kind: 'not_found' }
          }
          if (locked.status === 'queued') await callbacks.markSuspendedQueued(trx, locked.jobId)
          return { kind: 'suspended' }
        }

        const authorizationJob = await callbacks.readAuthorizationJob(
          trx,
          candidate.jobId,
        )
        if (
          authorizationJob === null ||
          authorizationJob.w4ContractVersion !== 1 ||
          authorizationJob.jobId !== candidate.jobId ||
          authorizationJob.orgId !== candidate.orgId
        ) {
          return { kind: 'not_found' }
        }
        const candidateAuthorized = await callbacks.authorizeFullImport(
          trx,
          authorizationJob,
        )
        const reservation = verifiedReservationIdentities(
          callbacks as AttendanceLegacyPlanWorkerCallbacksV1<unknown>,
          authorizationJob,
        )
        await callbacks.acquireClass10(trx, reservation)
        const rechecked = await callbacks.lockJob(trx, candidate.jobId)
        if (rechecked === null || rechecked.w4ContractVersion !== 1) return { kind: 'not_found' }
        if (rechecked.jobId !== candidate.jobId || rechecked.orgId !== candidate.orgId) {
          return { kind: 'not_found' }
        }
        const recheckedAuthorized = await callbacks.authorizeFullImport(trx, rechecked)
        if (!candidateAuthorized || !recheckedAuthorized) {
          return failClosed(trx, rechecked, 'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED')
        }
        if (rechecked.status === 'completed') {
          const storedResponse = await callbacks.loadCompletedResponse(trx, rechecked.jobId)
          const response = parseLegacyImportAsyncJobSummaryV1(storedResponse.response)
          if (
            computeLegacyImportAsyncJobSummaryDigestV1(response) !==
            storedResponse.responseDigest
          ) {
            return { kind: 'not_found' }
          }
          return {
            kind: 'completed',
            response,
          }
        }
        if (rechecked.status !== 'queued' || posture !== rechecked.acceptedWritePosture) {
          return failClosed(trx, rechecked, 'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED')
        }

        let plan: VerifiedAttendanceLegacyPlanV1
        try {
          plan = verifyPlan(rechecked, await callbacks.loadPlan(trx, rechecked.jobId))
        } catch (error) {
          if (error instanceof AttendanceLegacyPlanWorkerFailure) {
            return failClosed(trx, rechecked, error.reason)
          }
          throw error
        }
        let targets: readonly VerifiedAttendanceCalculationTargetIdentityV1[]
        try {
          targets = Object.freeze(callbacks.targetIdentities(plan).map(requireVerifiedAttendanceCalculationTargetIdentityV1))
        } catch {
          return failClosed(trx, rechecked, 'ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH')
        }
        await callbacks.acquireClass11(trx, plan, targets)
        if (!(await callbacks.recheckPreconditions(trx, plan))) {
          return failClosed(trx, rechecked, 'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED')
        }
        const response = parseLegacyImportAsyncJobSummaryV1(
          await callbacks.executeVerifiedPlan(trx, rechecked, plan),
        )
        await callbacks.storeCompletedResponseAndTerminalize(
          trx,
          rechecked,
          response,
          computeLegacyImportAsyncJobSummaryDigestV1(response),
        )
        return { kind: 'completed', response }
      })
    },
  })
}
