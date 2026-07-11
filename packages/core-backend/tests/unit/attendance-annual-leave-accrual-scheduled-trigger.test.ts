import { afterEach, describe, expect, it } from 'vitest'

// S3 annual-leave accrual scheduler (design-lock attendance-annual-leave-accrual-scheduler-s3-design-lock-20260710).
// Pure-logic coverage only — no database, no live server. Real-DB scheduler-run/due-gate/idempotency/PUT
// round-trip coverage lives in the 'attendance annual-leave accrual scheduled trigger (S3 ...)' describe
// block in tests/integration/attendance-plugin.test.ts (the existing attendance real-DB CI gate);
// job-isolation coverage lives in tests/unit/attendance-scheduler.test.ts.
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  normalizeAnnualLeavePolicySetting: (raw: unknown) => {
    enabled: boolean
    tenureMode: string
    standardDayMinutes: number
    tiers: Array<{ minYears: number; maxYears: number | null; days: number }>
    carryover: { enabled: boolean }
    timezone: string | null
    scheduledTrigger: { enabled: boolean }
  }
  mergeSettings: (base: Record<string, unknown>, update: Record<string, unknown>) => Record<string, unknown>
  isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled: () => boolean
  resolveAnnualLeaveAccrualScheduledTriggerPeriod: (
    now: Date,
    timezone: string,
  ) => { period: number; periodKey: string; workDate: string }
  isAnnualLeaveAccrualScheduledTriggerDue: (now: Date, timezone: string, lastRealRunCreatedAt: Date | null) => boolean
  ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_TRIGGER_MAX_ORGS_PER_RUN: number
}

describe('#S3 annual-leave accrual scheduled trigger — settings normalizer (pure, design-lock 20260710)', () => {
  it('defaults scheduledTrigger to off when raw is missing/null/non-object', () => {
    for (const bad of [undefined, null, 'nonsense']) {
      expect(helpers.normalizeAnnualLeavePolicySetting(bad).scheduledTrigger).toEqual({ enabled: false })
    }
  })

  it('passes through a well-formed scheduledTrigger.enabled=true', () => {
    expect(helpers.normalizeAnnualLeavePolicySetting({ scheduledTrigger: { enabled: true } }).scheduledTrigger).toEqual({
      enabled: true,
    })
  })

  it('scheduledTrigger.enabled only accepts a real boolean — any other type falls back to the default (false)', () => {
    for (const bad of ['true', 1, 0, 'false', null, undefined, {}]) {
      expect(helpers.normalizeAnnualLeavePolicySetting({ scheduledTrigger: { enabled: bad } }).scheduledTrigger.enabled).toBe(false)
    }
  })

  it('a non-object scheduledTrigger falls back to the off default, not a crash', () => {
    for (const bad of [null, 'x', 5, [], true]) {
      expect(helpers.normalizeAnnualLeavePolicySetting({ scheduledTrigger: bad }).scheduledTrigger).toEqual({ enabled: false })
    }
  })

  it('normalizing scheduledTrigger never disturbs the sibling annualLeavePolicy fields', () => {
    const result = helpers.normalizeAnnualLeavePolicySetting({
      enabled: true,
      tenureMode: 'company_tenure',
      standardDayMinutes: 400,
      timezone: 'Asia/Shanghai',
      scheduledTrigger: { enabled: true },
    })
    expect(result).toMatchObject({
      enabled: true,
      tenureMode: 'company_tenure',
      standardDayMinutes: 400,
      timezone: 'Asia/Shanghai',
      scheduledTrigger: { enabled: true },
    })
  })
})

describe('#S3 annual-leave accrual scheduled trigger — settings merge preserves siblings (pure)', () => {
  it('a partial update touching only annualLeavePolicy.enabled does not clear scheduledTrigger', () => {
    const base = helpers.mergeSettings({}, { annualLeavePolicy: { enabled: true, scheduledTrigger: { enabled: true } } })
    const merged = helpers.mergeSettings(base, { annualLeavePolicy: { enabled: false } })
    expect(merged.annualLeavePolicy).toMatchObject({ enabled: false, scheduledTrigger: { enabled: true } })
  })

  it('a partial update touching only scheduledTrigger.enabled does not clear carryover/timezone', () => {
    const base = helpers.mergeSettings({}, {
      annualLeavePolicy: { enabled: true, carryover: { enabled: true }, timezone: 'Asia/Shanghai', scheduledTrigger: { enabled: false } },
    })
    const merged = helpers.mergeSettings(base, { annualLeavePolicy: { scheduledTrigger: { enabled: true } } })
    expect(merged.annualLeavePolicy).toMatchObject({
      enabled: true,
      carryover: { enabled: true },
      timezone: 'Asia/Shanghai',
      scheduledTrigger: { enabled: true },
    })
  })

  it('an update with no annualLeavePolicy key at all leaves the existing scheduledTrigger untouched', () => {
    const base = helpers.mergeSettings({}, { annualLeavePolicy: { scheduledTrigger: { enabled: true } } })
    const merged = helpers.mergeSettings(base, { shiftEditPolicy: { mode: 'unrestricted' } })
    expect(merged.annualLeavePolicy).toMatchObject({ scheduledTrigger: { enabled: true } })
  })
})

describe('#S3 annual-leave accrual scheduled trigger — env gate (pure, double-gate half #1)', () => {
  afterEach(() => {
    delete process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED
  })

  it('is default OFF (unset env → false)', () => {
    delete process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled()).toBe(false)
  })

  it('is true only for the literal enabling values', () => {
    process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED = 'true'
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled()).toBe(true)
    process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED = 'false'
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled()).toBe(false)
    process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED = 'nonsense'
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled()).toBe(false)
  })
})

describe('#S3 annual-leave accrual scheduled trigger — period resolution (pure, org-tz not UTC)', () => {
  it('resolves period/periodKey/workDate from the org-local date', () => {
    // 2026-07-05T01:30:00Z = 2026-07-05 09:30 in Asia/Shanghai.
    const result = helpers.resolveAnnualLeaveAccrualScheduledTriggerPeriod(new Date('2026-07-05T01:30:00Z'), 'Asia/Shanghai')
    expect(result).toEqual({ period: 2026, periodKey: 'annual:2026', workDate: '2026-07-05' })
  })

  it('crosses the Dec 31 / Jan 1 org-tz boundary — UTC date and org-local date land in DIFFERENT years', () => {
    // 2026-12-31T20:00:00Z = 2027-01-01 04:00 in Asia/Shanghai (+8) — org-local is already next year; the
    // UTC year (2026) would misclassify the period were the code to use it instead of getZonedParts.
    const utcNow = new Date('2026-12-31T20:00:00Z')
    expect(utcNow.getUTCFullYear()).toBe(2026)
    const result = helpers.resolveAnnualLeaveAccrualScheduledTriggerPeriod(utcNow, 'Asia/Shanghai')
    expect(result).toEqual({ period: 2027, periodKey: 'annual:2027', workDate: '2027-01-01' })
  })

  it('UTC timezone: period/workDate match the UTC calendar date directly', () => {
    const result = helpers.resolveAnnualLeaveAccrualScheduledTriggerPeriod(new Date('2026-03-15T23:00:00Z'), 'UTC')
    expect(result).toEqual({ period: 2026, periodKey: 'annual:2026', workDate: '2026-03-15' })
  })
})

describe('#S3 annual-leave accrual scheduled trigger — due gate (pure, G5)', () => {
  it('is due when there is no prior real run at all (null)', () => {
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerDue(new Date('2026-07-10T12:00:00Z'), 'UTC', null)).toBe(true)
  })

  it('is NOT due when a real run already happened THIS org-local month', () => {
    const now = new Date('2026-07-10T12:00:00Z')
    const earlierThisMonth = new Date('2026-07-01T00:00:00Z')
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerDue(now, 'UTC', earlierThisMonth)).toBe(false)
  })

  it('IS due when the last real run was a PRIOR month (even the immediately preceding day, across a month boundary)', () => {
    const now = new Date('2026-07-01T00:30:00Z')
    const lastMonth = new Date('2026-06-30T23:30:00Z')
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerDue(now, 'UTC', lastMonth)).toBe(true)
  })

  it('IS due when the last real run was the same month/day but a PRIOR year', () => {
    const now = new Date('2026-07-10T12:00:00Z')
    const lastYear = new Date('2025-07-10T12:00:00Z')
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerDue(now, 'UTC', lastYear)).toBe(true)
  })

  it('org-tz boundary: a run stamped near a UTC month-end is "already next month" in a +8 org timezone', () => {
    // 2026-06-30T23:30:00Z (UTC = still June) is 2026-07-01 07:30 in Asia/Shanghai — ALREADY July in
    // org-local time. A now() of 2026-07-01T08:00Z (org-local 2026-07-01 16:00) must see this as "already
    // ran this month" under the org's OWN timezone, even though the run's UTC calendar month was June.
    const lastRun = new Date('2026-06-30T23:30:00Z')
    const now = new Date('2026-07-01T08:00:00Z')
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerDue(now, 'Asia/Shanghai', lastRun)).toBe(false)
    // The SAME two instants under UTC (no tz shift) land in different calendar months → still due.
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerDue(now, 'UTC', lastRun)).toBe(true)
  })

  it('an invalid/NaN lastRealRunCreatedAt is treated as no prior run (due) — never throws', () => {
    expect(helpers.isAnnualLeaveAccrualScheduledTriggerDue(new Date('2026-07-10T12:00:00Z'), 'UTC', new Date('not-a-date'))).toBe(true)
    expect(
      helpers.isAnnualLeaveAccrualScheduledTriggerDue(new Date('2026-07-10T12:00:00Z'), 'UTC', undefined as unknown as Date),
    ).toBe(true)
  })
})

describe('#S3 annual-leave accrual scheduled trigger — throttle constant (pure)', () => {
  it('the org fan-out cap is a positive integer', () => {
    expect(Number.isInteger(helpers.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_TRIGGER_MAX_ORGS_PER_RUN)).toBe(true)
    expect(helpers.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_TRIGGER_MAX_ORGS_PER_RUN).toBeGreaterThan(0)
  })
})
