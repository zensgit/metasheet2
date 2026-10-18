import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAttendanceTimezoneReadContext, withTimezoneExportColumns } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-read-context.cjs')
class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}
const base = { timezone: 'UTC', source: 'system_default', mode: 'default_only', policyVersion: 0, referenceId: 'rule', version: 1 }
const at = new Date('2026-10-12T23:30:00Z')
// CJS injection surface uses dynamic database rows, while each assertion below
// checks the exact public DTO or typed failure.
function fixture(select = (date: string) => ({ ...base, targetWorkDate: date })) {
  const optional = vi.fn(async (_sql: string, _args: unknown[]) => [] as Record<string, unknown>[])
  const load = vi.fn(async (input: { workDate: string }) => select(input.workDate))
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM users')) return (args[1] as string[]).map(id => ({ id }))
    return optional(sql, args)
  })
  const readTargetTimezoneContext = vi.fn(async (_trx: unknown, input: { orgId: string, userId: string, workDate: string }) => ({
    timezone: 'UTC', contextFingerprint: 'a'.repeat(64), frozen: false, provenance: base,
    isWorkingDay: true, rule: {}, orgId: input.orgId, userId: input.userId, workDate: input.workDate,
  }))
  const readTargetTimezoneContexts = vi.fn(async (trx: unknown, input: { orgId: string, userId: string, workDates: string[] }) =>
    new Map(await Promise.all(input.workDates.map(async workDate => [workDate,
      await readTargetTimezoneContext(trx, { orgId: input.orgId, userId: input.userId, workDate })] as const))))
  const runtime = { loaderFor: () => load, readTargetTimezoneContext, readTargetTimezoneContexts,
    uniqueWallInstant: (date: string, _time: string, zone: string) => new Date(date + (zone === 'Asia/Tokyo' ? 'T00:00:00+09:00' : 'T00:00:00Z')),
  }
  const acquireLocks = vi.fn(async () => {})
  const reader = createAttendanceTimezoneReadContext({ runtime: () => runtime, acquireLocks, HttpError,
    settingsKey: 'attendance.settings', normalizeSettings: (value: unknown) => value,
    validateIanaTimezone: (zone: string) => {
      if (!zone || zone !== zone.trim() || /^[+-]/.test(zone)) throw new Error('zone')
      new Intl.DateTimeFormat('en', { timeZone: zone }); return zone
    },
  })
  return { reader, query, trx: { query }, load, optional, readTargetTimezoneContext, readTargetTimezoneContexts, acquireLocks }
}
describe('attendance readonly timezone context', () => {
  it('reads fresh settings in the supplied transaction without a cache or schema fallback', async () => {
    const f = fixture()
    const value = { calendarPolicy: { overrides: [{ id: 'synthetic' }] } }
    f.optional.mockResolvedValueOnce([{ value: JSON.stringify(value) }])
    expect(await f.reader.readCalendarSettings(f.trx)).toEqual(value)
    expect(f.optional).toHaveBeenCalledWith('SELECT value FROM system_configs WHERE key=$1', ['attendance.settings'])
    f.optional.mockResolvedValueOnce([])
    expect(await f.reader.readCalendarSettings(f.trx)).toEqual({})
  })
  it.each([null, 'invalid-json', '[]', 'null'])('rejects malformed stored settings without fallback (%s)', async value => {
    const f = fixture()
    f.optional.mockResolvedValueOnce([{ value }])
    await expect(f.reader.readCalendarSettings(f.trx)).rejects.toMatchObject({
      status: 503, code: 'ATTENDANCE_TIMEZONE_SETTINGS_SOURCE_INVALID',
    })
  })
  it('propagates settings read failure as a values-free unavailable error', async () => {
    const f = fixture()
    f.optional.mockRejectedValueOnce(new Error('private database detail'))
    await expect(f.reader.readCalendarSettings(f.trx)).rejects.toMatchObject({
      status: 503, code: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE', message: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',
    })
  })
  it('OFF resolves the actual local date without touching optional sources', async () => {
    const f = fixture(date => ({ ...base, timezone: 'Asia/Tokyo', targetWorkDate: date }))
    expect(await f.reader.readCurrentTimezoneContext(f.trx, { orgId: 'org', userId: 'user', occurredAt: at })).toEqual({
      resolvedForInstant: at.toISOString(), effectiveTimezone: 'Asia/Tokyo', timezoneSource: 'system_default',
      mode: 'default_only', policyVersion: 0, referenceId: 'rule', version: 1,
      currentLocalDate: '2026-10-13', nextEffectiveBoundary: null,
    })
    expect(f.optional).not.toHaveBeenCalled()
    expect(f.load).toHaveBeenCalledTimes(5)
    expect(f.acquireLocks).toHaveBeenCalledWith(f.trx, { orgId: 'org', userId: 'user', mode: 'shared' })
  })
  it('rejects two local DATE fixed points rather than choosing by order', async () => {
    const f = fixture(date => ({ ...base, targetWorkDate: date,
      timezone: date === '2026-10-13' ? 'Asia/Tokyo' : 'UTC' }))
    await expect(f.reader.readCurrentTimezoneContext(f.trx, { orgId: 'org', userId: 'user', occurredAt: at }))
      .rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_TIMEZONE_CURRENT_CONTEXT_CONFLICT' })
  })
  it('rejects no self-consistent local DATE', async () => {
    const f = fixture(date => ({ ...base, targetWorkDate: date,
      timezone: date === '2026-10-12' ? 'Asia/Tokyo' : 'UTC' }))
    await expect(f.reader.readCurrentTimezoneContext(f.trx, { orgId: 'org', userId: 'user', occurredAt: at }))
      .rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_TIMEZONE_CURRENT_CONTEXT_CONFLICT' })
  })
  it('takes the earliest actual UTC interval boundary, including an end', async () => {
    const f = fixture(date => ({ ...base, mode: 'multi_timezone', policyVersion: 2, targetWorkDate: date }))
    f.optional.mockImplementation(async sql => sql.includes('attendance_employee_timezone_overrides')
      ? [{ starts_at: new Date('2026-10-12T00:00:00Z'), ends_at: new Date('2026-10-13T00:00:00Z'), timezone: 'UTC' },
        { starts_at: new Date('2026-10-13T01:00:00Z'), ends_at: null, timezone: 'Asia/Tokyo' }]
      : sql.includes('attendance_rules') ? [{ timezone: 'UTC' }] : [])
    expect((await f.reader.readCurrentTimezoneContext(f.trx, { orgId: 'org', userId: 'user', occurredAt: at })).nextEffectiveBoundary)
      .toBe('2026-10-13T00:00:00.000Z')
  })
  it('converts a governed membership DATE boundary with the IANA server resolver', async () => {
    const f = fixture(date => ({ ...base, timezone: 'Asia/Tokyo', mode: 'multi_timezone', policyVersion: 2, targetWorkDate: date }))
    f.optional.mockImplementation(async sql => sql.includes('attendance_rules') ? [{ timezone: 'Asia/Tokyo' }]
      : sql.includes('attendance_calculation_group_memberships')
        ? [{ effective_from: '2026-10-14', effective_to: null, timezone: 'Asia/Tokyo' }] : [])
    expect((await f.reader.readCurrentTimezoneContext(f.trx, { orgId: 'org', userId: 'user', occurredAt: at })).nextEffectiveBoundary)
      .toBe('2026-10-13T15:00:00.000Z')
  })
  it('propagates optional source failure without falling back', async () => {
    const f = fixture(date => ({ ...base, mode: 'multi_timezone', targetWorkDate: date }))
    f.optional.mockRejectedValue(new Error('sensitive database value'))
    await expect(f.reader.readCurrentTimezoneContext(f.trx, { orgId: 'org', userId: 'user', occurredAt: at }))
      .rejects.toMatchObject({ status: 503, message: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE' })
  })
  it.each(['actor', 'subject'])('requires actual active %s membership', async who => {
    const f = fixture()
    f.query.mockImplementation(async () => [{ id: who === 'actor' ? 'subject' : 'actor' }])
    await expect(f.reader.readCurrentTimezoneContext(f.trx, { orgId: 'org', actorId: 'actor', userId: 'subject', occurredAt: at }))
      .rejects.toMatchObject({ status: 403, code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' })
    expect(f.load).not.toHaveBeenCalled()
  })
  it('uses one batch target reader for all unique requested calendar dates in the same transaction', async () => {
    const f = fixture()
    const result = await f.reader.readCalendarContexts(f.trx, { orgId: 'org', userId: 'user',
      workDates: ['2026-10-13', '2026-10-12', '2026-10-13'] })
    expect([...result.keys()]).toEqual(['2026-10-12', '2026-10-13'])
    expect(f.readTargetTimezoneContexts).toHaveBeenCalledTimes(1)
    expect(f.readTargetTimezoneContexts).toHaveBeenCalledWith(f.trx, {
      orgId: 'org', userId: 'user', workDates: ['2026-10-12', '2026-10-13'],
    })
  })
  it('reads legacy history from its stored zone without current-policy reads', async () => {
    const f = fixture()
    const result = await f.reader.readStoredContexts(f.trx, { orgId: 'org', userId: 'user',
      records: [{ work_date: '2026-10-12', timezone: 'America/New_York' }] })
    expect(result.get('2026-10-12')).toEqual({
      effectiveTimezone: 'America/New_York', timezoneSource: 'legacy_record', mode: null,
      policyVersion: null, contextFingerprint: null, frozen: true, targetWorkDate: '2026-10-12',
    })
    expect(f.load).not.toHaveBeenCalled()
    expect(f.readTargetTimezoneContexts).not.toHaveBeenCalled()
  })
  it('batch-prefetches legacy calendar rows and never reinterprets them with the current target reader', async () => {
    const f = fixture()
    f.optional.mockImplementation(async sql => sql.includes('FROM attendance_current_records')
      ? [{ work_date: '2026-10-12', timezone: 'America/New_York', is_workday: true }] : [])
    const result = await f.reader.readCalendarContexts(f.trx, { orgId: 'org', userId: 'user', workDates: ['2026-10-12'] })
    expect(result.get('2026-10-12').attendanceTimeContext).toMatchObject({
      effectiveTimezone: 'America/New_York', timezoneSource: 'legacy_record', frozen: true, contextFingerprint: null,
    })
    expect(f.readTargetTimezoneContexts).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  })
  it('rejects impossible target dates before source queries', async () => {
    const f = fixture()
    await expect(f.reader.readCalendarContexts(f.trx, { orgId: 'org', userId: 'user', workDates: ['2026-99-99'] }))
      .rejects.toMatchObject({ status: 422, code: 'ATTENDANCE_TIMEZONE_INVALID_WORK_DATE' })
    expect(f.optional).not.toHaveBeenCalled()
  })
  it('rejects corrupted companion fingerprints instead of inventing legacy provenance', async () => {
    const f = fixture()
    f.optional.mockResolvedValue([{
      record_id: 'record', work_date: '2026-10-12', timezone: 'UTC', context_fingerprint: 'b'.repeat(64),
      original_freeze_snapshot: {},
      original_freeze_fingerprint: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      frame_snapshot: { identity: {}, fingerprint: 'b'.repeat(64), timezone: 'UTC', orgId: 'org', userId: 'user', workDate: '2026-10-12' },
    }])
    await expect(f.reader.readStoredContexts(f.trx, { orgId: 'org', userId: 'user',
      records: [{ id: 'record', work_date: '2026-10-12', timezone: 'UTC' }] }))
      .rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_TIMEZONE_STORED_CONTEXT_INVALID' })
  })
  it('unions mandatory export identity columns with all custom columns', () => {
    const fields = [{ code: 'custom', name: 'Custom' }, { code: 'timezone', name: 'Zone' }]
    const out = withTimezoneExportColumns(fields)
    expect(out.map((field: { code: string }) => field.code)).toEqual([
      'custom', 'timezone', 'work_date', 'first_in_at', 'last_out_at', 'timezone_source',
    ])
    expect(fields).toHaveLength(2)
  })
  it('retains configured collisions under unique keys while reserving stored identity columns', () => {
    const fields = [
      { code: 'timezone', formulaEnabled: true, formulaExpression: '"configured"' },
      { code: 'configured_timezone', formulaEnabled: true },
      { code: 'label', exportKey: 'timezone_source' },
    ]
    const out = withTimezoneExportColumns(fields)
    expect(out.slice(0, 3)).toEqual([
      { ...fields[0], exportKey: 'configured_timezone_2' }, fields[1],
      { ...fields[2], exportKey: 'configured_timezone_source' },
    ])
    for (const code of ['work_date', 'first_in_at', 'last_out_at', 'timezone', 'timezone_source']) {
      expect(out.filter((field: { code: string, exportKey?: string }) => (field.exportKey || field.code) === code))
        .toEqual([{ code, exportKey: code, name: expect.any(String) }])
    }
    expect(fields[0]).not.toHaveProperty('exportKey')
  })

  it.each(['missing', 'wrong_subject', 'wrong_date'])('rejects %s batch results without a per-day fallback', async (kind) => {
    const f = fixture()
    const target = { orgId: 'org', userId: kind === 'wrong_subject' ? 'other' : 'user',
      workDate: kind === 'wrong_date' ? '2026-10-13' : '2026-10-12',
      timezone: 'UTC', contextFingerprint: 'a'.repeat(64), frozen: false, provenance: base,
      isWorkingDay: true, rule: {} }
    f.readTargetTimezoneContexts.mockResolvedValue(kind === 'missing' ? new Map() : new Map([['2026-10-12', target]]))
    await expect(f.reader.readCalendarContexts(f.trx, {
      orgId: 'org', userId: 'user', workDates: ['2026-10-12'],
    })).rejects.toMatchObject({ status: 503, code: 'ATTENDANCE_TIMEZONE_TARGET_BATCH_INVALID' })
    expect(f.readTargetTimezoneContext).not.toHaveBeenCalled()
  })

  it('never attaches a replacement active record companion to an earlier record row', async () => {
    const f = fixture()
    const fingerprint = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
    f.optional.mockResolvedValue([{
      record_id: 'replacement', work_date: '2026-10-12', timezone: 'UTC',
      context_fingerprint: fingerprint, original_freeze_snapshot: {}, original_freeze_fingerprint: fingerprint,
      frame_snapshot: { identity: {}, fingerprint, orgId: 'org', userId: 'user',
        workDate: '2026-10-12', timezone: 'UTC', timezoneContext: base },
    }])
    await expect(f.reader.readStoredContexts(f.trx, { orgId: 'org', userId: 'user',
      records: [{ id: 'earlier', work_date: '2026-10-12', timezone: 'UTC' }] }))
      .rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_TIMEZONE_STORED_CONTEXT_INVALID' })
    const result = await f.reader.readStoredContexts(f.trx, { orgId: 'org', userId: 'user',
      records: [{ id: 'replacement', work_date: '2026-10-12', timezone: 'UTC' }] })
    expect(result.get('2026-10-12').timezoneSource).toBe('system_default')
  })

})
