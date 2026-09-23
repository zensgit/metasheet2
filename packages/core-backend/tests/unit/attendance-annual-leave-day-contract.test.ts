import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__annualLeaveDayContractForTests as {
  computeAnnualLeaveStandardDayMinutes: (input: {
    requestMinutes: number
    defaultMinutesPerDay: number
    standardDayMinutes: number
  }) => number
  annualLeaveEmployeeDayBasis: (leaveTypeCode: string, standardDayMinutes: unknown) => {
    minutesPerDay: number
    source: string
  } | null
  assertAnnualLeaveRequestSettleable: (client: {
    query: (sql: string, params: unknown[]) => Promise<Array<{ available: number }>>
  }, input: {
    orgId: string
    userId: string | null
    requestMinutes: number
    defaultMinutesPerDay: number
    standardDayMinutes: number
  }) => Promise<number>
}

function httpCode(error: unknown): string {
  return String((error as { code?: string } | null)?.code ?? '')
}

describe('annual leave day contract (#5969)', () => {
  it('exposes the live standard day only for annual leave', () => {
    expect(helpers.annualLeaveEmployeeDayBasis('annual', 450)).toEqual({
      minutesPerDay: 450,
      source: 'annualLeavePolicy.standardDayMinutes',
    })
    expect(helpers.annualLeaveEmployeeDayBasis('annual', 480)).toEqual({
      minutesPerDay: 480,
      source: 'annualLeavePolicy.standardDayMinutes',
    })
    expect(helpers.annualLeaveEmployeeDayBasis('comp_time', 480)).toBeNull()
    expect(helpers.annualLeaveEmployeeDayBasis('annual', 0)).toBeNull()
    expect(helpers.annualLeaveEmployeeDayBasis('annual', 450.5)).toBeNull()
  })

  it('keeps the integer standard-day formula, including a 540-minute wall clock against a 480-minute type day', () => {
    expect(helpers.computeAnnualLeaveStandardDayMinutes({
      requestMinutes: 600,
      defaultMinutesPerDay: 600,
      standardDayMinutes: 480,
    })).toBe(480)
    expect(helpers.computeAnnualLeaveStandardDayMinutes({
      requestMinutes: 240,
      defaultMinutesPerDay: 480,
      standardDayMinutes: 450,
    })).toBe(225)
    expect(() => helpers.computeAnnualLeaveStandardDayMinutes({
      requestMinutes: 540,
      defaultMinutesPerDay: 480,
      standardDayMinutes: 480,
    })).toThrowError(expect.objectContaining({ code: 'ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED', status: 422 }))
    try {
      helpers.computeAnnualLeaveStandardDayMinutes({
        requestMinutes: 7,
        defaultMinutesPerDay: 600,
        standardDayMinutes: 480,
      })
      throw new Error('expected non-whole deduction to throw')
    } catch (error) {
      expect(httpCode(error)).toBe('ANNUAL_LEAVE_DEDUCTION_NOT_WHOLE')
    }
  })

  it('rejects an unsettleable annual request before any balance write', async () => {
    const calls: string[] = []
    const client = {
      query: async (sql: string) => {
        calls.push(sql)
        return [{ available: 200 }]
      },
    }
    await expect(helpers.assertAnnualLeaveRequestSettleable(client, {
      orgId: 'default',
      userId: 'user-1',
      requestMinutes: 480,
      defaultMinutesPerDay: 480,
      standardDayMinutes: 450,
    })).rejects.toMatchObject({ code: 'ANNUAL_LEAVE_BALANCE_INSUFFICIENT', status: 422 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('SUM(remaining_minutes)')
    expect(calls[0]).not.toMatch(/UPDATE|INSERT/i)

    const quiet = { query: async () => [{ available: 9999 }] }
    await expect(helpers.assertAnnualLeaveRequestSettleable(quiet, {
      orgId: 'default',
      userId: 'user-1',
      requestMinutes: 540,
      defaultMinutesPerDay: 480,
      standardDayMinutes: 480,
    })).rejects.toMatchObject({ code: 'ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED' })

    await expect(helpers.assertAnnualLeaveRequestSettleable(quiet, {
      orgId: 'default',
      userId: 'user-1',
      requestMinutes: 480,
      defaultMinutesPerDay: 480,
      standardDayMinutes: 450,
    })).resolves.toBe(450)
  })
})