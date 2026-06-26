import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceOvertimeBankForTests as {
  buildCycleSettlementRows: (input?: {
    holidayOvertimeMinutes?: number
    compTimeRemainingBySource?: Record<string, number>
  }) => Array<{ source: string; convertibleMinutes: number; mustPayMinutes: number }>
}

describe('#加班银行 v1-5b — buildCycleSettlementRows (settlement compute §5)', () => {
  const f = helpers.buildCycleSettlementRows
  const sorted = (rows: ReturnType<typeof f>) => [...rows].sort((a, b) => a.source.localeCompare(b.source))

  it('convertible = comp_time remaining by source; must-pay = the cycle-period statutory holiday OT', () => {
    expect(sorted(f({ holidayOvertimeMinutes: 480, compTimeRemainingBySource: { workday: 120, restday: 60, legacy_unsourced: 30 } }))).toEqual([
      { source: 'legacy_unsourced', convertibleMinutes: 30, mustPayMinutes: 0 },
      { source: 'restday', convertibleMinutes: 60, mustPayMinutes: 0 },
      { source: 'statutory_holiday', convertibleMinutes: 0, mustPayMinutes: 480 },
      { source: 'workday', convertibleMinutes: 120, mustPayMinutes: 0 },
    ])
  })

  it('POISON-LOT (§7): a bogus statutory_holiday BALANCE lot does NOT move must_pay — it comes from PERIOD facts', () => {
    const rows = f({ holidayOvertimeMinutes: 480, compTimeRemainingBySource: { statutory_holiday: 9999, workday: 60 } })
    expect(rows.find((r) => r.source === 'statutory_holiday')).toEqual({ source: 'statutory_holiday', convertibleMinutes: 0, mustPayMinutes: 480 })
    expect(rows.some((r) => r.source === 'statutory_holiday' && r.convertibleMinutes > 0)).toBe(false)
  })

  it('UNCONDITIONAL must-pay (advisor #1 / §6): a bank-off org (no banked comp_time) with holiday OT still gets a must-pay row', () => {
    expect(f({ holidayOvertimeMinutes: 300, compTimeRemainingBySource: {} })).toEqual([
      { source: 'statutory_holiday', convertibleMinutes: 0, mustPayMinutes: 300 },
    ])
  })

  it('clean period (no holiday OT, no banked comp_time) → no rows', () => {
    expect(f({ holidayOvertimeMinutes: 0, compTimeRemainingBySource: {} })).toEqual([])
    expect(f({})).toEqual([])
  })

  it('clamps to >= 0 integers; only positive convertible sources emit a row', () => {
    expect(f({ holidayOvertimeMinutes: -5, compTimeRemainingBySource: { workday: 0, restday: 90.7, legacy_unsourced: -3 } })).toEqual([
      { source: 'restday', convertibleMinutes: 90, mustPayMinutes: 0 },
    ])
  })
})
