import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttendancePunchDetailReplayHostV1 } from '../w4c3a-punch-detail-replay-host'
import { fingerprintAttendancePunchDetailCommandV1 } from '../w4c3a-punch-detail-command'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

const previous = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
afterEach(() => {
  if (previous === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = previous
})
function harness(options: {
  state?: string | null; absentUser?: string; absentMember?: string; selfSubject?: boolean
  existing?: boolean; fingerprint?: string | null; commitError?: Error
} = {}) {
  const fixture = punchDetailPreparationFixture()
  const scope = { ...fixture.scope,
    actorId: options.selfSubject ? fixture.envelope.__punchDetailInput.userId : fixture.scope.actorId,
    tokenSubjectUserId: options.selfSubject ? fixture.envelope.__punchDetailInput.userId : fixture.scope.tokenSubjectUserId }
  const input = { scope, envelope: { ...fixture.envelope, idempotencyKey: 'replay-command' } }
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = scope.orgId
  const fingerprint = fingerprintAttendancePunchDetailCommandV1(scope, input.envelope)
  const meta = { engine: 'standard', recordUpsertStrategy: 'values', skippedCount: 0,
    ...(options.fingerprint === null ? {} : { punchDetailRequestFingerprint: options.fingerprint ?? fingerprint }) }
  const stored = { id: fixture.batchId, row_count: 4, meta }
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  let transaction = false
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params })
      if (sql === 'SAVEPOINT w4c5_idle_probe' && !transaction) throw Object.assign(new Error('idle'), { code: '25P01' })
      if (sql.startsWith('BEGIN')) transaction = true
      else if (sql === 'COMMIT') {
        if (options.commitError) throw options.commitError
        transaction = false
      } else if (sql === 'ROLLBACK') transaction = false
      else if (sql.includes('FROM attendance_calculation_rollout_state')) {
        return { rows: options.state === null ? [] : [{ state: options.state ?? 'authoritative', scope: 'synthetic_staging' }] }
      } else if (sql.includes('FROM users')) return { rows: params[0] === options.absentUser ? [] : [{ present: 1 }] }
      else if (sql.includes('FROM user_orgs')) {
        expect(params[1]).toBe(scope.orgId)
        return { rows: params[0] === options.absentMember ? [] : [{ present: 1 }] }
      } else if (sql.includes('FROM attendance_import_batches')) {
        expect(params).toEqual([scope.orgId, input.envelope.idempotencyKey])
        expect(sql).toContain("status = 'committed'")
        expect(sql).toContain('FOR UPDATE')
        return { rows: options.existing === false ? [] : [stored] }
      } else if (!sql.startsWith('SELECT set_config') && !sql.startsWith('SELECT pg_advisory')) {
        throw new Error('UNEXPECTED_REPLAY_SQL')
      }
      return { rows: [] }
    },
  }
  const release = vi.fn()
  const acquireConnection = vi.fn(async () => ({ client, release }))
  const host = createAttendancePunchDetailReplayHostV1({ acquireConnection })
  return { input, calls, stored, release, acquireConnection, host }
}
describe('punch-detail committed replay admission', () => {
  it.each(['shadow', 'authoritative'])('checks current admission and lock order before returning stored %s result', async (state) => {
    const h = harness({ state })
    expect(await h.host.readPunchDetailImportReplay(h.input)).toEqual({
      batchId: h.stored.id, imported: 4, skipped: 0, engine: 'standard', recordUpsertStrategy: 'values', meta: h.stored.meta,
    })
    const sql = h.calls.map((c) => c.sql)
    const prefix = sql.findIndex((s) => s.includes('hashtextextended'))
    const rollout = sql.findIndex((s) => s.includes('pg_advisory_xact_lock_shared'))
    const posture = sql.findIndex((s) => s.includes('FROM attendance_calculation_rollout_state'))
    const membership = sql.findIndex((s) => s.includes('FROM user_orgs'))
    const compatibility = sql.findIndex((s) => s === 'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))')
    const operation = sql.findIndex((s) => s === 'SELECT pg_advisory_xact_lock($1::bigint)')
    const batch = sql.findIndex((s) => s.includes('FROM attendance_import_batches'))
    expect(prefix).toBeGreaterThan(sql.findIndex((s) => s.startsWith('BEGIN')))
    expect(rollout).toBeGreaterThan(prefix)
    expect(posture).toBeGreaterThan(rollout)
    expect(membership).toBeGreaterThan(posture)
    expect(compatibility).toBeGreaterThan(membership)
    expect(operation).toBeGreaterThan(compatibility)
    expect(batch).toBeGreaterThan(operation)
    expect(sql.some((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s))).toBe(false)
    expect(sql.at(-1)).toBe('COMMIT')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })
  it.each(['legacy', 'suspended', null])('refuses current %s state before reading a stored result', async (state) => {
    const h = harness({ state })
    await expect(h.host.readPunchDetailImportReplay(h.input)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.calls.some((c) => c.sql.includes('FROM attendance_import_batches'))).toBe(false)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
  })
  it.each(['', '*', 'another-org'])('refuses current allowlist %j before reading a stored result', async (allowlist) => {
    const h = harness(); process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = allowlist
    await expect(h.host.readPunchDetailImportReplay(h.input)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.calls.some((c) => c.sql.includes('FROM attendance_import_batches'))).toBe(false)
  })
  it.each([
    { absentUser: 'punch-detail-admin' }, { absentUser: 'punch-detail-employee' },
    { absentMember: 'punch-detail-employee' }, { absentMember: 'punch-detail-employee', selfSubject: true },
  ])('refuses current inactive identity or subject membership %j before batch lookup', async (options) => {
    const h = harness(options)
    await expect(h.host.readPunchDetailImportReplay(h.input)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.calls.some((c) => c.sql.includes('FROM attendance_import_batches'))).toBe(false)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(h.release).toHaveBeenCalledTimes(1)
  })
  it('requires a non-platform actor to remain an organization member', async () => {
    const h = harness({ absentMember: 'punch-detail-admin' })
    await expect(h.host.readPunchDetailImportReplay({ ...h.input, scope: { ...h.input.scope, actorPosture: 'attendance_admin' } }))
      .rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.calls.some((c) => c.sql.includes('FROM attendance_import_batches'))).toBe(false)
  })
  it('accepts a platform self-subject only with active membership', async () => {
    const h = harness({ selfSubject: true })
    expect(await h.host.readPunchDetailImportReplay(h.input)).toMatchObject({ imported: 4, meta: h.stored.meta })
    expect(h.calls.filter((c) => c.sql.includes('FROM user_orgs'))).toHaveLength(1)
  })
  it.each([null, 'other-command'])('refuses daily or mismatched fingerprint %s', async (fingerprint) => {
    const h = harness({ fingerprint })
    await expect(h.host.readPunchDetailImportReplay(h.input)).rejects.toThrow('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
  })
  it('returns a guarded miss without any effect SQL', async () => {
    const h = harness({ existing: false })
    expect(await h.host.readPunchDetailImportReplay(h.input)).toBeNull()
    expect(h.calls.at(-1)?.sql).toBe('COMMIT')
  })
  it('does not acquire a connection without an idempotency key', async () => {
    const h = harness()
    expect(await h.host.readPunchDetailImportReplay({ ...h.input, envelope: { ...h.input.envelope, idempotencyKey: null } })).toBeNull()
    expect(h.acquireConnection).not.toHaveBeenCalled()
  })
  it('refuses a daily envelope before acquiring a connection', async () => {
    const h = harness()
    const { __punchDetailInput: _input, ...daily } = h.input.envelope
    await expect(h.host.readPunchDetailImportReplay({ ...h.input, envelope: daily as typeof h.input.envelope }))
      .rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    expect(h.acquireConnection).not.toHaveBeenCalled()
  })
  it('discards an uncertain completion through the existing transaction owner', async () => {
    const failure = Object.assign(new Error('COMMIT_CONNECTION_LOST'), { code: '08006' })
    const h = harness({ commitError: failure })
    await expect(h.host.readPunchDetailImportReplay(h.input)).rejects.toBe(failure)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(failure)
  })
})
