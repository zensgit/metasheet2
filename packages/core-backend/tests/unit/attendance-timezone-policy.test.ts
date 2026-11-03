import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
type Selected = {
  status: 'selected'
  timezone: string
  source: 'system_default' | 'trip' | 'employee_override' | 'calculation_group'
  mode: 'default_only' | 'multi_timezone'
  referenceId: string
  version: number
}
type Result = Selected | { status: 'invalid' | 'ambiguous', code: string }
const { resolveAttendanceTimezone: resolve } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy.cjs',
) as { resolveAttendanceTimezone: (input: unknown) => Result }

const instant = new Date('2026-10-12T04:00:00.000Z')
function row(timezone = 'Asia/Singapore', referenceId = 'employee-1') {
  return { orgId: 'org-a', userId: 'user-a', referenceId, version: 3, timezone }
}
function trip(overrides: Record<string, unknown> = {}) {
  return {
    ...row('Asia/Tokyo', 'trip-1'),
    approvalStatus: 'approved',
    lifecycleStatus: 'ACTIVE',
    startAt: new Date('2026-10-12T02:00:00.000Z'),
    endAt: new Date('2026-10-12T06:00:00.000Z'),
    ...overrides,
  }
}
function input(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    orgId: 'org-a',
    userId: 'user-a',
    occurredAt: instant,
    systemDefault: { orgId: 'org-a', referenceId: 'default-1', version: 2, timezone: 'Asia/Shanghai' },
    ...overrides,
  }
}
function selected(
  source: Selected['source'], timezone: string, referenceId: string, version: number,
  mode: Selected['mode'] = 'multi_timezone',
): Selected {
  return { status: 'selected', timezone, source, mode, referenceId, version }
}
function invalid(code: string): Result {
  return { status: 'invalid', code: 'ATTENDANCE_TIMEZONE_' + code }
}

describe('D1 authoritative pure timezone selection', () => {
  it.each(['Asia/Tokyo', 'Asia/Singapore'])('OFF preserves the configured %s default', timezone => {
    const data = input({
      enabled: false,
      systemDefault: { orgId: 'org-a', referenceId: 'default-1', version: 2, timezone },
      trips: [trip()],
      employeeOverrides: [row('Europe/London')],
      calculationGroups: [row('America/New_York', 'group-1')],
    })
    expect(resolve(data)).toEqual(selected('system_default', timezone, 'default-1', 2, 'default_only'))
  })
  it('missing flag is OFF and never inspects other source fields', () => {
    const data = input({ enabled: undefined })
    for (const key of ['occurredAt', 'trips', 'employeeOverrides', 'calculationGroups']) {
      Object.defineProperty(data, key, { get: () => { throw new Error('SOURCE_WAS_READ') } })
    }
    expect(resolve(data)).toEqual(selected('system_default', 'Asia/Shanghai', 'default-1', 2, 'default_only'))
  })
  it.each([null, 'true', 'false', 'TRUE', 1, 0, {}, []])('rejects non-boolean flag %j', enabled => {
    expect(resolve(input({ enabled }))).toEqual(invalid('INVALID_ENABLED'))
  })
  it.each([false, true])('requires a legal system default while enabled=%s', enabled => {
    expect(resolve(input({ enabled, systemDefault: { orgId: 'org-a', referenceId: 'default-1', version: 2, timezone: 'Invalid/Sentinel' } })))
      .toEqual(invalid('INVALID_ZONE'))
  })
  it('selects a final approved ACTIVE trip over employee and group zones', () => {
    expect(resolve(input({ trips: [trip()], employeeOverrides: [row()], calculationGroups: [row('Europe/London', 'group-1')] })))
      .toEqual(selected('trip', 'Asia/Tokyo', 'trip-1', 3))
  })
  it('selects administrator employee override ahead of calculation group', () => {
    expect(resolve(input({ employeeOverrides: [row()], calculationGroups: [row('Europe/London', 'group-1')] })))
      .toEqual(selected('employee_override', 'Asia/Singapore', 'employee-1', 3))
  })
  it('selects the calculation group without any W7 flag or input', () => {
    expect(resolve(input({ calculationGroups: [row('Europe/London', 'group-1')] })))
      .toEqual(selected('calculation_group', 'Europe/London', 'group-1', 3))
  })
  it.each([undefined, null])('an absent group zone (%s) inherits default', timezone => {
    expect(resolve(input({ calculationGroups: [{ ...row('Europe/London', 'group-1'), timezone }] })))
      .toEqual(selected('system_default', 'Asia/Shanghai', 'default-1', 2))
  })
  it('missing optional sources inherit default', () => {
    expect(resolve(input())).toEqual(selected('system_default', 'Asia/Shanghai', 'default-1', 2))
  })
  it.each([
    { approvalStatus: 'pending' },
    { approvalStatus: 'rejected' },
    { lifecycleStatus: 'INACTIVE' },
    { startAt: new Date('2026-10-12T05:00:00Z') },
    { endAt: new Date('2026-10-12T03:00:00Z') },
  ])('ineligible trip %j inherits employee selection', overrides => {
    expect(resolve(input({ trips: [trip(overrides)], employeeOverrides: [row()] })))
      .toEqual(selected('employee_override', 'Asia/Singapore', 'employee-1', 3))
  })
  it('includes exact start and excludes exact end of a UTC trip interval', () => {
    const active = trip()
    expect(resolve(input({ occurredAt: active.startAt, trips: [active] })))
      .toEqual(selected('trip', 'Asia/Tokyo', 'trip-1', 3))
    expect(resolve(input({ occurredAt: active.endAt, trips: [active] })))
      .toEqual(selected('system_default', 'Asia/Shanghai', 'default-1', 2))
  })
  it('adjacent trip intervals select uniquely at their common boundary', () => {
    const first = trip()
    const second = trip({ referenceId: 'trip-2', startAt: first.endAt, endAt: new Date('2026-10-12T08:00:00Z'), timezone: 'Asia/Singapore' })
    expect(resolve(input({ occurredAt: first.endAt, trips: [first, second] })))
      .toEqual(selected('trip', 'Asia/Singapore', 'trip-2', 3))
  })
  it.each([
    ['trips', 'MULTIPLE_TRIPS', trip(), trip({ referenceId: 'trip-2' })],
    ['employeeOverrides', 'MULTIPLE_EMPLOYEE_OVERRIDES', row(), row('Asia/Singapore', 'employee-2')],
    ['calculationGroups', 'MULTIPLE_CALCULATION_GROUPS', row('Asia/Singapore', 'group-1'), row('Asia/Singapore', 'group-2')],
  ] as const)('refuses multiple %s even with equal zones and reversed row order', (key, code, first, second) => {
    const expected = { status: 'ambiguous', code: 'ATTENDANCE_TIMEZONE_' + code }
    expect(resolve(input({ [key]: [first, second] }))).toEqual(expected)
    expect(resolve(input({ [key]: [second, first] }))).toEqual(expected)
  })
  it('lower-tier ambiguity cannot replace an eligible unique trip', () => {
    expect(resolve(input({ trips: [trip()], employeeOverrides: [row(), row('Europe/London', 'employee-2')] })))
      .toEqual(selected('trip', 'Asia/Tokyo', 'trip-1', 3))
  })
  it.each(['trips', 'employeeOverrides', 'calculationGroups'])('invalid selected %s zone refuses without fallback', key => {
    const winner = key === 'trips' ? trip({ timezone: 'Invalid/Sentinel' }) : row('Invalid/Sentinel')
    expect(resolve(input({ [key]: [winner] }))).toEqual(invalid('INVALID_ZONE'))
  })
  it('invalid ineligible trip zone is not a selecting source', () => {
    expect(resolve(input({ trips: [trip({ approvalStatus: 'pending', timezone: 'Invalid/Sentinel' })], employeeOverrides: [row()] })))
      .toEqual(selected('employee_override', 'Asia/Singapore', 'employee-1', 3))
  })
  it('selected trip does not validate unused lower-priority zones', () => {
    expect(resolve(input({ trips: [trip()], employeeOverrides: [row('Invalid/Sentinel')] })))
      .toEqual(selected('trip', 'Asia/Tokyo', 'trip-1', 3))
  })
  it.each(['trips', 'employeeOverrides', 'calculationGroups'])('rejects cross-org or cross-user %s frames', key => {
    for (const change of [{ orgId: 'other-org' }, { userId: 'other-user' }]) {
      const source = key === 'trips' ? trip(change) : { ...row(), ...change }
      expect(resolve(input({ [key]: [source] }))).toEqual(invalid('INVALID_REFERENCE'))
    }
  })
  it('validates lower-priority frames even when an eligible trip exists', () => {
    expect(resolve(input({ trips: [trip()], calculationGroups: [{ ...row(), orgId: 'other-org' }] })))
      .toEqual(invalid('INVALID_REFERENCE'))
  })
  it.each([undefined, '', ' ', 0, {}, null])('rejects nonempty-reference violation %j', referenceId => {
    expect(resolve(input({ employeeOverrides: [{ ...row(), referenceId }] }))).toEqual(invalid('INVALID_REFERENCE'))
  })
  it.each([undefined, null, '1', 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects nonpositive/noninteger version %s', version => {
    expect(resolve(input({ employeeOverrides: [{ ...row(), version }] }))).toEqual(invalid('INVALID_REFERENCE'))
  })
  it('rejects invalid system-default reference and org frames even OFF', () => {
    for (const change of [{ orgId: 'other-org' }, { referenceId: '' }, { version: '2' }]) {
      expect(resolve(input({ enabled: false, systemDefault: { ...input().systemDefault, ...change } })))
        .toEqual(invalid('INVALID_REFERENCE'))
    }
  })
  it.each(['approved_final', '', undefined])('rejects illegal approval enum %s', approvalStatus => {
    expect(resolve(input({ trips: [trip({ approvalStatus })] }))).toEqual(invalid('INVALID_TRIP_STATUS'))
  })
  it.each(['active', '', undefined])('rejects illegal lifecycle enum %s', lifecycleStatus => {
    expect(resolve(input({ trips: [trip({ lifecycleStatus })] }))).toEqual(invalid('INVALID_TRIP_STATUS'))
  })
  it.each([
    { startAt: '2026-10-12T02:00:00Z' },
    { endAt: new Date('invalid') },
    { startAt: instant, endAt: instant },
    { startAt: new Date('2026-10-12T08:00:00Z') },
  ])('rejects malformed UTC trip interval %j', overrides => {
    expect(resolve(input({ trips: [trip(overrides)] }))).toEqual(invalid('INVALID_TRIP_INTERVAL'))
  })
  it.each([undefined, null, new Date('invalid'), '2026-10-12T04:00:00Z', 0])('ON requires a valid Date instant %j', occurredAt => {
    expect(resolve(input({ occurredAt }))).toEqual(invalid('INVALID_INSTANT'))
  })
  it.each(['trips', 'employeeOverrides', 'calculationGroups'])('rejects sparse or missing-row %s frames', key => {
    for (const rows of [new Array(1), [undefined], [null]]) {
      expect(resolve(input({ [key]: rows }))).toEqual(invalid('INVALID_REFERENCE'))
    }
  })
  it.each(['', ' ', null, undefined, 1, false, {}, []])('rejects illegal default zone %j', timezone => {
    expect(resolve(input({ systemDefault: { ...input().systemDefault, timezone } })))
      .toEqual(invalid('INVALID_ZONE'))
  })
  it.each(['trips', 'employeeOverrides', 'calculationGroups'])('rejects non-array %s sources', key => {
    expect(resolve(input({ [key]: null }))).toEqual(invalid('INVALID_INPUT'))
  })
  it.each([null, [], {}, { orgId: ' ', userId: 'user-a' }])('rejects missing identity input %j', data => {
    expect(resolve(data)).toEqual(invalid('INVALID_INPUT'))
  })
  it('failure results never echo supplied zones, references, orgs, or other values', () => {
    const sentinel = 'SECRET_SENTINEL_INVALID'
    const failures = [
      resolve(input({ employeeOverrides: [row(sentinel, sentinel)] })),
      resolve(input({ employeeOverrides: [{ ...row(), orgId: sentinel }] })),
      resolve(input({ trips: [trip({ referenceId: sentinel }), trip({ referenceId: 'trip-2' })] })),
    ]
    for (const result of failures) {
      expect(Object.keys(result)).toEqual(['status', 'code'])
      expect(JSON.stringify(result)).not.toContain(sentinel)
    }
  })
  it('selection does not mutate input rows or Date objects', () => {
    const active = Object.freeze(trip())
    const data = Object.freeze(input({ trips: Object.freeze([active]) }))
    const before = JSON.stringify(data)
    expect(resolve(data)).toEqual(selected('trip', 'Asia/Tokyo', 'trip-1', 3))
    expect(JSON.stringify(data)).toBe(before)
  })
})
