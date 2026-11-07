import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LEGACY_LOGIN_GRANT_PROVIDER,
  LEGACY_LOGIN_GRANT_PROVIDERS,
  effectGrantProvider,
  isLegacyLoginGrantProvider,
} from '../../src/directory/login-grant-registry'

describe('legacy login-grant registry', () => {
  it('the production registry is exactly dingtalk and is frozen', () => {
    expect([...LEGACY_LOGIN_GRANT_PROVIDERS]).toEqual(['dingtalk'])
    expect(DEFAULT_LEGACY_LOGIN_GRANT_PROVIDER).toBe('dingtalk')
    expect(Object.isFrozen(LEGACY_LOGIN_GRANT_PROVIDERS)).toBe(true)
    expect(() => {
      ;(LEGACY_LOGIN_GRANT_PROVIDERS as string[]).push('wecom')
    }).toThrow()
    expect([...LEGACY_LOGIN_GRANT_PROVIDERS]).toEqual(['dingtalk'])
  })

  it('membership is exact: the default provider is in, anything else is out, a variant is injected', () => {
    expect(isLegacyLoginGrantProvider('dingtalk')).toBe(true)
    expect(isLegacyLoginGrantProvider('wecom')).toBe(false)
    expect(isLegacyLoginGrantProvider('DingTalk')).toBe(false)
    expect(isLegacyLoginGrantProvider(' dingtalk')).toBe(false)
    expect(isLegacyLoginGrantProvider(null)).toBe(false)
    expect(isLegacyLoginGrantProvider(undefined)).toBe(false)
    expect(isLegacyLoginGrantProvider(1)).toBe(false)
    expect(isLegacyLoginGrantProvider('wecom', ['dingtalk', 'wecom'])).toBe(true)
    expect(isLegacyLoginGrantProvider('dingtalk', ['wecom'])).toBe(false)
  })
})

describe('effectGrantProvider', () => {
  it('reads a missing provider witness as the default provider', () => {
    expect(effectGrantProvider({ provider: null })).toBe('dingtalk')
    expect(effectGrantProvider({ provider: undefined })).toBe('dingtalk')
    expect(effectGrantProvider({})).toBe('dingtalk')
  })

  it('returns a present provider unchanged', () => {
    expect(effectGrantProvider({ provider: 'wecom' })).toBe('wecom')
    expect(effectGrantProvider({ provider: 'dingtalk' })).toBe('dingtalk')
  })

  it('refuses a blank or non-string witness with a typed, values-free error', () => {
    for (const provider of ['', '   ', 7, true, {}]) {
      let caught: (Error & { code?: string }) | null = null
      try {
        effectGrantProvider({ provider })
      } catch (error) {
        caught = error as Error & { code?: string }
      }
      expect(caught?.code).toBe('DEPROVISION_EFFECT_PROVIDER_MALFORMED')
      expect(caught?.message).not.toMatch(/wecom|dingtalk/)
    }
  })
})
