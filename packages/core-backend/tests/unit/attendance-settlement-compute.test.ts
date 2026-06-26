import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
type Row = { source: string; convertibleMinutes: number; mustPayMinutes: number }
const helpers = attendancePlugin.__attendanceOvertimeBankForTests as {
  buildCycleSettlementRows: (input?: {
    periodOtBySource?: Record<string, number>
    compTimeRemainingBySource?: Record<string, number>
    pooledSources?: string[]
  }) => Row[]
}

describe('#加班银行 v1-5b — buildCycleSettlementRows (settlement compute §5)', () => {
  const f = helpers.buildCycleSettlementRows
  const byS = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.source, r])) as Record<string, Row>

  it('[P1] un-pooled source OT → must-pay; pooled source OT → 0 must-pay (it became comp_time)', () => {
    // pooledSources=['restday']: restday OT was banked (convertible), workday OT is un-pooled → must-pay 120.
    const rows = byS(f({ periodOtBySource: { workday: 120, restday: 60 }, compTimeRemainingBySource: { restday: 60 }, pooledSources: ['restday'] }))
    expect(rows.workday).toEqual({ source: 'workday', convertibleMinutes: 0, mustPayMinutes: 120 })
    expect(rows.restday).toEqual({ source: 'restday', convertibleMinutes: 60, mustPayMinutes: 0 })
  })

  it('all sources pooled → no non-statutory must-pay', () => {
    const rows = byS(f({ periodOtBySource: { workday: 120, restday: 60 }, compTimeRemainingBySource: { workday: 120, restday: 60 }, pooledSources: ['workday', 'restday'] }))
    expect(rows.workday.mustPayMinutes).toBe(0)
    expect(rows.restday.mustPayMinutes).toBe(0)
  })

  it('bank-off / pooledSources=[] → EVERY non-statutory source is un-pooled → all must-pay', () => {
    const rows = byS(f({ periodOtBySource: { workday: 120, restday: 60, statutory_holiday: 300 }, compTimeRemainingBySource: {}, pooledSources: [] }))
    expect(rows.workday.mustPayMinutes).toBe(120)
    expect(rows.restday.mustPayMinutes).toBe(60)
    expect(rows.statutory_holiday).toEqual({ source: 'statutory_holiday', convertibleMinutes: 0, mustPayMinutes: 300 })
  })

  it('statutory_holiday is ALWAYS must-pay (§6) regardless of pooledSources, never convertible', () => {
    for (const pooledSources of [[], ['restday'], ['workday', 'restday', 'statutory_holiday']]) {
      const rows = byS(f({ periodOtBySource: { statutory_holiday: 480 }, compTimeRemainingBySource: {}, pooledSources }))
      expect(rows.statutory_holiday).toEqual({ source: 'statutory_holiday', convertibleMinutes: 0, mustPayMinutes: 480 })
    }
  })

  it('POISON-LOT (§7): a bogus statutory_holiday BALANCE lot does NOT move must_pay — it comes from PERIOD facts', () => {
    const rows = byS(f({ periodOtBySource: { statutory_holiday: 480 }, compTimeRemainingBySource: { statutory_holiday: 9999, restday: 60 }, pooledSources: ['restday'] }))
    expect(rows.statutory_holiday).toEqual({ source: 'statutory_holiday', convertibleMinutes: 0, mustPayMinutes: 480 })
  })

  it('convertible (prior-period banked) + must-pay (this-period un-pooled) coexist on one source row', () => {
    const rows = byS(f({ periodOtBySource: { workday: 120 }, compTimeRemainingBySource: { workday: 90 }, pooledSources: ['restday'] }))
    expect(rows.workday).toEqual({ source: 'workday', convertibleMinutes: 90, mustPayMinutes: 120 })
  })

  it('legacy_unsourced = historical banked balance only (convertible, no must-pay); clean → no rows', () => {
    expect(byS(f({ periodOtBySource: {}, compTimeRemainingBySource: { legacy_unsourced: 45 }, pooledSources: ['restday'] })).legacy_unsourced)
      .toEqual({ source: 'legacy_unsourced', convertibleMinutes: 45, mustPayMinutes: 0 })
    expect(f({ periodOtBySource: {}, compTimeRemainingBySource: {}, pooledSources: ['restday'] })).toEqual([])
    expect(f({})).toEqual([])
  })
})
