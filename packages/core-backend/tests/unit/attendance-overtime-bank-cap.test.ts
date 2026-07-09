import { describe, expect, it } from 'vitest'

// S1b (overtime-bank-cap design-lock §3): the pure per-period (natural-month) BANKED accrual cap decision.
// Boundary contract: cap<=0/unset → NEVER blocked (byte-identical to pre-S1b); landing EXACTLY on the cap is
// allowed; only a projected total that STRICTLY exceeds the cap blocks. existing/added share the pooled-minutes
// 口径 (§6), so the sum is apples-to-apples with `newBanked = Σ pooled lots`.
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceOvertimeBankForTests as {
  overtimeBankCapDecision: (input: {
    maxMinutesPerPeriod?: unknown
    existingBanked?: unknown
    newBanked?: unknown
  }) => { blocked: boolean; cap: number | null; projected: number; existing: number; added: number }
}

describe('S1b — overtimeBankCapDecision (per-period banked accrual cap)', () => {
  const decide = helpers.overtimeBankCapDecision

  it('cap <= 0 / unset → never blocked (byte-identical to pre-S1b)', () => {
    expect(decide({ maxMinutesPerPeriod: 0, existingBanked: 9999, newBanked: 9999 }).blocked).toBe(false)
    expect(decide({ maxMinutesPerPeriod: undefined, existingBanked: 100, newBanked: 100 }).blocked).toBe(false)
    expect(decide({ maxMinutesPerPeriod: null, existingBanked: 100, newBanked: 100 }).blocked).toBe(false)
    expect(decide({ maxMinutesPerPeriod: -5, existingBanked: 100, newBanked: 100 }).blocked).toBe(false)
    // cap normalized to null when non-positive, so callers see "no cap"
    expect(decide({ maxMinutesPerPeriod: 0, existingBanked: 1, newBanked: 1 }).cap).toBeNull()
  })

  it('landing exactly on the cap is allowed (not blocked)', () => {
    const r = decide({ maxMinutesPerPeriod: 120, existingBanked: 60, newBanked: 60 })
    expect(r.blocked).toBe(false)
    expect(r.projected).toBe(120)
    expect(r.cap).toBe(120)
  })

  it('exceeding the cap by 1 minute blocks', () => {
    const r = decide({ maxMinutesPerPeriod: 120, existingBanked: 60, newBanked: 61 })
    expect(r.blocked).toBe(true)
    expect(r.projected).toBe(121)
  })

  it('a single grant alone over the cap blocks (existing = 0)', () => {
    expect(decide({ maxMinutesPerPeriod: 120, existingBanked: 0, newBanked: 121 }).blocked).toBe(true)
    expect(decide({ maxMinutesPerPeriod: 120, existingBanked: 0, newBanked: 120 }).blocked).toBe(false)
  })

  it('projected = existing + added; both floored at 0 for garbage inputs', () => {
    const r = decide({ maxMinutesPerPeriod: 100, existingBanked: -50, newBanked: 30 })
    expect(r.existing).toBe(0)
    expect(r.added).toBe(30)
    expect(r.projected).toBe(30)
    expect(r.blocked).toBe(false)
    // non-numeric strings coerce to 0, never NaN-leak into a comparison
    const g = decide({ maxMinutesPerPeriod: 100, existingBanked: 'x', newBanked: 'y' })
    expect(g.projected).toBe(0)
    expect(g.blocked).toBe(false)
  })
})
