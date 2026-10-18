import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAttendanceCalendarSettingsWriter } = require('../../../../plugins/plugin-attendance/lib/attendance-calendar-settings-writer.cjs')
class TestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
function fixture() {
  const events: string[] = []
  const current = { calendarPolicy: { overrides: [{ id: 'fresh' }] }, annualLeavePolicy: { enabled: false } }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM user_orgs')) { events.push('orgs'); return [{ org_id: 'a' }, { org_id: 'b' }] }
    if (sql.includes('pg_advisory')) { events.push('settings-lock'); return [] }
    events.push('fresh-settings')
    return [{ value: JSON.stringify(current) }]
  })
  const trx = { query }
  const cacheCommitted = vi.fn()
  const assertManage = vi.fn(async (_trx: unknown, actor: { orgId: string }) => { expect(_trx).toBe(trx); events.push('manage:' + actor.orgId) })
  const saveSettings = vi.fn(async (_trx: unknown, value: unknown, options: unknown) => {
    expect(_trx).toBe(trx); expect(options).toEqual({ updateCache: false }); events.push('write'); return value
  })
  const prepareSourceChange = vi.fn(async (_trx: unknown, { orgId }: { orgId: string }) => {
    expect(_trx).toBe(trx); events.push('capture:' + orgId)
    return async () => { events.push('verify:' + orgId) }
  })
  const db = { transaction: async (work: (trx: unknown) => Promise<unknown>) => {
    const result = await work(trx); events.push('commit'); return result
  } }
  const update = createAttendanceCalendarSettingsWriter({
    HttpError: TestError, settingsKey: 'attendance.settings', defaultSettings: {},
    normalizeSettings: (value: unknown) => value,
    mergeSettings: (base: Record<string, unknown>, patch: Record<string, unknown>) => ({ ...base, ...patch }),
    isValidTimeZoneIdentifier: (value: string) => value === 'UTC',
    lockOrg: async (_trx: unknown, orgId: string) => { expect(_trx).toBe(trx); events.push('prefix:' + orgId) },
    prepareSourceChange, saveSettings, cacheCommitted, assertManage,
  })
  return { events, current, query, update, db, cacheCommitted, prepareSourceChange, saveSettings, assertManage }
}
describe('calendar settings fresh transaction writer', () => {
  it('takes every sorted organization prefix before any member capture or settings lock, and caches only after commit', async () => {
    const f = fixture()
    f.cacheCommitted.mockImplementation(() => f.events.push('cache'))
    await f.update(f.db, { calendarPolicy: { overrides: [] } })
    expect(f.events).toEqual(['orgs', 'prefix:a', 'prefix:b', 'capture:a', 'capture:b',
      'settings-lock', 'fresh-settings', 'write', 'verify:a', 'verify:b', 'commit', 'cache'])
  })
  it('authorizes only the current actor organization after all affected prefixes and before settings DML', async () => {
    const f = fixture(), actor = { orgId: 'a', actorId: 'actor' }
    await f.update(f.db, { calendarPolicy: { overrides: [] } }, actor)
    expect(f.assertManage).toHaveBeenCalledOnce()
    expect(f.events).toEqual(['orgs', 'prefix:a', 'prefix:b', 'capture:a', 'capture:b',
      'manage:a', 'settings-lock', 'fresh-settings', 'write', 'verify:a', 'verify:b', 'commit'])
  })
  it('a revoked actor prevents every settings write and cache update', async () => {
    const f = fixture()
    f.assertManage.mockRejectedValue(new TestError(403, 'ATTENDANCE_TIMEZONE_FORBIDDEN', 'ATTENDANCE_TIMEZONE_FORBIDDEN'))
    await expect(f.update(f.db, {}, { orgId: 'a', actorId: 'actor' }))
      .rejects.toMatchObject({ status: 403, code: 'ATTENDANCE_TIMEZONE_FORBIDDEN' })
    expect(f.events).toEqual(['prefix:a'])
    expect(f.saveSettings).not.toHaveBeenCalled()
    expect(f.cacheCommitted).not.toHaveBeenCalled()
  })
  it('a status-only patch preserves the fresh persisted calendar and takes the absent-row serialization lock', async () => {
    const f = fixture()
    const result = await f.update(f.db, { holidaySync: { lastRun: { success: true } } })
    expect(result).toEqual({ ...f.current, holidaySync: { lastRun: { success: true } } })
    expect(f.prepareSourceChange).not.toHaveBeenCalled()
    expect(f.events).toEqual(['settings-lock', 'fresh-settings', 'write', 'commit'])
  })
  it('a post-write conflict leaves cache untouched and never reaches commit', async () => {
    const f = fixture()
    f.prepareSourceChange.mockResolvedValue(async () => { throw new TestError(409, 'CONFLICT', 'CONFLICT') })
    await expect(f.update(f.db, { calendarPolicy: { overrides: [] } })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(f.saveSettings).toHaveBeenCalledOnce()
    expect(f.cacheCommitted).not.toHaveBeenCalled()
    expect(f.events).not.toContain('commit')
  })
  it.each([
    [{ enabled: true }, 'ANNUAL_LEAVE_TIMEZONE_REQUIRED'],
    [{ enabled: true, timezone: 'Invalid/Zone' }, 'ANNUAL_LEAVE_TIMEZONE_INVALID'],
  ])('preserves enabled annual-leave timezone validation before settings DML', async (annualLeavePolicy, code) => {
    const f = fixture()
    await expect(f.update(f.db, { annualLeavePolicy }, { orgId: 'a', actorId: 'actor' })).rejects.toMatchObject({ status: 422, code })
    expect(f.saveSettings).not.toHaveBeenCalled()
    expect(f.cacheCommitted).not.toHaveBeenCalled()
  })
  it('allows the existing explicit valid annual-leave timezone policy', async () => {
    const f = fixture()
    const annualLeavePolicy = { enabled: true, timezone: 'UTC' }
    expect(await f.update(f.db, { annualLeavePolicy }, { orgId: 'a', actorId: 'actor' })).toEqual({ ...f.current, annualLeavePolicy })
    expect(f.saveSettings).toHaveBeenCalledOnce()
    expect(f.cacheCommitted).toHaveBeenCalledOnce()
  })
  it('a trusted sync-status patch does not revalidate or rewrite an existing annual policy', async () => {
    const f = fixture()
    const annualLeavePolicy = { enabled: true }
    f.query.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE')
      ? [{ value: JSON.stringify({ ...f.current, annualLeavePolicy }) }] : [])
    expect(await f.update(f.db, { holidaySync: { lastRun: { success: true } } }))
      .toEqual({ ...f.current, annualLeavePolicy, holidaySync: { lastRun: { success: true } } })
  })
  it('malformed persisted settings fail closed before DML rather than overwriting with defaults', async () => {
    const f = fixture()
    f.query.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE') ? [{ value: '[]' }] : [])
    await expect(f.update(f.db, {})).rejects.toMatchObject({ status: 503, code: 'ATTENDANCE_SETTINGS_SOURCE_INVALID' })
    expect(f.saveSettings).not.toHaveBeenCalled()
    expect(f.cacheCommitted).not.toHaveBeenCalled()
  })
})
