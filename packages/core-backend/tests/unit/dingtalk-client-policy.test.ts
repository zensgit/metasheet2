import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDingTalkConfigured, readDingTalkOauthConfig } from '../../src/integrations/dingtalk/client'

describe('dingtalk client runtime policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reports DingTalk as unavailable when corpId is outside the allowlist', () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'client-id')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'client-secret')
    vi.stubEnv('DINGTALK_REDIRECT_URI', 'https://example.com/callback')
    vi.stubEnv('DINGTALK_CORP_ID', 'dingcorp-blocked')
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'dingcorp-allowed')

    expect(isDingTalkConfigured()).toBe(false)
    expect(() => readDingTalkOauthConfig()).toThrow('not allowed by DINGTALK_ALLOWED_CORP_IDS')
  })

  it('allows DingTalk when corpId matches the configured allowlist', () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'client-id')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'client-secret')
    vi.stubEnv('DINGTALK_REDIRECT_URI', 'https://example.com/callback')
    vi.stubEnv('DINGTALK_CORP_ID', 'dingcorp-allowed')
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'dingcorp-allowed, dingcorp-2')

    expect(isDingTalkConfigured()).toBe(true)
    expect(readDingTalkOauthConfig()).toMatchObject({
      clientId: 'client-id',
      corpId: 'dingcorp-allowed',
    })
  })
})
