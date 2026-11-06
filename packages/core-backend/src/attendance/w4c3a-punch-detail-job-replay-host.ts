import { authorizeAttendanceLegacyPlanFullImportFromJobV1 } from './w4c3a-legacy-plan-enqueue'
import {
  computeLegacyImportAsyncJobSummaryDigestV1,
  parseLegacyImportAsyncJobSummaryV1,
} from './w4c3a-legacy-execution-plan'
import { verifyAttendanceLegacyImportStoredPlanV1 } from './w4c3a-legacy-plan-worker'
import { createAttendanceLegacyPlanWorkerRepositoryV1 } from './w4c3a-legacy-plan-worker-repository'
import { readAttendancePunchDetailEnvelopeV1 } from './w4c3a-punch-detail-command'
import type { AttendancePunchDetailPreparationHostInputV1 } from './w4c3a-punch-detail-preparation-host'
import { withCurrentAttendancePunchDetailReplayV1 } from './w4c3a-punch-detail-replay-host'
import type { AttendanceSyncImportHostDepsV1 } from './w4c3a-sync-import-host'

type Input = Pick<AttendancePunchDetailPreparationHostInputV1, 'scope' | 'envelope'> & Readonly<{ jobId?: string }>

function conflict(): never {
  throw new Error('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
}

/** Read an immutable-command-bound job without selecting or trusting its mutable payload. */
export function createAttendancePunchDetailJobReplayHostV1(deps: AttendanceSyncImportHostDepsV1) {
  return Object.freeze({
    async readPunchDetailImportJobReplay(input: Input) {
      const command = readAttendancePunchDetailEnvelopeV1(input.envelope)
      if (!command) throw new Error('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
      if (input.jobId === undefined && command.idempotencyKey === null) return null
      return withCurrentAttendancePunchDetailReplayV1(deps, input, async (trx, scope, envelope, fingerprint) => {
        const rows = await trx.query(
          `SELECT id, org_id, batch_id, created_by, idempotency_key, status, progress, total, error,
                  started_at, finished_at, created_at, updated_at,
                  w4_contract_version, w4_legacy_input_fingerprint, w4_execution_reason_code
             FROM attendance_import_jobs
            WHERE org_id = $1 AND (
              ($3::uuid IS NULL AND idempotency_key = $2) OR
              ($3::uuid IS NOT NULL AND id = $3::uuid)
            )`,
          [scope.orgId, envelope.idempotencyKey, input.jobId ?? null],
        )
        if (rows.rows.length === 0) return null
        if (rows.rows.length !== 1) conflict()
        const row = rows.rows[0] as Record<string, unknown>
        if (row.w4_contract_version !== 1 || row.w4_legacy_input_fingerprint !== fingerprint) conflict()
        const repository = createAttendanceLegacyPlanWorkerRepositoryV1(trx)
        const job = await repository.readAuthorizationJob(String(row.id), scope.orgId)
        if (!job || job.orgId !== scope.orgId || job.actorId !== scope.actorId
          || job.createdBy !== scope.actorId || job.actorPosture !== scope.actorPosture
          || job.tokenSubjectUserId !== scope.tokenSubjectUserId || job.idempotencyKey !== envelope.idempotencyKey
          || job.legacyInputFingerprint !== fingerprint || job.operationalBranch !== 'strict_targeted'
          || job.entrypoint !== 'import_batch' || job.batchCommandId !== job.batchId) conflict()
        if (!(await authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, job))) {
          throw new Error('ATTENDANCE_WRITE_NOT_AUTHORIZED')
        }
        const plan = verifyAttendanceLegacyImportStoredPlanV1(job, await repository.loadPlan(job.jobId, scope.orgId))
        if (plan.manifest.batch.kind !== 'normal') conflict()
        const mapping = plan.manifest.batch.mappingSnapshot as Record<string, unknown>
        if (mapping.kind !== 'punch_events_v1' || mapping.requestFingerprint !== fingerprint) conflict()
        let response: unknown = null
        if (job.status === 'completed') {
          const stored = await repository.loadCompletedResponse(job.jobId, scope.orgId)
          const parsed = parseLegacyImportAsyncJobSummaryV1(stored.response)
          if (computeLegacyImportAsyncJobSummaryDigestV1(parsed) !== stored.responseDigest) {
            throw new Error('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
          }
          if (parsed.idempotencyKey !== envelope.idempotencyKey || parsed.__importEngine !== envelope.__importEngine
            || parsed.recordUpsertStrategy !== envelope.recordUpsertStrategy
            || parsed.itemsInsertStrategy !== envelope.itemsInsertStrategy) conflict()
          response = parsed
        }
        return Object.freeze({ ...row, payload: envelope, w4_terminal_response: response })
      })
    },
  })
}
