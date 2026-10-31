import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AttendanceCalc14SourceWriteError,
  assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1,
  attendanceCalc14SourceWriteErrorV1,
  prepareAttendanceCalc14SourceWriteContextV1,
} from '../../src/attendance/attendance-calc14-source-write-context'

const ORG = '11111111-1111-4111-8111-111111111111'
const ACTOR = 'core-writer-actor'

function sourceTransaction({
  state = 'group_shadow', timezone = 'Asia/Taipei',
  context = {} as Record<string, unknown>,
  ruleCount = 1, flushError = null as unknown,
} = {}) {
  const query = vi.fn(async (statement: string, _params?: unknown[]) => {
    if (statement.includes('SELECT state, scope')) {
      return { rows: [{ state, scope: 'synthetic_staging' }] }
    }
    if (statement.includes('SELECT timezone')) {
      return { rows: Array.from({ length: ruleCount }, () => ({ timezone })) }
    }
    if (statement.includes('current_setting')) return { rows: [context] }
    if (statement.startsWith('SET CONSTRAINTS') && statement.endsWith('IMMEDIATE') && flushError) {
      throw flushError
    }
    return { rows: [] }
  })
  return { query }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T16:30:00Z'))
  vi.stubEnv('ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED', ORG)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('CALC14 core source date validator', () => {
  it.each([null, '', '2026-02-29', '2026-04-31', '0000-01-01', '2026-1-01', ['2026-10-31'], 20261031])(
    'rejects invalid date %j with a values-free error', (value) => {
      expect(() => assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1(value, '2026-10-31'))
        .toThrowError(expect.objectContaining({
          status: 422, code: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID',
          message: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID',
        }))
    },
  )

  it('separates missing, historical and valid ordinary dates', () => {
    expect(() => assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1(undefined, '2026-10-31'))
      .toThrowError(expect.objectContaining({ status: 422, code: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED' }))
    expect(() => assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1('2026-10-30', '2026-10-31'))
      .toThrowError(expect.objectContaining({ status: 403, code: 'ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED' }))
    expect(assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1('2026-10-31', '2026-10-31')).toBe('2026-10-31')
    expect(assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1('2028-02-29', '2026-10-31')).toBe('2028-02-29')
  })
})

describe('CALC14 same-transaction core context', () => {
  it.each(['group_shadow', 'group_eligible', 'group_authoritative', 'suspended'])(
    'consumes explicit date on actual transaction in %s', async (state) => {
      const trx = sourceTransaction({ state })
      const flush = await prepareAttendanceCalc14SourceWriteContextV1(trx, {
        orgId: ORG, actorId: ACTOR, businessEffectiveDate: '2026-11-01',
      })
      const set = trx.query.mock.calls.find(([sql]) => sql.includes("set_config('metasheet.calc14_"))
      expect(set?.[1]).toEqual([ORG, '2026-11-01', ACTOR])
      expect(set?.[0]).toContain("set_config('metasheet.calc14_date_required','true',true)")
      expect(set?.[0]).toContain("set_config('metasheet.calc14_business_effective_date',$2,true)")
      expect(trx.query.mock.calls.some(([sql]) => sql.startsWith('SET CONSTRAINTS'))).toBe(false)
      await flush()
      expect(trx.query.mock.calls.slice(-2).map(([sql]) => sql)).toEqual([
        'SET CONSTRAINTS calc14_capture_attendance_group_members, calc14_capture_attendance_shift_assignments, calc14_capture_attendance_calculation_group_memberships IMMEDIATE',
        'SET CONSTRAINTS calc14_capture_attendance_group_members, calc14_capture_attendance_shift_assignments, calc14_capture_attendance_calculation_group_memberships DEFERRED',
      ])
    },
  )

  it.each(['off', 'group_shadow'])('does no context/history SQL for effective OFF (%s)', async (state) => {
    vi.stubEnv('ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED', '')
    const trx = sourceTransaction({ state })
    const flush = await prepareAttendanceCalc14SourceWriteContextV1(trx, {
      orgId: ORG, actorId: ACTOR, businessEffectiveDate: 'invalid-and-ignored',
    })
    await flush()
    expect(trx.query.mock.calls.some(([sql]) => /set_config\('metasheet\.calc14_|SET CONSTRAINTS|SELECT timezone/.test(sql))).toBe(false)
  })

  it('keeps suspension active even with its existing allowlist absent', async () => {
    vi.stubEnv('ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED', '')
    const trx = sourceTransaction({ state: 'suspended' })
    await prepareAttendanceCalc14SourceWriteContextV1(trx, {
      orgId: ORG, actorId: ACTOR, businessEffectiveDate: '2026-10-31',
    })
    expect(trx.query.mock.calls.find(([sql]) => sql.includes("set_config('metasheet.calc14_"))?.[1])
      .toEqual([ORG, '2026-10-31', ACTOR])
  })

  it('preserves non-rollout legacy org behavior without querying posture/history', async () => {
    const trx = sourceTransaction()
    await (await prepareAttendanceCalc14SourceWriteContextV1(trx, {
      orgId: 'legacy-org', actorId: ACTOR, businessEffectiveDate: null,
    }))()
    expect(trx.query).not.toHaveBeenCalled()
  })

  it('uses trusted org timezone today, not UTC or a request today', async () => {
    const trx = sourceTransaction()
    await expect(prepareAttendanceCalc14SourceWriteContextV1(trx, {
      orgId: ORG, actorId: ACTOR, businessEffectiveDate: '2026-10-30',
    })).rejects.toMatchObject({ status: 403, code: 'ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED' })
    expect(trx.query.mock.calls.some(([sql]) => sql.includes("set_config('metasheet.calc14_"))).toBe(false)
  })

  it.each([{ timezone: 'Invalid/Zone' }, { ruleCount: 0 }, { ruleCount: 2 }])(
    'refuses untrusted or ambiguous org business today %j', async (options) => {
      const trx = sourceTransaction(options)
      await expect(prepareAttendanceCalc14SourceWriteContextV1(trx, {
        orgId: ORG, actorId: ACTOR, businessEffectiveDate: '2026-10-31',
      })).rejects.toMatchObject({ status: 422, code: 'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE' })
    },
  )

  it('lets semantic capture decide a missing date, and maps its refusal on flush', async () => {
    const trx = sourceTransaction({
      flushError: { code: '23514', message: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED' },
    })
    const flush = await prepareAttendanceCalc14SourceWriteContextV1(trx, { orgId: ORG, actorId: ACTOR })
    expect(trx.query.mock.calls.find(([sql]) => sql.includes("set_config('metasheet.calc14_"))?.[1]).toEqual([ORG, '', ACTOR])
    await expect(flush()).rejects.toMatchObject({ status: 422, code: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED' })
  })

  it.each([{ org_id: 'foreign-org' }, { actor_id: 'foreign-actor' }])(
    'refuses incompatible transaction context %j before replacing it', async (context) => {
      const trx = sourceTransaction({ context })
      await expect(prepareAttendanceCalc14SourceWriteContextV1(trx, {
        orgId: ORG, actorId: ACTOR, businessEffectiveDate: '2026-10-31',
      })).rejects.toMatchObject({ status: 403, code: 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID' })
      expect(trx.query.mock.calls.some(([sql]) => sql.includes("set_config('metasheet.calc14_"))).toBe(false)
    },
  )

  it('refuses overwriting a previously bound transaction date', async () => {
    const trx = sourceTransaction({ context: { org_id: ORG, effective_date: '2026-11-01' } })
    await expect(prepareAttendanceCalc14SourceWriteContextV1(trx, {
      orgId: ORG, actorId: ACTOR, businessEffectiveDate: '2026-10-31',
    })).rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT' })
  })

  it('does not hide a corrupt W7 posture as OFF', async () => {
    const trx = sourceTransaction({ state: 'unknown' })
    await expect(prepareAttendanceCalc14SourceWriteContextV1(trx, { orgId: ORG, actorId: ACTOR }))
      .rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_STATE_INVALID' })
  })

  it('maps only exact source constraint errors; never echoes arbitrary driver text', () => {
    expect(attendanceCalc14SourceWriteErrorV1({ code: '23514', message: 'private-driver-marker' })).toBeNull()
    expect(attendanceCalc14SourceWriteErrorV1({ code: '23505', message: 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT' })).toBeNull()
    expect(attendanceCalc14SourceWriteErrorV1({ code: '23514', message: 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT' }))
      .toEqual(new AttendanceCalc14SourceWriteError(409, 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT'))
  })
})
