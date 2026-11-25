import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAccountCenterReadEnabled } from '../../src/account-center/read-flag'

let assertions = 0
beforeEach(() => expect.hasAssertions())
afterEach(() => { assertions += expect.getState().assertionCalls; vi.unstubAllEnvs() })
afterAll(() => console.info('account-center-flag assertions', assertions))

describe('account center read flag', () => {
  it.each([undefined, '', 'false', 'TRUE', ' true', 'true ', '1', 'yes', 'True', '\ttrue'])('keeps value %j disabled', value => {
    expect(isAccountCenterReadEnabled({ ACCOUNT_CENTER_READ_ENABLED: value })).toBe(false)
  })
  it('accepts only the exact enabled value', () => {
    expect(isAccountCenterReadEnabled({ ACCOUNT_CENTER_READ_ENABLED: 'true' })).toBe(true)
  })
  it('reads the current environment on every call without changing it', () => {
    for (const value of ['false', 'true', 'false']) {
      vi.stubEnv('ACCOUNT_CENTER_READ_ENABLED', value)
      const before = { ...process.env }
      expect(isAccountCenterReadEnabled()).toBe(value === 'true')
      expect(process.env).toEqual(before)
    }
  })
  it('does not depend on other switches or mutate its argument', () => {
    const env = Object.freeze({ ACCOUNT_CENTER_READ_ENABLED: 'true' })
    expect(isAccountCenterReadEnabled(env)).toBe(true)
    expect(env).toEqual({ ACCOUNT_CENTER_READ_ENABLED: 'true' })
  })
})
