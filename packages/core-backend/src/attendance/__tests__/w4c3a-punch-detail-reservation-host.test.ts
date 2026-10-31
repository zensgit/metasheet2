import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttendanceLegacyPlanReservationHostV1 } from '../w4c3a-legacy-plan-reservation-host'
import { buildAttendancePunchDetailPreparedPlanV1 } from '../w4c3a-punch-detail-prepare'
import { punchDetailPreparationFixture } from './helpers/punch-detail-plan-fixture'

const reserve = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ kind: 'created', jobId: 'reserved-job' })))
vi.mock('../w4c3a-legacy-plan-enqueue', () => ({ reserveAttendanceLegacyImportPlanJobV1: reserve }))
const previous = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
afterEach(() => {
  reserve.mockClear()
  if (previous === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = previous
})

function harness(options: { absentUser?: string; absentMember?: string; selfSubject?: boolean } = {}) {
  const base = punchDetailPreparationFixture()
  const fixture = options.selfSubject ? { ...base, scope: { ...base.scope,
    actorId: base.envelope.__punchDetailInput.userId, tokenSubjectUserId: base.envelope.__punchDetailInput.userId } } : base
  const input = buildAttendancePunchDetailPreparedPlanV1(fixture).plan
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = input.orgId
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  let transaction = false
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params })
      if (sql === 'SAVEPOINT w4c5_idle_probe' && !transaction) throw Object.assign(new Error('idle'), { code: '25P01' })
      if (sql.startsWith('BEGIN')) transaction = true
      else if (sql === 'COMMIT' || sql === 'ROLLBACK') transaction = false
      else if (sql.includes('FROM attendance_calculation_rollout_state')) {
        return { rows: [{ state: 'authoritative', scope: 'synthetic_staging' }] }
      } else if (sql.includes('FROM users')) {
        return { rows: params[0] === options.absentUser ? [] : [{ present: 1 }] }
      } else if (sql.includes('FROM user_orgs')) {
        expect(params[1]).toBe(input.orgId)
        return { rows: params[0] === options.absentMember ? [] : [{ present: 1 }] }
      } else if (!sql.startsWith('SELECT set_config') && !sql.startsWith('SELECT pg_advisory')) throw new Error('UNEXPECTED_TEST_SQL')
      return { rows: [] }
    },
  }
  const release = vi.fn()
  const host = createAttendanceLegacyPlanReservationHostV1({ acquireConnection: async () => ({ client, release }) })
  return { input, calls, release, host }
}

describe('named punch-detail reservation boundary', () => {
  it.each([
    { absentUser: 'punch-detail-employee' },
    { absentMember: 'punch-detail-employee' },
    { absentMember: 'punch-detail-employee', selfSubject: true },
  ])('rechecks the subject before the existing reservation writer %j', async (options) => {
    const h = harness(options)
    await expect(h.host.reserveLegacyImportPlanV1(h.input)).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(reserve).not.toHaveBeenCalled()
    expect(h.calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })
  it('takes the timezone prefix before rollout and membership reads', async () => {
    const h = harness()
    await h.host.reserveLegacyImportPlanV1(h.input)
    const sql = h.calls.map(c => c.sql)
    const prefix = sql.findIndex(s => s.includes('hashtextextended'))
    const rollout = sql.findIndex(s => s.includes('pg_advisory_xact_lock_shared'))
    const member = sql.findIndex(s => s.includes('FROM user_orgs'))
    expect(prefix).toBeGreaterThan(sql.findIndex(s => s.startsWith('BEGIN')))
    expect(rollout).toBeGreaterThan(prefix)
    expect(member).toBeGreaterThan(rollout)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(sql.at(-1)).toBe('COMMIT')
  })
  it('passes the full four-event plan to the original reservation writer for an active subject', async () => {
    const h = harness()
    await expect(h.host.reserveLegacyImportPlanV1(h.input)).resolves.toEqual({ kind: 'created', jobId: 'reserved-job' })
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(reserve.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      items: h.input.items, recordWrites: h.input.recordWrites, groupEffects: [],
    }))
    expect(h.input.items).toHaveLength(4)
    expect(h.calls.at(-1)?.sql).toBe('COMMIT')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(undefined)
  })
})
