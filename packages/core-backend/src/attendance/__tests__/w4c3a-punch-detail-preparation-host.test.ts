import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAttendancePunchDetailPreparationHostV1,
  type AttendancePunchDetailPreparationReadClientV1,
} from '../w4c3a-punch-detail-preparation-host'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

const previous = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
afterEach(() => {
  if (previous === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = previous
})

function harness(options: {
  state?: string | null; scope?: string; absentUser?: string; absentMember?: string; commitError?: Error
} = {}) {
  const fixture = punchDetailPreparationFixture()
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.scope.orgId
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  let transaction = false
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params })
      if (sql === 'SAVEPOINT w4c5_idle_probe' && !transaction) {
        throw Object.assign(new Error('idle'), { code: '25P01' })
      }
      if (sql.startsWith('BEGIN')) transaction = true
      else if (sql === 'COMMIT') {
        if (options.commitError) throw options.commitError
        transaction = false
      } else if (sql === 'ROLLBACK') transaction = false
      else if (sql.includes('FROM attendance_calculation_rollout_state')) {
        return { rows: options.state === null ? [] : [{ state: options.state ?? 'authoritative', scope: options.scope ?? 'synthetic_staging' }] }
      } else if (sql.includes('FROM users')) {
        return { rows: params[0] === options.absentUser ? [] : [{ present: 1 }] }
      } else if (sql.includes('FROM user_orgs')) {
        expect(params[1]).toBe(fixture.scope.orgId)
        return { rows: params[0] === options.absentMember ? [] : [{ present: 1 }] }
      } else if (sql === 'SELECT frozen_target') return { rows: [{ fixture: true }] }
      else if (!sql.startsWith('SELECT set_config') && !sql.startsWith('SELECT pg_advisory') && !sql.startsWith('BEGIN')) {
        throw new Error('UNEXPECTED_TEST_SQL')
      }
      return { rows: [] }
    },
  }
  const release = vi.fn()
  const acquireConnection = vi.fn(async () => ({ client, release }))
  const host = createAttendancePunchDetailPreparationHostV1({ acquireConnection })
  const resolve = vi.fn(async (trx: AttendancePunchDetailPreparationReadClientV1, posture: { referenceSegments: true }) => {
    expect(posture).toEqual({ referenceSegments: true })
    expect(trx.__w4CanonicalTrx).toBe(true)
    expect(await trx.query('SELECT frozen_target')).toEqual([{ fixture: true }])
    return { attribution: fixture.attribution, context: fixture.context, policySourceProof: fixture.policySourceProof }
  })
  return { fixture, calls, release, acquireConnection, host, resolve }
}

describe('punch-detail preparation transaction', () => {
  it.each(['shadow', 'authoritative'])('locks, authorizes both identities and preserves all events in %s', async (state) => {
    const h = harness({ state })
    const result = await h.host.preparePunchDetailImport(h.fixture, h.resolve)
    expect(result.calculation.dailyProjection?.workedMinutes).toBe(165)
    expect(result.plan.items.flatMap((item) => item.rawEvidence.punches)).toEqual(h.fixture.envelope.__punchDetailInput.punches)
    expect(h.calls.filter((c) => c.sql.includes('FROM users')).map((c) => c.params[0]))
      .toEqual([h.fixture.scope.actorId, h.fixture.envelope.__punchDetailInput.userId])
    expect(h.calls.filter((c) => c.sql.includes('FROM user_orgs')).map((c) => c.params[0]))
      .toEqual([h.fixture.envelope.__punchDetailInput.userId])
    const sql = h.calls.map((c) => c.sql)
    const timezone = sql.findIndex((s) => s.includes('hashtextextended'))
    const rollout = sql.findIndex((s) => s.includes('pg_advisory_xact_lock_shared'))
    const persisted = sql.findIndex((s) => s.includes('FROM attendance_calculation_rollout_state'))
    expect(timezone).toBeGreaterThan(sql.findIndex((s) => s.startsWith('BEGIN')))
    expect(rollout).toBeGreaterThan(timezone)
    expect(persisted).toBeGreaterThan(rollout)
    expect(sql.indexOf('SELECT frozen_target')).toBeGreaterThan(persisted)
    expect(sql.at(-1)).toBe('COMMIT')
    expect(sql.some((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s))).toBe(false)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })

  it.each(['', '*', 'another-org'])('refuses non-exact allowlist %j before frozen source reads', async (allowlist) => {
    const h = harness()
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = allowlist
    await expect(h.host.preparePunchDetailImport(h.fixture, h.resolve)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.resolve).not.toHaveBeenCalled()
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })

  it.each(['legacy', 'suspended', null])('refuses persisted %s before frozen source reads', async (state) => {
    const h = harness({ state })
    await expect(h.host.preparePunchDetailImport(h.fixture, h.resolve)).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it.each([{ state: 'unknown' }, { scope: 'production' }])('retains invalid persisted posture refusal %j', async (options) => {
    const h = harness(options)
    await expect(h.host.preparePunchDetailImport(h.fixture, h.resolve)).rejects.toThrow(/W4C0_ROLLOUT_(STATE|SCOPE)_INVALID/)
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it.each(['punch-detail-admin', 'punch-detail-employee'])('refuses inactive %s before frozen source reads', async (absentUser) => {
    const h = harness({ absentUser })
    await expect(h.host.preparePunchDetailImport(h.fixture, h.resolve)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('does not waive imported-subject membership for a platform administrator', async () => {
    const h = harness({ absentMember: 'punch-detail-employee' })
    await expect(h.host.preparePunchDetailImport(h.fixture, h.resolve)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('self-subject platform admin without membership is refused before source reads', async () => {
    const h = harness({ absentMember: 'punch-detail-employee' })
    const input = { ...h.fixture, scope: { ...h.fixture.scope,
      actorId: 'punch-detail-employee', tokenSubjectUserId: 'punch-detail-employee' } }
    await expect(h.host.preparePunchDetailImport(input, h.resolve)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.resolve).not.toHaveBeenCalled()
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })

  it('self-subject platform admin with membership keeps the complete physical result', async () => {
    const h = harness()
    const input = { ...h.fixture, scope: { ...h.fixture.scope,
      actorId: 'punch-detail-employee', tokenSubjectUserId: 'punch-detail-employee' } }
    const result = await h.host.preparePunchDetailImport(input, h.resolve)
    expect(result.calculation.dailyProjection?.workedMinutes).toBe(165)
    expect(h.resolve).toHaveBeenCalledTimes(1)
    expect(h.calls.at(-1)?.sql).toBe('COMMIT')
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('requires the non-platform import actor to remain an organization member', async () => {
    const h = harness({ absentMember: 'punch-detail-admin' })
    const input = { ...h.fixture, scope: { ...h.fixture.scope, actorPosture: 'attendance_admin' as const } }
    await expect(h.host.preparePunchDetailImport(input, h.resolve)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('rolls back source resolution failure and closes the callback facade', async () => {
    const h = harness()
    let retained: AttendancePunchDetailPreparationReadClientV1 | undefined
    const failure = new Error('FROZEN_SOURCE_UNAVAILABLE')
    await expect(h.host.preparePunchDetailImport(h.fixture, async (trx) => { retained = trx; throw failure })).rejects.toBe(failure)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    const count = h.calls.length
    await expect(retained?.query('SELECT frozen_target')).rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_PREPARATION_CLOSED')
    expect(h.calls).toHaveLength(count)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })

  it('discards an uncertain commit through the original transaction runner', async () => {
    const failure = Object.assign(new Error('COMMIT_CONNECTION_LOST'), { code: '08006' })
    const h = harness({ commitError: failure })
    await expect(h.host.preparePunchDetailImport(h.fixture, h.resolve)).rejects.toBe(failure)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(failure)
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('rejects a missing named command before acquiring a connection', async () => {
    const h = harness()
    const { __punchDetailInput: _input, ...daily } = h.fixture.envelope
    await expect(h.host.preparePunchDetailImport({ ...h.fixture, envelope: daily as typeof h.fixture.envelope }, h.resolve))
      .rejects.toThrow('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    expect(h.acquireConnection).not.toHaveBeenCalled()
  })
})
