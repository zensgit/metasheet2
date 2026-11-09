import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttendancePunchDetailJobReplayHostV1 } from '../w4c3a-punch-detail-job-replay-host'
import { buildAttendancePunchDetailPreparedPlanV1 } from '../w4c3a-punch-detail-prepare'
import { buildLegacyImportExecutionPlanPackageV1, computeLegacyImportAsyncJobSummaryDigestV1, sha256HexOfCanonicalJsonV1 } from '../w4c3a-legacy-execution-plan'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

const jobId = '10000000-0000-4000-8000-000000000001'
const recordId = '10000000-0000-4000-8000-000000000002'
const hex = 'a'.repeat(64)
afterEach(() => vi.unstubAllEnvs())

function harness(options: {
  status?: string; state?: string; absentUser?: string; absentMember?: string
  nullKey?: boolean; missing?: boolean; badFingerprint?: boolean; legacy?: boolean; noPermission?: boolean; permissionError?: Error
  corrupt?: 'manifest' | 'chunk' | 'identity' | 'response' | 'responseBinding'
} = {}) {
  const original = punchDetailPreparationFixture()
  const fixture = { ...original, envelope: { ...original.envelope, idempotencyKey: options.nullKey ? null : 'job-retry' } }
  const input = { scope: fixture.scope, envelope: fixture.envelope }
  const { plan } = buildAttendancePunchDetailPreparedPlanV1(fixture)
  const packet = buildLegacyImportExecutionPlanPackageV1({
    manifestSeed: {
      schemaVersion: 1, orgId: plan.orgId, jobId, batchId: plan.batchId,
      sourceKind: 'import_batch', sourceRef: 'attendance-import:' + plan.batchId,
      createdBy: plan.actorId, actorId: plan.actorId, actorPosture: plan.actorPosture,
      tokenSubjectUserId: plan.tokenSubjectUserId, acceptedWritePosture: 'authoritative',
      identityProofVectorDigest: sha256HexOfCanonicalJsonV1([]), commandFingerprint: hex,
      legacyInputFingerprint: plan.legacyInputFingerprint, operationalBranch: 'strict_targeted',
      legacyRowSourceKind: 'direct_rows', sourceRowCount: 4, w4ItemCount: 4, w4DistinctTargetCount: 1,
      w4ItemSequenceFingerprint: hex, w4ItemSetFingerprint: hex, legacySourceRowLimit: null,
      groupRevision: null, groupStateFingerprint: null, batch: plan.batch, artifactCleanup: plan.artifactCleanup,
    },
    items: plan.items.map((item, i) => ({ ...item,
      itemId: '10000000-0000-4000-8000-00000000001' + i, recordWriteRef: recordId })),
    recordWrites: plan.recordWrites.map((row) => ({ ...row, recordWriteId: recordId, recordId,
      targetRevision: 0, existingRecordPreconditionFingerprint: hex, expectedSourceOwnership: null })),
    groupEffects: [], groupEffectPlacements: [],
  })
  const row = {
    id: jobId, org_id: plan.orgId, batch_id: plan.batchId, created_by: plan.actorId,
    idempotency_key: plan.idempotencyKey, status: options.status ?? 'queued', progress: 0, total: 4,
    error: null, started_at: null, finished_at: null, created_at: '2026-10-28T00:00:00.000Z',
    updated_at: '2026-10-28T00:00:00.000Z', w4_contract_version: options.legacy ? null : 1,
    w4_legacy_input_fingerprint: options.badFingerprint ? 'b'.repeat(64) : plan.legacyInputFingerprint,
    w4_execution_reason_code: null,
  }
  const authRow = { ...row, w4_entrypoint: 'import_batch', w4_batch_command_id: plan.batchId,
    w4_source_kind: 'import_batch', w4_source_ref: 'attendance-import:' + plan.batchId,
    w4_actor_id: plan.actorId, w4_actor_posture: plan.actorPosture, w4_token_subject_user_id: plan.tokenSubjectUserId,
    w4_command_fingerprint: hex, w4_accepted_write_posture: 'authoritative', w4_item_count: 4,
    w4_item_sequence_fingerprint: hex, w4_item_set_fingerprint: hex, w4_identity_proof_vector: [],
    w4_identity_proof_vector_digest: packet.manifest.identityProofVectorDigest,
    w4_legacy_plan_digest: packet.planDigest, w4_distinct_target_count: 1, w4_operational_branch: 'strict_targeted' }
  const storedManifest = JSON.parse(JSON.stringify(packet.manifest))
  const chunks = packet.chunks.map(c => ({ chunk_index: c.chunkIndex, first_source_ordinal: c.firstSourceOrdinal,
    source_row_count: c.sourceRowCount, chunk_digest: c.chunkDigest, chunk: JSON.parse(JSON.stringify(c.body)) }))
  if (options.corrupt === 'manifest') storedManifest.batch.source = 'changed'
  if (options.corrupt === 'chunk') chunks[0].chunk.items[0].previewSnapshot.workDate = '2000-01-01'
  if (options.corrupt === 'identity') authRow.w4_actor_id = 'other-actor'
  const response = { __jobType: 'commit' as const, idempotencyKey: plan.idempotencyKey,
    __importEngine: 'standard' as const, recordUpsertStrategy: 'values' as const,
    itemsInsertStrategy: 'values' as const,
    summary: { processedRows: 4, failedRows: 0, elapsedMs: 1, chunkConfig: { size: 100 } } }
  const boundResponse = options.corrupt === 'responseBinding' ? { ...response, itemsInsertStrategy: 'unnest' as const } : response
  const responseDigest = computeLegacyImportAsyncJobSummaryDigestV1(boundResponse)
  if (options.corrupt === 'response') response.summary.processedRows = 3
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  vi.stubEnv('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED', plan.orgId)
  let transaction = false
  const client = { async query(sql: string, params: readonly unknown[] = []) {
    calls.push({ sql, params })
    expect(sql).not.toMatch(/\bpayload\b/)
    if (sql === 'SAVEPOINT w4c5_idle_probe' && !transaction) throw Object.assign(new Error('idle'), { code: '25P01' })
    if (sql.startsWith('BEGIN')) transaction = true
    else if (sql === 'COMMIT' || sql === 'ROLLBACK') transaction = false
    else if (sql.includes('FROM attendance_calculation_rollout_state')) return { rows: options.state === 'missing' ? [] : [{ state: options.state ?? 'authoritative', scope: 'synthetic_staging' }] }
    else if (sql.includes('FROM user_roles')) {
      if (options.permissionError) throw options.permissionError
      return { rows: options.noPermission ? [] : [{ present: 1 }] }
    }
    else if (sql.includes('FROM users')) return { rows: params[0] === options.absentUser ? [] : [{ present: 1 }] }
    else if (sql.includes('FROM user_orgs')) return { rows: params[0] === options.absentMember ? [] : [{ present: 1 }] }
    else if (sql.includes('FROM attendance_import_jobs')) {
      if (sql.includes('w4_identity_proof_vector_digest')) {
        expect(params).toEqual([jobId, plan.orgId]); return { rows: [authRow] }
      }
      expect(params.slice(0, 2)).toEqual([plan.orgId, plan.idempotencyKey])
      return { rows: options.missing ? [] : [row] }
    } else if (sql.includes('FROM attendance_import_legacy_execution_plans')) {
      expect(params).toEqual([jobId, plan.orgId])
      return { rows: [{ plan_digest: packet.planDigest, chunk_vector_digest: packet.manifest.chunkVectorDigest,
        chunk_count: packet.chunks.length, manifest: storedManifest }] }
    } else if (sql.includes('FROM attendance_import_legacy_execution_plan_chunks')) return { rows: chunks }
    else if (sql.includes('FROM attendance_import_legacy_terminal_responses')) return { rows: [{ response: boundResponse, response_digest: responseDigest }] }
    else if (!sql.startsWith('SELECT set_config') && !sql.startsWith('SELECT pg_advisory')) throw new Error('UNEXPECTED_JOB_REPLAY_SQL')
    return { rows: [] }
  } }
  const release = vi.fn()
  const acquireConnection = vi.fn(async () => ({ client, release }))
  const host = createAttendancePunchDetailJobReplayHostV1({ acquireConnection })
  const read = () => host.readPunchDetailImportJobReplay(input)
  return { input, row, response, calls, read, host, release, acquireConnection }
}
describe('punch-detail durable job replay', () => {
  it.each(['queued', 'running', 'failed', 'completed'])('returns verified %s job with frozen envelope and no mutable payload read', async status => {
    const h = harness({ status })
    expect(await h.read()).toEqual({ ...h.row, payload: h.input.envelope,
      w4_terminal_response: status === 'completed' ? h.response : null })
    const sql = h.calls.map(c => c.sql)
    expect(sql.findIndex(s => s.includes('FROM attendance_import_jobs')))
      .toBeGreaterThan(sql.findIndex(s => s === 'SELECT pg_advisory_xact_lock($1::bigint)'))
    expect(sql.some(s => /^(INSERT|UPDATE|DELETE)\b/.test(s))).toBe(false)
    expect(sql.at(-1)).toBe('COMMIT')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })
  it.each(['legacy', 'suspended', 'missing'])('rejects current %s posture before job read', async state => {
    const h = harness({ state })
    await expect(h.read()).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.calls.some(c => c.sql.includes('FROM attendance_import_jobs'))).toBe(false)
  })
  it.each([
    { absentUser: 'punch-detail-admin' }, { absentUser: 'punch-detail-employee' },
    { absentMember: 'punch-detail-employee' },
  ])('rejects current liveness %j before job read', async options => {
    const h = harness(options)
    await expect(h.read()).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.calls.some(c => c.sql.includes('FROM attendance_import_jobs'))).toBe(false)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
  })
  it.each([{ badFingerprint: true }, { legacy: true }])('rejects another command or old job %j', async options => {
    const h = harness(options)
    await expect(h.read()).rejects.toThrow('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
    expect(h.calls.some(c => c.sql.includes('FROM attendance_import_legacy_execution_plans'))).toBe(false)
  })
  it.each(['manifest', 'chunk', 'identity'] as const)('rejects corrupted durable %s', async corrupt => {
    const h = harness({ corrupt })
    await expect(h.read()).rejects.toThrow(corrupt === 'identity'
      ? 'ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT' : 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
  })
  it('refuses revoked full-import permission even while actor and subject remain active', async () => {
    const h = harness({ noPermission: true })
    await expect(h.read()).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
  })
  it('propagates permission SQL failures without turning them into an authorization denial', async () => {
    const failure = new Error('SYNTHETIC_QUERY_FAILURE')
    const h = harness({ permissionError: failure })
    await expect(h.read()).rejects.toBe(failure)
  })
  it('rejects a self-consistent terminal digest for a different command strategy', async () => {
    const h = harness({ status: 'completed', corrupt: 'responseBinding' })
    await expect(h.read()).rejects.toThrow('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
  })
  it('checks completed response digest before projecting a result', async () => {
    const h = harness({ status: 'completed', corrupt: 'response' })
    await expect(h.read()).rejects.toThrow('ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
  })
  it('reads a just-reserved keyless job by server job ID with current admission', async () => {
    const h = harness({ nullKey: true })
    expect(await h.host.readPunchDetailImportJobReplay({ ...h.input, jobId })).toEqual({
      ...h.row, payload: h.input.envelope, w4_terminal_response: null,
    })
    expect(h.calls.find(c => c.sql.includes('FROM attendance_import_jobs'))?.params)
      .toEqual([h.input.scope.orgId, null, jobId])
  })
  it('returns an admitted miss without any reservation or effects', async () => {
    const h = harness({ missing: true })
    expect(await h.read()).toBeNull()
    expect(h.calls.at(-1)?.sql).toBe('COMMIT')
  })
  it('does no lookup for a keyless initial request', async () => {
    const h = harness({ nullKey: true })
    expect(await h.read()).toBeNull()
    expect(h.acquireConnection).not.toHaveBeenCalled()
  })
})
