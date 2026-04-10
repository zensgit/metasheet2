import { describe, expect, it } from 'vitest'

import { isWhitelisted } from '../../src/auth/jwt-middleware'

describe('jwt auth whitelist', () => {
  it('allows DingTalk launch without a bearer token', () => {
    expect(isWhitelisted('/api/auth/dingtalk/launch')).toBe(true)
    expect(isWhitelisted('/api/auth/dingtalk/launch?redirect=%2Fdashboard')).toBe(true)
  })

  it('allows DingTalk callback without a bearer token', () => {
    expect(isWhitelisted('/api/auth/dingtalk/callback')).toBe(true)
  })
})
