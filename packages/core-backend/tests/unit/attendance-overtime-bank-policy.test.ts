import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceOvertimeBankForTests as {
  OVERTIME_BANK_POOLABLE_SOURCES: readonly string[]
  normalizeOvertimeBankPolicySetting: (raw: unknown) => {
    enabled: boolean
    pooledSources: string[]
    maxMinutesPerPeriod: number
    validityDays: number | null
  }
}

describe('#8/加班银行 v1-1a — OvertimeBankPolicy normalizer (LATENT, compliance-floor)', () => {
  const norm = helpers.normalizeOvertimeBankPolicySetting
  const DORMANT = { enabled: false, pooledSources: [], maxMinutesPerPeriod: 0, validityDays: null }

  it('default dormant: empty / garbage → enabled false, empty pool, no cap, no expiry', () => {
    expect(norm(undefined)).toEqual(DORMANT)
    expect(norm({})).toEqual(DORMANT)
    expect(norm('nope')).toEqual(DORMANT)
    expect(norm(null)).toEqual(DORMANT)
  })

  it('keeps the poolable allowlist sources, de-duped, preserving order', () => {
    const r = norm({ pooledSources: ['restday', 'workday', 'restday', 'special_hours', 'adjusted_rest_day', 'company_holiday'] })
    expect(r.pooledSources).toEqual(['restday', 'workday', 'special_hours', 'adjusted_rest_day', 'company_holiday'])
  })

  it('COMPLIANCE FLOOR: statutory_holiday is dropped from pooledSources (法定节假日不可入池, 劳动法 §44)', () => {
    expect(norm({ pooledSources: ['statutory_holiday'] }).pooledSources).toEqual([])
    expect(norm({ pooledSources: ['restday', 'statutory_holiday', 'workday'] }).pooledSources).toEqual(['restday', 'workday'])
    // the allowlist itself must never contain statutory_holiday.
    expect(helpers.OVERTIME_BANK_POOLABLE_SOURCES).not.toContain('statutory_holiday')
    expect([...helpers.OVERTIME_BANK_POOLABLE_SOURCES].sort()).toEqual(
      ['adjusted_rest_day', 'company_holiday', 'restday', 'special_hours', 'workday'],
    )
  })

  it('drops unknown / non-string sources (fail-closed)', () => {
    expect(norm({ pooledSources: ['restday', 'bogus', 42, null, ''] }).pooledSources).toEqual(['restday'])
    expect(norm({ pooledSources: 'restday' }).pooledSources).toEqual([]) // not an array → empty
  })

  it('enabled toggle + maxMinutesPerPeriod clamp ≥ 0', () => {
    expect(norm({ enabled: true }).enabled).toBe(true)
    expect(norm({ enabled: 'yes' }).enabled).toBe(true) // parseBoolean truthy
    expect(norm({ maxMinutesPerPeriod: -5 }).maxMinutesPerPeriod).toBe(0)
    expect(norm({ maxMinutesPerPeriod: 600 }).maxMinutesPerPeriod).toBe(600)
  })

  it('validityDays: null = no expiry; positive kept; 0 / negative → null', () => {
    expect(norm({ validityDays: null }).validityDays).toBeNull()
    expect(norm({ validityDays: 90 }).validityDays).toBe(90)
    expect(norm({ validityDays: 0 }).validityDays).toBeNull()
    expect(norm({ validityDays: -3 }).validityDays).toBeNull()
  })
})
