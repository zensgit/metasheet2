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
  resolveBankedLotExpiresInDays: (
    policy: { enabled?: boolean; validityDays?: number | null } | null | undefined,
    fallbackExpiresInDays: number | null,
  ) => number | null
  clampLotValidityDays: (raw: unknown) => number | null
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

  it('keeps the poolable allowlist sources, de-duped, preserving order; drops not-yet-producible sources', () => {
    const r = norm({ pooledSources: ['restday', 'workday', 'restday', 'special_hours', 'adjusted_rest_day', 'company_holiday'] })
    // §P2: v1-1b only produces workday/restday — the holiday sub-types + special_hours are NOT yet in the
    // allowlist (they'd silently never pool), so they're dropped here until the calendar exposes the dayType.
    expect(r.pooledSources).toEqual(['restday', 'workday'])
  })

  it('COMPLIANCE FLOOR: statutory_holiday is dropped from pooledSources (法定节假日不可入池, 劳动法 §44)', () => {
    expect(norm({ pooledSources: ['statutory_holiday'] }).pooledSources).toEqual([])
    expect(norm({ pooledSources: ['restday', 'statutory_holiday', 'workday'] }).pooledSources).toEqual(['restday', 'workday'])
    // the allowlist itself must never contain statutory_holiday, and (§P2) only exposes what v1-1b produces.
    expect(helpers.OVERTIME_BANK_POOLABLE_SOURCES).not.toContain('statutory_holiday')
    expect([...helpers.OVERTIME_BANK_POOLABLE_SOURCES].sort()).toEqual(['restday', 'workday'])
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
    // P2-2: the normalizer now guarantees a positive integer or null (fractions
    // rejected here, not merely two layers away in zod) — matches the sibling.
    expect(norm({ validityDays: 0.5 }).validityDays).toBeNull()
    expect(norm({ validityDays: 90.7 }).validityDays).toBeNull()
  })
})

describe('S1 — resolveBankedLotExpiresInDays (banked-lot validity precedence)', () => {
  const resolve = helpers.resolveBankedLotExpiresInDays

  it('bank enabled + validityDays set → validityDays governs (overrides expiresInDays)', () => {
    expect(resolve({ enabled: true, validityDays: 90 }, 30)).toBe(90)
    expect(resolve({ enabled: true, validityDays: 90 }, null)).toBe(90)
  })

  it('bank enabled + validityDays unset/invalid → falls back to expiresInDays (pre-S1 behaviour)', () => {
    expect(resolve({ enabled: true, validityDays: null }, 30)).toBe(30)
    expect(resolve({ enabled: true, validityDays: 0 }, 30)).toBe(30)
    expect(resolve({ enabled: true, validityDays: -5 }, 30)).toBe(30)
    expect(resolve({ enabled: true, validityDays: null }, null)).toBeNull()
  })

  it('bank disabled → never governs, always the fallback (dormant path untouched)', () => {
    expect(resolve({ enabled: false, validityDays: 90 }, 30)).toBe(30)
    expect(resolve({ enabled: false, validityDays: 90 }, null)).toBeNull()
    expect(resolve(null, 30)).toBe(30)
    expect(resolve(undefined, null)).toBeNull()
  })

  it('floors before the positivity check so 0<raw<1 falls back (no dead-on-arrival lot) — review P2-2', () => {
    expect(resolve({ enabled: true, validityDays: 90.9 }, null)).toBe(90)
    expect(resolve({ enabled: true, validityDays: 0.5 }, 30)).toBe(30)   // floors to 0 → fallback, NOT expires-now
    expect(resolve({ enabled: true, validityDays: 0.5 }, null)).toBeNull()
    expect(resolve({ enabled: false, validityDays: null }, 0)).toBeNull()
    expect(resolve({ enabled: false, validityDays: null }, -1)).toBeNull()
  })

  it('caps validity at MAX_LOT_VALIDITY_DAYS so a huge value falls back instead of overflowing PG interval — review P2-1', () => {
    expect(resolve({ enabled: true, validityDays: 36500 }, null)).toBe(36500)  // boundary in-range
    expect(resolve({ enabled: true, validityDays: 36501 }, 30)).toBe(30)       // just over → fallback
    expect(resolve({ enabled: true, validityDays: 999999999 }, null)).toBeNull()
    expect(resolve({ enabled: true, validityDays: Infinity }, 30)).toBe(30)
    expect(resolve({ enabled: true, validityDays: NaN }, 30)).toBe(30)
  })
})

describe('clampLotValidityDays (expiresInDays parity — no PG interval overflow)', () => {
  const clamp = helpers.clampLotValidityDays
  it('keeps a positive integer within bounds', () => {
    expect(clamp(30)).toBe(30)
    expect(clamp(36500)).toBe(36500)
  })
  it('clamps an over-large value down to MAX (36500), never overflowing the interval', () => {
    expect(clamp(36501)).toBe(36500)
    expect(clamp(999999999)).toBe(36500)
    expect(clamp(2147483648)).toBe(36500)
  })
  it('rejects non-positive / non-integer / null / garbage → null (no expiry)', () => {
    expect(clamp(0)).toBeNull()
    expect(clamp(-5)).toBeNull()
    expect(clamp(0.5)).toBeNull()
    expect(clamp(null)).toBeNull()
    expect(clamp(undefined)).toBeNull()
    expect(clamp(Infinity)).toBeNull()
    expect(clamp(NaN)).toBeNull()
  })
})
