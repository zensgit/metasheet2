import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceApprovalExemptionForTests
const guard = require('../../../../plugins/plugin-attendance/lib/leave-offset-partial-absence-guard.cjs')

type QueryLog = string[]

function scriptedTrx(settings: Record<string, unknown>, balanceRows: Array<Record<string, unknown>> = []) {
  const queries: QueryLog = []
  return {
    queries,
    async query(sql: string) {
      const text = String(sql).replace(/\s+/g, ' ').trim()
      queries.push(text)
      if (text.includes('SELECT value FROM system_configs')) {
        return [{ value: JSON.stringify(settings) }]
      }
      if (text.includes('FROM attendance_leave_balances') && text.includes('SELECT')) {
        return balanceRows
      }
      throw new Error(`unexpected sql: ${text.slice(0, 220)}`)
    },
  }
}

function effects(trx: { query: (sql: string) => Promise<unknown> }, metadata: Record<string, unknown>, requestType = 'leave') {
  return helpers.applyExemptedLeaveOrOvertimeEffects(trx, {
    orgId: 'org-1',
    userId: 'user-1',
    requestId: 'req-1',
    requestType,
    workDate: '2026-09-20',
    metadata,
    referenceSegments: false,
    resolvedAt: new Date('2026-09-20T01:00:00.000Z'),
  })
}

function wroteBalanceOrAttendance(queries: QueryLog) {
  return queries.some((sql) =>
    /UPDATE attendance_leave_balances|INSERT INTO attendance_leave_balance_events|INSERT INTO attendance_events|attendance_records/i.test(sql),
  )
}

describe('approval-exempt leave balance rejection (#5967 + #6009)', () => {
  beforeEach(() => {
    attendancePlugin.resetAttendanceSettingsCacheForTests()
  })

  it('rejects partial_unpaid_absence before any balance read when the pool cannot cover the request', async () => {
    const trx = scriptedTrx({
      leaveBalanceDeductionPolicy: {
        enabled: true,
        rules: [{
          requestLeaveType: 'personal_leave',
          deductFrom: ['comp_time'],
          insufficient: 'partial_unpaid_absence',
        }],
      },
    }, [{ id: 'lot-short', remaining_minutes: 10, status: 'active' }])

    await expect(effects(trx, {
      minutes: 60,
      leaveType: { code: 'personal_leave' },
    })).rejects.toMatchObject({
      status: 422,
      code: guard.LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE_CODE,
    })

    expect(trx.queries.some((sql) => sql.includes('attendance_leave_balances'))).toBe(false)
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })

  it('rejects partial_unpaid_absence even when the pool could cover the request, with no projection', async () => {
    const trx = scriptedTrx({
      leaveBalanceDeductionPolicy: {
        enabled: true,
        rules: [{
          requestLeaveType: 'personal_leave',
          deductFrom: ['comp_time'],
          insufficient: 'partial_unpaid_absence',
        }],
      },
    }, [{ id: 'lot-full', remaining_minutes: 500, status: 'active' }])

    await expect(effects(trx, {
      minutes: 60,
      leaveType: { code: 'personal_leave' },
    })).rejects.toMatchObject({
      status: 422,
      code: 'LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE',
    })
    expect(trx.queries.some((sql) => sql.includes('attendance_leave_balances'))).toBe(false)
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })

  it('rejects a block-mode offset when the balance is short and does not project the leave', async () => {
    const trx = scriptedTrx({
      leaveBalanceDeductionPolicy: {
        enabled: true,
        rules: [{
          requestLeaveType: 'personal_leave',
          deductFrom: ['comp_time'],
          insufficient: 'block',
        }],
      },
    }, [{ id: 'lot-short', remaining_minutes: 10, status: 'active' }])

    await expect(effects(trx, {
      minutes: 60,
      leaveType: { code: 'personal_leave' },
    })).rejects.toMatchObject({
      status: 422,
      code: 'LEAVE_OFFSET_BALANCE_INSUFFICIENT',
    })
    expect(trx.queries.some((sql) => sql.includes('FROM attendance_leave_balances'))).toBe(true)
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })

  it('rejects exempt comp-time leave when the balance is short and writes no attendance row', async () => {
    const trx = scriptedTrx({}, [{ id: 'lot-short', remaining_minutes: 10, status: 'active' }])

    await expect(effects(trx, {
      minutes: 60,
      leaveType: { code: 'comp_time' },
    })).rejects.toMatchObject({
      status: 422,
      code: 'COMP_TIME_BALANCE_INSUFFICIENT',
    })
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })

  it('rejects exempt annual leave when the enabled policy balance is short', async () => {
    const trx = scriptedTrx({
      annualLeavePolicy: { enabled: true, standardDayMinutes: 480 },
    }, [{ id: 'lot-short', remaining_minutes: 10, status: 'active' }])

    await expect(effects(trx, {
      minutes: 480,
      leaveType: { code: 'annual', defaultMinutesPerDay: 480 },
    })).rejects.toMatchObject({
      status: 422,
      code: 'ANNUAL_LEAVE_BALANCE_INSUFFICIENT',
    })
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })
})

describe('approval-exempt overtime credit guard (#5967 owner decision)', () => {
  beforeEach(() => {
    attendancePlugin.resetAttendanceSettingsCacheForTests()
  })

  it('rejects exempt overtime when comp-time-from-overtime is enabled', async () => {
    const trx = scriptedTrx({ compTimeFromOvertime: { enabled: true } })
    await expect(effects(trx, { minutes: 60, overtimeRule: { requiresApproval: false } }, 'overtime'))
      .rejects.toMatchObject({
        status: 422,
        code: helpers.EXEMPT_OVERTIME_CREDIT_PENDING_CODE,
      })
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })

  it('rejects exempt overtime when only the overtime bank is enabled', async () => {
    const trx = scriptedTrx({ overtimeBankPolicy: { enabled: true } })
    await expect(effects(trx, { minutes: 60 }, 'overtime')).rejects.toMatchObject({
      status: 422,
      code: 'EXEMPT_OVERTIME_CREDIT_PENDING',
    })
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })

  it('does not apply the credit guard when both policies are off', async () => {
    expect(helpers.exemptOvertimeCreditPolicyBlocksSubmission({
      compTimeFromOvertime: { enabled: false },
      overtimeBankPolicy: { enabled: false },
    })).toBe(false)
    expect(helpers.exemptOvertimeCreditPolicyBlocksSubmission({})).toBe(false)
    // The helper itself only sees booleans. Normalization happens in getSettings
    // before the helper runs; these raw values are not "enabled".
    expect(helpers.exemptOvertimeCreditPolicyBlocksSubmission({
      compTimeFromOvertime: { enabled: 'true' },
      overtimeBankPolicy: { enabled: 1 },
    })).toBe(false)

    const trx = scriptedTrx({})
    trx.query = async (sql: string) => {
      const text = String(sql).replace(/\s+/g, ' ').trim()
      trx.queries.push(text)
      if (text.includes('SELECT value FROM system_configs')) return [{ value: '{}' }]
      throw new Error('reached-projection')
    }
    await expect(effects(trx, { minutes: 60 }, 'overtime')).rejects.toThrow(/reached-projection/)
    expect(trx.queries.some((sql) => sql.includes('INSERT INTO attendance_events'))).toBe(false)
  })

  it('rejects exempt overtime after settings normalization when the overtime bank stores enabled as the string true', async () => {
    const trx = scriptedTrx({ overtimeBankPolicy: { enabled: 'true' } })
    await expect(effects(trx, { minutes: 60 }, 'overtime')).rejects.toMatchObject({
      status: 422,
      code: 'EXEMPT_OVERTIME_CREDIT_PENDING',
    })
    expect(wroteBalanceOrAttendance(trx.queries)).toBe(false)
  })

  it('does not treat a numeric overtime-bank flag or a string comp-time flag as enabled', async () => {
    const trx = scriptedTrx({
      compTimeFromOvertime: { enabled: 'true' },
      overtimeBankPolicy: { enabled: 1 },
    })
    trx.query = async (sql: string) => {
      const text = String(sql).replace(/\s+/g, ' ').trim()
      trx.queries.push(text)
      if (text.includes('SELECT value FROM system_configs')) {
        return [{ value: JSON.stringify({
          compTimeFromOvertime: { enabled: 'true' },
          overtimeBankPolicy: { enabled: 1 },
        }) }]
      }
      throw new Error('reached-projection')
    }
    await expect(effects(trx, { minutes: 60 }, 'overtime')).rejects.toThrow(/reached-projection/)
    expect(trx.queries.some((sql) => sql.includes('INSERT INTO attendance_events'))).toBe(false)
  })
})
