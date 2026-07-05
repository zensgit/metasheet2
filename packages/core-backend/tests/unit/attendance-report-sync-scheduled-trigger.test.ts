import { afterEach, describe, expect, it, vi } from 'vitest'

// A2 report-sync scheduled trigger (design-lock #3623, RATIFIED owner-delegated 2026-07-05). Pure-logic
// coverage only — no database, no live server. Real-DB claim/idempotency/throttle/PUT-round-trip coverage
// lives in the 'attendance report sync scheduled trigger (A2)' describe block in
// tests/integration/attendance-plugin.test.ts (the existing attendance real-DB CI gate); job-isolation
// coverage lives in tests/unit/attendance-scheduler.test.ts.
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_CADENCES: readonly string[]
  isAttendanceReportSyncScheduledTriggerRuntimeEnabled: () => boolean
  normalizeAttendanceReportSyncScheduledTriggerSetting: (raw: unknown) => {
    enabled: boolean
    cadence: string
    maxOrgsPerRun: number
    maxUsersPerRun: number
  }
  normalizeAttendanceReportSyncSetting: (raw: unknown) => {
    scheduledTrigger: { enabled: boolean; cadence: string; maxOrgsPerRun: number; maxUsersPerRun: number }
  }
  buildAttendanceReportSyncScheduledTriggerIdempotencyKey: (
    cadence: string,
    workDate: string,
    now: Date,
    timezone: string,
  ) => string
  resolveAttendanceReportSyncScheduledTriggerOrgIds: (
    db: { query: (sql: string, params?: unknown[]) => Promise<Array<{ org_id?: string | null }>> },
    maxOrgsPerRun: number,
    logger?: { warn?: (message: string, meta?: unknown) => void },
  ) => Promise<string[]>
  mergeSettings: (base: Record<string, unknown>, update: Record<string, unknown>) => Record<string, unknown>
}

describe('#A2 report-sync scheduled trigger — settings normalizer (pure, design-lock #3623)', () => {
  it('defaults to fully-off when raw is missing/null/non-object', () => {
    const expected = { enabled: false, cadence: 'daily', maxOrgsPerRun: 5, maxUsersPerRun: 100 }
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting(undefined)).toEqual(expected)
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting(null)).toEqual(expected)
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting('nonsense')).toEqual(expected)
    expect(helpers.normalizeAttendanceReportSyncSetting(undefined)).toEqual({ scheduledTrigger: expected })
  })

  it('passes through a well-formed enabled config', () => {
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({
      enabled: true,
      cadence: 'hourly',
      maxOrgsPerRun: 3,
      maxUsersPerRun: 50,
    })).toEqual({ enabled: true, cadence: 'hourly', maxOrgsPerRun: 3, maxUsersPerRun: 50 })
  })

  it('enabled only accepts a real boolean — any other type falls back to the default (false)', () => {
    for (const bad of ['true', 1, 0, 'false', null, undefined, {}]) {
      expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ enabled: bad }).enabled).toBe(false)
    }
  })

  it('cadence is enum-strict — anything outside hourly|daily falls back to the daily default', () => {
    expect(helpers.ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_CADENCES).toEqual(['hourly', 'daily'])
    for (const bad of ['weekly', 'Daily', 'HOURLY', '', 123, null]) {
      expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ cadence: bad }).cadence).toBe('daily')
    }
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ cadence: 'hourly' }).cadence).toBe('hourly')
  })

  it('maxOrgsPerRun clamps to 1..50 — out-of-range or non-integer falls back to the default (5)', () => {
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ maxOrgsPerRun: 1 }).maxOrgsPerRun).toBe(1)
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ maxOrgsPerRun: 50 }).maxOrgsPerRun).toBe(50)
    for (const bad of [0, -1, 51, 2.5, 'x', null, undefined]) {
      expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ maxOrgsPerRun: bad }).maxOrgsPerRun).toBe(5)
    }
  })

  // The 1..100 ceiling mirrors ATTENDANCE_REPORT_RECORDS_SYNC_MAX_PAGE_SIZE, the real per-page cap the
  // runner's pageSize is clamped to downstream — keeping this validated range in sync with that
  // constant means a configured value never silently does less than it claims (see normalizer comment).
  it('maxUsersPerRun clamps to 1..100 — out-of-range or non-integer falls back to the default (100)', () => {
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ maxUsersPerRun: 1 }).maxUsersPerRun).toBe(1)
    expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ maxUsersPerRun: 100 }).maxUsersPerRun).toBe(100)
    for (const bad of [0, -1, 101, 3.14, 'x', null, undefined]) {
      expect(helpers.normalizeAttendanceReportSyncScheduledTriggerSetting({ maxUsersPerRun: bad }).maxUsersPerRun).toBe(100)
    }
  })
})

describe('#A2 report-sync scheduled trigger — settings merge preserves siblings (pure)', () => {
  it('a partial update touching only `enabled` does not clear cadence/maxOrgsPerRun/maxUsersPerRun', () => {
    const base = helpers.mergeSettings({}, {
      reportSync: { scheduledTrigger: { enabled: false, cadence: 'hourly', maxOrgsPerRun: 7, maxUsersPerRun: 42 } },
    })
    const merged = helpers.mergeSettings(base, { reportSync: { scheduledTrigger: { enabled: true } } })
    expect(merged.reportSync).toEqual({
      scheduledTrigger: { enabled: true, cadence: 'hourly', maxOrgsPerRun: 7, maxUsersPerRun: 42 },
    })
  })

  it('an update with no reportSync key at all leaves the existing scheduledTrigger untouched', () => {
    const base = helpers.mergeSettings({}, {
      reportSync: { scheduledTrigger: { enabled: true, cadence: 'daily', maxOrgsPerRun: 9, maxUsersPerRun: 11 } },
    })
    const merged = helpers.mergeSettings(base, { shiftEditPolicy: { mode: 'unrestricted' } })
    expect(merged.reportSync).toEqual({
      scheduledTrigger: { enabled: true, cadence: 'daily', maxOrgsPerRun: 9, maxUsersPerRun: 11 },
    })
  })
})

describe('#A2 report-sync scheduled trigger — env gate (pure, double-gate half #1)', () => {
  afterEach(() => {
    delete process.env.ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED
  })

  it('is default OFF (unset env → false)', () => {
    delete process.env.ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED
    expect(helpers.isAttendanceReportSyncScheduledTriggerRuntimeEnabled()).toBe(false)
  })

  it('is true only for the literal enabling values', () => {
    process.env.ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED = 'true'
    expect(helpers.isAttendanceReportSyncScheduledTriggerRuntimeEnabled()).toBe(true)
    process.env.ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED = 'false'
    expect(helpers.isAttendanceReportSyncScheduledTriggerRuntimeEnabled()).toBe(false)
    process.env.ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED = 'nonsense'
    expect(helpers.isAttendanceReportSyncScheduledTriggerRuntimeEnabled()).toBe(false)
  })
})

describe('#A2 report-sync scheduled trigger — idempotency-key period grain (pure)', () => {
  it('daily cadence ignores time-of-day — same key for any hour of the same work date', () => {
    const morning = helpers.buildAttendanceReportSyncScheduledTriggerIdempotencyKey(
      'daily', '2026-07-05', new Date('2026-07-05T01:00:00Z'), 'UTC',
    )
    const evening = helpers.buildAttendanceReportSyncScheduledTriggerIdempotencyKey(
      'daily', '2026-07-05', new Date('2026-07-05T23:00:00Z'), 'UTC',
    )
    expect(morning).toBe('scheduled-report-sync:daily_records:2026-07-05')
    expect(evening).toBe(morning)
  })

  it('hourly cadence includes the ORG-TIMEZONE hour, not the UTC hour', () => {
    // 2026-07-05T01:30:00Z = 2026-07-05 09:30 in Asia/Shanghai (+8) — hour bucket h09.
    const key = helpers.buildAttendanceReportSyncScheduledTriggerIdempotencyKey(
      'hourly', '2026-07-05', new Date('2026-07-05T01:30:00Z'), 'Asia/Shanghai',
    )
    expect(key).toBe('scheduled-report-sync:daily_records:2026-07-05:h09')
  })

  it('hourly cadence mints a DIFFERENT key for the next hour (unlike daily)', () => {
    const h09 = helpers.buildAttendanceReportSyncScheduledTriggerIdempotencyKey(
      'hourly', '2026-07-05', new Date('2026-07-05T01:30:00Z'), 'Asia/Shanghai',
    )
    const h10 = helpers.buildAttendanceReportSyncScheduledTriggerIdempotencyKey(
      'hourly', '2026-07-05', new Date('2026-07-05T02:30:00Z'), 'Asia/Shanghai',
    )
    expect(h09).not.toBe(h10)
  })
})

describe('#A2 report-sync scheduled trigger — org fan-out throttle (pure, fake db — maxOrgsPerRun)', () => {
  it('caps the org list at maxOrgsPerRun, preserving SELECT DISTINCT order', async () => {
    const db = { query: async () => [{ org_id: 'a' }, { org_id: 'b' }, { org_id: 'c' }] }
    await expect(helpers.resolveAttendanceReportSyncScheduledTriggerOrgIds(db, 2)).resolves.toEqual(['a', 'b'])
    await expect(helpers.resolveAttendanceReportSyncScheduledTriggerOrgIds(db, 10)).resolves.toEqual(['a', 'b', 'c'])
  })

  it('review P2-1: orders the DISTINCT scan (deterministic which orgs a capped tick covers)', async () => {
    const seen: string[] = []
    const db = { query: async (sql: string) => { seen.push(sql); return [{ org_id: 'a' }] } }
    await helpers.resolveAttendanceReportSyncScheduledTriggerOrgIds(db, 1)
    expect(seen[0]).toMatch(/ORDER BY org_id/)
  })

  it('review P2-1: warns with exact coverage numbers when active orgs exceed the per-tick cap (observable, not silent)', async () => {
    const db = { query: async () => [{ org_id: 'a' }, { org_id: 'b' }, { org_id: 'c' }] }
    const warn = vi.fn()
    const result = await helpers.resolveAttendanceReportSyncScheduledTriggerOrgIds(db, 2, { warn })
    expect(result).toEqual(['a', 'b']) // still deterministic first-N
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toEqual({ totalOrgs: 3, maxOrgsPerRun: 2, syncedOrgs: 2, uncoveredOrgs: 1 })
  })

  it('review P2-1: does NOT warn when the org count is within the cap', async () => {
    const db = { query: async () => [{ org_id: 'a' }, { org_id: 'b' }] }
    const warn = vi.fn()
    await helpers.resolveAttendanceReportSyncScheduledTriggerOrgIds(db, 5, { warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to [DEFAULT_ORG_ID] when attendance_rules has no rows at all', async () => {
    const db = { query: async () => [] }
    await expect(helpers.resolveAttendanceReportSyncScheduledTriggerOrgIds(db, 5)).resolves.toEqual(['default'])
  })

  it('substitutes DEFAULT_ORG_ID for a null/blank org_id value on an existing row', async () => {
    const db = { query: async () => [{ org_id: null }, { org_id: 'b' }] }
    await expect(helpers.resolveAttendanceReportSyncScheduledTriggerOrgIds(db, 5)).resolves.toEqual(['default', 'b'])
  })
})
