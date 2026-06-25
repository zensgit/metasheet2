import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceOvertimeBankForTests as {
  buildOvertimeSettlementExport: (
    summary: Record<string, unknown>,
    compTimeRemainingBySource: Record<string, number>,
    overtimeBankPolicy: { enabled?: boolean } | undefined,
  ) => { convertibleBySource: { workday: number; restday: number }; mustPayBySource: { statutory_holiday: number } } | null
}

describe('#加班银行 v1-4 — buildOvertimeSettlementExport (账4 各来源剩余 + 可折算/直付, no amounts)', () => {
  const f = helpers.buildOvertimeSettlementExport
  const ON = { enabled: true }

  it('DORMANT: policy off / missing → null (no field → summary response byte-identical)', () => {
    expect(f({ holiday_overtime_minutes: 300 }, { workday: 120 }, undefined)).toBeNull()
    expect(f({ holiday_overtime_minutes: 300 }, { workday: 120 }, { enabled: false })).toBeNull()
  })

  it('ENABLED: convertible = comp_time remaining by source; must-pay = statutory_holiday OT total (§6)', () => {
    const r = f({ holiday_overtime_minutes: 300, workday_overtime_minutes: 600 }, { workday: 120, restday: 60, unsourced: 999 }, ON)
    expect(r).toEqual({
      // banked comp_time REMAINING by source; the NULL-source legacy bucket ('unsourced') is NOT exported.
      convertibleBySource: { workday: 120, restday: 60 },
      // statutory_holiday OT total = must-pay (v1-1b never banks it; §6 legal floor — must be paid).
      mustPayBySource: { statutory_holiday: 300 },
    })
  })

  it('clamps to ≥0 integers; missing inputs → 0', () => {
    expect(f({}, {}, ON)).toEqual({ convertibleBySource: { workday: 0, restday: 0 }, mustPayBySource: { statutory_holiday: 0 } })
    expect(f({ holiday_overtime_minutes: -5 }, { workday: -3, restday: 90.7 }, ON)).toEqual({
      convertibleBySource: { workday: 0, restday: 90 }, mustPayBySource: { statutory_holiday: 0 },
    })
  })

  it('NO amounts (rates/money = payroll): only minutes split by convertible vs must-pay disposition', () => {
    const r = f({ holiday_overtime_minutes: 300 }, { workday: 120 }, ON)!
    expect(Object.keys(r).sort()).toEqual(['convertibleBySource', 'mustPayBySource'])
    expect(JSON.stringify(r)).not.toMatch(/amount|rate|salary|wage|金额|倍率/i)
  })
})
