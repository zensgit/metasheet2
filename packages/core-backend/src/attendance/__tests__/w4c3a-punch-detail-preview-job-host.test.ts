import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttendancePunchDetailPreviewJobHostV1 } from '../w4c3a-punch-detail-preview-job-host'
import { buildAttendancePunchDetailPreviewRecordV1 } from '../w4c3a-punch-detail-preview-record'
import type { AttendancePunchDetailPreparationReadClientV1 } from '../w4c3a-punch-detail-preparation-host'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

const jobId = '21000000-0000-4000-8000-000000000001'
afterEach(() => vi.unstubAllEnvs())
function harness(options: { status?: string; state?: string; absentUser?: string; absentMember?: string;
  admitted?: boolean; targetAllowed?: boolean; updateError?: Error; commitError?: Error; namespaceError?: Error } = {}) {
  const fixture = punchDetailPreparationFixture('fold_start')
  const { record, snapshotDigest } = buildAttendancePunchDetailPreviewRecordV1({ jobId, preparation: fixture, previewLimit: 2 })
  vi.stubEnv('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED', fixture.scope.orgId)
  const seed: Record<string, unknown> = { id: jobId, org_id: fixture.scope.orgId, created_by: fixture.scope.actorId,
    batch_id: fixture.batchId, idempotency_key: null, status: options.status ?? 'queued', progress: 0, total: 4,
    w4_contract_version: null, punch_preview_version: 1, punch_preview_request_fingerprint: record.requestFingerprint,
    punch_preview_snapshot_digest: snapshotDigest, punch_preview_actor_posture: fixture.scope.actorPosture,
    punch_preview_token_subject_user_id: fixture.scope.tokenSubjectUserId, envelope: record.envelope }
  const { envelope: _envelope, ...metadata } = seed
  const locked: Record<string, unknown> = { ...metadata, snapshot: record }
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  let transaction = false
  const client = { async query(sql: string, params: readonly unknown[] = []) {
    calls.push({ sql, params })
    if (sql === 'SAVEPOINT w4c5_idle_probe' && !transaction) throw Object.assign(new Error('idle'), { code: '25P01' })
    if (sql.startsWith('BEGIN')) { transaction = true; return { rows: [] } }
    if (sql === 'COMMIT') { if (options.commitError) throw options.commitError; transaction = false; return { rows: [] } }
    if (sql === 'ROLLBACK') { transaction = false; return { rows: [] } }
    if (sql.includes('FROM attendance_import_jobs j')) {
      if (params.length === 2 && params[1] !== fixture.scope.orgId) return { rows: [] }
      return { rows: [sql.includes("snapshot->'envelope'") ? seed : locked] }
    }
    if (sql.includes('FROM attendance_calculation_rollout_state')) return { rows: [{ state: options.state ?? 'authoritative', scope: 'synthetic_staging' }] }
    if (sql.includes('FROM users')) return { rows: params[0] === options.absentUser ? [] : [{ present: 1 }] }
    if (sql.includes('FROM user_orgs')) return { rows: params[0] === options.absentMember ? [] : [{ present: 1 }] }
    if (sql.includes('FROM user_roles ur')) return { rows: [{ role_id: 'attendance_admin', permission_code: 'attendance:import' }] }
    if (sql.includes('FROM user_namespace_admissions')) {
      if (options.namespaceError) throw options.namespaceError
      return { rows: [{ namespace: 'attendance', enabled: options.admitted !== false }] }
    }
    if (sql === 'SELECT current_target_permission') return { rows: [{ allowed: options.targetAllowed !== false }] }
    if (sql.startsWith('UPDATE attendance_import_jobs AS j')) {
      if (options.updateError) throw options.updateError
      expect(params).toEqual([jobId, fixture.scope.orgId, 4])
      return { rows: [{ ...metadata, status: 'completed', progress: 4, total: 4 }] }
    }
    if (sql.startsWith('SELECT set_config') || sql.startsWith('SELECT pg_advisory')) return { rows: [] }
    throw new Error('UNEXPECTED_TEST_SQL')
  } }
  const release = vi.fn()
  const acquireConnection = vi.fn(async () => ({ client, release }))
  let retained: AttendancePunchDetailPreparationReadClientV1 | undefined
  const authorize = vi.fn(async (read: AttendancePunchDetailPreparationReadClientV1) => {
    retained = read; return (await read.query('SELECT current_target_permission'))[0].allowed === true
  })
  return { fixture, record, seed, locked, calls, release, acquireConnection, authorize, retained: () => retained,
    host: createAttendancePunchDetailPreviewJobHostV1({ acquireConnection }) }
}
const writes = (h: ReturnType<typeof harness>) => h.calls.filter(c => /^(INSERT|UPDATE|DELETE)\b/.test(c.sql))

describe('punch-detail frozen preview job recovery and reads', () => {
  it.each(['queued', 'running'])('recovers %s using frozen facts and only one job metadata update', async status => {
    const h = harness({ status })
    expect(await h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).toEqual({ kind: 'completed', idempotent: false })
    expect(writes(h)).toHaveLength(1)
    expect(writes(h)[0].sql).toMatch(/^UPDATE attendance_import_jobs AS j/)
    const queries = h.calls.map(c => c.sql)
    expect(queries.findIndex(s => s.includes('FOR UPDATE OF j'))).toBeGreaterThan(queries.findIndex(s => s.includes('pg_advisory_xact_lock_shared')))
    expect(queries.findIndex(s => s.includes('FOR UPDATE OF j'))).toBeGreaterThan(queries.indexOf('SELECT current_target_permission'))
    expect(queries.some(s => s.includes('payload') || s.includes('attendance_shifts') || s.includes('commit_token'))).toBe(false)
    expect(h.calls.at(-1)?.sql).toBe('COMMIT')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })
  it.each(['completed', 'failed'])('verifies terminal %s without another status write', async status => {
    const h = harness({ status })
    expect(await h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).toEqual({ kind: status, idempotent: true })
    expect(writes(h)).toEqual([])
    expect(h.authorize).toHaveBeenCalledTimes(1)
  })
  it('allows a currently authorized same-org reader while verifying the original creator identity', async () => {
    const h = harness({ status: 'completed' })
    const reader = { ...h.fixture.scope, actorPosture: 'attendance_admin' as const, actorId: 'another-reader', tokenSubjectUserId: 'another-reader' }
    const result = await h.host.readPunchDetailPreviewJob({ jobId, scope: reader }, h.authorize)
    expect(result?.record).toEqual(h.record)
    expect(result?.record.scope.actorId).toBe(h.fixture.scope.actorId)
    expect(h.authorize).toHaveBeenCalledWith(expect.anything(), { scope: reader, envelope: h.record.envelope })
    expect(result?.changed).toBe(false)
    expect(writes(h)).toEqual([])
  })
  it('foreign organization gets no result and no permission or result hydration', async () => {
    const h = harness()
    expect(await h.host.readPunchDetailPreviewJob({ jobId, scope: { ...h.fixture.scope, orgId: '10000000-0000-4000-8000-000000000009' } }, h.authorize)).toBeNull()
    expect(h.authorize).not.toHaveBeenCalled()
    expect(h.calls.some(c => c.sql.includes('FOR UPDATE'))).toBe(false)
  })
  it.each(['punch-detail-admin', 'punch-detail-employee'])('rejects inactive %s before full result hydration', async absentUser => {
    const h = harness({ absentUser })
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.authorize).not.toHaveBeenCalled()
    expect(h.calls.some(c => c.sql.includes('FOR UPDATE'))).toBe(false)
    expect(writes(h)).toEqual([])
  })
  it('refuses revoked namespace before target callback and completion', async () => {
    const h = harness({ admitted: false })
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.authorize).not.toHaveBeenCalled()
    expect(writes(h)).toEqual([])
  })
  it('refuses unavailable namespace even with optional RBAC degradation configured', async () => {
    vi.stubEnv('RBAC_OPTIONAL', '1')
    const h = harness({ namespaceError: Object.assign(new Error('missing table'), { code: '42P01' }) })
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.authorize).not.toHaveBeenCalled()
    expect(writes(h)).toEqual([])
  })
  it('refuses revoked scoped target access before full result hydration', async () => {
    const h = harness({ targetAllowed: false })
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.calls.some(c => c.sql.includes('FOR UPDATE'))).toBe(false)
    expect(writes(h)).toEqual([])
  })
  it('refuses suspended rollout without result or metadata writes', async () => {
    const h = harness({ state: 'suspended' })
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.authorize).not.toHaveBeenCalled()
    expect(writes(h)).toEqual([])
  })
  it('rejects changed independent identity after acquiring the row lock', async () => {
    const h = harness(); h.locked.punch_preview_token_subject_user_id = 'changed'
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREVIEW_IDENTITY_MISMATCH')
    expect(writes(h)).toEqual([])
  })
  it('rejects a target command different from the command used for authorization', async () => {
    const h = harness(); h.seed.envelope = { ...h.record.envelope, idempotencyKey: 'changed' }
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREVIEW_IDENTITY_MISMATCH')
    expect(writes(h)).toEqual([])
  })
  it('rejects corrupt frozen result before metadata completion', async () => {
    const h = harness(); h.locked.snapshot = { ...h.record, previewLimit: 999 }
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREVIEW_DIGEST_MISMATCH')
    expect(writes(h)).toEqual([])
  })
  it('rolls back a failed completion and closes the retained facade', async () => {
    const failure = new Error('COMPLETION_FAILED'); const h = harness({ updateError: failure })
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toBe(failure)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    const count = h.calls.length
    await expect(h.retained()?.query('SELECT current_target_permission')).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREVIEW_CLOSED')
    expect(h.calls).toHaveLength(count)
  })
  it('discards an uncertain completion commit through the original transaction owner', async () => {
    const failure = Object.assign(new Error('COMMIT_LOST'), { code: '08006' }); const h = harness({ commitError: failure })
    await expect(h.host.processPunchDetailPreviewJob({ jobId }, h.authorize)).rejects.toBe(failure)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(failure)
  })
})
