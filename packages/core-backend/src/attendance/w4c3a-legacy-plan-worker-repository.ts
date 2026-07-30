/**
 * Fixed-SQL persistence boundary for the W4C-3a private worker.
 *
 * This module owns no connection or transaction lifecycle. It only reads the
 * frozen core rows and performs the worker's org-scoped terminal transitions.
 * Plan JSON is deliberately returned as an opaque value; the worker parser is
 * the only layer that interprets its nested control shape.
 */
import type {
  AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import type {
  AttendanceLegacyPlanWorkerCandidateV1,
  AttendanceLegacyPlanWorkerJobV1,
  AttendanceLegacyPlanWorkerStoredPlanV1,
  VerifiedAttendanceLegacyPlanV1,
} from './w4c3a-legacy-plan-worker'
import {
  ATTENDANCE_LEGACY_PLAN_FAILURE_REASON_CODES_V1,
  type AttendanceLegacyPlanFailureReasonCodeV1,
  type LegacyImportAsyncJobSummaryV1,
} from './w4c3a-legacy-execution-plan'

type QueryRow = Record<string, unknown>

export type AttendanceLegacyPlanWorkerRepositoryJobV1 =
  AttendanceLegacyPlanWorkerJobV1 & Readonly<{
    entrypoint: string
    batchCommandId: string
    executionReasonCode: string | null
  }>

export class AttendanceLegacyPlanWorkerRepositoryError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceLegacyPlanWorkerRepositoryError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceLegacyPlanWorkerRepositoryError(code)
}

function isObject(value: unknown): value is QueryRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(row: QueryRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || value.length === 0) fail('W4C3A_REPOSITORY_ROW_INVALID')
  return value
}

function nullableString(row: QueryRow, key: string): string | null {
  const value = row[key]
  if (value !== null && typeof value !== 'string') fail('W4C3A_REPOSITORY_ROW_INVALID')
  return value as string | null
}

function nonNegativeInteger(row: QueryRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('W4C3A_REPOSITORY_ROW_INVALID')
  }
  return value
}

function oneOf<T extends string>(row: QueryRow, key: string, values: readonly T[]): T {
  const value = row[key]
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail('W4C3A_REPOSITORY_ROW_INVALID')
  }
  return value as T
}

function requiredRow(result: { rows: readonly QueryRow[] }): QueryRow {
  if (result.rows.length === 0) fail('W4C3A_REPOSITORY_ROW_MISSING')
  if (result.rows.length !== 1) fail('W4C3A_REPOSITORY_ROW_CARDINALITY')
  const row = result.rows[0]
  if (!isObject(row)) fail('W4C3A_REPOSITORY_ROW_MISSING')
  return row
}

function optionalRow(result: { rows: readonly QueryRow[] }): QueryRow | null {
  if (result.rows.length > 1) fail('W4C3A_REPOSITORY_ROW_CARDINALITY')
  const row = result.rows[0]
  if (row === undefined) return null
  if (!isObject(row)) fail('W4C3A_REPOSITORY_ROW_INVALID')
  return row
}

function mapJob(row: QueryRow): AttendanceLegacyPlanWorkerRepositoryJobV1 {
  const w4ContractVersion = nonNegativeInteger(row, 'w4_contract_version')
  if (w4ContractVersion !== 1) fail('W4C3A_REPOSITORY_W4_VERSION_UNSUPPORTED')

  const identityProofVector = row.w4_identity_proof_vector
  if (!Array.isArray(identityProofVector)) fail('W4C3A_REPOSITORY_ROW_INVALID')

  return Object.freeze({
    jobId: requiredString(row, 'id'),
    orgId: requiredString(row, 'org_id'),
    status: oneOf(row, 'status', ['queued', 'running', 'completed', 'failed'] as const),
    w4ContractVersion: 1,
    batchId: requiredString(row, 'batch_id'),
    idempotencyKey: nullableString(row, 'idempotency_key'),
    sourceKind: oneOf(row, 'w4_source_kind', ['import_batch'] as const),
    sourceRef: requiredString(row, 'w4_source_ref'),
    createdBy: requiredString(row, 'created_by'),
    actorId: requiredString(row, 'w4_actor_id'),
    actorPosture: requiredString(row, 'w4_actor_posture'),
    tokenSubjectUserId: nullableString(row, 'w4_token_subject_user_id'),
    acceptedWritePosture: oneOf(
      row,
      'w4_accepted_write_posture',
      ['legacy_projection_only', 'shadow', 'authoritative'] as const,
    ),
    commandFingerprint: requiredString(row, 'w4_command_fingerprint'),
    legacyInputFingerprint: requiredString(row, 'w4_legacy_input_fingerprint'),
    operationalBranch: requiredString(row, 'w4_operational_branch'),
    identityProofVector,
    identityProofVectorDigest: requiredString(row, 'w4_identity_proof_vector_digest'),
    itemCount: nonNegativeInteger(row, 'w4_item_count'),
    distinctTargetCount: nonNegativeInteger(row, 'w4_distinct_target_count'),
    itemSequenceFingerprint: requiredString(row, 'w4_item_sequence_fingerprint'),
    itemSetFingerprint: requiredString(row, 'w4_item_set_fingerprint'),
    planDigest: requiredString(row, 'w4_legacy_plan_digest'),
    entrypoint: requiredString(row, 'w4_entrypoint'),
    batchCommandId: requiredString(row, 'w4_batch_command_id'),
    executionReasonCode: nullableString(row, 'w4_execution_reason_code'),
  })
}

function mapStoredChunk(row: QueryRow): Record<string, unknown> {
  const chunkIndex = nonNegativeInteger(row, 'chunk_index')
  const firstSourceOrdinal = nonNegativeInteger(row, 'first_source_ordinal')
  const sourceRowCount = nonNegativeInteger(row, 'source_row_count')
  if (sourceRowCount < 1) fail('W4C3A_REPOSITORY_ROW_INVALID')
  if (!Object.prototype.hasOwnProperty.call(row, 'chunk')) {
    fail('W4C3A_REPOSITORY_ROW_INVALID')
  }
  return Object.freeze({
    chunkIndex,
    firstSourceOrdinal,
    sourceRowCount,
    chunkDigest: requiredString(row, 'chunk_digest'),
    chunk: row.chunk,
  })
}

const CANDIDATE_SQL = `
  SELECT id, org_id
  FROM attendance_import_jobs
  WHERE id = $1::uuid
`

const JOB_SQL = `
  SELECT
    id, org_id, batch_id, created_by, idempotency_key, status,
    w4_contract_version, w4_entrypoint, w4_batch_command_id, w4_source_kind,
    w4_source_ref, w4_actor_id, w4_actor_posture, w4_token_subject_user_id,
    w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
    w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector,
    encode(
      digest(convert_to(w4_identity_proof_vector::text, 'UTF8'), 'sha256'),
      'hex'
    ) AS w4_identity_proof_vector_digest,
    w4_legacy_plan_digest, w4_distinct_target_count,
    w4_operational_branch, w4_legacy_input_fingerprint, w4_execution_reason_code
  FROM attendance_import_jobs
  WHERE id = $1::uuid AND org_id = $2 AND w4_contract_version = 1
`

const JOB_FOR_UPDATE_SQL = `${JOB_SQL} FOR UPDATE`

const MANIFEST_SQL = `
  SELECT plan_digest, chunk_vector_digest, chunk_count, manifest
  FROM attendance_import_legacy_execution_plans
  WHERE job_id = $1::uuid AND org_id = $2
`

const CHUNKS_SQL = `
  SELECT c.chunk_index, c.first_source_ordinal, c.source_row_count, c.chunk_digest, c.chunk
  FROM attendance_import_legacy_execution_plan_chunks AS c
  INNER JOIN attendance_import_legacy_execution_plans AS p
    ON p.job_id = c.job_id AND p.org_id = $2
  WHERE c.job_id = $1::uuid
  ORDER BY c.chunk_index ASC
`

const COMPLETED_RESPONSE_SQL = `
  SELECT response, response_digest
  FROM attendance_import_legacy_terminal_responses
  WHERE job_id = $1::uuid AND org_id = $2
`

const MARK_SUSPENDED_SQL = `
  UPDATE attendance_import_jobs
  SET w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED',
      updated_at = CASE
        WHEN w4_execution_reason_code IS NULL THEN now()
        ELSE updated_at
      END
  WHERE id = $1::uuid AND org_id = $2 AND w4_contract_version = 1
    AND status = 'queued'
    AND (
      w4_execution_reason_code IS NULL OR
      w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED'
    )
  RETURNING id
`

const CLEAR_SUSPENDED_SQL = `
  UPDATE attendance_import_jobs
  SET w4_execution_reason_code = NULL,
      updated_at = CASE
        WHEN w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED' THEN now()
        ELSE updated_at
      END
  WHERE id = $1::uuid AND org_id = $2 AND w4_contract_version = 1
    AND status = 'queued'
    AND (
      w4_execution_reason_code IS NULL OR
      w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED'
    )
  RETURNING id
`

const MARK_FAILED_SQL = `
  UPDATE attendance_import_jobs
  SET status = 'failed', error = NULL, w4_execution_reason_code = $3,
      finished_at = now(), updated_at = now()
  WHERE id = $1::uuid AND org_id = $2 AND w4_contract_version = 1
    AND status IN ('queued', 'running') AND w4_execution_reason_code IS NULL
  RETURNING id
`

const INSERT_TERMINAL_RESPONSE_SQL = `
  INSERT INTO attendance_import_legacy_terminal_responses (
    job_id, org_id, response_variant, response_digest, response
  ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
`

const INSERT_CLEANUP_COMMAND_SQL = `
  INSERT INTO attendance_import_upload_cleanup_commands (
    job_id, org_id, file_id, status, attempt_count, created_at, updated_at
  ) VALUES ($1::uuid, $2, $3::uuid, 'pending', 0, now(), now())
`

const MARK_COMPLETED_SQL = `
  UPDATE attendance_import_jobs
  SET status = 'completed', progress = total, error = NULL,
      w4_execution_reason_code = NULL, finished_at = now(), updated_at = now()
  WHERE id = $1::uuid AND org_id = $2 AND w4_contract_version = 1
    AND status = 'queued' AND w4_execution_reason_code IS NULL
  RETURNING id
`

function terminalResponseVariant(
  plan: VerifiedAttendanceLegacyPlanV1,
): 'first_execution' | 'idempotent_early' | 'idempotent_in_transaction' {
  const batch = plan.manifest.batch
  if (batch.kind === 'normal') return 'first_execution'
  return batch.replaySelector === 'precheck_hit'
    ? 'idempotent_early'
    : 'idempotent_in_transaction'
}

export function createAttendanceLegacyPlanWorkerRepositoryV1(
  db: AttendanceW4TransactionClientV1,
): Readonly<{
  readCandidateJob(jobId: string): Promise<AttendanceLegacyPlanWorkerCandidateV1 | null>
  readAuthorizationJob(jobId: string, orgId: string): Promise<AttendanceLegacyPlanWorkerRepositoryJobV1 | null>
  lockJob(jobId: string, orgId: string): Promise<AttendanceLegacyPlanWorkerRepositoryJobV1 | null>
  loadPlan(jobId: string, orgId: string): Promise<AttendanceLegacyPlanWorkerStoredPlanV1 | null>
  loadCompletedResponse(jobId: string, orgId: string): Promise<Readonly<{ response: unknown; responseDigest: string }>>
  markSuspendedQueued(jobId: string, orgId: string): Promise<void>
  clearResumedSuspendedReason(jobId: string, orgId: string): Promise<void>
  markPlanFailed(jobId: string, orgId: string, reason: AttendanceLegacyPlanFailureReasonCodeV1): Promise<void>
  storeCompletedResponseAndTerminalize(
    job: AttendanceLegacyPlanWorkerRepositoryJobV1,
    plan: VerifiedAttendanceLegacyPlanV1,
    response: LegacyImportAsyncJobSummaryV1,
    responseDigest: string,
  ): Promise<void>
}> {
  if (typeof db !== 'object' || db === null || typeof db.query !== 'function') {
    fail('W4C3A_REPOSITORY_DB_INVALID')
  }

  return Object.freeze({
    async readCandidateJob(jobId: string) {
      const row = optionalRow(await db.query(CANDIDATE_SQL, [jobId]))
      if (row === null) return null
      return Object.freeze({
        jobId: requiredString(row, 'id'),
        orgId: requiredString(row, 'org_id'),
      })
    },

    async readAuthorizationJob(jobId: string, orgId: string) {
      const row = optionalRow(await db.query(JOB_SQL, [jobId, orgId]))
      return row === null ? null : mapJob(row)
    },

    async lockJob(jobId: string, orgId: string) {
      const row = optionalRow(await db.query(JOB_FOR_UPDATE_SQL, [jobId, orgId]))
      return row === null ? null : mapJob(row)
    },

    async loadPlan(jobId: string, orgId: string) {
      const manifest = optionalRow(await db.query(MANIFEST_SQL, [jobId, orgId]))
      if (manifest === null) return null
      if (!Object.prototype.hasOwnProperty.call(manifest, 'manifest')) {
        fail('W4C3A_REPOSITORY_ROW_INVALID')
      }
      const chunks = (await db.query(CHUNKS_SQL, [jobId, orgId])).rows.map(mapStoredChunk)
      return Object.freeze({
        planDigest: requiredString(manifest, 'plan_digest'),
        chunkVectorDigest: requiredString(manifest, 'chunk_vector_digest'),
        chunkCount: nonNegativeInteger(manifest, 'chunk_count'),
        manifest: manifest.manifest,
        chunks: Object.freeze(chunks),
      })
    },

    async loadCompletedResponse(jobId: string, orgId: string) {
      const row = requiredRow(await db.query(COMPLETED_RESPONSE_SQL, [jobId, orgId]))
      if (!Object.prototype.hasOwnProperty.call(row, 'response')) {
        fail('W4C3A_REPOSITORY_ROW_INVALID')
      }
      return Object.freeze({
        response: row.response,
        responseDigest: requiredString(row, 'response_digest'),
      })
    },

    async markSuspendedQueued(jobId: string, orgId: string) {
      if ((await db.query(MARK_SUSPENDED_SQL, [jobId, orgId])).rows.length !== 1) {
        fail('W4C3A_REPOSITORY_STATUS_UPDATE_REJECTED')
      }
    },

    async clearResumedSuspendedReason(jobId: string, orgId: string) {
      if ((await db.query(CLEAR_SUSPENDED_SQL, [jobId, orgId])).rows.length !== 1) {
        fail('W4C3A_REPOSITORY_STATUS_UPDATE_REJECTED')
      }
    },

    async markPlanFailed(jobId: string, orgId: string, reason: AttendanceLegacyPlanFailureReasonCodeV1) {
      if (!ATTENDANCE_LEGACY_PLAN_FAILURE_REASON_CODES_V1.includes(reason)) {
        fail('W4C3A_REPOSITORY_REASON_INVALID')
      }
      if ((await db.query(MARK_FAILED_SQL, [jobId, orgId, reason])).rows.length !== 1) {
        fail('W4C3A_REPOSITORY_STATUS_UPDATE_REJECTED')
      }
    },

    async storeCompletedResponseAndTerminalize(job, plan, response, responseDigest) {
      await db.query(INSERT_TERMINAL_RESPONSE_SQL, [
        job.jobId,
        job.orgId,
        terminalResponseVariant(plan),
        responseDigest,
        JSON.stringify(response),
      ])
      const cleanup = plan.manifest.artifactCleanup
      if (cleanup.kind === 'uploaded_import_file') {
        await db.query(INSERT_CLEANUP_COMMAND_SQL, [
          job.jobId,
          job.orgId,
          cleanup.fileId,
        ])
      }
      if ((await db.query(MARK_COMPLETED_SQL, [job.jobId, job.orgId])).rows.length !== 1) {
        fail('W4C3A_REPOSITORY_STATUS_UPDATE_REJECTED')
      }
    },
  })
}
