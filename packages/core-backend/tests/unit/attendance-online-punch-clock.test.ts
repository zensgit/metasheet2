import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const clock = require('../../../../plugins/plugin-attendance/lib/attendance-online-punch-clock.cjs')
const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = 'test'
  clock.setOnlinePunchInstantForTests(null)
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})
describe('ordinary punch server clock', () => {
  it.each(['occurredAt', 'occurred_at'])('rejects own alias %s by presence for every supplied value', alias => {
    for (const value of [null, '', undefined, 0, false, {}, [], '2026-10-10T12:00:00Z']) {
      expect(clock.hasClientPunchTimestamp({ [alias]: value })).toBe(true)
    }
    expect(clock.hasClientPunchTimestamp({ occurredAt: null, occurred_at: null })).toBe(true)
  })
  it('does not treat absent or inherited time as a caller field', () => {
    for (const value of [null, undefined, {}, { eventType: 'check_in' }, Object.create({ occurredAt: 'x' })]) {
      expect(clock.hasClientPunchTimestamp(value)).toBe(false)
    }
  })
  it('returns fresh Date objects at the process test instant', () => {
    process.env.NODE_ENV = 'test'
    clock.setOnlinePunchInstantForTests('2026-10-10T02:03:04.005Z')
    const first = clock.getOnlinePunchServerInstant()
    expect(first.toISOString()).toBe('2026-10-10T02:03:04.005Z')
    first.setTime(0)
    expect(clock.getOnlinePunchServerInstant().toISOString()).toBe('2026-10-10T02:03:04.005Z')
  })
  it.each(['production', 'development', '', undefined])('refuses the test seam outside test (%s)', value => {
    if (value === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = value
    expect(() => clock.setOnlinePunchInstantForTests('2026-10-10T00:00:00Z')).toThrow('ONLINE_PUNCH_TEST_CLOCK_FORBIDDEN')
  })
  it('ignores a previously installed test instant after changing to production', () => {
    process.env.NODE_ENV = 'test'
    clock.setOnlinePunchInstantForTests('2000-01-01T00:00:00Z')
    process.env.NODE_ENV = 'production'
    const before = Date.now()
    const actual = clock.getOnlinePunchServerInstant().getTime()
    expect(actual).toBeGreaterThanOrEqual(before)
    expect(actual).toBeLessThanOrEqual(Date.now())
  })
  it('rejects invalid test instants and exposes the fixed values-free refusal', () => {
    process.env.NODE_ENV = 'test'
    expect(() => clock.setOnlinePunchInstantForTests('invalid')).toThrow('ONLINE_PUNCH_TEST_CLOCK_INVALID')
    expect([clock.CLIENT_TIMESTAMP_CODE, clock.CLIENT_TIMESTAMP_MESSAGE]).toEqual(['PUNCH_CLIENT_TIMESTAMP_FORBIDDEN', 'The server determines online punch time'])
  })
})
