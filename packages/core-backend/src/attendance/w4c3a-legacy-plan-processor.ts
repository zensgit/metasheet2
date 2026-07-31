/**
 * W4C-3a core-owned canonical legacy-plan processor (P07/P08 recovery).
 *
 * Production API accepts only jobId plus stable DB infrastructure. Internally
 * assembles SERIALIZABLE repository, authorization, class-00/10/11 locks,
 * preconditions, fixed effects, result and terminal response. No injected
 * effect/request/payload/rule/settings/profile/source callback may cross the
 * production boundary.
 *
 * Authority: P08 restart-recovery blueprint + OD-W4C-56/57/58/59/60.
 */
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceImportReservationLocksV1,
  acquireAttendanceOperationalBulkTargetLockV1,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  createVerifiedAttendanceOperationIdentityV1,
  parseCanonicalAttendanceLegacyIdempotencyKeyV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceCalculationTargetIdentityV1,
  type VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import {
  AttendanceLegacyPlanEnqueueError,
  authorizeAttendanceLegacyPlanFullImportFromJobV1,
  requireReplayBatchCongruence,
} from './w4c3a-legacy-plan-enqueue'
import {
  applyAttendanceLegacyBatchEffectsV1,
  buildAttendanceLegacyAsyncJobSummaryV1,
} from './w4c3a-legacy-plan-batch-effects'
import { applyAttendanceLegacyGroupEffectsV1 } from './w4c3a-legacy-plan-group-effects'
import { applyAttendanceLegacyItemEffectsV1 } from './w4c3a-legacy-plan-item-effects'
import { lockAndRecheckAttendanceLegacyPlanPreconditionsV1 } from './w4c3a-legacy-plan-preconditions'
import { applyAttendanceLegacyRecordEffectsV1 } from './w4c3a-legacy-plan-record-effects'
import {
  createAttendanceLegacyPlanWorkerRepositoryV1,
} from './w4c3a-legacy-plan-worker-repository'
import {
  createAttendanceLegacyPlanWorkerV1,
  type AttendanceLegacyPlanWorkerCallbacksV1,
  type AttendanceLegacyPlanWorkerJobV1,
  type AttendanceLegacyPlanWorkerResultV1,
  type VerifiedAttendanceLegacyPlanV1,
} from './w4c3a-legacy-plan-worker'

export type AttendanceLegacyPlanProcessorConnectionV1 = AttendanceW4TransactionClientV1 & {
  release?(): void
}

export type AttendanceLegacyPlanProcessorDepsV1 = Readonly<{
  /**
   * Stable host infrastructure only: dedicated connection provider over the
   * core PostgreSQL pool. Must not close over request/payload/rule state.
   */
  acquireConnection(): Promise<{
    client: AttendanceLegacyPlanProcessorConnectionV1
    release(): void
  }>
}>

export type AttendanceLegacyPlanProcessorV1 = Readonly<{
  processLegacyImportPlanV1(
    jobId: string,
  ): Promise<AttendanceLegacyPlanWorkerResultV1>
}>

function reservationIdentitiesFromJob(
  job: AttendanceLegacyPlanWorkerJobV1,
): readonly VerifiedAttendanceOperationIdentityV1[] {
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({
    orgId: job.orgId,
    acceptedWritePosture: job.acceptedWritePosture,
  })
  const batch = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'batch',
    entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: job.batchId },
  })
  const identities: VerifiedAttendanceOperationIdentityV1[] = [batch]
  // OD-W4C-59=(a): normal drafts include every planned item identity in the
  // one complete class-10 set. Replay has zero item identities.
  if (
    Array.isArray(job.identityProofVector) &&
    job.identityProofVector.length > 0
  ) {
    for (const entry of job.identityProofVector) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
      }
      const row = entry as Record<string, unknown>
      const ordinal = row.ordinal
      const semanticFingerprint =
        typeof row.semanticFingerprint === 'string'
          ? row.semanticFingerprint
          : null
      if (
        typeof ordinal !== 'number' ||
        !Number.isInteger(ordinal) ||
        ordinal < 0 ||
        semanticFingerprint === null
      ) {
        throw new Error('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
      }
      identities.push(
        createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'item',
          entrypoint: 'import_batch',
          source: {
            sourceKind: 'import_item',
            batchCommandId: job.batchId,
            ordinal,
            semanticFingerprint,
          },
        }),
      )
    }
  }
  return Object.freeze(identities)
}

export function deriveAttendanceLegacyPlanTargetIdentitiesV1(
  plan: VerifiedAttendanceLegacyPlanV1,
): readonly VerifiedAttendanceCalculationTargetIdentityV1[] {
  if (plan.manifest.operationalBranch !== 'strict_targeted') {
    return Object.freeze([])
  }
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({
    orgId: plan.manifest.orgId,
    acceptedWritePosture: plan.manifest.acceptedWritePosture,
  })
  return Object.freeze(
    plan.recordWrites.map((write) =>
      createVerifiedAttendanceCalculationTargetIdentityV1({
        org,
        userId: write.userId,
        workDate: write.workDate,
      }),
    ),
  )
}

export async function acquireAttendanceLegacyPlanClass11V1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
  identities: readonly VerifiedAttendanceCalculationTargetIdentityV1[],
): Promise<void> {
  if (plan.manifest.operationalBranch === 'operational_only_batch_limit') {
    if (identities.length !== 0) {
      throw new Error('W4C3A_PROCESSOR_CLASS11_SHAPE_INVALID')
    }
    await acquireAttendanceOperationalBulkTargetLockV1(
      trx,
      parseCanonicalAttendanceRolloutOrgKeyV1(plan.manifest.orgId),
    )
    return
  }
  if (plan.manifest.operationalBranch !== 'strict_targeted') {
    if (identities.length !== 0) {
      throw new Error('W4C3A_PROCESSOR_CLASS11_SHAPE_INVALID')
    }
    return
  }
  await acquireAttendanceCalculationTargetLocks(trx, identities)
}

async function executeFixedVerifiedPlan(
  trx: AttendanceW4TransactionClientV1,
  job: AttendanceLegacyPlanWorkerJobV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<unknown> {
  const startedAt = Date.now()
  // Replay: zero item/record/group/batch DML; summary from locked batch fields.
  if (plan.manifest.batch.kind === 'idempotent_replay') {
    const elapsedMs =
      plan.manifest.batch.replaySelector === 'precheck_hit' ? 0 : Math.max(0, Date.now() - startedAt)
    return buildAttendanceLegacyAsyncJobSummaryV1({
      plan,
      effectResult: { groupCreated: 0, groupMembersAdded: 0 },
      elapsedMs,
    })
  }

  // First execution: mirror the retained legacy FK/effect order. Groups are
  // resolved before batch metadata is frozen; the batch parent precedes items.
  // For legacy_projection_only: zero W4 operation/source/result DML.
  const groupResult = await applyAttendanceLegacyGroupEffectsV1(trx, plan)
  await applyAttendanceLegacyBatchEffectsV1(trx, plan, groupResult)
  await applyAttendanceLegacyRecordEffectsV1(trx, plan)
  await applyAttendanceLegacyItemEffectsV1(trx, plan)
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  return buildAttendanceLegacyAsyncJobSummaryV1({
    plan,
    effectResult: groupResult,
    elapsedMs,
  })
}

function assembleCallbacks(
  connection: AttendanceW4TransactionClientV1,
): AttendanceLegacyPlanWorkerCallbacksV1<AttendanceW4TransactionClientV1> {
  // Repository is org-scoped; worker passes candidate.orgId explicitly.
  // A fresh repository is created per transaction client.
  return Object.freeze({
    async readCandidateJob(jobId) {
      const repository = createAttendanceLegacyPlanWorkerRepositoryV1(connection)
      return repository.readCandidateJob(jobId)
    },
    async runSerializable(work) {
      return runAttendanceResultOperationTransactionV1(connection, work)
    },
    async acquireClass00(trx, orgId) {
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(orgId)
      await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
    },
    async resolveWritePosture(trx, orgId) {
      const posture = await resolveSegmentCalculationPosture(trx, orgId)
      // Suspended rollout maps to blocked write posture in the resolver table.
      if (posture.writePosture === 'blocked') return 'suspended'
      if (
        posture.writePosture === 'legacy_projection_only' ||
        posture.writePosture === 'shadow' ||
        posture.writePosture === 'authoritative'
      ) {
        return posture.writePosture
      }
      return 'suspended'
    },
    async readAuthorizationJob(trx, jobId, orgId) {
      return createAttendanceLegacyPlanWorkerRepositoryV1(trx).readAuthorizationJob(
        jobId,
        orgId,
      )
    },
    async lockJob(trx, jobId, orgId) {
      return createAttendanceLegacyPlanWorkerRepositoryV1(trx).lockJob(jobId, orgId)
    },
    async authorizeFullImport(trx, job) {
      return authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, job)
    },
    reservationIdentities(job) {
      return reservationIdentitiesFromJob(job)
    },
    async acquireClass10(trx, job, identities) {
      const legacyIdempotency =
        job.idempotencyKey === null
          ? null
          : parseCanonicalAttendanceLegacyIdempotencyKeyV1({
              orgId: job.orgId,
              idempotencyKey: job.idempotencyKey,
            })
      await acquireAttendanceImportReservationLocksV1(
        trx,
        identities,
        legacyIdempotency,
      )
    },
    async loadPlan(trx, jobId, orgId) {
      return createAttendanceLegacyPlanWorkerRepositoryV1(trx).loadPlan(jobId, orgId)
    },
    async recheckReplayPrecondition(trx, job, plan) {
      try {
        await requireReplayBatchCongruence(trx, job, plan.manifest)
        return true
      } catch (error) {
        if (error instanceof AttendanceLegacyPlanEnqueueError) return false
        throw error
      }
    },
    targetIdentities(plan) {
      return deriveAttendanceLegacyPlanTargetIdentitiesV1(plan)
    },
    async acquireClass11(trx, plan, identities) {
      await acquireAttendanceLegacyPlanClass11V1(trx, plan, identities)
    },
    async recheckPreconditions(trx, plan) {
      return lockAndRecheckAttendanceLegacyPlanPreconditionsV1(trx, plan)
    },
    async executeVerifiedPlan(trx, job, plan) {
      return executeFixedVerifiedPlan(trx, job, plan)
    },
    async storeCompletedResponseAndTerminalize(
      trx,
      job,
      plan,
      response,
      responseDigest,
    ) {
      // Repository typing requires the durable job extension; store path uses
      // only jobId/orgId (already org-bound by the worker state machine).
      const repositoryJob = {
        ...job,
        entrypoint: job.sourceKind,
        batchCommandId: job.batchId,
        executionReasonCode: job.executionReasonCode,
      }
      await createAttendanceLegacyPlanWorkerRepositoryV1(
        trx,
      ).storeCompletedResponseAndTerminalize(
        repositoryJob,
        plan,
        response,
        responseDigest,
      )
    },
    async loadCompletedResponse(trx, jobId, orgId) {
      return createAttendanceLegacyPlanWorkerRepositoryV1(trx).loadCompletedResponse(
        jobId,
        orgId,
      )
    },
    async markSuspendedQueued(trx, jobId, orgId) {
      await createAttendanceLegacyPlanWorkerRepositoryV1(trx).markSuspendedQueued(
        jobId,
        orgId,
      )
    },
    async clearResumedSuspendedReason(trx, jobId, orgId) {
      await createAttendanceLegacyPlanWorkerRepositoryV1(
        trx,
      ).clearResumedSuspendedReason(jobId, orgId)
    },
    async markPlanFailed(trx, jobId, orgId, reason) {
      await createAttendanceLegacyPlanWorkerRepositoryV1(trx).markPlanFailed(
        jobId,
        orgId,
        reason,
      )
    },
  })
}

/**
 * Canonical production processor. Accepts only jobId at the process boundary.
 */
export function createAttendanceLegacyPlanProcessorV1(
  deps: AttendanceLegacyPlanProcessorDepsV1,
): AttendanceLegacyPlanProcessorV1 {
  if (
    typeof deps !== 'object' ||
    deps === null ||
    typeof deps.acquireConnection !== 'function'
  ) {
    throw new Error('W4C3A_PROCESSOR_DEPS_INVALID')
  }

  return Object.freeze({
    async processLegacyImportPlanV1(jobId: string) {
      if (typeof jobId !== 'string' || jobId.length === 0) {
        return { kind: 'not_found' as const }
      }
      const acquired = await deps.acquireConnection()
      try {
        const callbacks = assembleCallbacks(acquired.client)
        const worker = createAttendanceLegacyPlanWorkerV1(callbacks)
        return worker.process(jobId)
      } finally {
        acquired.release()
      }
    },
  })
}

/**
 * Static-import allowlist for production: only this module may import the
 * generic worker factory outside of tests. Guarded by unit inventory tests.
 */
export const W4C3A_LEGACY_PLAN_WORKER_PRODUCTION_IMPORTER =
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-processor.ts' as const
