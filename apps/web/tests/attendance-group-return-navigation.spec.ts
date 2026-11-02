import { describe, expect, it } from 'vitest'
import { createAttendanceGroupReturnNavigation } from '../src/views/attendance/attendanceGroupReturnNavigation'

const GROUP = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'
const OTHER = '3f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'
const ORIGIN = '/attendance?tab=admin&section=attendance-admin-groups'

describe('parent group return history metadata', () => {
  it.each(['basics', 'people', 'schedule', 'policies'] as const)('retains the closed local stage %s', (stage) => {
    const navigation = createAttendanceGroupReturnNavigation(() => 'session-a/org-a')
    const intent = navigation.capture(GROUP, stage, ORIGIN)!
    expect(intent).toEqual({ groupId: GROUP, stage, origin: ORIGIN, nonce: expect.any(String) })
    expect(navigation.read(structuredClone(intent), ORIGIN + '#attendance-admin-groups')).toEqual(intent)
    expect(navigation.read(intent, '/attendance?tab=admin')).toBeNull()
    expect(navigation.read(intent, undefined, OTHER)).toBeNull()
    expect(navigation.read(intent, undefined, GROUP)).toEqual(intent)
    expect(createAttendanceGroupReturnNavigation(() => 'session-a/org-a').read(intent)).toBeNull()
  })

  it.each([undefined, null, [], 'rules', 'calendar', 'Policies', ''])('rejects illegal stage %j', (stage) => {
    const navigation = createAttendanceGroupReturnNavigation(() => 'session-a/org-a')
    expect(navigation.capture(GROUP, stage, ORIGIN)).toBeNull()
    const intent = navigation.capture(GROUP, 'policies', ORIGIN)!
    expect(navigation.read({ ...intent, stage })).toBeNull()
  })

  it('uses safe origin and query semantics without banning unrelated query keys', () => {
    const navigation = createAttendanceGroupReturnNavigation(() => 'session-a/org-a')
    const source = ORIGIN + '&filter=hello%20world&tag=one&tag=two&groupId=ignored&stage=ignored'
    const intent = navigation.capture(GROUP, 'people', source)!
    expect(intent.groupId).toBe(GROUP)
    expect(intent.stage).toBe('people')
    expect(navigation.read(intent, '/attendance?tag=one&tag=two&stage=ignored&groupId=ignored&filter=hello+world&section=attendance-admin-groups&tab=admin#decorative')).toEqual(intent)
    expect(navigation.read(intent, source.replace('hello%20world', 'different'))).toBeNull()
    expect(navigation.read(intent, source.replace('tag=one&tag=two', 'tag=two&tag=one'))).toBeNull()
    expect(navigation.capture(GROUP, 'policies', '/attendance?tab=admin&extra=ok')).not.toBeNull()
  })

  it.each([
    '//example.test/attendance?tab=admin', '/attendance-evil?tab=admin',
    '/attendance?tab=admin&returnTo=x', 'https://example.test/attendance?tab=admin',
  ])('rejects unsafe origins through the existing normalizer: %s', (origin) => {
    const navigation = createAttendanceGroupReturnNavigation(() => 'session-a/org-a')
    expect(navigation.capture(GROUP, 'policies', origin)).toBeNull()
  })

  it.each(['session-b/org-a', 'session-a/org-b', 'session-renewed/org-a', null])('regenerates the nonce on scope change %s', (next) => {
    let scope: string | null = 'session-a/org-a'
    const navigation = createAttendanceGroupReturnNavigation(() => scope)
    const intent = navigation.capture(GROUP, 'policies', ORIGIN)
    scope = next
    expect(navigation.read(intent)).toBeNull()
    scope = 'session-a/org-a'
    expect(navigation.read(intent)).toBeNull()
  })

  it('keeps older history intents without an entry limit and resets the nonce on clear', () => {
    const navigation = createAttendanceGroupReturnNavigation(() => 'private-session')
    const oldest = navigation.capture(GROUP, 'basics', ORIGIN)!
    for (let index = 0; index < 40; index += 1) navigation.capture(GROUP, 'people', ORIGIN)
    expect(navigation.read(oldest)).toEqual(oldest)
    expect(Object.keys(oldest).sort()).toEqual(['groupId', 'nonce', 'origin', 'stage'])
    navigation.clear()
    expect(navigation.read(oldest)).toBeNull()
    expect(navigation.capture(GROUP, 'basics', ORIGIN)?.nonce).not.toBe(oldest.nonce)
    expect(navigation.capture('other', 'basics', ORIGIN)).toBeNull()
    expect(createAttendanceGroupReturnNavigation(() => null).capture(GROUP, 'basics', ORIGIN)).toBeNull()
  })

  it('rejects malformed/foreign metadata without interpreting query selectors', () => {
    const navigation = createAttendanceGroupReturnNavigation(() => 'private-session')
    const intent = navigation.capture(GROUP, 'policies', ORIGIN)!
    for (const value of [null, 'old-handle', {}, { ...intent, nonce: 'foreign' }, { ...intent, groupId: 'invalid' }, { ...intent, origin: '//evil.test' }]) {
      expect(navigation.read(value)).toBeNull()
    }
  })
})
