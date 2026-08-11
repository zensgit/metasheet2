import { describe, expect, it, vi } from 'vitest'
import {
  AttendanceLegacyPlanWorkerRepositoryError,
  createAttendanceLegacyPlanWorkerRepositoryV1,
} from '../w4c3a-legacy-plan-worker-repository'
import type {
  AttendanceLegacyPlanWorkerRepositoryJobV1,
} from '../w4c3a-legacy-plan-worker-repository'
import type {
  VerifiedAttendanceLegacyPlanV1,
} from '../w4c3a-legacy-plan-worker'
import {
  computeLegacyImportAsyncJobSummaryDigestV1,
  type LegacyImportAsyncJobSummaryV1,
} from '../w4c3a-legacy-execution-plan'

const JOB_ID = '10000000-0000-4000-8000-000000000001'
const ORG_ID = 'org-a'
const BATCH_ID = '10000000-0000-4000-8000-000000000002'
const HEX = 'a'.repeat(64)
const FILE_ID = '10000000-0000-4000-8000-000000000003'
const RESPONSE: LegacyImportAsyncJobSummaryV1 = {
  __jobType: 'commit',
  idempotencyKey: 'idem-a',
  __importEngine: 'standard',
  recordUpsertStrategy: 'unnest',
  itemsInsertStrategy: 'unnest',
  summary: {
    processedRows: 1,
    failedRows: 0,
    elapsedMs: 10,
    chunkConfig: { size: 500 },
  },
}
const RESPONSE_DIGEST = computeLegacyImportAsyncJobSummaryDigestV1(RESPONSE)

function jobRow(): Record<string, unknown> {
  return {
    id: JOB_ID,
    org_id: ORG_ID,
    batch_id: BATCH_ID,
    created_by: 'user-a',
    idempotency_key: 'idem-a',
    status: 'queued',
    w4_contract_version: 1,
    w4_entrypoint: 'import_batch',
    w4_batch_command_id: BATCH_ID,
    w4_source_kind: 'import_batch',
    w4_source_ref: 'source-a',
    w4_actor_id: 'actor-a',
    w4_actor_posture: 'platform_admin',
    w4_token_subject_user_id: 'user-a',
    w4_command_fingerprint: HEX,
    w4_accepted_write_posture: 'legacy_projection_only',
    w4_item_count: 1,
    w4_item_sequence_fingerprint: HEX,
    w4_item_set_fingerprint: HEX,
    w4_identity_proof_vector: [],
    w4_identity_proof_vector_digest: HEX,
    w4_legacy_plan_digest: HEX,
    w4_distinct_target_count: 1,
    w4_operational_branch: 'strict_targeted',
    w4_legacy_input_fingerprint: HEX,
    w4_execution_reason_code: null,
  }
}

function queryStub(rowsByCall: Array<Array<Record<string, unknown>>>) {
  const query = vi.fn(async () => ({ rows: rowsByCall.shift() ?? [] }))
  return { query, db: { query } }
}

function mappedJob(): AttendanceLegacyPlanWorkerRepositoryJobV1 {
  return {
    jobId: JOB_ID,
    orgId: ORG_ID,
    status: 'queued',
    w4ContractVersion: 1,
    batchId: BATCH_ID,
    idempotencyKey: 'idem-a',
    sourceKind: 'import_batch',
    sourceRef: 'source-a',
    createdBy: 'user-a',
    actorId: 'actor-a',
    actorPosture: 'platform_admin',
    tokenSubjectUserId: 'user-a',
    acceptedWritePosture: 'legacy_projection_only',
    commandFingerprint: HEX,
    legacyInputFingerprint: HEX,
    operationalBranch: 'strict_targeted',
    identityProofVector: [],
    identityProofVectorDigest: HEX,
    itemCount: 1,
    distinctTargetCount: 1,
    itemSequenceFingerprint: HEX,
    itemSetFingerprint: HEX,
    planDigest: HEX,
    entrypoint: 'import_batch',
    batchCommandId: BATCH_ID,
    executionReasonCode: null,
  }
}

function terminalPlan(
  batch: Record<string, unknown>,
  artifactCleanup: Record<string, unknown>,
): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {
      batch,
      artifactCleanup,
    },
    chunks: [],
    items: [],
    recordWrites: [],
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

describe('createAttendanceLegacyPlanWorkerRepositoryV1', () => {
  it('recovers a narrow candidate identity from only the durable job id', async () => {
    const { db, query } = queryStub([[{ id: JOB_ID, org_id: ORG_ID }]])
    const repository = createAttendanceLegacyPlanWorkerRepositoryV1(db)
    const result = await repository.readCandidateJob("x' OR 1=1 --")

    expect(result).toEqual({ jobId: JOB_ID, orgId: ORG_ID })
    expect(query.mock.calls[0]?.[0]).toContain('WHERE id = $1::uuid')
    expect(query.mock.calls[0]?.[0]).not.toContain('org_id = $2')
    expect(query.mock.calls[0]?.[1]).toEqual(["x' OR 1=1 --"])
  })

  it('maps the explicit frozen job columns and never selects payload', async () => {
    const { db, query } = queryStub([[jobRow()]])
    const repository = createAttendanceLegacyPlanWorkerRepositoryV1(db)
    const result = await repository.readAuthorizationJob(JOB_ID, ORG_ID)

    expect(result).toMatchObject({
      jobId: JOB_ID,
      orgId: ORG_ID,
      idempotencyKey: 'idem-a',
      acceptedWritePosture: 'legacy_projection_only',
      identityProofVector: [],
      planDigest: HEX,
      entrypoint: 'import_batch',
      batchCommandId: BATCH_ID,
    })
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).not.toMatch(/select\s+\*/i)
    expect(sql).not.toMatch(/\bpayload\b/i)
    expect(sql).toContain("digest(convert_to(w4_identity_proof_vector::text, 'UTF8')")
    expect(sql.match(/\bw4_identity_proof_vector_digest\b/g)).toHaveLength(1)
    expect(sql).toContain('AS w4_identity_proof_vector_digest')
  })

  it('rejects an empty or malformed job row instead of manufacturing defaults', async () => {
    const empty = queryStub([ [{}] ])
    await expect(
      createAttendanceLegacyPlanWorkerRepositoryV1(empty.db).readAuthorizationJob(JOB_ID, ORG_ID),
    ).rejects.toMatchObject({ code: 'W4C3A_REPOSITORY_ROW_INVALID' })

    const bad = jobRow()
    delete bad.w4_identity_proof_vector
    const malformed = queryStub([[bad]])
    await expect(
      createAttendanceLegacyPlanWorkerRepositoryV1(malformed.db).readAuthorizationJob(JOB_ID, ORG_ID),
    ).rejects.toBeInstanceOf(AttendanceLegacyPlanWorkerRepositoryError)
  })

  it('reads a fixed manifest and ordered chunks without dynamic SQL', async () => {
    const { db, query } = queryStub([
      [{ plan_digest: HEX, chunk_vector_digest: HEX, chunk_count: 1, manifest: { schemaVersion: 1 } }],
      [{ chunk_index: 0, first_source_ordinal: 0, source_row_count: 1, chunk_digest: HEX, chunk: { items: [], recordWrites: [], groupEffects: [] } }],
    ])
    const repository = createAttendanceLegacyPlanWorkerRepositoryV1(db)
    const result = await repository.loadPlan("job' UNION SELECT", ORG_ID)

    expect(result).toEqual({
      planDigest: HEX,
      chunkVectorDigest: HEX,
      chunkCount: 1,
      manifest: { schemaVersion: 1 },
      chunks: [{ chunkIndex: 0, firstSourceOrdinal: 0, sourceRowCount: 1, chunkDigest: HEX, chunk: { items: [], recordWrites: [], groupEffects: [] } }],
    })
    for (const [sql] of query.mock.calls) {
      expect(String(sql)).not.toMatch(/select\s+\*/i)
      expect(String(sql)).not.toMatch(/\bpayload\b/i)
    }
    expect(query.mock.calls[0]?.[1]).toEqual(["job' UNION SELECT", ORG_ID])
    expect(query.mock.calls[1]?.[1]).toEqual(["job' UNION SELECT", ORG_ID])
    expect(String(query.mock.calls[1]?.[0])).toMatch(/org_id = \$2/)
  })

  it('fails closed when a required terminal response is absent', async () => {
    const { db } = queryStub([[]])
    await expect(
      createAttendanceLegacyPlanWorkerRepositoryV1(db).loadCompletedResponse(JOB_ID, ORG_ID),
    ).rejects.toMatchObject({ code: 'W4C3A_REPOSITORY_ROW_MISSING' })
  })

  it('requires org and id on every status update and rejects zero-row updates', async () => {
    const suspended = queryStub([[{ id: JOB_ID }]])
    const repository = createAttendanceLegacyPlanWorkerRepositoryV1(suspended.db)
    await repository.markSuspendedQueued(JOB_ID, ORG_ID)
    const suspendedSql = String(suspended.query.mock.calls[0]?.[0])
    expect(suspendedSql).toMatch(/WHERE id = \$1::uuid AND org_id = \$2/)
    expect(suspendedSql).toMatch(/w4_execution_reason_code IS NULL OR/)
    expect(suspended.query.mock.calls[0]?.[1]).toEqual([JOB_ID, ORG_ID])

    const resumed = queryStub([[{ id: JOB_ID }]])
    await createAttendanceLegacyPlanWorkerRepositoryV1(resumed.db)
      .clearResumedSuspendedReason(JOB_ID, ORG_ID)
    expect(String(resumed.query.mock.calls[0]?.[0])).toMatch(
      /w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED'/,
    )

    const failed = queryStub([[]])
    await expect(
      createAttendanceLegacyPlanWorkerRepositoryV1(failed.db).markPlanFailed(
        JOB_ID,
        ORG_ID,
        'ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING',
      ),
    ).rejects.toMatchObject({ code: 'W4C3A_REPOSITORY_STATUS_UPDATE_REJECTED' })
    const failedSql = String(failed.query.mock.calls[0]?.[0])
    expect(failedSql).toMatch(/WHERE id = \$1::uuid AND org_id = \$2/)
    expect(failedSql).toMatch(/status = 'failed', error = NULL/)
    expect(failed.query.mock.calls[0]?.[1]).toEqual([JOB_ID, ORG_ID, 'ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING'])
  })

  it('stores a normal response before atomically terminalizing the queued job', async () => {
    const { db, query } = queryStub([[], [{ id: JOB_ID }]])
    await createAttendanceLegacyPlanWorkerRepositoryV1(db)
      .storeCompletedResponseAndTerminalize(
        mappedJob(),
        terminalPlan(
          { kind: 'normal' },
          { kind: 'none' },
        ),
        RESPONSE,
        RESPONSE_DIGEST,
      )

    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'INSERT INTO attendance_import_legacy_terminal_responses',
    )
    expect(query.mock.calls[0]?.[1]).toEqual([
      JOB_ID,
      ORG_ID,
      'first_execution',
      RESPONSE_DIGEST,
      JSON.stringify(RESPONSE),
    ])
    expect(String(query.mock.calls[1]?.[0])).toMatch(
      /status = 'completed'.*error = NULL/s,
    )
    expect(String(query.mock.calls[1]?.[0])).toMatch(/progress = \$3/)
    expect(String(query.mock.calls[1]?.[0])).toMatch(
      /started_at = COALESCE\(started_at, now\(\)\)/,
    )
    expect(query.mock.calls[1]?.[1]).toEqual([
      JOB_ID,
      ORG_ID,
      RESPONSE.summary.processedRows,
    ])
  })

  it('stores uploaded replay cleanup before terminalizing a locked-race response', async () => {
    const { db, query } = queryStub([[], [], [{ id: JOB_ID }]])
    await createAttendanceLegacyPlanWorkerRepositoryV1(db)
      .storeCompletedResponseAndTerminalize(
        mappedJob(),
        terminalPlan(
          { kind: 'replay', replaySelector: 'locked_race' },
          { kind: 'uploaded_import_file', fileId: FILE_ID },
        ),
        RESPONSE,
        RESPONSE_DIGEST,
      )

    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[0]?.[1]?.[2]).toBe('idempotent_in_transaction')
    expect(String(query.mock.calls[1]?.[0])).toContain(
      'INSERT INTO attendance_import_upload_cleanup_commands',
    )
    expect(query.mock.calls[1]?.[1]).toEqual([JOB_ID, ORG_ID, FILE_ID])
    expect(String(query.mock.calls[2]?.[0])).toContain("status = 'completed'")
  })

  it('rejects a zero-row terminal transition after writing transaction-local rows', async () => {
    const { db } = queryStub([[], []])
    await expect(
      createAttendanceLegacyPlanWorkerRepositoryV1(db)
        .storeCompletedResponseAndTerminalize(
          mappedJob(),
          terminalPlan(
            { kind: 'replay', replaySelector: 'precheck_hit' },
            { kind: 'none' },
          ),
          RESPONSE,
          RESPONSE_DIGEST,
        ),
    ).rejects.toMatchObject({ code: 'W4C3A_REPOSITORY_STATUS_UPDATE_REJECTED' })
  })

  it('rejects a caller-supplied response digest before terminal DML', async () => {
    const { db, query } = queryStub([])
    await expect(
      createAttendanceLegacyPlanWorkerRepositoryV1(db)
        .storeCompletedResponseAndTerminalize(
          mappedJob(),
          terminalPlan(
            { kind: 'normal' },
            { kind: 'none' },
          ),
          RESPONSE,
          HEX,
        ),
    ).rejects.toMatchObject({
      code: 'W4C3A_REPOSITORY_RESPONSE_DIGEST_MISMATCH',
    })
    expect(query).not.toHaveBeenCalled()
  })
})
