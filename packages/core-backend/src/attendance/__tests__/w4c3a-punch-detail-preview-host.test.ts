import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttendancePunchDetailPreviewHostV1 } from '../w4c3a-punch-detail-preview-host'
import { buildAttendancePunchDetailPreviewRecordV1 } from '../w4c3a-punch-detail-preview-record'
import { withCurrentAttendancePunchDetailReplayV1 } from '../w4c3a-punch-detail-replay-host'
import { buildAttendanceLegacyIdempotencyAdvisoryKey, parseCanonicalAttendanceLegacyIdempotencyKeyV1 } from '../w4c0-identity'
import { sha256HexOfCanonicalJsonV1 } from '../w4c3a-legacy-execution-plan'
import type { AttendancePunchDetailPreparationReadClientV1 } from '../w4c3a-punch-detail-preparation-host'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

const jobId = '20000000-0000-4000-8000-000000000001'
afterEach(() => vi.unstubAllEnvs())

function harness(options: {
  existing?: boolean; permission?: boolean; absentUser?: string; absentMember?: string
  state?: string; recordError?: Error; commitError?: Error
} = {}) {
  const original = punchDetailPreparationFixture('fold_start')
  const fixture = { ...original, envelope: { ...original.envelope, idempotencyKey: 'preview-retry' } }
  const input = { scope: fixture.scope, envelope: fixture.envelope, previewLimit: 2, jobId, batchId: fixture.batchId }
  vi.stubEnv('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED', fixture.scope.orgId)
  const packet = buildAttendancePunchDetailPreviewRecordV1({ jobId, preparation: fixture, previewLimit: 2 })
  const key = 'punch-preview:' + sha256HexOfCanonicalJsonV1({ domain: 'metasheet2:attendance:punch-detail-preview-key:v1', key: fixture.envelope.idempotencyKey })
  const job: Record<string, unknown> = { id: jobId, org_id: fixture.scope.orgId, created_by: fixture.scope.actorId,
    batch_id: fixture.batchId, idempotency_key: key, status: 'queued', progress: 0, total: 4,
    error: null, started_at: null, finished_at: null, created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
    w4_contract_version: null, punch_preview_version: 1,
    punch_preview_request_fingerprint: packet.record.requestFingerprint, punch_preview_snapshot_digest: packet.snapshotDigest,
    punch_preview_actor_posture: fixture.scope.actorPosture, punch_preview_token_subject_user_id: fixture.scope.tokenSubjectUserId,
    snapshot: JSON.parse(JSON.stringify(packet.record)) }
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  let transaction = false
  const client = { async query(sql: string, params: readonly unknown[] = []) {
    calls.push({ sql, params })
    if (sql === 'SAVEPOINT w4c5_idle_probe' && !transaction) throw Object.assign(new Error('idle'), { code: '25P01' })
    if (sql.startsWith('BEGIN')) { transaction = true; return { rows: [] } }
    if (sql === 'COMMIT') {
      if (options.commitError) throw options.commitError
      transaction = false; return { rows: [] }
    }
    if (sql === 'ROLLBACK') { transaction = false; return { rows: [] } }
    if (sql.includes('FROM attendance_calculation_rollout_state')) return { rows: [{ state: options.state ?? 'authoritative', scope: 'synthetic_staging' }] }
    if (sql.includes('FROM users')) return { rows: options.absentUser === params[0] ? [] : [{ present: 1 }] }
    if (sql.includes('FROM user_orgs')) return { rows: options.absentMember === params[0] ? [] : [{ present: 1 }] }
    if (sql.includes('FROM user_roles ur')) return { rows: [{ role_id: 'admin', permission_code: null }] }
    if (sql.includes('FROM user_namespace_admissions')) return { rows: [] }
    if (sql === 'SELECT scoped_preview_permission') return { rows: [{ allowed: options.permission !== false }] }
    if (sql === 'SELECT frozen_target') return { rows: [{ present: 1 }] }
    if (sql.includes('FROM attendance_import_jobs j')) return { rows: options.existing ? [job] : [] }
    if (sql.startsWith('INSERT INTO attendance_import_jobs AS j')) {
      expect(params).toEqual([jobId, fixture.scope.orgId, fixture.scope.actorId, fixture.batchId, key,
        4, packet.record.requestFingerprint, packet.snapshotDigest, fixture.scope.actorPosture, fixture.scope.tokenSubjectUserId])
      const { snapshot: _snapshot, ...row } = job
      return { rows: [row] }
    }
    if (sql.startsWith('INSERT INTO attendance_import_punch_preview_records')) {
      if (options.recordError) throw options.recordError
      expect(params).toEqual([jobId, fixture.scope.orgId, fixture.scope.actorId, fixture.batchId,
        packet.record.requestFingerprint, packet.snapshotDigest, JSON.stringify(packet.record)])
      return { rows: [] }
    }
    if (sql.startsWith('SELECT set_config') || sql.startsWith('SELECT pg_advisory')) return { rows: [] }
    throw new Error('UNEXPECTED_TEST_SQL')
  } }
  const release = vi.fn()
  const deps = { acquireConnection: vi.fn(async () => ({ client, release })) }
  let retained: AttendancePunchDetailPreparationReadClientV1 | undefined
  const authorizeTarget = vi.fn(async (read: AttendancePunchDetailPreparationReadClientV1, request: Pick<typeof input, 'scope' | 'envelope'>) => {
    retained = read
    expect(request).toEqual({ scope: fixture.scope, envelope: fixture.envelope })
    expect(read.__w4CanonicalTrx).toBe(true)
    return (await read.query('SELECT scoped_preview_permission'))[0].allowed === true
  })
  const beforeCreate = vi.fn(async () => {})
  const resolveFrozenTarget = vi.fn(async (read: AttendancePunchDetailPreparationReadClientV1) => {
    expect(await read.query('SELECT frozen_target')).toEqual([{ present: 1 }])
    return { attribution: fixture.attribution, context: fixture.context, policySourceProof: fixture.policySourceProof }
  })
  return { fixture, input, key, job, packet, calls, release, deps, retained: () => retained,
    host: createAttendancePunchDetailPreviewHostV1(deps), callbacks: { authorizeTarget, beforeCreate, resolveFrozenTarget } }
}

function writes(h: ReturnType<typeof harness>) { return h.calls.filter(c => /^(INSERT|UPDATE|DELETE)\b/.test(c.sql)) }
function lockValue(orgId: string, idempotencyKey: string) {
  return buildAttendanceLegacyIdempotencyAdvisoryKey(parseCanonicalAttendanceLegacyIdempotencyKeyV1({ orgId, idempotencyKey })).toString()
}

describe('punch-detail preview reservation host', () => {
  it('atomically reserves only a preview job and full frozen record with scoped admission', async () => {
    const h = harness()
    const result = await h.host.reservePunchDetailPreview(h.input, h.callbacks)
    expect(result).toEqual({ created: true, job: expect.objectContaining({ id: jobId, w4_contract_version: null }), record: h.packet.record })
    expect(result.record.preview.items).toHaveLength(2)
    expect(result.record.preview.eventCount).toBe(4)
    expect(result.record.preview.targets[0].dailyProjection?.workedMinutes).toBe(165)
    expect(writes(h).map(c => c.sql.split('\n')[0])).toEqual([
      'INSERT INTO attendance_import_jobs AS j', 'INSERT INTO attendance_import_punch_preview_records'])
    const statements = h.calls.map(c => c.sql)
    expect(statements.indexOf('SELECT scoped_preview_permission')).toBeLessThan(statements.findIndex(s => s.includes('FROM attendance_import_jobs j')))
    expect(statements.indexOf('SELECT frozen_target')).toBeGreaterThan(statements.findIndex(s => s.includes('FROM attendance_import_jobs j')))
    expect(h.callbacks.beforeCreate).toHaveBeenCalledTimes(1)
    expect(h.callbacks.resolveFrozenTarget).toHaveBeenCalledTimes(1)
    expect(h.calls.some(c => c.params.includes(lockValue(h.input.scope.orgId, h.key)))).toBe(true)
    expect(h.calls.at(-1)?.sql).toBe('COMMIT')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })

  it.each(['queued', 'running', 'completed', 'failed'])('verifies an exact %s retry without token/refreeze/writes', async (status) => {
    const h = harness({ existing: true }); h.job.status = status
    const result = await h.host.reservePunchDetailPreview({ ...h.input, jobId: '30000000-0000-4000-8000-000000000001' }, h.callbacks)
    expect(result.created).toBe(false)
    expect(result.job.id).toBe(jobId)
    expect(result.record).toEqual(h.packet.record)
    expect(result.job).not.toHaveProperty('snapshot')
    expect(h.callbacks.authorizeTarget).toHaveBeenCalledTimes(1)
    expect(h.callbacks.beforeCreate).not.toHaveBeenCalled()
    expect(h.callbacks.resolveFrozenTarget).not.toHaveBeenCalled()
    expect(writes(h)).toEqual([])
    expect(h.calls.filter(c => c.sql.includes('FROM attendance_import_jobs j')).every(c => !c.sql.includes('payload'))).toBe(true)
  })

  it('requires current scoped permission before reading existing results', async () => {
    const h = harness({ existing: true, permission: false })
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.calls.some(c => c.sql.includes('FROM attendance_import_jobs j'))).toBe(false)
    expect(writes(h)).toEqual([])
    expect(h.callbacks.beforeCreate).not.toHaveBeenCalled()
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  it.each(['punch-detail-admin', 'punch-detail-employee'])('rejects inactive %s before permission and result reads', async (absentUser) => {
    const h = harness({ existing: true, absentUser })
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.callbacks.authorizeTarget).not.toHaveBeenCalled()
    expect(writes(h)).toEqual([])
  })

  it('rejects imported subject outside the current organization', async () => {
    const h = harness({ existing: true, absentMember: 'punch-detail-employee' })
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.callbacks.authorizeTarget).not.toHaveBeenCalled()
  })

  it('rejects suspended current rollout before returning frozen results', async () => {
    const h = harness({ existing: true, state: 'suspended' })
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.callbacks.authorizeTarget).not.toHaveBeenCalled()
  })

  it.each([
    ['punch_preview_version', null], ['w4_contract_version', 1], ['org_id', 'another-org'],
    ['created_by', 'other-actor'], ['punch_preview_actor_posture', 'operator'],
    ['punch_preview_token_subject_user_id', 'other-subject'], ['punch_preview_request_fingerprint', '0'.repeat(64)],
  ])('refuses independently mismatched job identity %s', async (field, value) => {
    const h = harness({ existing: true }); h.job[field as string] = value
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
    expect(writes(h)).toEqual([])
    expect(h.callbacks.beforeCreate).not.toHaveBeenCalled()
  })

  it('rejects changing preview limit under the same accepted command', async () => {
    const h = harness({ existing: true })
    await expect(h.host.reservePunchDetailPreview({ ...h.input, previewLimit: 3 }, h.callbacks))
      .rejects.toThrow('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
    expect(h.callbacks.resolveFrozenTarget).not.toHaveBeenCalled()
  })

  it('rejects a missing record instead of returning a partial job', async () => {
    const h = harness({ existing: true }); h.job.snapshot = null
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREVIEW_INVALID')
    expect(writes(h)).toEqual([])
  })

  it('rejects changed frozen output even if its digest was also replaced', async () => {
    const h = harness({ existing: true })
    const changed = JSON.parse(JSON.stringify(h.packet.record))
    changed.preview.targets[0].dailyProjection.workedMinutes = 999
    h.job.snapshot = changed; h.job.punch_preview_snapshot_digest = sha256HexOfCanonicalJsonV1(changed)
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREVIEW_RESULT_MISMATCH')
    expect(h.callbacks.resolveFrozenTarget).not.toHaveBeenCalled()
  })

  it('read-only retry miss performs no create callback or writes', async () => {
    const h = harness()
    expect(await h.host.readPunchDetailPreviewReplay(h.input, h.callbacks.authorizeTarget)).toBeNull()
    expect(writes(h)).toEqual([])
    expect(h.callbacks.resolveFrozenTarget).not.toHaveBeenCalled()
  })

  it('null-key replay does not acquire a connection', async () => {
    const h = harness()
    expect(await h.host.readPunchDetailPreviewReplay({ ...h.input, envelope: { ...h.input.envelope, idempotencyKey: null } }, h.callbacks.authorizeTarget)).toBeNull()
    expect(h.deps.acquireConnection).not.toHaveBeenCalled()
  })

  it('retains the ordinary replay helper raw-key lock when no override is supplied', async () => {
    const h = harness()
    expect(await withCurrentAttendancePunchDetailReplayV1(h.deps, h.input, async () => 'original')).toBe('original')
    expect(h.calls.some(c => c.params.includes(lockValue(h.input.scope.orgId, h.input.envelope.idempotencyKey)))).toBe(true)
    expect(h.calls.some(c => c.params.includes(lockValue(h.input.scope.orgId, h.key)))).toBe(false)
  })

  it.each(['success', 'failure'])('closes the retained transaction facade after %s', async (outcome) => {
    const h = harness({ permission: outcome === 'success' })
    if (outcome === 'success') await h.host.reservePunchDetailPreview(h.input, h.callbacks)
    else await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    const count = h.calls.length
    await expect(h.retained()?.query('SELECT frozen_target')).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREVIEW_CLOSED')
    expect(h.calls).toHaveLength(count)
  })

  it('rolls back the job insert if frozen record persistence fails', async () => {
    const failure = new Error('RECORD_INSERT_FAILED'); const h = harness({ recordError: failure })
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toBe(failure)
    expect(writes(h)).toHaveLength(2)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })

  it('discards an uncertain commit through the existing transaction runner', async () => {
    const failure = Object.assign(new Error('COMMIT_CONNECTION_LOST'), { code: '08006' })
    const h = harness({ commitError: failure })
    await expect(h.host.reservePunchDetailPreview(h.input, h.callbacks)).rejects.toBe(failure)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(failure)
  })
})
